// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MOD_LABEL, commandLabel, commands, matchBinding } from "../src/commands";

/**
 * The command registry (ui DESIGN.md, "命令面板"): one descriptor list feeds
 * the palette, the shortcut dispatcher and the help overlay. These tests pin
 * the binding matcher's semantics and the registry's display contract.
 */

const key = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });

describe("matchBinding", () => {
  it("matches plain character keys regardless of shift state", () => {
    expect(matchBinding(key("?", { shiftKey: true }), { key: "?" })).toBe(true);
    expect(matchBinding(key("?"), { key: "?" })).toBe(true);
    expect(matchBinding(key("a"), { key: "a" })).toBe(true);
  });

  it("matches letters case-insensitively", () => {
    expect(matchBinding(key("K"), { key: "k" })).toBe(true);
    expect(matchBinding(key("k"), { key: "k" })).toBe(true);
  });

  it("requires ctrlOrMeta exactly", () => {
    const binding = { key: "=", ctrlOrMeta: true };
    expect(matchBinding(key("=", { ctrlKey: true }), binding)).toBe(true);
    expect(matchBinding(key("=", { metaKey: true }), binding)).toBe(true);
    expect(matchBinding(key("="), binding)).toBe(false);
  });

  it("never matches with Alt held (the peek modifier)", () => {
    expect(
      matchBinding(key("=", { ctrlKey: true, altKey: true }), { key: "=", ctrlOrMeta: true }),
    ).toBe(false);
  });

  it("matches by event.code for modifier-bearing top-row keys", () => {
    // Shift+1 produces event.key "!" on US layouts; Digit1 is the stable fact.
    expect(
      matchBinding(key("!", { code: "Digit1", shiftKey: true }), { code: "Digit1", shift: true }),
    ).toBe(true);
    expect(matchBinding(key("!", { code: "Digit1" }), { code: "Digit1", shift: true })).toBe(false);
    expect(matchBinding(key("1", { code: "Digit1" }), { code: "Digit1", shift: true })).toBe(false);
  });

  it("rejects modified events for plain bindings", () => {
    expect(matchBinding(key("?", { ctrlKey: true }), { key: "?" })).toBe(false);
  });
});

describe("command registry", () => {
  it("gives every bound command a display key string", () => {
    // The palette and the help overlay render `keys` verbatim next to the
    // binding; a binding without its display string would show an empty kbd.
    for (const command of commands) {
      if (command.bindings !== undefined) expect(command.keys, command.id).toBeDefined();
    }
  });

  it("spells modifier-bearing keys with the platform modifier", () => {
    // The display strings sit next to the binding in the palette and the
    // help overlay; "+" alone would claim a key that does nothing.
    for (const command of commands) {
      const modified = command.bindings?.some((binding) => binding.ctrlOrMeta === true);
      if (modified === true) expect(command.keys, command.id).toContain(MOD_LABEL);
    }
  });

  it("registers the palette so the help overlay lists its shortcut", () => {
    const palette = commands.find((command) => command.id === "command-palette");
    expect(palette?.bindings).toEqual([{ key: "k", ctrlOrMeta: true }]);
    expect(palette?.keys).toBe(`${MOD_LABEL}K`);
  });

  it("labels toggle commands from the context", () => {
    const t = (key: string): string => key;
    const dark = { store: { state: { theme: "dark" } }, workspace: {} } as never;
    expect(
      commandLabel(
        commands.find((c) => c.id === "theme")!,
        dark,
        t,
      ),
    ).toBe("app.themeLight");
  });

  it("toggles the display options from the palette", () => {
    const t = (key: string): string => key;
    const config = { showMinimap: true, showVirtualRoot: false };
    const setConfig = vi.fn((patch: Partial<typeof config>) => Object.assign(config, patch));
    const ctx = { workspace: { state: { config }, setConfig } } as never;

    const minimap = commands.find((command) => command.id === "minimap")!;
    expect(commandLabel(minimap, ctx, t)).toBe("canvas.minimap: common.on");
    minimap.run(ctx);
    expect(config.showMinimap).toBe(false);

    const root = commands.find((command) => command.id === "virtual-root")!;
    expect(commandLabel(root, ctx, t)).toBe("canvas.virtualRoot: common.off");
    root.run(ctx);
    expect(config.showVirtualRoot).toBe(true);
  });

  it("names and toggles the canvas view from the context", () => {
    const t = (key: string): string => key;
    const config: { canvasView: "planar" | "orbit" } = { canvasView: "planar" };
    const setConfig = vi.fn((next: { canvasView: "planar" | "orbit" }) => {
      config.canvasView = next.canvasView;
    });
    const ctx = { workspace: { state: { config }, setConfig } } as never;
    const command = commands.find((entry) => entry.id === "view-toggle")!;
    expect(commandLabel(command, ctx, t)).toBe("canvas.viewOrbit");
    command.run(ctx);
    expect(setConfig).toHaveBeenLastCalledWith({ canvasView: "orbit" });
    expect(commandLabel(command, ctx, t)).toBe("canvas.viewPlanar");
    command.run(ctx);
    expect(config.canvasView).toBe("planar");
  });
});
