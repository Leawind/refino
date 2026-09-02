import { describe, expect, it } from "vitest";
import { extractSummary, parseNodeSource, SUMMARY_MAX_LENGTH } from "../src/parser.js";

describe("parseNodeSource", () => {
  it("accepts both separator styles and stores the canonical forward-slash form", () => {
    const { node, issues } = parseNodeSource("constraints\\E5F6G7H8.md", "constraint", "Body.");
    expect(issues).toEqual([]);
    expect(node).toMatchObject({ id: "E5F6G7H8", file: "constraints/E5F6G7H8.md" });
  });

  it("parses a constraint with grounds, summary and body", () => {
    const source = [
      "---",
      "grounds: [1A2B3C4D, D4E5F6G7]",
      "rationale: 业务层不得直接依赖数据库。",
      "---",
      "",
      "实现必须通过 Repository 层。",
      "",
      "完整的推导与权衡过程。",
    ].join("\n");

    const { node, issues } = parseNodeSource("constraints/E5F6G7H8.md", "constraint", source);
    expect(issues).toEqual([]);
    expect(node).toEqual({
      id: "E5F6G7H8",
      type: "constraint",
      file: "constraints/E5F6G7H8.md",
      summary: "实现必须通过 Repository 层。",
      body: "实现必须通过 Repository 层。\n\n完整的推导与权衡过程。",
      grounds: ["1A2B3C4D", "D4E5F6G7"],
      rationale: "业务层不得直接依赖数据库。",
    });
  });

  it("parses a premise with a confirmed timestamp", () => {
    const { node, issues } = parseNodeSource(
      "premises/1A2B3C4D.md",
      "premise",
      "---\nconfirmed: 2026-05-01T00:00:00Z\n---\n\nPostgreSQL 不支持 extension X。\n",
    );
    expect(issues).toEqual([]);
    expect(node).toMatchObject({
      id: "1A2B3C4D",
      type: "premise",
      confirmed: "2026-05-01T00:00:00Z",
    });
    expect(node?.grounds).toBeUndefined();
  });

  it("accepts a file without frontmatter at all", () => {
    const { node, issues } = parseNodeSource(
      "premises/1A2B3C4D.md",
      "premise",
      "PostgreSQL 不支持 extension X。\n",
    );
    expect(issues).toEqual([]);
    expect(node).toMatchObject({
      id: "1A2B3C4D",
      type: "premise",
      summary: "PostgreSQL 不支持 extension X。",
      body: "PostgreSQL 不支持 extension X。",
    });
  });

  it("accepts an empty frontmatter block", () => {
    const { node, issues } = parseNodeSource(
      "premises/1A2B3C4D.md",
      "premise",
      "---\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.body).toBe("Body.");
  });

  it("derives type from the directory, not from frontmatter", () => {
    const { node } = parseNodeSource("constraints/1A2B3C4D.md", "constraint", "Body.\n");
    expect(node?.type).toBe("constraint");
  });

  it("silently ignores unknown frontmatter fields", () => {
    const { node, issues } = parseNodeSource(
      "premises/1A2B3C4D.md",
      "premise",
      "---\nsource: somewhere\ncustom: [1, 2]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.body).toBe("Body.");
  });

  it("omits grounds for a root constraint declared without the field", () => {
    const { node } = parseNodeSource("constraints/A1B2C3D4.md", "constraint", "Root decision.\n");
    expect(node?.grounds).toEqual([]);
  });

  it("deduplicates grounds while preserving order", () => {
    const { node, issues } = parseNodeSource(
      "constraints/A1B2C3D4.md",
      "constraint",
      "---\ngrounds: [B2C3D4E5, C3D4E5F6, B2C3D4E5]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual(["B2C3D4E5", "C3D4E5F6"]);
  });

  it("accepts an explicit empty grounds list", () => {
    const { node, issues } = parseNodeSource(
      "constraints/A1B2C3D4.md",
      "constraint",
      "---\ngrounds: []\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual([]);
  });

  it("normalizes CRLF line endings and a leading BOM", () => {
    const source = `\uFEFF---\r\ngrounds: []\r\n---\r\n\r\nFirst\r\nparagraph continues.\r\n\r\nRationale.\r\n`;
    const { node, issues } = parseNodeSource("constraints/A1B2C3D4.md", "constraint", source);
    expect(issues).toEqual([]);
    expect(node?.summary).toBe("First paragraph continues.");
    expect(node?.body).toBe("First\nparagraph continues.\n\nRationale.");
  });

  it("uses the first paragraph as summary, collapsing internal whitespace", () => {
    const { node } = parseNodeSource(
      "constraints/A1B2C3D4.md",
      "constraint",
      "Line one.\nLine two continues.\n\nRationale.\n",
    );
    expect(node?.summary).toBe("Line one. Line two continues.");
  });

  it("truncates long summaries with an ellipsis", () => {
    const longParagraph = "x".repeat(SUMMARY_MAX_LENGTH + 10);
    const { node } = parseNodeSource("constraints/A1B2C3D4.md", "constraint", `${longParagraph}\n`);
    expect(node?.summary).toBe(`${"x".repeat(SUMMARY_MAX_LENGTH)}...`);
    expect(node?.summary).toHaveLength(SUMMARY_MAX_LENGTH + 3);
  });

  it("reports INVALID_FRONTMATTER for broken YAML", () => {
    const { node, issues } = parseNodeSource(
      "constraints/A1B2C3D4.md",
      "constraint",
      "---\ngrounds: [unclosed\n---\n\nBody.\n",
    );
    expect(node).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(["INVALID_FRONTMATTER"]);
  });

  it("reports INVALID_FRONTMATTER when the frontmatter is not a mapping", () => {
    const { issues } = parseNodeSource(
      "constraints/A1B2C3D4.md",
      "constraint",
      "---\n- a\n- b\n---\n\nBody.\n",
    );
    expect(issues.map((i) => i.code)).toEqual(["INVALID_FRONTMATTER"]);
  });

  it.each([
    ["an id that is too short", "constraints/A1B2C3D.md", "Body.\n", "INVALID_ID"],
    ["an id with excluded characters", "constraints/AIB2C3D4.md", "Body.\n", "INVALID_ID"],
    ["an old-style prefixed id", "constraints/C-001.md", "Body.\n", "INVALID_ID"],
    [
      "premise with grounds",
      "premises/1A2B3C4D.md",
      "---\ngrounds: [A1B2C3D4]\n---\n\nBody.\n",
      "PREMISE_WITH_GROUNDS",
    ],
    [
      "grounds not a list",
      "constraints/A1B2C3D4.md",
      "---\ngrounds: B2C3D4E5\n---\n\nBody.\n",
      "INVALID_GROUNDS",
    ],
    [
      "grounds entry not a string",
      "constraints/A1B2C3D4.md",
      "---\ngrounds: [3]\n---\n\nBody.\n",
      "INVALID_GROUNDS",
    ],
  ])("rejects %s", (_label, file, source, code) => {
    const expectedType = file.startsWith("premises/") ? "premise" : "constraint";
    const { issues } = parseNodeSource(file, expectedType, source);
    expect(issues.map((i) => i.code)).toEqual([code]);
  });
});

describe("extractSummary", () => {
  it("does not truncate summaries within the limit", () => {
    expect(extractSummary("short")).toBe("short");
  });
});
