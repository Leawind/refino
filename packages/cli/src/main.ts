import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConstraint,
  createPremise,
  deleteNode,
  loadGraph,
  nodeRelativeFile,
  readNode,
  updateConstraint,
  updatePremise,
} from "@refino/storage";
import { CommanderError, Command, Option } from "commander";
import {
  assignLayers,
  checkGroundsChange,
  generateId,
  getAncestors,
  getDependents,
  getGrounds,
  ID_RE,
  isValidConfirmed,
  queryGroups,
  RefinoError,
  requireNode,
  validateGraph,
} from "refino";
import type { Graph, NodeWithDepth, QueryGroup, RefinoIssue, RefinoNode } from "refino";
import { processIo, renderFullRecord, renderIssues, renderNodeTable } from "./format.js";
import type { CliIo } from "./format.js";
import { startWebServer } from "./web/server.js";

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
    .addOption(new Option("--unreferenced", "list only premises that no constraint grounds on"))
    .action((_opts, cmd) =>
      run(cmd, async (opts) => {
        const { type: typeFilter, unreferenced } = cmd.opts() as {
          type?: "premise" | "constraint";
          unreferenced?: boolean;
        };
        if (unreferenced && typeFilter === "constraint") {
          io.stderr.write("error: --unreferenced only applies to premises\n");
          return 1;
        }
        const { graph, issues } = await loadGraph(refinoDir(opts));
        if (issues.length > 0) return reportBlockingIssues(io, opts, issues);
        let nodes = sortNodes(graph);
        if (typeFilter) nodes = nodes.filter((n) => n.type === typeFilter);
        if (unreferenced) {
          const referenced = new Set<string>();
          for (const node of graph.nodes.values()) {
            if (node.type !== "constraint") continue;
            for (const ground of node.grounds ?? []) referenced.add(ground);
          }
          nodes = nodes.filter((n) => n.type === "premise" && !referenced.has(n.id));
        }
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
          const groups = queryGroups(graph, ids, (graph, id) => [requireNode(graph, id)]);
          const missing = groups.some((group) => "error" in group);
          if (opts.json) {
            emit(
              io,
              groups.map((group) =>
                "error" in group
                  ? group
                  : { id: group.id, results: group.results.map(fullNodeJson) },
              ),
            );
          } else {
            io.stdout.write(
              `${groups
                .map((group) =>
                  "error" in group ? `error: ${group.error}` : renderFullRecord(group.results[0]!),
                )
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
          const { missing } = emitGroupedNodes(io, opts, queryGroups(graph, ids, getGrounds));
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
          const { missing } = emitGroupedDepths(io, opts, queryGroups(graph, ids, getAncestors));
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
          const { missing } = emitGroupedDepths(io, opts, queryGroups(graph, ids, getDependents));
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
        .option("--id <text>", "explicit node id (3-16 characters: A-Z, 0-9, _)")
        .requiredOption("--body <text>", "fact content (markdown body)")
        .option("--summary <text>", "short summary for relevance checks (stored in frontmatter)")
        .option("--confirmed <timestamp>", "RFC 3339 timestamp with an explicit UTC offset")
        .option("--now", 'confirm now: use the current UTC time as "confirmed"')
        .action((_opts, cmd) =>
          run(cmd, async (opts) => {
            const { id, body, summary, confirmed, now } = cmd.opts() as {
              id?: string;
              body: string;
              summary?: string;
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
              summary,
              confirmed: now ? new Date().toISOString() : confirmed,
            });
            emitWritten(io, opts, newId, "premise", "created");
            return 0;
          }),
        ),
    )
    .addCommand(
      new Command("constraint")
        .description("create a constraint node")
        .option("--id <text>", "explicit node id (3-16 characters: A-Z, 0-9, _)")
        .requiredOption("--body <text>", "decision content (markdown body)")
        .option("--grounds <ids>", "comma-separated ground node ids")
        .option("--rationale <text>", "why the decision was made")
        .option("--summary <text>", "short summary for relevance checks (stored in frontmatter)")
        .action((_opts, cmd) =>
          run(cmd, async (opts) => {
            const { id, body, grounds, rationale, summary } = cmd.opts() as {
              id?: string;
              body: string;
              grounds?: string;
              rationale?: string;
              summary?: string;
            };
            const groundIds = (grounds ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            const invalidGround = groundIds.find((g) => !ID_RE.test(g));
            if (invalidGround !== undefined) {
              io.stderr.write(
                `error: invalid ground id "${invalidGround}" (must be 3-16 characters of A-Z, 0-9 or _)\n`,
              );
              return 1;
            }
            // Graph-level grounds check before anything is written, via the
            // engine's shared write-path primitive. Pre-existing parse issues
            // elsewhere in the graph must not block creation.
            const graph = await loadGraphForWrite(refinoDir(opts));
            const probeId = id ?? freshProbeId(graph);
            const groundIssues = checkGroundsChange(
              withPhantomConstraint(graph, probeId, groundIds),
              probeId,
              groundIds,
            );
            if (groundIssues.length > 0) {
              io.stderr.write(`${renderIssues(groundIssues)}\n`);
              return 1;
            }
            const newId = await createConstraint(refinoDir(opts), {
              id,
              body,
              grounds: groundIds.length > 0 ? groundIds : undefined,
              rationale,
              summary,
            });
            emitWritten(io, opts, newId, "constraint", "created");
            return 0;
          }),
        ),
    );

  program
    .command("update")
    .description("update fields of an existing node; unspecified fields keep their current value")
    .argument("<id>", "node id")
    .option("--body <text>", "new content (markdown body)")
    .option("--summary <text>", "short summary for relevance checks (stored in frontmatter)")
    .option("--rationale <text>", "why the decision was made (constraints only)")
    .option(
      "--grounds <ids>",
      "comma-separated ground node ids, replacing the whole list (constraints only)",
    )
    .option(
      "--confirmed <timestamp>",
      "RFC 3339 timestamp with an explicit UTC offset (premises only)",
    )
    .option("--now", 'confirm now: use the current UTC time as "confirmed" (premises only)')
    .action((id: string, _opts, cmd) =>
      run(cmd, async (opts) => {
        const o = cmd.opts() as {
          body?: string;
          summary?: string;
          rationale?: string;
          grounds?: string;
          confirmed?: string;
          now?: boolean;
        };
        const dir = refinoDir(opts);

        const typeOptions = [o.rationale, o.grounds, o.confirmed, o.now];
        const touched = [o.body, o.summary, ...typeOptions].filter(
          (v) => v !== undefined && v !== false,
        );
        if (touched.length === 0) {
          io.stderr.write("error: specify at least one field to update\n");
          return 1;
        }

        const read = await readNode(dir, id);
        if (read.node === null) {
          io.stderr.write(`error: node "${id}" not found\n`);
          return 1;
        }
        const node = read.node;

        if (node.type === "premise" && (o.rationale !== undefined || o.grounds !== undefined)) {
          io.stderr.write("error: premises do not support --rationale or --grounds\n");
          return 1;
        }
        if (node.type === "constraint" && (o.confirmed !== undefined || o.now === true)) {
          io.stderr.write("error: constraints do not support --confirmed or --now\n");
          return 1;
        }
        if (o.now === true && o.confirmed !== undefined) {
          io.stderr.write("error: --now and --confirmed are mutually exclusive\n");
          return 1;
        }
        if (o.summary !== undefined && o.summary.trim() === "") {
          io.stderr.write("error: --summary must be a non-empty string\n");
          return 1;
        }
        if (o.confirmed !== undefined && !isValidConfirmed(o.confirmed)) {
          io.stderr.write(
            `error: "confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${o.confirmed}"\n`,
          );
          return 1;
        }

        let grounds: string[] | undefined;
        if (o.grounds !== undefined) {
          grounds = (o.grounds ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const invalidGround = grounds.find((g) => !ID_RE.test(g));
          if (invalidGround !== undefined) {
            io.stderr.write(
              `error: invalid ground id "${invalidGround}" (must be 3-16 characters of A-Z, 0-9 or _)\n`,
            );
            return 1;
          }
          // The node exists here, so the shared write-path primitive applies
          // directly; pre-existing issues elsewhere must not block the update.
          const graph = await loadGraphForWrite(dir);
          const groundIssues = checkGroundsChange(graph, id, grounds);
          if (groundIssues.length > 0) {
            io.stderr.write(`${renderIssues(groundIssues)}\n`);
            return 1;
          }
        }

        // Partial update: unspecified fields keep their current value. A
        // summary that was derived from the body stays derived (not passed),
        // so updating the body keeps the fallback in sync.
        const summary =
          o.summary !== undefined
            ? o.summary
            : read.summaryExplicit === true
              ? node.summary
              : undefined;
        if (node.type === "premise") {
          await updatePremise(dir, id, {
            body: o.body ?? node.body,
            summary,
            confirmed: o.now === true ? new Date().toISOString() : (o.confirmed ?? node.confirmed),
          });
        } else {
          await updateConstraint(dir, id, {
            body: o.body ?? node.body,
            summary,
            rationale: o.rationale ?? node.rationale,
            grounds: grounds ?? node.grounds,
          });
        }
        emitWritten(io, opts, id, node.type, "updated");
        return 0;
      }),
    );

  program
    .command("delete")
    .description("delete one or more nodes; refuses while other nodes ground on the target")
    .argument("<ids...>", "node ids")
    .option("--force", "delete even when other nodes ground on the target")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) => {
        const { force } = cmd.opts() as { force?: boolean };
        const dir = refinoDir(opts);
        // A write command: pre-existing issues elsewhere must not block it.
        const graph = await loadGraphForWrite(dir);
        const results: Array<{ id: string; error?: string }> = [];
        let failure = false;
        for (const id of ids) {
          const node = graph.nodes.get(id);
          if (node === undefined) {
            results.push({ id, error: `node "${id}" not found` });
            failure = true;
            continue;
          }
          // Direct dependents only: deleting is refused exactly when it would
          // leave dangling grounds behind (mirrors the web API's 409).
          const dependents = graph.dependents.get(id) ?? [];
          if (dependents.length > 0) {
            const detail = `grounded on by ${dependents.join(", ")}`;
            if (force !== true) {
              results.push({ id, error: `${detail} (use --force to delete anyway)` });
              failure = true;
              continue;
            }
            io.stderr.write(`warning: deleted "${id}" is still ${detail}\n`);
          }
          try {
            await deleteNode(dir, id);
            results.push({ id });
          } catch (error) {
            results.push({
              id,
              error: error instanceof Error ? error.message : String(error),
            });
            failure = true;
          }
        }
        if (opts.json) emit(io, results);
        else {
          io.stdout.write(
            `${results
              .map((r) => (r.error === undefined ? `deleted ${r.id}` : `error: ${r.error}`))
              .join("\n")}\n`,
          );
        }
        return failure ? 1 : 0;
      }),
    );

  program
    .command("web")
    .description("start the web UI server")
    .option("--host <ip>", "IP address to bind", "127.0.0.1")
    .option("--port <n>", "port to listen on", "5649")
    .action((_opts, cmd) =>
      run(cmd, async (opts) => {
        const { host, port } = cmd.opts() as { host: string; port: string };
        const portNumber = Number(port);
        if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
          io.stderr.write(`error: invalid port "${port}"\n`);
          return 1;
        }
        const { server, url } = await startWebServer({
          host,
          port: portNumber,
          refinoDir: refinoDir(opts),
        });
        io.stdout.write(`listening on ${url}\n`);
        return new Promise<number>((resolve) => {
          const shutdown = (): void => {
            server.close(() => resolve(0));
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
      }),
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

function emitWritten(
  io: CliIo,
  opts: GlobalOptions,
  id: string,
  type: "premise" | "constraint",
  verb: "created" | "updated",
): void {
  const file = nodeRelativeFile(type, id);
  if (opts.json) emit(io, { id, file });
  else io.stdout.write(`${verb} ${id} (${join(".refino", file)})\n`);
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
  groups: QueryGroup<RefinoNode>[],
): { missing: boolean } {
  const missing = groups.some((group) => "error" in group);
  if (opts.json) {
    emit(
      io,
      groups.map((group) =>
        "error" in group ? group : { id: group.id, results: group.results.map(nodeJson) },
      ),
    );
  } else if (groups.length === 1) {
    emitNodesOrError(io, opts, groups[0]!);
  } else {
    for (const group of groups) {
      io.stdout.write(`${group.id}:\n`);
      emitNodesOrError(io, opts, group);
    }
  }
  return { missing };
}

function emitNodesOrError(io: CliIo, opts: GlobalOptions, group: QueryGroup<RefinoNode>): void {
  if ("error" in group) {
    io.stdout.write(`error: ${group.error}\n`);
    return;
  }
  emitNodes(io, opts, group.results);
}

function emitGroupedDepths(
  io: CliIo,
  opts: GlobalOptions,
  groups: QueryGroup<NodeWithDepth>[],
): { missing: boolean } {
  const missing = groups.some((group) => "error" in group);
  if (opts.json) {
    emit(
      io,
      groups.map((group) =>
        "error" in group
          ? group
          : {
              id: group.id,
              results: group.results.map((r) => ({ ...nodeJson(r.node), depth: r.depth })),
            },
      ),
    );
  } else if (groups.length === 1) {
    emitDepthsOrError(io, opts, groups[0]!);
  } else {
    for (const group of groups) {
      io.stdout.write(`${group.id}:\n`);
      emitDepthsOrError(io, opts, group);
    }
  }
  return { missing };
}

function emitDepthsOrError(io: CliIo, opts: GlobalOptions, group: QueryGroup<NodeWithDepth>): void {
  if ("error" in group) {
    io.stdout.write(`error: ${group.error}\n`);
    return;
  }
  emitDepths(io, opts, group.results);
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

/**
 * Grounds check for a not-yet-persisted constraint. The shared primitive
 * requires the target to exist, so a phantom node is inserted into a copy of
 * the graph; a brand-new node has no dependents and cannot close a cycle, so
 * the check reduces to unknown/duplicate reference reporting.
 */
function withPhantomConstraint(graph: Graph, id: string, grounds: string[]): Graph {
  const nodes = new Map(graph.nodes);
  nodes.set(id, {
    id,
    type: "constraint",
    file: nodeRelativeFile("constraint", id),
    summary: "",
    body: "",
    grounds,
  });
  return { ...graph, nodes };
}

/** Fresh id for the phantom node of `withPhantomConstraint`. */
function freshProbeId(graph: Graph): string {
  let id = generateId();
  while (graph.nodes.has(id)) id = generateId();
  return id;
}

/**
 * Load the graph for a write command. A missing `.refino` directory is the
 * empty store, not an error: creating the first node must work.
 */
async function loadGraphForWrite(refinoDir: string): Promise<Graph> {
  try {
    return (await loadGraph(refinoDir)).graph;
  } catch (error) {
    if (error instanceof RefinoError && error.code === "REFINO_DIR_NOT_FOUND") {
      return { refinoDir, nodes: new Map(), dependents: new Map() };
    }
    throw error;
  }
}

function emit(io: CliIo, payload: unknown): void {
  // Compact: the primary JSON consumers are programs and agents.
  io.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(io: CliIo, error: unknown): number {
  io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

function refinoDir(opts: GlobalOptions): string {
  return join(opts.root, ".refino");
}

/** List order: upstream → downstream by longest-path layer (refino,
 * assignLayers), ties in id order for stable, readable output. */
function sortNodes(graph: Graph): RefinoNode[] {
  const layers = assignLayers([...graph.nodes.values()]);
  return [...graph.nodes.values()].sort((a, b) => {
    const byLayer = (layers.get(a.id) ?? 0) - (layers.get(b.id) ?? 0);
    return byLayer !== 0 ? byLayer : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
