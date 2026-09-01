import { describe, expect, it } from "vitest";
import { parseNodeSource } from "../src/parser.js";

describe("parseNodeSource", () => {
  it("parses a constraint with grounds, summary and body", () => {
    const source = [
      "---",
      "id: C-019",
      "type: constraint",
      "grounds: [P-003, C-007]",
      "---",
      "",
      "实现必须通过 Repository 层。",
      "",
      "理由：业务层不得直接依赖数据库，权衡过程如下。",
    ].join("\n");

    const { node, issues } = parseNodeSource("constraints/C-019.md", "constraint", source);
    expect(issues).toEqual([]);
    expect(node).toEqual({
      id: "C-019",
      type: "constraint",
      file: "constraints/C-019.md",
      summary: "实现必须通过 Repository 层。",
      body: "实现必须通过 Repository 层。\n\n理由：业务层不得直接依赖数据库，权衡过程如下。",
      grounds: ["P-003", "C-007"],
    });
  });

  it("parses a premise without grounds", () => {
    const { node, issues } = parseNodeSource(
      "premises/P-003.md",
      "premise",
      "---\nid: P-003\ntype: premise\n---\n\nPostgreSQL 不支持 extension X。\n",
    );
    expect(issues).toEqual([]);
    expect(node).toMatchObject({ id: "P-003", type: "premise" });
    expect(node?.grounds).toBeUndefined();
  });

  it("omits grounds for a root constraint declared without the field", () => {
    const { node } = parseNodeSource(
      "constraints/C-001.md",
      "constraint",
      "---\nid: C-001\ntype: constraint\n---\n\nRoot decision.\n",
    );
    expect(node?.grounds).toEqual([]);
  });

  it("deduplicates grounds while preserving order", () => {
    const { node, issues } = parseNodeSource(
      "constraints/C-001.md",
      "constraint",
      "---\nid: C-001\ntype: constraint\ngrounds: [B, A, B]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual(["B", "A"]);
  });

  it("accepts an explicit empty grounds list", () => {
    const { node, issues } = parseNodeSource(
      "constraints/C-001.md",
      "constraint",
      "---\nid: C-001\ntype: constraint\ngrounds: []\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual([]);
  });

  it("normalizes CRLF line endings and a leading BOM", () => {
    const source = `\uFEFF---\r\nid: C-001\r\ntype: constraint\r\n---\r\n\r\nFirst\r\nparagraph continues.\r\n\r\nRationale.\r\n`;
    const { node, issues } = parseNodeSource("constraints/C-001.md", "constraint", source);
    expect(issues).toEqual([]);
    expect(node?.summary).toBe("First paragraph continues.");
    expect(node?.body).toBe("First\nparagraph continues.\n\nRationale.");
  });

  it("uses the first paragraph as summary, collapsing internal whitespace", () => {
    const { node } = parseNodeSource(
      "constraints/C-001.md",
      "constraint",
      "---\nid: C-001\ntype: constraint\n---\n\nLine one.\nLine two continues.\n\nRationale.\n",
    );
    expect(node?.summary).toBe("Line one. Line two continues.");
  });

  it("reports MISSING_FRONTMATTER", () => {
    const { node, issues } = parseNodeSource("x.md", "constraint", "no frontmatter here\n");
    expect(node).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(["MISSING_FRONTMATTER"]);
  });

  it("reports INVALID_FRONTMATTER for broken YAML", () => {
    const { node, issues } = parseNodeSource(
      "x.md",
      "constraint",
      "---\nid: [unclosed\n---\n\nBody.\n",
    );
    expect(node).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(["INVALID_FRONTMATTER"]);
  });

  it("reports INVALID_FRONTMATTER when the frontmatter is not a mapping", () => {
    const { issues } = parseNodeSource("x.md", "constraint", "---\n- a\n- b\n---\n\nBody.\n");
    expect(issues.map((i) => i.code)).toEqual(["INVALID_FRONTMATTER"]);
  });

  it.each([
    ["missing id", "constraint", "---\ntype: constraint\n---\n\nBody.\n", "MISSING_ID"],
    ["blank id", "constraint", '---\nid: ""\ntype: constraint\n---\n\nBody.\n', "INVALID_ID"],
    [
      "untrimmed id",
      "constraint",
      '---\nid: " C-001"\ntype: constraint\n---\n\nBody.\n',
      "INVALID_ID",
    ],
    ["missing type", "constraint", "---\nid: C-001\n---\n\nBody.\n", "MISSING_TYPE"],
    [
      "unknown type",
      "constraint",
      "---\nid: C-001\ntype: decision\n---\n\nBody.\n",
      "INVALID_TYPE",
    ],
    [
      "type does not match directory",
      "constraint",
      "---\nid: C-001\ntype: premise\n---\n\nBody.\n",
      "TYPE_DIR_MISMATCH",
    ],
    [
      "premise with grounds",
      "premise",
      "---\nid: P-001\ntype: premise\ngrounds: [C-001]\n---\n\nBody.\n",
      "PREMISE_WITH_GROUNDS",
    ],
    [
      "grounds not a list",
      "constraint",
      "---\nid: C-001\ntype: constraint\ngrounds: C-002\n---\n\nBody.\n",
      "INVALID_GROUNDS",
    ],
    [
      "grounds entry not a string",
      "constraint",
      "---\nid: C-001\ntype: constraint\ngrounds: [3]\n---\n\nBody.\n",
      "INVALID_GROUNDS",
    ],
  ])("rejects %s", (_label, expectedType, source, code) => {
    const { issues } = parseNodeSource("x.md", expectedType as "premise" | "constraint", source);
    expect(issues.map((i) => i.code)).toEqual([code]);
  });
});
