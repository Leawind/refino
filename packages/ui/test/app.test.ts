// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";

describe("refino web shell", () => {
  it("renders the placeholder shell", () => {
    const wrapper = mount(App);
    expect(wrapper.text()).toContain("refino web");
    expect(wrapper.text()).toContain("The web UI is not implemented yet.");
  });
});
