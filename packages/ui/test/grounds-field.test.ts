// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { clientKey, type RefinoClient } from "../src/api";
import GroundsField from "../src/components/GroundsField.vue";
import { createRefinoI18n } from "../src/i18n";

/** The shared grounds editor (ui DESIGN.md, "编辑功能"): rows name nodes by
 * summary, never by id, and an empty summary reads as untitled. */

function fakeClient(): RefinoClient {
  return {
    queryNeighbors: async () => [],
    queryExpand: async () => [],
    queryRange: async () => ({ mode: "disconnected", nodes: [] }),
    queryGrounds: async () => [
      {
        id: "OWNER",
        results: [
          { id: "G1", type: "premise", summary: "依据一", depth: 0 },
          { id: "G2", type: "premise", summary: "", depth: 0 },
        ],
      },
    ],
    search: async () => ({ nodes: [] }),
    fetchNode: async () => {
      throw new Error("not used");
    },
    fetchIssues: async () => ({ ok: true, issues: [], revision: 0 }),
    reloadGraph: async () => ({ revision: 0, changed: [], deleted: [] }),
    createNode: async () => {
      throw new Error("not used");
    },
    updateNode: async () => {
      throw new Error("not used");
    },
    deleteNode: async () => {
      throw new Error("not used");
    },
    connectEvents: () => () => {},
  };
}

describe("GroundsField", () => {
  it("names resolved grounds by summary without leaking the id", async () => {
    const wrapper = mount(GroundsField, {
      props: { grounds: ["G1", "G2"], ownerId: "OWNER" },
      global: {
        provide: { [clientKey as symbol]: fakeClient() },
        plugins: [createRefinoI18n("zh")],
      },
    });
    await vi.waitFor(() =>
      expect(wrapper.findAll(".grounds-list .summary").map((row) => row.text())).toEqual([
        "依据一",
        "（无摘要）",
      ]),
    );
    for (const row of wrapper.findAll(".grounds-list .summary")) {
      expect(row.attributes("title")).toBeUndefined();
    }
  });
});
