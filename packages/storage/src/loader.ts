import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { buildGraph, ID_CHARSET, ID_RE, IssueCode, RefinoError } from "refino";
import { StorageIssueCode, type StorageIssue } from "./codes.js";
import { parseNodeSource, type NodeContent } from "./parser.js";
import { nodeFilePath, nodeRelativeFile, NODE_TYPES } from "./writer.js";
import type { Graph, NodeType, RefinoNode } from "refino";

const NODES_DIR = "nodes";

/**
 * A shard directory name: the first 2 characters of a node id, drawn from
 * the engine's id charset (the id rule itself lives in the engine).
 */
const SHARD_RE = new RegExp(`^[${ID_CHARSET}]{2}$`);

export interface LoadResult {
  graph: Graph;
  /** Issues found while reading and parsing node files (including duplicate ids). */
  issues: StorageIssue[];
  /** Node id -> file mtime (ms) at read time; the baseline for change detection. */
  mtimes: Map<string, number>;
  /** Node id -> whether the summary came from an explicit frontmatter field. */
  summaryExplicit: Map<string, boolean>;
}

export interface ReadNodeResult {
  /** The parsed node, or null when neither candidate file exists. */
  node: RefinoNode | null;
  /** The node's paged content (body, rationale); undefined when node is null. */
  content?: NodeContent;
  issues: StorageIssue[];
  /** File mtime (ms) of the winning candidate; undefined when node is null. */
  mtimeMs?: number;
  /**
   * Whether the winning candidate's summary came from an explicit frontmatter
   * field (as opposed to being derived from the body); undefined when node is
   * null. Partial-update write paths use this to keep derived summaries from
   * being materialized into the file.
   */
  summaryExplicit?: boolean;
}

/**
 * Read a node file's source and its mtime as one consistent snapshot: both
 * come from the same open file handle, so the mtime always describes the
 * content being parsed even under concurrent atomic writes.
 * Returns undefined when the file does not exist.
 */
