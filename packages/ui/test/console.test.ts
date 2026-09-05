// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import AuthorizationConsole from "../src/components/AuthorizationConsole.vue";
import { createRefinoI18n } from "../src/i18n";
import type { AuthorizationContext } from "@refino/harness";
import type { ConsoleClient, ConsoleNode } from "../src/console";

/**
 * Authorization console (docs/design.md, "用户侧：授权控制台") against a
 * fake ConsoleClient: the derived zone preview, the frontier, the estimate
 * and the sign round-trip.
 *
 *   P1 1A2B3C4D   P2 1A2B3C4E
 *   R1 A1B2C3D4 grounds []          (root)
 *   C1 D4E5F6G7 grounds [R1, P1]
 *   C2 E5F6G7H8 grounds [C1]
 */

const P1 = "1A2B3C4D";
const R1 = "A1B2C3D4";
const C1 = "D4E5F6G7";
const C2 = "E5F6G7H8";

const graphNodes: ConsoleNode[] = [
  { id: P1, type: "premise", summary: "前提一" },
  { id: "1A2B3C4E", type: "premise", summary: "前提二" },
  { id: R1, type: "constraint", summary: "根约束" },
  { id: C1, type: "constraint", summary: "子约束", grounds: [R1, P1] },
  { id: C2, type: "constraint", summary: "孙约束", grounds: [C1] },
];

/** Mounts the console with a recording client and waits for the graph. */
async function mountConsole(effective: AuthorizationContext | null) {
  const client: ConsoleClient & { signed: AuthorizationContext[] } = {
    signed: [],
    fetchGraph: async () => graphNodes,
    fetchContext: async () => effective,
    sign: async (context) => {
      client.signed.push(context);
    },
  };
  const i18n = createRefinoI18n("zh");
  const wrapper = mount(AuthorizationConsole, {
    props: { client },
    global: { plugins: [i18n] },
  });
  await vi.waitFor(() => expect(wrapper.text()).toContain("冻结区将包含"));
  return { wrapper, client };
}

describe("AuthorizationConsole", () => {
  it("starts with an empty draft when nothing was signed yet", async () => {
    const { wrapper } = await mountConsole(null);
    expect(wrapper.text()).toContain("冻结区将包含 0 个约束、0 个前提");
    expect(wrapper.text()).toContain("未冻结任何约束");
  });

  it("previews the propagation and signs the draft", async () => {
    const { wrapper, client } = await mountConsole(null);
    const vm = wrapper.vm as unknown as { anchors: string[]; frozen: string[] };
    vm.frozen = [C1];
    // Freezing C1 pulls R1 and P1 into the zone: 2 constraints, 1 premise.
    await vi.waitFor(() => expect(wrapper.text()).toContain("冻结区将包含 2 个约束、1 个前提"));
    expect(wrapper.text()).toContain("本次新增冻结 2 个");

    await wrapper.find(".actions button").trigger("click");
    expect(client.signed).toEqual([{ anchors: [], frozen: [C1] }]);
  });

  it("seeds the draft from the effective context", async () => {
    const { wrapper } = await mountConsole({ anchors: [C2], frozen: [C1] });
    expect((wrapper.vm as unknown as { anchors: string[] }).anchors).toEqual([C2]);
    expect((wrapper.vm as unknown as { frozen: string[] }).frozen).toEqual([C1]);
  });
});
