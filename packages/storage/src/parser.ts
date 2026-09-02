import { parse as parseYaml } from "yaml";
import type { NodeType, RefinoIssue, RefinoNode } from "refino";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const EMPTY_FRONTMATTER_RE = /^---\n---(?:\n|$)/;

export const SUMMARY_MAX_LENGTH = 100;

export interface ParseResult {
  /** The parsed node, or null when the frontmatter could not be parsed. */
  node: RefinoNode | null;
  issues: RefinoIssue[];
}

/**
 * Parse one node file into a node object.
 *
 * `id` is derived by the loader from the file path (path is identity); `file`
 * is the `.refino`-relative path in either separator style, always stored in
 * the canonical forward-slash form. A file without frontmatter is a valid
 * node with no fields. The summary comes from the "summary" frontmatter
 * field, falling back to the first paragraph of the body via `extractSummary`.
 */
export function parseNodeSource(
  id: string,
  file: string,
  expectedType: NodeType,
  source: string,
): ParseResult {
  const issues: RefinoIssue[] = [];
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const canonicalFile = file.replace(/\\/g, "/");

  let fields: Record<string, unknown> = {};
  const match = FRONTMATTER_RE.exec(normalized) ?? EMPTY_FRONTMATTER_RE.exec(normalized);
  if (match) {
    const parsed = parseFrontmatter(canonicalFile, match[1] ?? "", issues);
    if (!parsed) return { node: null, issues };
    fields = parsed;
  }

  const body = match ? normalized.slice(match[0].length).trim() : normalized.trim();

  const node: RefinoNode = { id, type: expectedType, file: canonicalFile, summary: "", body };

  // The summary is an independent attribute (docs/crg.md). A "summary"
  // frontmatter field takes precedence; the first-paragraph fallback keeps
  // summary-less files readable.
  const summaryField = fields["summary"];
  if (summaryField === undefined || summaryField === null) {
    node.summary = extractSummary(body);
  } else if (typeof summaryField === "string" && summaryField.trim() !== "") {
    node.summary = summaryField;
  } else {
    issues.push({
      code: "INVALID_FRONTMATTER",
      message: '"summary" must be a non-empty string.',
      file: canonicalFile,
      nodeId: id,
    });
    node.summary = extractSummary(body);
  }

  if (expectedType === "premise") {
    if (fields["grounds"] !== undefined && fields["grounds"] !== null) {
      issues.push({
        code: "PREMISE_WITH_GROUNDS",
        message: 'Premise nodes must not declare "grounds".',
        file: canonicalFile,
        nodeId: id,
      });
    }
    const confirmed = fields["confirmed"];
    if (confirmed !== undefined && confirmed !== null) {
      if (typeof confirmed === "string" && confirmed.trim() === confirmed && confirmed !== "") {
        node.confirmed = confirmed;
      } else {
        issues.push({
          code: "INVALID_CONFIRMED",
          message: '"confirmed" must be an RFC 3339 timestamp with an explicit UTC offset.',
          file: canonicalFile,
          nodeId: id,
        });
      }
    }
  } else {
    const grounds = parseGrounds(canonicalFile, id, fields["grounds"], issues);
    if (grounds) node.grounds = grounds;
    const rationale = fields["rationale"];
    if (rationale !== undefined && rationale !== null) {
      if (typeof rationale === "string") {
        node.rationale = rationale;
      } else {
        issues.push({
          code: "INVALID_FRONTMATTER",
          message: '"rationale" must be a string.',
          file: canonicalFile,
          nodeId: id,
        });
      }
    }
  }

  return { node, issues };
}

function parseFrontmatter(
  file: string,
  yaml: string,
  issues: RefinoIssue[],
): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch (error) {
    issues.push({
      code: "INVALID_FRONTMATTER",
      message: `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      file,
    });
    return null;
  }
  if (data === null || data === undefined) return {}; // empty frontmatter block
  if (typeof data !== "object" || Array.isArray(data)) {
    issues.push({
      code: "INVALID_FRONTMATTER",
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
  issues: RefinoIssue[],
): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({
      code: "INVALID_GROUNDS",
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
        code: "INVALID_GROUNDS",
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
