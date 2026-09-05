import { parse as parseYaml } from "yaml";
import {
  IssueCode,
  type ConstraintNode,
  type NodeType,
  type PremiseNode,
  type RefinoNode,
} from "refino";
import { StorageIssueCode, type StorageIssue } from "./codes.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const EMPTY_FRONTMATTER_RE = /^---\n---(?:\n|$)/;

export const SUMMARY_MAX_LENGTH = 100;

export interface ParseResult {
  /** The parsed node, or null when the frontmatter could not be parsed. */
  node: RefinoNode | null;
  issues: StorageIssue[];
  /**
   * Whether the summary came from an explicit "summary" frontmatter field.
   * When false, `node.summary` was derived from the body; write paths use
   * this to avoid materializing a derived summary into the file.
   */
  summaryExplicit: boolean;
}

/**
 * Parse one node file into a node object.
 *
 * `id` is derived by the loader from the file path (path is identity). `file`
 * is the `.refino`-relative path in either separator style, normalized to the
 * canonical forward-slash form; it exists only to attribute issues to the
 * file — nodes carry no paths. A file without frontmatter is a valid node
 * with no fields. The summary comes from the "summary" frontmatter field,
 * falling back to the first paragraph of the body via `extractSummary`.
 */
export function parseNodeSource(
  id: string,
  file: string,
  expectedType: NodeType,
  source: string,
): ParseResult {
  const issues: StorageIssue[] = [];
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const canonicalFile = file.replace(/\\/g, "/");

  let fields: Record<string, unknown> = {};
  const match = FRONTMATTER_RE.exec(normalized) ?? EMPTY_FRONTMATTER_RE.exec(normalized);
  if (match) {
    const parsed = parseFrontmatter(canonicalFile, match[1] ?? "", issues);
    if (!parsed) return { node: null, issues, summaryExplicit: false };
    fields = parsed;
  }

  const body = match ? normalized.slice(match[0].length).trim() : normalized.trim();

  // The summary is an independent attribute (docs/crg.md). A "summary"
  // frontmatter field takes precedence; the first-paragraph fallback keeps
  // summary-less files readable.
  const summaryField = fields["summary"];
  let summary: string;
  let summaryExplicit = false;
  if (summaryField === undefined || summaryField === null) {
    summary = extractSummary(body);
  } else if (typeof summaryField === "string" && summaryField.trim() !== "") {
    summary = summaryField;
    summaryExplicit = true;
  } else {
    issues.push({
      code: StorageIssueCode.InvalidFrontmatter,
      message: '"summary" must be a non-empty string.',
      file: canonicalFile,
      nodeId: id,
    });
    summary = extractSummary(body);
  }

  const base = { id, summary, body };
  const node: RefinoNode =
    expectedType === "premise"
      ? parsePremise(base, fields, canonicalFile, id, issues)
      : parseConstraint(base, fields, canonicalFile, id, issues);

  return { node, issues, summaryExplicit };
}

/**
 * Premise fields: `confirmed`. A declared `grounds` is a misplaced attribute
 * (edges only come from constraint grounds) and is silently ignored, like any
 * unknown frontmatter field — no issue is reported.
 */
function parsePremise(
  base: { id: string; summary: string; body: string },
  fields: Record<string, unknown>,
  file: string,
  id: string,
  issues: StorageIssue[],
): PremiseNode {
  const node: PremiseNode = { ...base, type: "premise" };
  const confirmed = fields["confirmed"];
  if (confirmed !== undefined && confirmed !== null) {
    if (typeof confirmed === "string" && confirmed.trim() === confirmed && confirmed !== "") {
      node.confirmed = confirmed;
    } else {
      issues.push({
        code: IssueCode.InvalidConfirmed,
        message: '"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset.',
        file,
        nodeId: id,
      });
    }
  }
  return node;
}

/** Constraint fields: `grounds` (absent -> []) and `rationale`. */
function parseConstraint(
  base: { id: string; summary: string; body: string },
  fields: Record<string, unknown>,
  file: string,
  id: string,
  issues: StorageIssue[],
): ConstraintNode {
  const node: ConstraintNode = { ...base, type: "constraint", grounds: [] };
  const grounds = parseGrounds(file, id, fields["grounds"], issues);
  if (grounds) node.grounds = grounds;
  const rationale = fields["rationale"];
  if (rationale !== undefined && rationale !== null) {
    if (typeof rationale === "string") {
      node.rationale = rationale;
    } else {
      issues.push({
        code: StorageIssueCode.InvalidFrontmatter,
        message: '"rationale" must be a string.',
        file,
        nodeId: id,
      });
    }
  }
  return node;
}

function parseFrontmatter(
  file: string,
  yaml: string,
  issues: StorageIssue[],
): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (error) {
    issues.push({
      code: StorageIssueCode.InvalidFrontmatter,
      message: `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      file,
    });
    return null;
  }
  if (data === null || data === undefined) return {}; // empty frontmatter block
  if (typeof data !== "object" || Array.isArray(data)) {
    issues.push({
      code: StorageIssueCode.InvalidFrontmatter,
      message: "Frontmatter must be a YAML mapping.",
      file,
    });
    return null;
  }
  return data as Record<string, unknown>;
}

function parseGrounds(
  file: string,
  nodeId: string,
  value: unknown,
  issues: StorageIssue[],
): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({
      code: IssueCode.InvalidGrounds,
      message: `"grounds" must be a list of node ids, got ${JSON.stringify(value)}.`,
      file,
      nodeId,
    });
    return undefined;
  }
  const grounds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() !== entry || entry.length === 0) {
      issues.push({
        code: IssueCode.InvalidGrounds,
        message: `"grounds" entries must be non-empty strings, got ${JSON.stringify(entry)}.`,
        file,
        nodeId,
      });
      return undefined;
    }
    if (!grounds.includes(entry)) grounds.push(entry);
  }
  return grounds;
}

/**
 * Fallback summary rule: first paragraph of the body, whitespace-collapsed to
 * a single line, truncated with an ellipsis when longer than
 * `SUMMARY_MAX_LENGTH`. The truncation applies to the fallback only; explicit
 * "summary" fields and node bodies are never length-limited.
 */
export function extractSummary(body: string): string {
  const firstBlock = body.split(/\n[ \t]*\n/, 1)[0] ?? "";
  const collapsed = firstBlock.replace(/\s+/g, " ").trim();
  if (collapsed.length > SUMMARY_MAX_LENGTH) {
    return `${collapsed.slice(0, SUMMARY_MAX_LENGTH)}...`;
  }
  return collapsed;
}