async function readSource(
  absolute: string,
): Promise<{ source: string; mtimeMs: number } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // no file of this shape
    throw error;
  }
  try {
    const [source, stats] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    return { source, mtimeMs: stats.mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * Read a single node by id (path is identity): parse whichever of the two
 * candidate files exists. Incremental index updates use this instead of a
 * full rescan, so parse logic stays single-sourced in the storage layer.
 *
 * Candidate order mirrors loadGraph's within-shard lexicographic scan
 * ("constraint" sorts before "premise"), so single-node reads agree with
 * full loads: parse issues from every existing candidate are reported, the
 * first candidate yielding a valid node wins, and a second valid candidate
 * is reported as DUPLICATE_ID.
 */
export async function readNode(refinoDir: string, id: string): Promise<ReadNodeResult> {
  if (!ID_RE.test(id)) {
    throw new RefinoError(
      IssueCode.InvalidId,
      `Node id must be 3-16 characters of A-Z, 0-9 or _, got "${id}".`,
    );
  }
  const candidates = [...NODE_TYPES].sort().map((type) => ({
    type,
    file: nodeRelativeFile(type, id),
    absolute: nodeFilePath(refinoDir, type, id),
  }));
  const issues: StorageIssue[] = [];
  let node: RefinoNode | null = null;
  let content: NodeContent | undefined;
  let mtimeMs: number | undefined;
  let summaryExplicit: boolean | undefined;
  for (const candidate of candidates) {
    const read = await readSource(candidate.absolute);
    if (read === undefined) continue; // no file of this type
    const parsed = parseNodeSource(id, candidate.file, candidate.type, read.source);
    issues.push(...parsed.issues);
    if (parsed.node === null) continue;
    if (node === null) {
      node = parsed.node;
      content = parsed.content;
      mtimeMs = read.mtimeMs;
      summaryExplicit = parsed.summaryExplicit;
    } else {
      issues.push({
        code: IssueCode.DuplicateId,
        message: `Duplicate node id "${id}" (already defined in ${nodeRelativeFile(node.type, node.id)}).`,
        file: candidate.file,
        nodeId: id,
      });
      break; // both candidates parsed: nothing left to read
    }
  }
  return { node, content, issues, mtimeMs, summaryExplicit };
}

/**
 * Read every node file under `<refinoDir>/nodes/` and build the resident
 * in-memory graph. Loading is read-only; the only write path is `writer.ts`.
 * Paged content (body, rationale) is parsed for summary derivation and then
 * discarded — the resident graph never holds it.
 *
 * Layout: `nodes/<2-char shard>/<rest>-<type>.md`, where `<type>` is
 * `premise` or `constraint`. The node id is derived from the file path
 * (path is identity): shard directory name + the segment before the `-`
 * separator (ids never contain `-`, so the split is unambiguous), and the
 * type travels in the file name, never in the frontmatter.
 *
 * Directory names that are not valid shards and non-markdown files are
 * silently ignored; nested files are ignored; stray markdown files at the
 * top of `nodes/` and files whose name has no valid `<id_2>-<type>` shape
 * are reported as INVALID_NODE_PATH; ids that fail the engine's id rule are
 * reported as INVALID_ID. A missing `nodes/` directory is an empty graph.
 * Structural validation (unknown grounds, cycles) is a separate step:
 * `validateGraph`.
 */
export async function loadGraph(refinoDir: string): Promise<LoadResult> {
  let dirStat;
  try {
    dirStat = await stat(refinoDir);
  } catch {
    throw new RefinoError(
      StorageIssueCode.RefinoDirNotFound,
      `No .refino directory found at ${refinoDir}`,
    );
  }
  if (!dirStat.isDirectory()) {
    throw new RefinoError(StorageIssueCode.RefinoDirNotFound, `${refinoDir} is not a directory`);
  }

  const nodes: RefinoNode[] = [];
  const issues: StorageIssue[] = [];
  const seenIds = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const summaryExplicit = new Map<string, boolean>();

  let shards;
  try {
    shards = await readdir(join(refinoDir, NODES_DIR), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { graph: buildGraph([]), issues, mtimes, summaryExplicit }; // empty store
    }
    throw error;
  }

  for (const shard of shards.sort(byName)) {
    if (shard.isFile() && shard.name.endsWith(".md")) {
      const file = `${NODES_DIR}/${shard.name}`;
      issues.push({
        code: StorageIssueCode.InvalidNodePath,
        message: `Node files must live at ${NODES_DIR}/<shard>/<id_2>-<type>.md, e.g. ${NODES_DIR}/01/9ABCDE-premise.md; got "${file}".`,
        file,
      });
      continue;
    }
    if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue; // silently ignored
    let files;
    try {
      files = await readdir(join(refinoDir, NODES_DIR, shard.name), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // changed mid-scan
      throw error;
    }
    for (const entry of files.sort(byName)) {
      // Deeper directories and non-markdown files are silently ignored.
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = `${NODES_DIR}/${shard.name}/${entry.name}`;
      const read = await readSource(join(refinoDir, file));
      if (read === undefined) continue; // changed mid-scan
      const parsed = parseFileName(entry.name.slice(0, -".md".length));
      if (!parsed) {
        issues.push({
          code: StorageIssueCode.InvalidNodePath,
          message: `Node file names must be <id_2>-<type>.md with <type> one of ${NODE_TYPES.join("|")}, got "${entry.name}".`,
          file,
        });
        continue;
      }
      const { id2, type } = parsed;
      const id = shard.name + id2;
      if (!ID_RE.test(id)) {
        issues.push({
          code: IssueCode.InvalidId,
          message: `Node id must be 3-16 characters of A-Z, 0-9 or _ (the id is shard + id_2), got "${id}".`,
          file,
        });
        continue;
      }
      const {
        node,
        issues: parseIssues,
        summaryExplicit: explicit,
      } = parseNodeSource(id, file, type, read.source);
      issues.push(...parseIssues);
      if (!node) continue;
      const existingFile = seenIds.get(node.id);
      if (existingFile) {
        issues.push({
          code: IssueCode.DuplicateId,
          message: `Duplicate node id "${node.id}" (already defined in ${existingFile}).`,
          file: nodeRelativeFile(type, id),
          nodeId: id,
        });
        continue;
      }
      seenIds.set(node.id, nodeRelativeFile(node.type, node.id));
      mtimes.set(node.id, read.mtimeMs);
      summaryExplicit.set(node.id, explicit);
      nodes.push(node);
    }
  }

  return { graph: buildGraph(nodes), issues, mtimes, summaryExplicit };
}

/**
 * Split `<id_2>-<type>` into its parts; null when the shape is wrong. The
 * split is unambiguous: ids never contain `-` (engine id rule), so the last
 * `-` is always the id/type separator.
 */
function parseFileName(name: string): { id2: string; type: NodeType } | null {
  const dash = name.lastIndexOf("-");
  if (dash === -1) return null;
  const type = name.slice(dash + 1);
  if (type !== "premise" && type !== "constraint") return null;
  return { id2: name.slice(0, dash), type };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
