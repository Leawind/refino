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
 */
export function renderNodeTable(
  rows: ReadonlyArray<{ id: string; type: string; summary: string; depth?: number }>,
): string {
  const withDepth = rows.some((r) => r.depth !== undefined);
  const idWidth = Math.max(...rows.map((r) => r.id.length), 2);
  const typeWidth = Math.max(...rows.map((r) => r.type.length), 2);
  const depthWidth = Math.max(...rows.map((r) => String(r.depth ?? "").length), 2);
  return rows
    .map((r) => {
      const head = `${r.id.padEnd(idWidth)}  ${r.type.padEnd(typeWidth)}  `;
      const depthCol = withDepth ? `${String(r.depth ?? "").padEnd(depthWidth)}  ` : "";
      return `${head}${depthCol}${truncate(r.summary, 80)}`;
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

/** Compact single-line identity, e.g. `constraints(id=E5F6G7H8, grounds=[...])`. */
export function renderNodeHeading(node: { id: string; type: string; grounds?: string[] }): string {
  const parts = [`id=${node.id}`];
  if (node.type === "constraint") parts.push(`grounds=[${(node.grounds ?? []).join(", ")}]`);
  return `${node.type}s(${parts.join(", ")})`;
}

/**
 * Full human-readable record: heading line, labeled attributes, then the
 * body. Optional attributes (rationale, confirmed) only occupy a line when
 * present, mirroring the JSON shape.
 */
export function renderFullRecord(node: {
  id: string;
  type: string;
  summary: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
  body: string;
}): string {
  const lines = [renderNodeHeading(node), `summary: ${node.summary}`];
  if (node.rationale !== undefined) lines.push(`rationale: ${node.rationale}`);
  if (node.confirmed !== undefined) lines.push(`confirmed: ${node.confirmed}`);
  return `${lines.join("\n")}\n\n${node.body}`;
}
