import { describe, expect, it } from "vitest";
import { generateId, ID_RE } from "../src/id.js";

describe("ids", () => {
  it("ID_RE accepts 8-character Crockford base32 ids", () => {
    expect(ID_RE.test("01234567")).toBe(true);
    expect(ID_RE.test("ABCDEFGH")).toBe(true);
    expect(ID_RE.test("ILOU2345")).toBe(false);
    expect(ID_RE.test("short")).toBe(false);
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
