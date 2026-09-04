import { describe, expect, it } from "vitest";
import { generateId, ID_RE } from "../src/id.js";

describe("ids", () => {
  it("ID_RE implements the engine id rule (3-16 chars of A-Z, 0-9, _)", () => {
    expect(ID_RE.test("ABC")).toBe(true); // minimum length 3
    expect(ID_RE.test("01234567")).toBe(true);
    expect(ID_RE.test("A1_B2_C3")).toBe(true); // underscores allowed
    expect(ID_RE.test("ABCDEFGHIJKLMNOP")).toBe(true); // maximum length 16
    expect(ID_RE.test("AB")).toBe(false); // too short
    expect(ID_RE.test("ABCDEFGHIJKLMNOPQ")).toBe(false); // too long
    expect(ID_RE.test("A-B-CD")).toBe(false); // hyphen (path separator)
    expect(ID_RE.test("A.B.CD")).toBe(false); // dot (extension separator)
    expect(ID_RE.test("ABCDE FG")).toBe(false); // space
    expect(ID_RE.test("abcde")).toBe(false); // lowercase
  });

  it("generateId produces distinct valid ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateId();
      expect(id).toMatch(ID_RE);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });
});
