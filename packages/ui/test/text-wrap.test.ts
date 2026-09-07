import { describe, expect, it } from "vitest";
import { wrap, wrapEllipsized } from "../src/graph/render/atlas";

type Measurer = Parameters<typeof wrap>[0];

// jsdom canvas has no 2D context; measure with a stub via a cast.
// ASCII characters are 10px, CJK characters 20px, the ellipsis 10px.
function fakeAtlas(): Measurer {
  const cjk = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;
  return {
    measure: (text: string) => [...text].reduce((sum, ch) => sum + (cjk.test(ch) ? 20 : 10), 0),
  } as unknown as Measurer;
}

describe("label wrapping", () => {
  const atlas = fakeAtlas();

  it("keeps text that fits on one line", () => {
    expect(wrap(atlas, "hello", 50)).toEqual(["hello"]);
    expect(wrap(atlas, "hello", Infinity)).toEqual(["hello"]);
  });

  it("breaks at whitespace, keeping it on the line (lossless join)", () => {
    const lines = wrap(atlas, "alpha beta gamma", 60);
    expect(lines).toEqual(["alpha ", "beta ", "gamma"]);
    expect(lines.join("")).toBe("alpha beta gamma");
  });

  it("wraps CJK text after each character", () => {
    const lines = wrap(atlas, "约束细化约束", 60);
    expect(lines).toEqual(["约束细", "化约束"]);
    expect(lines.join("")).toBe("约束细化约束");
  });

  it("hard-breaks a run without break opportunities", () => {
    const lines = wrap(atlas, "abcdefghij", 35);
    expect(lines).toEqual(["abc", "def", "ghi", "j"]);
    expect(lines.join("")).toBe("abcdefghij");
  });

  it("gives an oversized single character its own line", () => {
    const lines = wrap(atlas, "ab", 5);
    expect(lines).toEqual(["a", "b"]);
    expect(wrap(atlas, "约束", 10)).toEqual(["约", "束"]);
  });

  it("mixes word, CJK and hard breaks without losing text", () => {
    const text = "复用 alpha 组合 beta/gamma 验证";
    const lines = wrap(atlas, text, 90);
    expect(lines.join("")).toBe(text);
    for (const line of lines) expect(atlas.measure(line)).toBeLessThanOrEqual(90);
  });
});

describe("label wrapping with an ellipsis budget", () => {
  const atlas = fakeAtlas();

  it("returns the wrapped lines while they fit the line budget", () => {
    expect(wrapEllipsized(atlas, "alpha beta", 60, 2)).toEqual(["alpha ", "beta"]);
    expect(wrapEllipsized(atlas, "alpha beta", 60, 5)).toEqual(["alpha ", "beta"]);
  });

  it("collapses the overflow into an ellipsized last line", () => {
    const lines = wrapEllipsized(atlas, "alpha beta gamma delta", 60, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("alpha ");
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(atlas.measure(lines[1]!)).toBeLessThanOrEqual(60);
    // Everything before the ellipsis is a prefix of the original text.
    expect("alpha beta gamma delta".startsWith(lines.join("").replace(/…$/, ""))).toBe(true);
  });

  it("treats a non-positive line budget as one line", () => {
    expect(wrapEllipsized(atlas, "alpha beta", 60, 0)).toEqual(["alpha…"]);
  });
});
