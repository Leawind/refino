import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  confirmedToMs,
  isValidConfirmed,
  nodeRelativeFile,
  type NodeContent,
} from "@refino/storage";
import { CommanderError, Command, Option } from "commander";
import {
  assignLayers,
  getAncestors,
  getDependents,
  getGrounds,
  ID_RE,
  queryGroups,
  RefinoError,
  requireNode,
} from "refino";
import type { Graph, NodeWithDepth, QueryGroup, RefinoNode } from "refino";
import { processIo, renderFullRecord, renderIssues, renderNodeTable } from "./format.js";
import type { CliIo } from "./format.js";
import { createDevCommand } from "./dev.js";
import { checkModification, type ModificationCheck } from "@refino/harness";
import { effectiveContext, resolveAuthorization } from "@refino/harness/state";
import { coveringFrontier, renderEscalation } from "./authorization.js";
import { frozenIds } from "./frozen.js";
import { createInitCommand } from "./commands/init.js";
import { createContextCommand } from "./commands/context.js";
import { createSearchCommand } from "./commands/search.js";
import { createPendingCommand } from "./commands/pending.js";
import { createAuthCommand } from "./commands/auth.js";
import { createGuideCommand, createSkillCommand } from "./commands/selfdoc.js";
import { emit, fail, refinoDir, withStore, withStoreForWrite } from "./shared.js";
import type { GlobalOptions } from "./shared.js";
import { DEFAULT_WEB_PORT, startWebServer } from "./web/server.js";

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
    .option(
      "--authorization <path>",
      "path to an orchestrator-signed authorization document (overrides workspace state)",
    )
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
      run(cmd, async (opts) =>
        withStore(io, opts, async (store) => {
          const issues = store.issues();
          const counts = countNodes(store.graph);
          if (opts.json) {
            emit(io, { ok: issues.length === 0, refinoDir: refinoDir(opts), counts, issues });
          } else if (issues.length > 0) {
            io.stdout.write(`${renderIssues(issues)}\n`);
          } else {
            io.stdout.write(
              `valid: ${counts.constraints} constraints, ${counts.premises} premises (${refinoDir(opts)})\n`,
            );
          }
          return issues.length > 0 ? 1 : 0;
        }),
      ),
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
      run(cmd, async (opts) =>
        withStore(io, opts, async (store) => {
          const { type: typeFilter, unreferenced } = cmd.opts() as {
            type?: "premise" | "constraint";
            unreferenced?: boolean;
          };
          if (unreferenced && typeFilter === "constraint") {
            io.stderr.write("error: --unreferenced only applies to premises\n");
            return 1;
          }
          const graph = store.graph;
          let nodes = sortNodes(graph);
          if (typeFilter) nodes = nodes.filter((n) => n.type === typeFilter);
          if (unreferenced) {
            const referenced = new Set<string>();
            for (const node of graph.nodes.values()) {
              if (node.type !== "constraint") continue;
              for (const ground of node.grounds) referenced.add(ground);
            }
            nodes = nodes.filter((n) => n.type === "premise" && !referenced.has(n.id));
          }
          const frozen = await frozenIds(graph, opts);
          if (opts.json) {
            emit(
              io,
              nodes.map((n) => nodeJson(n, frozen)),
            );
          } else if (nodes.length === 0) {
            io.stdout.write("(no nodes)\n");
          } else {
            io.stdout.write(`${renderNodeTable(nodes.map((n) => withFrozen(n, frozen)))}\n`);
          }
          return 0;
        }),
      ),
    );

  program
    .command("show")
    .description("print the full record of one or more nodes")
    .argument("<ids...>", "node ids")
    .action((ids: string[], _opts, cmd) =>
      run(cmd, async (opts) =>
        withStore(io, opts, async (store) => {
          const graph = store.graph;
          const groups = queryGroups(graph, ids, (graph, id) => [requireNode(graph, id)]);
          const missing = groups.some((group) => "error" in group);
          // Body and rationale are paged content: fetch them per id, since
          // the resident fields alone cannot render a full record.
          const contents = new Map<string, NodeContent>();
          for (const group of groups) {
            if ("error" in group) continue;
            const content = await store.content(group.id);
            if (content !== undefined) contents.set(group.id, content);
          }
          const frozen = await frozenIds(graph, opts);
          if (opts.json) {
            emit(
              io,
              groups.map((group) =>
                "error" in group
                  ? group
                  : {
                      id: group.id,
                      results: group.results.map((node) =>
                        fullNodeJson(node, contents.get(group.id), frozen),
                      ),
                    },
              ),
            );
          } else {
            io.stdout.write(
              `${groups
                .map((group) =>
                  "error" in group
                    ? `error: ${group.error}`
                    : renderFullRecord(
                        group.results[0]!,
                        contents.get(group.id),
                        frozen.has(group.id),
                      ),
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
        withStore(io, opts, async (store) => {
          const { missing } = emitGroupedNodes(
            io,
            opts,
            queryGroups(store.graph, ids, getGrounds),
            await frozenIds(store.graph, opts),
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
        withStore(io, opts, async (store) => {
          const { missing } = emitGroupedDepths(
            io,
            opts,
            queryGroups(store.graph, ids, getAncestors),
            await frozenIds(store.graph, opts),
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
        withStore(io, opts, async (store) => {
          const { missing } = emitGroupedDepths(
            io,
            opts,
            queryGroups(store.graph, ids, getDependents),
            await frozenIds(store.graph, opts),
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
            if (confirmed !== undefined && !isValidConfirmed(confirmed)) {
              io.stderr.write(
                `error: "confirmed" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got "${confirmed}"\n`,
              );
              return 1;
            }
            return withStoreForWrite(io, opts, async (store) => {
              const outcome = await store.createPremise({
                id,
                body,
                summary,
                confirmed:
                  now === true
                    ? Date.now()
                    : confirmed !== undefined
                      ? confirmedToMs(confirmed)
                      : undefined,
              });
              emitWritten(io, opts, outcome.id, "premise", "created");
              return 0;
            });
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
            return withStoreForWrite(io, opts, async (store) => {
              // Grounds validation runs inside the store's write method;
              // pre-existing parse issues elsewhere do not block creation.
              const outcome = await store.createConstraint({
                id,
                body,
                grounds: groundIds.length > 0 ? groundIds : undefined,
                rationale,
                summary,
              });
              emitWritten(io, opts, outcome.id, "constraint", "created");
              // Creation always lands in the modification space (new nodes
              // have no downstream), but a grounds-less constraint is a root:
              // under the default authorization it is frozen from the next
              // invocation on, so say so while the caller can still react.
              // JSON consumers get structured output only.
              if (groundIds.length === 0 && !opts.json) {
                const resolved = await resolveAuthorization(store.graph, opts);
                if (resolved.source === "default") {
                  io.stdout.write(
                    'notice: created a root constraint; under the default authorization root constraints are frozen — re-sign via "refino auth apply" to modify it later\n',
                  );
                }
              }
              return 0;
            });
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

        const typeOptions = [o.rationale, o.grounds, o.confirmed, o.now];
        const touched = [o.body, o.summary, ...typeOptions].filter(
          (v) => v !== undefined && v !== false,
        );
        if (touched.length === 0) {
          io.stderr.write("error: specify at least one field to update\n");
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

        return withStoreForWrite(io, opts, async (store) => {
          const entry = store.entry(id);
          if (entry === undefined) {
            io.stderr.write(`error: node "${id}" not found\n`);
            return 1;
          }
          // The frozen zone is enforced on the write path itself: a target
          // inside it is refused with a structured escalation report, no
          // matter how the command was invoked.
          const resolved = await resolveAuthorization(store.graph, opts);
          const check = checkModification(store.graph, effectiveContext(store.graph, resolved), id);
          if (!check.allowed) {
            renderEscalation(store.graph, resolved, check, io, opts.json);
            return 1;
          }
          const node = entry.node;
          const content = (await store.content(id)) ?? { body: "" };

          // Partial update: unspecified fields keep their current value. A
          // summary that was derived from the body stays derived (not
          // passed), so updating the body keeps the fallback in sync.
          // Options that do not apply to the node's type are misplaced
          // attributes and silently ignored (docs/design.md, "存储格式容错").
          const summary =
            o.summary !== undefined ? o.summary : entry.summaryExplicit ? node.summary : undefined;
          if (node.type === "premise") {
            if (o.now === true && o.confirmed !== undefined) {
              io.stderr.write("error: --now and --confirmed are mutually exclusive\n");
              return 1;
            }
            await store.updatePremise(id, {
              body: o.body ?? content.body,
              summary,
              confirmed:
                o.now === true
                  ? Date.now()
                  : o.confirmed !== undefined
                    ? confirmedToMs(o.confirmed)
                    : node.confirmed,
            });
          } else {
            let grounds: string[] | undefined;
            if (o.grounds !== undefined) {
              grounds = o.grounds
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
            }
            // Grounds validation runs inside the store's write method.
            await store.updateConstraint(id, {
              body: o.body ?? content.body,
              summary,
              rationale: o.rationale ?? content.rationale,
              grounds: grounds ?? node.grounds,
            });
          }
          emitWritten(io, opts, id, node.type, "updated");
          return 0;
        });
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
        return withStoreForWrite(io, opts, async (store) => {
          const resolved = await resolveAuthorization(store.graph, opts);
          const context = effectiveContext(store.graph, resolved);
          const results: Array<{
            id: string;
            error?: string;
            blocked?: {
              coveringFrontier: string[];
              affected: Array<{ id: string; depth: number }>;
            };
          }> = [];
          const blocked: ModificationCheck[] = [];
          let failure = false;
          for (const id of ids) {
            const node = store.graph.nodes.get(id);
            if (node === undefined) {
              results.push({ id, error: `node "${id}" not found` });
              failure = true;
              continue;
            }
            // Authorization is not bypassable with --force: --force covers the
            // structural guard only, the frozen zone needs a signed change.
            const check = checkModification(store.graph, context, id);
            if (!check.allowed) {
              const covering = coveringFrontier(store.graph, resolved, id);
              results.push({
                id,
                error: `frozen by authorization (frontier: ${covering.join(", ")})`,
                blocked: {
                  coveringFrontier: covering,
                  affected:
                    check.report?.affected.map((a) => ({ id: a.node.id, depth: a.depth })) ?? [],
                },
              });
              blocked.push(check);
              failure = true;
              continue;
            }
            // Direct dependents only: deleting is refused exactly when it would
            // leave dangling grounds behind (mirrors the web API's 409).
            const dependents = node.children;
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
              await store.deleteNode(id);
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
            for (const check of blocked) {
              renderEscalation(store.graph, resolved, check, io, false);
            }
            io.stdout.write(
              `${results
                .map((r) => (r.error === undefined ? `deleted ${r.id}` : `error: ${r.error}`))
                .join("\n")}\n`,
            );
          }
          return failure ? 1 : 0;
        });
      }),
    );

  program
    .command("web")
    .description("start the web UI server")
    .option("--host <ip>", "IP address to bind", "127.0.0.1")
    .option(
      "--port <n>",
      `port to listen on (default: ${DEFAULT_WEB_PORT}; bumps to the next free port when taken)`,
    )
    .action((_opts, cmd) =>
      run(cmd, async (opts) => {
        const { host, port } = cmd.opts() as { host: string; port?: string };
        let portNumber: number | undefined;
        if (port !== undefined) {
          portNumber = Number(port);
          if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
            io.stderr.write(`error: invalid port "${port}"\n`);
            return 1;
          }
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

  program.addCommand(createInitCommand(io, run));
  program.addCommand(createContextCommand(io, run));
  program.addCommand(createSearchCommand(io, run));
  program.addCommand(createPendingCommand(io, run));
  program.addCommand(createAuthCommand(io, run));
  program.addCommand(createGuideCommand(io, run));
  program.addCommand(createSkillCommand(io, run));

  // Hidden dev tooling: registered only when explicitly enabled, so without
  // REFINO_DEV=true the command does not exist at all — help output, unknown
  // command errors and completions are indistinguishable from a bare CLI.
  if (process.env.REFINO_DEV === "true") {
    program.addCommand(createDevCommand(io, run), { hidden: true });
  }

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

function emitNodes(
  io: CliIo,
  opts: GlobalOptions,
  nodes: RefinoNode[],
  frozen?: ReadonlySet<string>,
): void {
  if (opts.json) {
    emit(
      io,
      nodes.map((n) => nodeJson(n, frozen)),
    );
  } else if (nodes.length === 0) {
    io.stdout.write("(empty)\n");
  } else {
    io.stdout.write(`${renderNodeTable(nodes.map((n) => withFrozen(n, frozen)))}\n`);
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
  frozen?: ReadonlySet<string>,
): { missing: boolean } {
  const missing = groups.some((group) => "error" in group);
  if (opts.json) {
    emit(
      io,
      groups.map((group) =>
        "error" in group
          ? group
          : { id: group.id, results: group.results.map((n) => nodeJson(n, frozen)) },
      ),
    );
  } else if (groups.length === 1) {
    emitNodesOrError(io, opts, groups[0]!, frozen);
  } else {
    for (const group of groups) {
      io.stdout.write(`${group.id}:\n`);
      emitNodesOrError(io, opts, group, frozen);
    }
  }
  return { missing };
}

function emitNodesOrError(
  io: CliIo,
  opts: GlobalOptions,
  group: QueryGroup<RefinoNode>,
  frozen?: ReadonlySet<string>,
): void {
  if ("error" in group) {
    io.stdout.write(`error: ${group.error}\n`);
    return;
  }
  emitNodes(io, opts, group.results, frozen);
}

function emitGroupedDepths(
  io: CliIo,
  opts: GlobalOptions,
  groups: QueryGroup<NodeWithDepth>[],
  frozen?: ReadonlySet<string>,
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
              results: group.results.map((r) => ({ ...nodeJson(r.node, frozen), depth: r.depth })),
            },
      ),
    );
  } else if (groups.length === 1) {
    emitDepthsOrError(io, opts, groups[0]!, frozen);
  } else {
    for (const group of groups) {
      io.stdout.write(`${group.id}:\n`);
      emitDepthsOrError(io, opts, group, frozen);
    }
  }
  return { missing };
}

function emitDepthsOrError(
  io: CliIo,
  opts: GlobalOptions,
  group: QueryGroup<NodeWithDepth>,
  frozen?: ReadonlySet<string>,
): void {
  if ("error" in group) {
    io.stdout.write(`error: ${group.error}\n`);
    return;
  }
  emitDepths(io, opts, group.results, frozen);
}

function emitDepths(
  io: CliIo,
  opts: GlobalOptions,
  results: ReadonlyArray<{ node: RefinoNode; depth: number }>,
  frozen?: ReadonlySet<string>,
): void {
  if (opts.json) {
    emit(
      io,
      results.map((r) => ({ ...nodeJson(r.node, frozen), depth: r.depth })),
    );
  } else if (results.length === 0) {
    io.stdout.write("(empty)\n");
  } else {
    io.stdout.write(
      `${renderNodeTable(results.map((r) => withFrozen({ ...r.node, depth: r.depth }, frozen)))}\n`,
    );
  }
}

/** Text-side frozen annotation: the JSON side carries a `frozen` field. */
function withFrozen<T extends { id: string }>(
  row: T,
  frozen?: ReadonlySet<string>,
): T & { frozen?: boolean } {
  return frozen === undefined ? row : { ...row, frozen: frozen.has(row.id) };
}

function fullNodeJson(
  node: RefinoNode,
  content?: NodeContent,
  frozen?: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    ...nodeJson(node, frozen),
    body: content?.body ?? "",
    ...(node.type === "constraint" &&
      content?.rationale !== undefined && {
        rationale: content.rationale,
      }),
    ...(node.type === "premise" &&
      node.confirmed !== undefined && {
        confirmed: node.confirmed,
      }),
  };
}

function nodeJson(node: RefinoNode, frozen?: ReadonlySet<string>): Record<string, unknown> {
  const base = {
    id: node.id,
    type: node.type,
    summary: node.summary,
    ...(frozen !== undefined && { frozen: frozen.has(node.id) }),
  };
  return node.type === "constraint" ? { ...base, grounds: node.grounds } : base;
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
