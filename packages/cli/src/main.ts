import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConstraint, createPremise, loadGraph } from "@refino/storage";
import { CommanderError, Command, Option } from "commander";
import { getAncestors, getDependents, getGrounds, ID_RE, RefinoError, validateGraph } from "refino";
import type { Graph, RefinoIssue, RefinoNode } from "refino";
import { processIo, renderIssues, renderNodeTable } from "./format.js";
import type { CliIo } from "./format.js";

export interface GlobalOptions {
  root: string;
  json: boolean;
}

/**
 * Entry point. Returns the process exit code instead of calling
 * `process.exit` so it can be exercised in tests.
 */
export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  let exitCode = 0;

  const program = new Command();
  program
    .name("refino")
    .description("Parse, validate and query a Constraint Refinement Graph stored in .refino/.")
    .version(readVersion())
    .option("--root <dir>", "project root directory containing .refino/", process.cwd())
    .option("--json", "emit machine-readable JSON on stdout", false)
    .configureOutput({
      writeOut: (text) => void io.stdout.write(text),
      writeErr: (text) => void io.stderr.write(text),
    })
    .exitOverride();

  /** Run an action with merged global options and capture its exit code. */
  const run = (cmd: Command, action: (opts: GlobalOptions) => Promise<number>): Promise<void> => {
    const opts = cmd.optsWithGlobals() as GlobalOptions;
    return action(opts).then(
      (code) => {
        exitCode = code;
      },
      (error: unknown) => {
        exitCode = fail(io, error);
      },
    );
  };

  program
    .command("validate")
    .description("build the graph and report all validation issues")
    .action((_opts, cmd) =>
      run(cmd, async (opts) => {
        const { graph, issues } = await loadGraph(refinoDir(opts));
        issues.push(...validateGraph(graph));
        const counts = countNodes(graph);
        if (opts.json) {
          emit(io, { ok: issues.length === 0, refinoDir: graph.refinoDir, counts, issues });
        } else if (issues.length > 0) {
          io.stdout.write(`${renderIssues(issues)}\n`);
        } else {
          io.stdout.write(
            `valid: ${counts.constraints} constraints, ${counts.premises} premises (${graph.refinoDir})\n`,
          );
        }
        return issues.length > 0 ? 1 : 0;
      }),
    );

  program
    .command("list")
    .description("list all nodes (id, type, summary)")
    .addOption(
      new Option("--type <type>", "only list nodes of this type").choices([
        "premise",
        "constraint",
      ]),
    )
    .action((_opts, cmd) =>
      run(cmd, async (opts) => {
        const typeFilter = (cmd.opts() as { type?: string }).type as
          "premise" | "constraint" | undefined;
        const { graph, issues } = await loadGraph(refinoDir(opts));
        if (issues.length > 0) return reportBlockingIssues(io, opts, issues);
        let nodes = sortNodes(graph);
        if (typeFilter) nodes = nodes.filter((n) => n.type === typeFilter);
        if (opts.json) {
          emit(io, nodes.map(nodeJson));
        } else if (nodes.length === 0) {
          io.stdout.write("(no nodes)\n");
        } else {
          io.stdout.write(`${renderNodeTable(nodes)}\n`);
        }
        return 0;
      }),
    );

  program
    .command("show")
    .description("print the full record of one or more nodes")
    .argument("<ids...>", "node ids")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) =>
        withGraph(io, opts, (graph) => {
          let missing = false;
          if (opts.json) {
            emit(
              io,
              ids.map((id) => {
                const node = graph.nodes.get(id);
                if (!node) {
                  missing = true;
                  return { id, error: notFound(id) };
                }
                return fullNodeJson(node);
              }),
            );
          } else {
            io.stdout.write(
              `${ids
                .map((id) => {
                  const node = graph.nodes.get(id);
                  if (!node) {
                    missing = true;
                    return `error: ${notFound(id)}`;
                  }
                  return `${renderNodeHeading(node)}\n\n${node.body}`;
                })
                .join("\n\n")}\n`,
            );
          }
          return missing ? 1 : 0;
        }),
      ),
    );

  program
    .command("grounds")
    .description("direct grounds of one or more nodes")
    .argument("<ids...>", "node ids")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) =>
        withGraph(io, opts, (graph) => {
          const { missing } = emitGroupedNodes(io, opts, ids, (id) =>
            graph.nodes.has(id) ? { results: getGrounds(graph, id) } : { error: notFound(id) },
          );
          return missing ? 1 : 0;
        }),
      ),
    );

  program
    .command("ancestors")
    .description("all nodes reachable by recursively following grounds")
    .argument("<ids...>", "node ids")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) =>
        withGraph(io, opts, (graph) => {
          const { missing } = emitGroupedDepths(io, opts, ids, (id) =>
            graph.nodes.has(id) ? { results: getAncestors(graph, id) } : { error: notFound(id) },
          );
          return missing ? 1 : 0;
        }),
      ),
    );

  program
    .command("dependents")
    .description("constraints potentially affected if these nodes change")
    .argument("<ids...>", "node ids")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) =>
        withGraph(io, opts, (graph) => {
          const { missing } = emitGroupedDepths(io, opts, ids, (id) =>
            graph.nodes.has(id) ? { results: getDependents(graph, id) } : { error: notFound(id) },
          );
          return missing ? 1 : 0;
        }),
      ),
    );

  program
    .command("new")
    .description("create a new node file in .refino/")
    .addCommand(
      new Command("premise")
        .description("create a premise node")
        .option("--id <text>", "explicit node id (8-character Crockford base32)")
        .requiredOption("--body <text>", "fact content (markdown body)")
        .option("--confirmed <timestamp>", "RFC 3339 timestamp with an explicit UTC offset")
        .option("--now", 'confirm now: use the current UTC time as "confirmed"')
        .action((_opts, cmd) =>
          run(cmd, async (opts) => {
            const { id, body, confirmed, now } = cmd.opts() as {
              id?: string;
              body: string;
              confirmed?: string;
              now?: boolean;
            };
            if (now && confirmed !== undefined) {
              io.stderr.write("error: --now and --confirmed are mutually exclusive\n");
              return 1;
            }
            const newId = await createPremise(refinoDir(opts), {
              id,
              body,
              confirmed: now ? new Date().toISOString() : confirmed,
            });
            emitCreated(io, opts, newId, "premise");
            return 0;
          }),
        ),
    )
    .addCommand(
      new Command("constraint")
        .description("create a constraint node")
        .option("--id <text>", "explicit node id (8-character Crockford base32)")
        .requiredOption("--body <text>", "decision content (markdown body)")
        .option("--grounds <ids>", "comma-separated ground node ids")
        .option("--rationale <text>", "why the decision was made")
        .action((_opts, cmd) =>
          run(cmd, async (opts) => {
            const { id, body, grounds, rationale } = cmd.opts() as {
              id?: string;
              body: string;
              grounds?: string;
              rationale?: string;
            };
            const groundIds = (grounds ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            const invalidGround = groundIds.find((g) => !ID_RE.test(g));
            if (invalidGround !== undefined) {
              io.stderr.write(
                `error: invalid ground id "${invalidGround}" (must be an 8-character Crockford base32 id)\n`,
              );
              return 1;
            }
            const newId = await createConstraint(refinoDir(opts), {
              id,
              body,
              grounds: groundIds.length > 0 ? groundIds : undefined,
              rationale,
            });
            emitCreated(io, opts, newId, "constraint");
            return 0;
          }),
        ),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof RefinoError) {
      io.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  return exitCode;
}

/** Load and structurally validate the graph, then run a query against it. */
async function withGraph(
  io: CliIo,
  opts: GlobalOptions,
  query: (graph: Graph) => number,
): Promise<number> {
  try {
    const { graph, issues } = await loadGraph(refinoDir(opts));
    issues.push(...validateGraph(graph));
    if (issues.length > 0) return reportBlockingIssues(io, opts, issues);
    return query(graph);
  } catch (error) {
    return fail(io, error);
  }
}

/** Graph issues make query results ambiguous, so queries refuse to run. */
function reportBlockingIssues(io: CliIo, opts: GlobalOptions, issues: RefinoIssue[]): number {
  if (opts.json) emit(io, { ok: false, issues });
  else io.stdout.write(`${renderIssues(issues)}\n`);
  return 1;
}

function emitCreated(
  io: CliIo,
  opts: GlobalOptions,
  id: string,
  type: "premise" | "constraint",
): void {
  const file = `nodes/${id.slice(0, 2)}/${id.slice(2)}.${type}.md`;
  if (opts.json) emit(io, { id, file });
  else io.stdout.write(`created ${id} (${join(".refino", file)})\n`);
}

function notFound(id: string): string {
  return `Node "${id}" not found`;
}

function emitNodes(io: CliIo, opts: GlobalOptions, nodes: RefinoNode[]): void {
  if (opts.json) {
    emit(io, nodes.map(nodeJson));
  } else if (nodes.length === 0) {
    io.stdout.write("(empty)\n");
  } else {
    io.stdout.write(`${renderNodeTable(nodes)}\n`);
  }
}

/**
 * Emit results of a batch query. JSON groups results under the queried id so
 * that overlapping results from different queries stay unambiguous; with a
 * single id the flat shape is kept. Unknown ids yield a per-id error entry
 * while results for the remaining ids are still emitted. Human-readable
 * output prints one section per queried id when batching.
 */
function emitGroupedNodes(
  io: CliIo,
  opts: GlobalOptions,
  ids: string[],
  select: (id: string) => { results: RefinoNode[] } | { error: string },
): { missing: boolean } {
  let missing = false;
  const resolve = (id: string): { results: RefinoNode[] } | { error: string } => {
    const selected = select(id);
    if ("error" in selected) missing = true;
    return selected;
  };
  if (opts.json) {
    emit(
      io,
      ids.map((id) => {
        const selected = resolve(id);
        return "error" in selected
          ? { id, error: selected.error }
          : { id, results: selected.results.map(nodeJson) };
      }),
    );
  } else if (ids.length === 1) {
    emitNodesOrError(io, opts, resolve(ids[0]!));
  } else {
    for (const id of ids) {
      io.stdout.write(`${id}:\n`);
      emitNodesOrError(io, opts, resolve(id));
    }
  }
  return { missing };
}

function emitNodesOrError(
  io: CliIo,
  opts: GlobalOptions,
  selected: { results: RefinoNode[] } | { error: string },
): void {
  if ("error" in selected) {
    io.stdout.write(`error: ${selected.error}\n`);
    return;
  }
  emitNodes(io, opts, selected.results);
}

function emitGroupedDepths(
  io: CliIo,
  opts: GlobalOptions,
  ids: string[],
  select: (
    id: string,
  ) => { results: ReadonlyArray<{ node: RefinoNode; depth: number }> } | { error: string },
): { missing: boolean } {
  let missing = false;
  const resolve = (
    id: string,
  ): { results: ReadonlyArray<{ node: RefinoNode; depth: number }> } | { error: string } => {
    const selected = select(id);
    if ("error" in selected) missing = true;
    return selected;
  };
  if (opts.json) {
    emit(
      io,
      ids.map((id) => {
        const selected = resolve(id);
        return "error" in selected
          ? { id, error: selected.error }
          : { id, results: selected.results.map((r) => ({ ...nodeJson(r.node), depth: r.depth })) };
      }),
    );
  } else if (ids.length === 1) {
    emitDepthsOrError(io, opts, resolve(ids[0]!));
  } else {
    for (const id of ids) {
      io.stdout.write(`${id}:\n`);
      emitDepthsOrError(io, opts, resolve(id));
    }
  }
  return { missing };
}

function emitDepthsOrError(
  io: CliIo,
  opts: GlobalOptions,
  selected: { results: ReadonlyArray<{ node: RefinoNode; depth: number }> } | { error: string },
): void {
  if ("error" in selected) {
    io.stdout.write(`error: ${selected.error}\n`);
    return;
  }
  emitDepths(io, opts, selected.results);
}

function emitDepths(
  io: CliIo,
  opts: GlobalOptions,
  results: ReadonlyArray<{ node: RefinoNode; depth: number }>,
): void {
  if (opts.json) {
    emit(
      io,
      results.map((r) => ({ ...nodeJson(r.node), depth: r.depth })),
    );
  } else if (results.length === 0) {
    io.stdout.write("(empty)\n");
  } else {
    io.stdout.write(`${renderNodeTable(results.map((r) => ({ ...r.node, depth: r.depth })))}\n`);
  }
}

function fullNodeJson(node: RefinoNode): Record<string, unknown> {
  return {
    ...nodeJson(node),
    body: node.body,
    ...(node.rationale !== undefined && { rationale: node.rationale }),
    ...(node.confirmed !== undefined && { confirmed: node.confirmed }),
  };
}

function nodeJson(node: RefinoNode): Record<string, unknown> {
  const base = { id: node.id, type: node.type, file: node.file, summary: node.summary };
  return node.type === "constraint" ? { ...base, grounds: node.grounds ?? [] } : base;
}

/** Compact single-line identity, e.g. `constraints(id=E5F6G7H8, grounds=[...])`. */
function renderNodeHeading(node: RefinoNode): string {
  const parts = [`id=${node.id}`];
  if (node.type === "constraint") parts.push(`grounds=[${(node.grounds ?? []).join(", ")}]`);
  return `${node.type}s(${parts.join(", ")})`;
}

function emit(io: CliIo, payload: unknown): void {
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(io: CliIo, error: unknown): number {
  io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

function refinoDir(opts: GlobalOptions): string {
  return join(opts.root, ".refino");
}

function sortNodes(graph: Graph): RefinoNode[] {
  return [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function countNodes(graph: Graph): { premises: number; constraints: number } {
  const counts = { premises: 0, constraints: 0 };
  for (const node of graph.nodes.values()) {
    if (node.type === "premise") counts.premises++;
    else counts.constraints++;
  }
  return counts;
}

function readVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(fileURLToPath(import.meta.url), "../../package.json"), "utf8"),
    ) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
