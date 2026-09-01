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

/** One line per node: `id  type  summary`, columns aligned across the batch. */
export function renderNodeTable(
  rows: ReadonlyArray<{ id: string; type: string; summary: string }>,
): string {
  const idWidth = Math.max(...rows.map((r) => r.id.length), 2);
  const typeWidth = Math.max(...rows.map((r) => r.type.length), 2);
  return rows
    .map((r) => `${r.id.padEnd(idWidth)}  ${r.type.padEnd(typeWidth)}  ${truncate(r.summary, 80)}`)
    .join("\n");
}

export function renderIssues(
  issues: ReadonlyArray<{ code: string; message: string; file?: string }>,
): string {
  return issues
    .map((issue) => `[${issue.code}] ${issue.message}${issue.file ? ` (${issue.file})` : ""}`)
    .join("\n");
}
