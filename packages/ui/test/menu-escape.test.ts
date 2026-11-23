// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { useMenuEscape } from "../src/menuEscape";

let open = ref(false);

const Host = defineComponent({
  setup() {
    open = ref(true);
    useMenuEscape(open);
    return { open };
  },
  template: `<div>{{ open }}</div>`,
});

function escape(): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("useMenuEscape", () => {
  it("closes an open menu and stops the key from reaching the shell", () => {
    const later = vi.fn();
    document.addEventListener("keydown", later);
    const wrapper = mount(Host, { attachTo: document.body });
    escape();
    expect(open.value).toBe(false);
    expect(later).not.toHaveBeenCalled();
    document.removeEventListener("keydown", later);
    wrapper.unmount();
  });

  it("detaches on unmount", () => {
    const wrapper = mount(Host, { attachTo: document.body });
    const watched = open;
    wrapper.unmount();
    escape();
    expect(watched.value).toBe(true);
  });
});
