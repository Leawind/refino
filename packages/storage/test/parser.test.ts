import { describe, expect, it } from "vitest";
import { extractSummary, parseNodeSource, SUMMARY_MAX_LENGTH } from "../src/parser.js";
import { IssueCode } from "refino";
import { StorageIssueCode } from "../src/codes.js";

describe("parseNodeSource", () => {
  it("normalizes backslash paths to the canonical forward-slash form on issues", () => {
    const { issues } = parseNodeSource(
      "E5F6G7H8",
      "nodes\\E5\\F6G7H8-constraint.md",
      "constraint",
      "---\nsummary: 42\n---\n\nBody.\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("nodes/E5/F6G7H8-constraint.md");
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

    const { node, content, issues } = parseNodeSource(
      "E5F6G7H8",
      "nodes/E5/F6G7H8-constraint.md",
      "constraint",
      source,
    );
    expect(issues).toEqual([]);
    expect(node).toEqual({
      id: "E5F6G7H8",
      type: "constraint",
      summary: "实现必须通过 Repository 层。",
      grounds: ["1A2B3C4D", "D4E5F6G7"],
    });
    expect(content).toEqual({
      body: "实现必须通过 Repository 层。\n\n完整的推导与权衡过程。",
      rationale: "业务层不得直接依赖数据库。",
    });
  });

  it("accepts an empty frontmatter block", () => {
    const { node, content, issues } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      "---\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(content?.body).toBe("Body.");
    expect(node?.summary).toBe("Body.");
  });

  it("derives type from the caller, not from frontmatter", () => {
    const { node } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-constraint.md",
      "constraint",
      "Body.\n",
    );
    expect(node?.type).toBe("constraint");
  });

  it("silently ignores unknown frontmatter fields", () => {
    const { content, issues } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      "---\nsource: somewhere\ncustom: [1, 2]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(content?.body).toBe("Body.");
  });

  it("omits grounds for a root constraint declared without the field", () => {
    const { node } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "Root decision.\n",
    );
    expect(node?.grounds).toEqual([]);
  });

  it("deduplicates grounds while preserving order", () => {
    const { node, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\ngrounds: [B2C3D4E5, C3D4E5F6, B2C3D4E5]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual(["B2C3D4E5", "C3D4E5F6"]);
  });

  it("accepts an explicit empty grounds list", () => {
    const { node, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\ngrounds: []\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.grounds).toEqual([]);
  });

  it("normalizes CRLF line endings and a leading BOM", () => {
    const source = `\uFEFF---\r\ngrounds: []\r\n---\r\n\r\nFirst\r\nparagraph continues.\r\n\r\nRationale.\r\n`;
    const { node, content, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      source,
    );
    expect(issues).toEqual([]);
    expect(node?.summary).toBe("First paragraph continues.");
    expect(content?.body).toBe("First\nparagraph continues.\n\nRationale.");
  });

  it("uses the first paragraph as summary, collapsing internal whitespace", () => {
    const { node } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "Line one.\nLine two continues.\n\nRationale.\n",
    );
    expect(node?.summary).toBe("Line one. Line two continues.");
  });

  it("prefers an explicit summary frontmatter field over the first paragraph", () => {
    const { node, content, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      '---\nsummary: "Short relevance summary."\n---\n\nFirst paragraph that is not the summary.\n',
    );
    expect(issues).toEqual([]);
    expect(node?.summary).toBe("Short relevance summary.");
    expect(content?.body).toBe("First paragraph that is not the summary.");
  });

  it("accepts a summary frontmatter field on premise nodes", () => {
    const { node, issues } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      '---\nsummary: "PostgreSQL version fact."\n---\n\nLong fact body.\n',
    );
    expect(issues).toEqual([]);
    expect(node?.summary).toBe("PostgreSQL version fact.");
  });

  it("reports an issue and falls back for a non-string summary field", () => {
    const { node, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\nsummary: 42\n---\n\nFallback paragraph.\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: StorageIssueCode.InvalidFrontmatter });
    expect(node?.summary).toBe("Fallback paragraph.");
  });

  it("truncates long summaries with an ellipsis", () => {
    const longParagraph = "x".repeat(SUMMARY_MAX_LENGTH + 10);
    const { node } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      `${longParagraph}\n`,
    );
    expect(node?.summary).toBe(`${"x".repeat(SUMMARY_MAX_LENGTH)}...`);
    expect(node?.summary).toHaveLength(SUMMARY_MAX_LENGTH + 3);
  });

  it("reports INVALID_FRONTMATTER for broken YAML", () => {
    const { node, issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\ngrounds: [unclosed\n---\n\nBody.\n",
    );
    expect(node).toBeNull();
    expect(issues.map((i) => i.code)).toEqual([StorageIssueCode.InvalidFrontmatter]);
  });

  it("reports INVALID_FRONTMATTER when the frontmatter is not a mapping", () => {
    const { issues } = parseNodeSource(
      "A1B2C3D4",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\n- a\n- b\n---\n\nBody.\n",
    );
    expect(issues.map((i) => i.code)).toEqual([StorageIssueCode.InvalidFrontmatter]);
  });

  it("silently ignores grounds declared on a premise file", () => {
    const { node, issues } = parseNodeSource(
      "2B3C4D5E",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      "---\ngrounds: [A1B2C3D4]\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node).toEqual({ id: "2B3C4D5E", type: "premise", summary: "Body." });
  });

  it("converts a valid confirmed frontmatter field to epoch milliseconds", () => {
    const { node, issues } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      "---\nconfirmed: 2026-05-01T12:00:00+08:00\n---\n\nBody.\n",
    );
    expect(issues).toEqual([]);
    expect(node?.type).toBe("premise");
    expect(node).toMatchObject({ confirmed: Date.parse("2026-05-01T12:00:00+08:00") });
  });

  it.each([
    ["missing the UTC offset", "2026-05-01T12:00:00"],
    ["a date-only value", "2026-05-01"],
    ["not a timestamp", "yesterday"],
  ])("reports INVALID_CONFIRMED for confirmed %s", (_label, confirmed) => {
    const { node, issues } = parseNodeSource(
      "1A2B3C4D",
      "nodes/1A/2B3C4D-premise.md",
      "premise",
      `---\nconfirmed: ${confirmed}\n---\n\nBody.\n`,
    );
    expect(issues.map((i) => i.code)).toEqual([StorageIssueCode.InvalidConfirmed]);
    expect(node).toMatchObject({ id: "1A2B3C4D", type: "premise" });
    expect(node?.confirmed).toBeUndefined();
  });

  it.each([
    [
      "grounds not a list",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\ngrounds: B2C3D4E5\n---\n\nBody.\n",
      IssueCode.InvalidGrounds,
    ],
    [
      "grounds entry not a string",
      "nodes/A1/B2C3D4-constraint.md",
      "constraint",
      "---\ngrounds: [3]\n---\n\nBody.\n",
      IssueCode.InvalidGrounds,
    ],
  ])("rejects %s", (_label, file, expectedType, source, code) => {
    const id = file.split("/").pop()!.replace(/\.md$/, "");
    const { issues } = parseNodeSource(id, file, expectedType, source);
    expect(issues.map((i) => i.code)).toEqual([code]);
  });
});

describe("extractSummary", () => {
  it("does not truncate summaries within the limit", () => {
    expect(extractSummary("short")).toBe("short");
  });
});
