import { describe, expect, it } from "vitest";
import { structureSignature } from "../src/graph/layout/structure";
import type { NodeLite } from "../src/types";

const node = (id: string, grounds?: string[]): NodeLite =>
  ({ id, type: "decision", summary: id, ...(grounds && { grounds }) }) as NodeLite;

const premiseNode = (id: string): NodeLite => ({ id, type: "premise", summary: id }) as NodeLite;

describe("structure signature", () => {
  it("is order-independent for the same node set and edges", () => {
    const a = structureSignature([node("b", ["a"]), node("a")]);
    const b = structureSignature([node("a"), node("b", ["a"])]);
    expect(a).toBe(b);
  });

  it("changes when a node joins or leaves", () => {
    const base = structureSignature([node("a"), node("b", ["a"])]);
    expect(structureSignature([node("a"), node("b", ["a"]), node("c")])).not.toBe(base);
    expect(structureSignature([node("a")])).not.toBe(base);
  });

  it("changes when a node's kind flips between premise and decision", () => {
    // Layouts place premises on their own display layers, so a same-id
    // rebuild as the other kind must restart the session.
    const base = structureSignature([node("a"), node("b", ["a"])]);
    expect(structureSignature([premiseNode("a"), node("b", ["a"])])).not.toBe(base);
  });

  it("changes when a grounds edge is added, removed or retargeted", () => {
    const single = structureSignature([node("a"), node("b")]);
    const ab = structureSignature([node("a"), node("b", ["a"])]);
    expect(ab).not.toBe(single);
    // Adding an out-of-set ground changes nothing: only in-set edges count.
    expect(structureSignature([node("a"), node("b", ["a", "zzz"])])).toBe(ab);
    expect(structureSignature([node("a"), node("b", ["a"]), node("c", ["b"])])).not.toBe(ab);
  });
});
