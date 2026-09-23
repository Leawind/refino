import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InvalidArgumentError, Command } from "commander";
import { renderIssues } from "./format.js";
import type { CliIo } from "./format.js";
import { refinoDir, withStoreForWrite } from "./shared.js";
import type { GlobalOptions, RunFn } from "./shared.js";

/**
 * Hidden development tooling (`refino dev`), registered only when
 * `REFINO_DEV=true` so that production consumers never see the command at
 * all. The generator produces structurally valid DLG fixtures for manual
 * testing, demos and benchmarks; writes go through the store, so a generator
 * bug surfaces as a rejected write instead of corrupt data.
 */

export interface GenerateDlgParams {
  /** Total number of nodes (premises + decisions). */
  nodes: number;
  /** Fraction of premises among all nodes, 0-1. */
  premiseRatio: number;
  /**
   * Number of root decisions (empty grounds). Defaults to 1 when omitted.
   */
  roots?: number;
  /**
   * Maximum number of grounds per non-root decision (>= 1). Defaults to
   * 8 when omitted.
   */
  maxGrounds: number;
  /**
   * Maximum decision-chain depth (>= 1): no decision grounds on a
   * decision whose own chain already reaches this length. Unlimited when
   * omitted.
   */
  maxDepth?: number;
  /**
   * Fraction of companion grounds drawn from shallower layers or premises,
   * 0-1. Real graphs ground mostly within one layer; only a minority of
   * nodes span several. Defaults to 0.2 when omitted.
   */
  crossLayerRatio: number;
  /** Fraction of premises carrying a confirmed timestamp, 0-1. */
  confirmedRatio: number;
}

export interface GeneratedNode {
  type: "premise" | "decision";
  id: string;
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: number;
}

/**
 * Build a random but structurally valid DLG as a topologically ordered node
 * list: premises first, then root decisions, then decisions grounding on
 * earlier ones (acyclic by construction). Deterministic given `rand`.
 */
