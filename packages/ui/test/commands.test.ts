// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { commandLabel, commands, matchBinding } from "../src/commands";

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
});
