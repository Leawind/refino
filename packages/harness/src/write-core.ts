import { effectiveExploring, getDependents, ID_RE, RefinoError, type RefinoNode } from "refino";
import { HarnessError } from "./errors.js";
import {
  isRfc3339,
  rfc3339ToMs,
  WriteRejected,
  type NodeContent,
  type StoreChange,
} from "@refino/storage";
import { issueLite, lite, type WriteResult } from "./shapes.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * DLG write tool cores. Every write walks the same chain before persisting:
 * engine `checkGroundsChange` (create validates against a prospective graph
 * copy). The target's own sync runs after persisting; its pending-review set
 * rides the result instead of being injected. Successful writes absorb into
 * the session known set: the author knows what it wrote, and the one-hop
 * neighborhood snapshots re-sync silently so the next external sync never
 * reports the write back.
 */

export interface CreatePremiseArgs {
  body: string;
  summary?: string;
  confirmed?: string;
  id?: string;
}

export async function runCreatePremise(
  ws: RefinoWorkspace,
  args: CreatePremiseArgs,
): Promise<WriteResult> {
  const confirmed = parseTimestamp(args.confirmed);
  if (confirmed === "invalid") return invalidTimestamp("confirmed", args.confirmed!);
  try {
    const outcome = await ws.store.createPremise({
      body: args.body,
      summary: args.summary,
      confirmed,
      id: args.id,
    });
    return harvested(ws, outcome.id, undefined, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

export interface CreateDecisionArgs {
  body: string;
  summary?: string;
  rationale?: string;
  grounds?: string[];
  /** Trial-commitment mark: true writes `exploring: true`; a root decision defaults to it. */
  exploring?: boolean;
  /** Last review time as an RFC 3339 timestamp. */
  reviewed?: string;
  id?: string;
}

export async function runCreateDecision(
  ws: RefinoWorkspace,
  args: CreateDecisionArgs,
): Promise<WriteResult> {
  if (args.id !== undefined && !ID_RE.test(args.id)) {
    return { ok: false, error: `节点 ID 必须是 3-16 位 A-Z、0-9 或 _，收到 "${args.id}"` };
  }
  if (args.id !== undefined && ws.graph.nodes.has(args.id)) {
    return { ok: false, error: `节点 ID "${args.id}" 已被占用` };
  }
  const reviewed = parseTimestamp(args.reviewed);
  if (reviewed === "invalid") return invalidTimestamp("reviewed", args.reviewed!);
  try {
    // Grounds validation runs inside the store's write method; a
    // rejected change never touches the disk.
    const outcome = await ws.store.createDecision({
      body: args.body,
      summary: args.summary,
      rationale: args.rationale,
      grounds: args.grounds,
      exploring: args.exploring,
      reviewed,
      id: args.id,
    });
    return harvested(ws, outcome.id, undefined, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

export interface UpdateNodeArgs {
  id: string;
  summary?: string;
  body?: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
  /** Decision last-review time; omitted keeps the current value, "" clears it. */
  reviewed?: string;
  /** Decision trial mark; omitted keeps the current value (booleans have no clear-to-empty form). */
  exploring?: boolean;
}

export async function runUpdateNode(
  ws: RefinoWorkspace,
  args: UpdateNodeArgs,
): Promise<WriteResult> {
  const node = ws.graph.nodes.get(args.id);
  if (node === undefined) {
    return { ok: false, error: `节点 "${args.id}" 不存在` };
  }
  const touched =
    args.summary !== undefined ||
    args.body !== undefined ||
    args.grounds !== undefined ||
    args.rationale !== undefined ||
    args.confirmed !== undefined ||
    args.reviewed !== undefined ||
    args.exploring !== undefined;
  if (!touched) {
    return { ok: false, error: "未指定任何要更新的字段；省略的字段保持不变" };
  }
  if (node.type === "premise") {
    return updatePremiseNode(ws, node, args);
  }
  return updateDecisionNode(ws, node, args);
}

/**
 * Harvest a persisted write into the known set and frame its result: the
 * pending set's summaries were delivered in the result, the written node is
 * recorded full, and the one-hop neighborhood re-syncs silently. `prev` is
 * the pre-write neighborhood (undefined for creates; grounds-only suffices
 * for deletes — a node with dependents is never deletable).
 */
async function harvested(
  ws: RefinoWorkspace,
  id: string,
  prev: { grounds: string[]; children: string[] } | undefined,
  change: StoreChange | undefined,
): Promise<WriteResult> {
  const pending = ws.pendingOf(change);
  ws.known.recordSummaries(pending);
  await ws.absorbOwnWrite(id, prev);
  return { ok: true, id, pending: pending.map((node) => lite(node, effectiveOf(ws, node))) };
}

/** Pre-write one-hop neighborhood snapshot, from the graph the write is about to detach. */
function neighborhoodOf(
  ws: RefinoWorkspace,
  id: string,
): { grounds: string[]; children: string[] } {
  const node = ws.graph.nodes.get(id);
  return {
    grounds: node === undefined || node.type !== "decision" ? [] : [...node.grounds],
    children: node === undefined ? [] : [...node.children],
  };
}

export async function runDeleteNode(ws: RefinoWorkspace, id: string): Promise<WriteResult> {
  const node = ws.graph.nodes.get(id);
  if (node === undefined) {
    return { ok: false, error: `节点 "${id}" 不存在` };
  }
  const dependents = getDependents(ws.graph, node.id);
  if (dependents.length > 0) {
    return {
      ok: false,
      error: `节点 ${node.id} 仍有下游决策，不能删除`,
      dependents: dependents.map((dependent) =>
        lite(dependent.node, effectiveOf(ws, dependent.node)),
      ),
    };
  }
  const prev = neighborhoodOf(ws, node.id);
  try {
    await ws.store.deleteNode(node.id);
  } catch (error) {
    return writeFailure(error);
  }
  return harvested(ws, node.id, prev, undefined);
}

// ---- shared write helpers ----

/**
 * Read what a partial update needs: the paged content (body, rationale live there,
 * not on the resident node) plus the summary per the partial semantics — an omitted
 * summary keeps an explicit one and stays body-derived otherwise, so updating the
 * body alone keeps the fallback in sync; an empty string clears the explicit
 * summary.
 */
async function readForUpdate(
  ws: RefinoWorkspace,
  id: string,
  args: UpdateNodeArgs,
): Promise<{ summary: string | undefined; content: NodeContent } | WriteResult> {
  const entry = ws.store.entry(id);
  if (entry === undefined) return { ok: false, error: `节点 "${id}" 不存在` };
  const summary =
    args.summary === undefined
      ? entry.summaryExplicit
        ? entry.node.summary
        : undefined
      : args.summary === ""
        ? undefined
        : args.summary;
  return { summary, content: (await ws.content(id)) ?? { body: "" } };
}

async function updatePremiseNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "premise" },
  args: UpdateNodeArgs,
): Promise<WriteResult> {
  let confirmed = node.confirmed;
  if (args.confirmed !== undefined) {
    if (args.confirmed !== "") {
      const parsed = parseTimestamp(args.confirmed);
      if (parsed === "invalid") return invalidTimestamp("confirmed", args.confirmed);
      confirmed = parsed;
    } else {
      confirmed = undefined;
    }
  }
  // Rationale, grounds, reviewed and exploring do not apply to premises; per the
  // misplaced-field policy they are silently ignored instead of rejected.
  const read = await readForUpdate(ws, node.id, args);
  if ("ok" in read) return read;
  const prev = neighborhoodOf(ws, node.id);
  try {
    const outcome = await ws.store.updatePremise(node.id, {
      body: args.body ?? read.content.body,
      summary: read.summary,
      confirmed,
    });
    return harvested(ws, node.id, prev, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

async function updateDecisionNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "decision" },
  args: UpdateNodeArgs,
): Promise<WriteResult> {
  // `confirmed` does not apply to decisions; per the misplaced-field policy
  // it is silently ignored instead of rejected. Grounds validation runs
  // inside the store's write method; a rejected change never touches the disk.
  let reviewed = node.reviewed;
  if (args.reviewed !== undefined) {
    if (args.reviewed !== "") {
      const parsed = parseTimestamp(args.reviewed);
      if (parsed === "invalid") return invalidTimestamp("reviewed", args.reviewed);
      reviewed = parsed;
    } else {
      reviewed = undefined;
    }
  }
  const read = await readForUpdate(ws, node.id, args);
  if ("ok" in read) return read;
  const prev = neighborhoodOf(ws, node.id);
  try {
    const outcome = await ws.store.updateDecision(node.id, {
      body: args.body ?? read.content.body,
      summary: read.summary,
      rationale:
        args.rationale === undefined
          ? read.content.rationale
          : args.rationale === ""
            ? undefined
            : args.rationale,
      grounds: args.grounds ?? node.grounds,
      exploring: args.exploring ?? node.exploring === true,
      reviewed,
    });
    return harvested(ws, node.id, prev, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

/** Derived effective exploring status for a delivered decision (same rule as query-core). */
function effectiveOf(ws: RefinoWorkspace, node: RefinoNode): boolean {
  return node.type === "decision" && effectiveExploring(ws.graph, node.id);
}

/**
 * Parse an optional RFC 3339 write argument: `undefined` keeps the field as it
 * is and the empty string clears it (callers decide), anything else must be a
 * real timestamp.
 */
function parseTimestamp(value: string | undefined): number | undefined | "invalid" {
  if (value === undefined || value === "") return undefined;
  const ms = isRfc3339(value) ? rfc3339ToMs(value) : undefined;
  return ms === undefined ? "invalid" : ms;
}

function invalidTimestamp(field: string, value: string): WriteResult {
  return {
    ok: false,
    error: `${field} 必须是带显式 UTC 偏移的 RFC 3339 时间戳，收到 "${value}"`,
  };
}

function writeFailure(error: unknown): WriteResult {
  if (error instanceof WriteRejected) {
    return { ok: false, error: "grounds 校验未通过", issues: error.issues.map(issueLite) };
  }
  if (error instanceof RefinoError) {
    return { ok: false, error: `${error.code}: ${error.message}` };
  }
  if (error instanceof HarnessError) {
    return { ok: false, error: error.message };
  }
  throw error;
}
