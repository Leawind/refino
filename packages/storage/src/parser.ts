import { parse as parseYaml } from "yaml";
import {
  IssueCode,
  RefinoError,
  type DecisionNode,
  type NodeType,
  type PremiseNode,
  type RefinoNode,
} from "refino";
import { StorageIssueCode, type StorageIssue } from "./codes.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const EMPTY_FRONTMATTER_RE = /^---\n---(?:\n|$)/;

/** RFC 3339 timestamp; the UTC offset (Z or ±HH:MM) is mandatory. */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether the value is a timestamp in the file's RFC 3339 form. Timestamps in
 * frontmatter are persisted as RFC 3339, so both `confirmed` and `reviewed`
 * share this rule and the conversions below.
 */
export function isRfc3339(value: string): boolean {
  return RFC3339_RE.test(value);
}

/** The file's RFC 3339 form as epoch milliseconds; `undefined` when it is not a real instant. */
export function rfc3339ToMs(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Epoch milliseconds as the file's RFC 3339 form (UTC, Z offset). */
export function msToRfc3339(ms: number, field: string): string {
  if (!Number.isFinite(ms)) {
    throw new RefinoError(
      StorageIssueCode.InvalidTimestamp,
      `"${field}" must be a finite epoch-millisecond number, got ${ms}.`,
    );
  }
  return new Date(ms).toISOString();
}

/** A frontmatter timestamp in file form as epoch milliseconds, or undefined when it is not a valid instant. */
function parseTimestamp(value: string): number | undefined {
  return isRfc3339(value) ? rfc3339ToMs(value) : undefined;
}

/** Paged node content: everything that lives in the file but not in the engine's resident memory model. */
export interface NodeContent {
  /** Full body text (trimmed). */
  body: string;
  /** Why the decision was made; independent and optional, decisions only. */
  rationale?: string;
}

export const SUMMARY_MAX_LENGTH = 100;

export interface ParseResult {
  /** The parsed node, or null when the frontmatter could not be parsed. */
  node: RefinoNode | null;
  /** The node's paged content; undefined exactly when `node` is null. */
  content?: NodeContent;
  issues: StorageIssue[];
  /**
   * Whether the summary came from an explicit "summary" frontmatter field.
   * When false, `node.summary` was derived from the body; write paths use
   * this to avoid materializing a derived summary into the file.
   */
  summaryExplicit: boolean;
}

/**
 * Parse one node file into a resident node record plus its paged content.
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

  const content: NodeContent = {
    body: match ? normalized.slice(match[0].length).trim() : normalized.trim(),
  };

  // The summary is an independent attribute. A "summary"
  // frontmatter field takes precedence; the first-paragraph fallback keeps
  // summary-less files readable.
  const summaryField = fields["summary"];
  let summary: string;
  let summaryExplicit = false;
  if (summaryField === undefined || summaryField === null) {
    summary = extractSummary(content.body);
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
    summary = extractSummary(content.body);
  }

  const base = { id, summary };
  const node: RefinoNode =
    expectedType === "premise"
      ? parsePremise(base, fields, canonicalFile, issues)
      : parseDecision(base, fields, content, canonicalFile, issues);

  return { node, content, issues, summaryExplicit };
}

/**
 * Premise fields: `confirmed` as epoch milliseconds, converted from the
 * file's RFC 3339 form. A declared `grounds`, `exploring` or `reviewed` is a
 * misplaced attribute (edges and decision bookkeeping belong to decisions
 * only) and is silently ignored, like any unknown frontmatter field — no
 * issue is reported.
 */
function parsePremise(
  base: { id: string; summary: string },
  fields: Record<string, unknown>,
  file: string,
  issues: StorageIssue[],
): PremiseNode {
  const node: PremiseNode = { ...base, type: "premise" };
  const confirmed = fields["confirmed"];
  if (confirmed !== undefined && confirmed !== null) {
    const ms = typeof confirmed === "string" ? parseTimestamp(confirmed) : undefined;
    if (ms === undefined) {
      issues.push({
        code: StorageIssueCode.InvalidTimestamp,
        message: '"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset.',
        file,
        nodeId: base.id,
      });
    } else {
      node.confirmed = ms;
    }
  }
  return node;
}

/** Decision fields: `grounds` (absent -> []), `exploring` (only true marks), `reviewed`; `rationale` lands in the paged content. */
function parseDecision(
  base: { id: string; summary: string },
  fields: Record<string, unknown>,
  content: NodeContent,
  file: string,
  issues: StorageIssue[],
): DecisionNode {
  const node: DecisionNode = { ...base, type: "decision", grounds: [] };
  const grounds = parseGrounds(file, base.id, fields["grounds"], issues);
  if (grounds) node.grounds = grounds;
  const reviewed = fields["reviewed"];
  if (reviewed !== undefined && reviewed !== null) {
    const ms = typeof reviewed === "string" ? parseTimestamp(reviewed) : undefined;
    if (ms === undefined) {
      issues.push({
        code: StorageIssueCode.InvalidTimestamp,
        message: '"reviewed" must be an RFC 3339 timestamp with an explicit UTC offset.',
        file,
        nodeId: base.id,
      });
    } else {
      node.reviewed = ms;
    }
  }
  const exploring = fields["exploring"];
  if (exploring !== undefined && exploring !== null) {
    // Canonical form: only `true` is meaningful; an explicit false parses to
    // "no mark", identical to absence.
    if (exploring === true) node.exploring = true;
    else if (exploring !== false) {
      issues.push({
        code: StorageIssueCode.InvalidExploring,
        message: '"exploring" must be a boolean.',
        file,
        nodeId: base.id,
      });
    }
  }
  const rationale = fields["rationale"];
  if (rationale !== undefined && rationale !== null) {
    if (typeof rationale === "string") {
      content.rationale = rationale;
    } else {
      issues.push({
        code: StorageIssueCode.InvalidFrontmatter,
        message: '"rationale" must be a string.',
        file,
        nodeId: base.id,
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
