import type { RefinoIssue } from "refino";
import type { StorageIssue } from "@refino/storage";

/** Output sinks injected into `main` so tests can capture output in-process. */
export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export const processIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

/**
 * One line per node: `id  type  [depth]  summary`, columns aligned across the
 * batch. The depth column appears only when at least one row carries a depth.
 * A row marked `exploring` (the derived effective status, never the stored
 * mark alone) prefixes the summary with `[探索]`.
 */
export function renderNodeTable(
  rows: ReadonlyArray<{
    id: string;
    type: string;
    summary: string;
    depth?: number;
    exploring?: boolean;
  }>,
): string {
  const withDepth = rows.some((r) => r.depth !== undefined);
  const idWidth = Math.max(...rows.map((r) => r.id.length), 2);
  const typeWidth = Math.max(...rows.map((r) => r.type.length), 2);
  const depthWidth = Math.max(...rows.map((r) => String(r.depth ?? "").length), 2);
  return rows
    .map((r) => {
      const head = `${r.id.padEnd(idWidth)}  ${r.type.padEnd(typeWidth)}  `;
      const depthCol = withDepth ? `${String(r.depth ?? "").padEnd(depthWidth)}  ` : "";
      const mark = r.exploring === true ? "[探索] " : "";
      return `${head}${depthCol}${mark}${truncate(r.summary, 80)}`;
    })
    .join("\n");
}

export function renderIssues(issues: ReadonlyArray<RefinoIssue | StorageIssue>): string {
  return issues
    .map((issue) => {
      // File paths are persistence vocabulary: only storage-raised issues
      // carry one; engine issues locate by node id.
      const file = "file" in issue ? issue.file : undefined;
      return `[${issue.code}] ${issue.message}${file ? ` (${file})` : ""}`;
    })
    .join("\n");
}

/** Compact single-line identity, e.g. `decisions(id=E5F6G7H8, grounds=[...])`. */
export function renderNodeHeading(node: { id: string; type: string; grounds?: string[] }): string {
  const parts = [`id=${node.id}`];
  if (node.type === "decision") parts.push(`grounds=[${(node.grounds ?? []).join(", ")}]`);
  return `${node.type}s(${parts.join(", ")})`;
}

/**
 * Full human-readable record: heading line, labeled attributes, then the
 * body. Optional attributes (rationale, confirmed, exploring) only occupy a
 * line when present, mirroring the JSON shape. Confirmed is stored as epoch
 * milliseconds and rendered in its RFC 3339 (UTC) form. The exploring line
 * shows the stored trial mark, or the derived effective status (no stored
 * mark but an exploring ground) when `effective` says so.
 */
export function renderFullRecord(
  node: {
    id: string;
    type: string;
    summary: string;
    grounds?: string[];
  },
  content?: { body?: string; rationale?: string },
  effective?: boolean,
): string {
  const lines = [renderNodeHeading(node), `summary: ${node.summary}`];
  if (content?.rationale !== undefined) lines.push(`rationale: ${content.rationale}`);
  const record = node as { confirmed?: number; exploring?: boolean };
  if (record.confirmed !== undefined) {
    lines.push(`confirmed: ${new Date(record.confirmed).toISOString()}`);
  }
  if (record.exploring === true) lines.push("exploring: true");
  else if (effective === true) lines.push("exploring: true (derived)");
  return `${lines.join("\n")}\n\n${content?.body ?? ""}`;
}