export function generateDlg(params: GenerateDlgParams, rand: () => number): GeneratedNode[] {
  const premiseCount = Math.round(params.nodes * params.premiseRatio);
  const decisionCount = params.nodes - premiseCount;
  const rootCount = params.roots ?? 1;
  if (rootCount > decisionCount) {
    throw new Error(
      `--roots ${rootCount} exceeds the ${decisionCount} decisions implied by --nodes and --premise-ratio`,
    );
  }
  // Non-root decisions need at least one ground source: a premise or a
  // root decision. Premises cannot ground, so with neither, generation is
  // impossible.
  if (decisionCount > 0 && premiseCount === 0 && rootCount === 0) {
    throw new Error(
      "nothing to ground on: --roots 0 combined with a premise ratio of 0 leaves no ground source",
    );
  }

  const nextId = createIdFactory(rand);
  const nodes: GeneratedNode[] = [];
  const confirmedCount = Math.round(premiseCount * params.confirmedRatio);
  // A fixed base keeps the output byte-identical across runs with the same
  // seed; spacing avoids identical timestamps for all premises.
  const CONFIRMED_BASE_MS = Date.UTC(2026, 0, 1);
  const DAY_MS = 86_400_000;
  for (let i = 0; i < premiseCount; i++) {
    nodes.push({
      type: "premise",
      id: nextId(),
      summary: `dev premise #${i}`,
      body: `Dev-generated premise #${i}.\n\nThis premise exists to populate a development graph; its content carries no meaning.\n`,
      ...(i < confirmedCount && { confirmed: CONFIRMED_BASE_MS - i * DAY_MS }),
    });
  }

  const premiseIds = nodes.map((n) => n.id);
  /** Longest decision-chain below each decision (roots: 0, premises ignored). */
  const depths = new Map<string, number>();
  /** Decision ids per depth, in creation order; the last one is the newest. */
  const layers = new Map<number, string[]>();
  const addDecision = (index: number, grounds: string[] | undefined): void => {
    const id = nextId();
    const parentDepths = (grounds ?? []).map((g) => depths.get(g) ?? -1);
    const depth = grounds === undefined ? 0 : 1 + Math.max(-1, ...parentDepths);
    depths.set(id, depth);
    const layer = layers.get(depth);
    if (layer === undefined) layers.set(depth, [id]);
    else layer.push(id);
    nodes.push({
      type: "decision",
      id,
      summary: `dev decision #${index}`,
      body: `Dev-generated decision #${index}.\n\nThis decision exists to populate a development graph; its content carries no meaning.\n`,
      grounds,
      rationale: "dev-generated fixture data",
    });
  };

  for (let i = 0; i < rootCount; i++) addDecision(i, undefined);
  for (let i = rootCount; i < decisionCount; i++) {
    const eligibleLayers = [...layers.entries()]
      .filter(([depth]) => params.maxDepth === undefined || depth < params.maxDepth!)
      .sort(([a], [b]) => a - b);
    if (eligibleLayers.length === 0) {
      // Only possible when no decision layer qualifies yet (e.g. --roots 0
      // before any decision exists): ground on premises, which never
      // extend a chain.
      const sources = [...premiseIds];
      const count = 1 + Math.floor(rand() * Math.min(params.maxGrounds, sources.length));
      addDecision(i, takeDistinct(sources, count, rand));
      continue;
    }
    // Deeper layers attract more refinements: square-bias the layer pick
    // toward the deep end (rand()² skews small, so count the index down from
    // the deepest). The frontier keeps growing while earlier layers still
    // receive children — without the bias most nodes would pile up at the
    // shallowest layer.
    const layerIndex = Math.max(
      0,
      eligibleLayers.length - 1 - Math.floor(rand() * rand() * eligibleLayers.length),
    );
    const [, anchorLayer] = eligibleLayers[layerIndex]!;
    const anchor = anchorLayer[anchorLayer.length - 1]!; // newest member
    // Real graphs ground mostly within one layer; only a minority of nodes
    // reach across to shallower layers or premises. A node is cross-layer as
    // a whole; companions never mix the two pools, and thin pools simply
    // yield fewer grounds.
    const sameLayer = anchorLayer.slice(0, -1);
    const crossLayer = [
      ...premiseIds,
      ...eligibleLayers.slice(0, layerIndex).flatMap(([, ids]) => [...ids]),
    ];
    const crossNode = rand() < params.crossLayerRatio;
    const count = 1 + Math.floor(rand() * params.maxGrounds);
    const chosen = new Set<string>([anchor]);
    const pool = crossNode ? crossLayer : sameLayer;
    for (let k = 1; k < count && pool.length > 0; k++) {
      chosen.add(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
    }
    addDecision(i, [...chosen]);
  }
  return nodes;
}

/** Remove up to `count` random entries from `items` (mutates the array). */
function takeDistinct<T>(items: T[], count: number, rand: () => number): T[] {
  const picked: T[] = [];
  for (let i = 0; i < count && items.length > 0; i++) {
    picked.push(items.splice(Math.floor(rand() * items.length), 1)[0]!);
  }
  return picked;
}

/** Register the hidden `dev` command group on the program. */
export function createDevCommand(io: CliIo, run: RunFn): Command {
  // exitOverride and output routing: subcommands inherit both from here
  // (addCommand does not copy them from the program), so parse errors throw
  // instead of process.exit and their messages reach the same io.
  const dev = new Command("dev")
    .description("development utilities (only registered when REFINO_DEV=true)")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => void io.stdout.write(text),
      writeErr: (text) => void io.stderr.write(text),
    });

  dev
    .command("generate")
    .description("programmatically generate a DLG fixture under .refino/")
    .requiredOption("--nodes <n>", "total number of nodes to generate", intAtLeast(1))
    .option(
      "--premise-ratio <r>",
      "fraction of premises among all nodes, 0-1 (default 0.3)",
      ratio(),
      0.3,
    )
    .option(
      "--roots <n>",
      "number of root decisions with empty grounds (default 1)",
      intAtLeast(0),
      1,
    )
    .option(
      "--max-grounds <n>",
      "maximum grounds per non-root decision (default 8)",
      intAtLeast(1),
      8,
    )
    .option("--max-depth <n>", "maximum decision-chain depth (default unlimited)", intAtLeast(1))
    .option(
      "--cross-layer-ratio <r>",
      "fraction of companion grounds reaching across layers (default 0.2)",
      ratio(),
      0.2,
    )
    .option(
      "--confirmed-ratio <r>",
      "fraction of premises carrying a confirmed timestamp, 0-1 (default 1)",
      ratio(),
      1,
    )
    .option(
      "--seed <n>",
      "random seed in [0, 2^32); same seed and options reproduce the graph",
      uint32(),
    )
    .option("--force", "allow generating into a non-empty .refino (new nodes are added)", false)
    .action((_opts, cmd) =>
      run(cmd, async (opts: GlobalOptions) => {
        const o = cmd.opts() as {
          nodes: number;
          premiseRatio: number;
          roots?: number;
          maxGrounds: number;
          maxDepth?: number;
          crossLayerRatio: number;
          confirmedRatio: number;
          seed?: number;
          force: boolean;
        };
        // Resolve the seed up front so the output can report it even when it
        // was picked at random, keeping one-off runs reproducible after the
        // fact.
        const seed = o.seed ?? Math.floor(Math.random() * 0x1_0000_0000);
        // Dev tooling is exempt from the adoption contract: generating
        // fixtures into a bare root is the point, so adopt unconditionally.
        await mkdir(join(refinoDir(opts), "nodes"), { recursive: true });
        return withStoreForWrite(io, opts, async (store) => {
          if (store.graph.nodes.size > 0 && o.force !== true) {
            io.stderr.write(
              `error: ${refinoDir(opts)} is not empty; use --force to add nodes anyway\n`,
            );
            return 1;
          }
          const generated = generateDlg(
            {
              nodes: o.nodes,
              premiseRatio: o.premiseRatio,
              roots: o.roots,
              maxGrounds: o.maxGrounds,
              maxDepth: o.maxDepth,
              crossLayerRatio: o.crossLayerRatio,
              confirmedRatio: o.confirmedRatio,
            },
            mulberry32(seed),
          );
          for (const node of generated) {
            if (node.type === "premise") {
              await store.createPremise({
                id: node.id,
                body: node.body,
                summary: node.summary,
                confirmed: node.confirmed,
              });
            } else {
              await store.createDecision({
                id: node.id,
                body: node.body,
                summary: node.summary,
                grounds: node.grounds,
                rationale: node.rationale,
              });
            }
          }
          const issues = store.issues();
          if (issues.length > 0) {
            // Unreachable unless the generator produces invalid graphs; a
            // rejected write fails earlier, so this only reports, never hides.
            io.stdout.write(`${renderIssues(issues)}\n`);
            return 1;
          }
          const premises = generated.filter((n) => n.type === "premise").length;
          const decisions = generated.length - premises;
          const roots = generated.filter(
            (n) => n.type === "decision" && (n.grounds?.length ?? 0) === 0,
          ).length;
          io.stdout.write(
            `generated ${premises} premises, ${decisions} decisions (${roots} roots) in ${refinoDir(opts)} (seed ${seed})\n`,
          );
          return 0;
        });
      }),
    );

  return dev;
}

/** Small seeded PRNG (mulberry32); good enough for fixtures, not crypto. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Crockford base32 — the same alphabet the engine's generateId() draws from;
// a subset of the id charset, so every id is valid by construction.
const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Seeded id factory matching the engine's id rule, collision-free within a run. */
function createIdFactory(rand: () => number): () => string {
  const used = new Set<string>();
  return () => {
    for (;;) {
      let id = "";
      for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length)];
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

function intAtLeast(min: number): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      throw new InvalidArgumentError(`must be an integer >= ${min}`);
    }
    return n;
  };
}

function ratio(): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new InvalidArgumentError("must be a number between 0 and 1");
    }
    return n;
  };
}

function uint32(): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
      throw new InvalidArgumentError("must be an integer in [0, 4294967295]");
    }
    return n;
  };
}
