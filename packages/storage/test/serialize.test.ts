import { describe, expect, it } from "vitest";
import { serializeNode } from "../src/serialize.js";

describe("serializeNode", () => {
  it("omits the frontmatter block when no fields are present", () => {
    expect(serializeNode({}, "Root decision.")).toBe("Root decision.\n");
    expect(serializeNode({ grounds: undefined }, "Root decision.")).toBe("Root decision.\n");
  });

  it("serializes present fields as a YAML frontmatter block", () => {
    const source = serializeNode(
      { grounds: ["1A2B3C4D"], rationale: "Keeps DB access testable." },
      "Use Repository layer.",
    );
    expect(source).toContain("grounds:");
    expect(source).toContain("1A2B3C4D");
    expect(source).toContain("rationale:");
    expect(source.endsWith("Use Repository layer.\n")).toBe(true);
  });

  it("trims the body to a single trailing newline", () => {
    expect(serializeNode({}, "Body.\n\n\n")).toBe("Body.\n");
  });
});
