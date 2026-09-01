import { parse as parseYaml } from "yaml";
import type { NodeType, RefinoIssue, RefinoNode } from "./types.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export interface ParseResult {
  /** The parsed node, or null when id/type could not be established. */
  node: RefinoNode | null;
  issues: RefinoIssue[];
}

/**
 * Parse one node file from its markdown source.
 *
 * `expectedType` comes from the storage layout: files under `.refino/premises/`
 * are expected to be premises, `.refino/constraints/` constraints. The node's
 * own `type` frontmatter field must agree with it.
 */
export function parseNodeSource(file: string, expectedType: NodeType, source: string): ParseResult {
  const issues: RefinoIssue[] = [];
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) {
    issues.push({
      code: "MISSING_FRONTMATTER",
      message: "File does not start with a YAML frontmatter block (--- ... ---).",
      file,
    });
    return { node: null, issues };
  }

  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (error) {
    issues.push({
      code: "INVALID_FRONTMATTER",
      message: `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      file,
    });
    return { node: null, issues };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    issues.push({
      code: "INVALID_FRONTMATTER",
      message: "Frontmatter must be a YAML mapping.",
      file,
    });
    return { node: null, issues };
  }
  const fields = data as Record<string, unknown>;

  const id = fields["id"];
  if (id === undefined || id === null) {
    issues.push({ code: "MISSING_ID", message: 'Frontmatter is missing the "id" field.', file });
    return { node: null, issues };
  }
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    issues.push({
      code: "INVALID_ID",
      message: `"id" must be a non-empty string without surrounding whitespace.`,
      file,
    });
    return { node: null, issues };
  }

  const type = fields["type"];
  if (type === undefined || type === null) {
    issues.push({
      code: "MISSING_TYPE",
      message: 'Frontmatter is missing the "type" field.',
      file,
      nodeId: id,
    });
    return { node: null, issues };
  }
  if (type !== "premise" && type !== "constraint") {
    issues.push({
      code: "INVALID_TYPE",
      message: `"type" must be "premise" or "constraint", got ${JSON.stringify(type)}.`,
      file,
      nodeId: id,
    });
    return { node: null, issues };
  }
  if (type !== expectedType) {
    issues.push({
      code: "TYPE_DIR_MISMATCH",
      message: `Node of type "${type}" is stored under .refino/${expectedType === "premise" ? "premises" : "constraints"}/.`,
      file,
      nodeId: id,
    });
    return { node: null, issues };
  }

  let grounds: string[] | undefined;
  if (type === "premise") {
    if (fields["grounds"] !== undefined && fields["grounds"] !== null) {
      issues.push({
        code: "PREMISE_WITH_GROUNDS",
        message: 'Premise nodes must not declare "grounds".',
        file,
        nodeId: id,
      });
    }
  } else {
    grounds = parseGrounds(file, id, fields["grounds"], issues);
  }

  const body = normalized.slice(match[0].length).trim();
  const summary = extractSummary(body);

  const node: RefinoNode = { id, type, file, summary, body };
  if (grounds) node.grounds = grounds;
  return { node, issues };
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

/** First paragraph of the body, whitespace-collapsed to a single line. */
function extractSummary(body: string): string {
  const firstBlock = body.split(/\n[ \t]*\n/, 1)[0] ?? "";
  return firstBlock.replace(/\s+/g, " ").trim();
}
