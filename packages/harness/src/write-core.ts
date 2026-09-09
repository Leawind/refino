import { getDependents, ID_RE, RefinoError, type NodeWithDepth, type RefinoNode } from "refino";
import { checkModification } from "./boundary.js";
import { HarnessError } from "./errors.js";
import {
  confirmedToMs,
  isValidConfirmed,
  WriteRejected,
  type NodeContent,
  type StoreChange,
} from "@refino/storage";
import { depthLite, issueLite, lite, type WriteResult } from "./shapes.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * CRG write tool cores (docs/design.md, dsh 插件落地形态). Every write walks
 * the same chain before persisting: engine `checkGroundsChange` (create
 * validates against a prospective graph copy) and harness `checkModification`
 * — a frozen-zone target returns a structured escalation report as a normal
 * tool result, never an error. The modification space closes downwards along
 * dependents (docs/crg.md 2.4), so no downstream-freeze check exists. The
 * target's own sync runs after persisting; its pending-review set rides the
 * result instead of being injected. Successful writes absorb into the
 * session known set (docs/design.md, 会话已知集): the author knows what it
 * wrote, and the one-hop neighborhood snapshots re-sync silently so the
 * next external sync never reports the write back.
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
  if (args.confirmed !== undefined && !isValidConfirmed(args.confirmed)) {
    return invalidConfirmed(args.confirmed);
  }
  try {
    const outcome = await ws.store.createPremise({
      ...args,
      confirmed: args.confirmed === undefined ? undefined : confirmedToMs(args.confirmed),
    });
    return harvested(ws, outcome.id, undefined, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

export interface CreateConstraintArgs {
  body: string;
  summary?: string;
  rationale?: string;
  grounds?: string[];
  id?: string;
}

export async function runCreateConstraint(
  ws: RefinoWorkspace,
  args: CreateConstraintArgs,
): Promise<WriteResult> {
  if (args.id !== undefined && !ID_RE.test(args.id)) {
    return { ok: false, error: `节点 ID 必须是 3-16 位 A-Z、0-9 或 _，收到 "${args.id}"` };
  }
  if (args.id !== undefined && ws.graph.nodes.has(args.id)) {
    return { ok: false, error: `节点 ID "${args.id}" 已被占用` };
  }
  try {
    // Grounds validation runs inside the store's write method; a
    // rejected change never touches the disk.
    const outcome = await ws.store.createConstraint(args);
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
    args.confirmed !== undefined;
  if (!touched) {
    return { ok: false, error: "未指定任何要更新的字段；省略的字段保持不变" };
  }
  const blocked = checkModification(ws.graph, ws.authorizationContext, node.id);
  if (!blocked.allowed) {
    return escalationResult(node.id, blocked.report!.affected);
  }
  if (node.type === "premise") {
    return updatePremiseNode(ws, node, args);
  }
  return updateConstraintNode(ws, node, args);
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
  return { ok: true, id, pending: pending.map(lite) };
}

/** Pre-write one-hop neighborhood snapshot, from the graph the write is about to detach. */
function neighborhoodOf(
  ws: RefinoWorkspace,
  id: string,
): { grounds: string[]; children: string[] } {
  const node = ws.graph.nodes.get(id);
  return {
    grounds: node === undefined || node.type !== "constraint" ? [] : [...node.grounds],
    children: node === undefined ? [] : [...node.children],
  };
}

export async function runDeleteNode(ws: RefinoWorkspace, id: string): Promise<WriteResult> {
  const node = ws.graph.nodes.get(id);
  if (node === undefined) {
    return { ok: false, error: `节点 "${id}" 不存在` };
  }
  const blocked = checkModification(ws.graph, ws.authorizationContext, node.id);
  if (!blocked.allowed) {
    return escalationResult(node.id, blocked.report!.affected);
  }
  const dependents = getDependents(ws.graph, node.id);
  if (dependents.length > 0) {
    return {
      ok: false,
      error: `节点 ${node.id} 仍有下游约束，不能删除`,
      dependents: dependents.map((dependent) => lite(dependent.node)),
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
 * Read what a partial update needs: the paged content (body, rationale live
 * there, not on the resident node) plus the summary per the partial
 * semantics (docs/design.md) — an omitted summary keeps an explicit one and
 * stays body-derived otherwise, so updating the body alone keeps the
 * fallback in sync; an empty string clears the explicit summary.
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
  if (args.confirmed !== undefined && args.confirmed !== "" && !isValidConfirmed(args.confirmed)) {
    return invalidConfirmed(args.confirmed);
  }
  // Rationale and grounds do not apply to premises; per the misplaced-field
  // policy they are silently ignored instead of rejected.
  const read = await readForUpdate(ws, node.id, args);
  if ("ok" in read) return read;
  const prev = neighborhoodOf(ws, node.id);
  try {
    const outcome = await ws.store.updatePremise(node.id, {
      body: args.body ?? read.content.body,
      summary: read.summary,
      confirmed:
        args.confirmed === undefined
          ? node.confirmed
          : args.confirmed === ""
            ? undefined
            : confirmedToMs(args.confirmed),
    });
    return harvested(ws, node.id, prev, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

async function updateConstraintNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "constraint" },
  args: UpdateNodeArgs,
): Promise<WriteResult> {
  // `confirmed` does not apply to constraints; per the misplaced-field policy
  // it is silently ignored instead of rejected. Grounds validation runs
  // inside the store's write method; a rejected change never touches the disk.
  const read = await readForUpdate(ws, node.id, args);
  if ("ok" in read) return read;
  const prev = neighborhoodOf(ws, node.id);
  try {
    const outcome = await ws.store.updateConstraint(node.id, {
      body: args.body ?? read.content.body,
      summary: read.summary,
      rationale:
        args.rationale === undefined
          ? read.content.rationale
          : args.rationale === ""
            ? undefined
            : args.rationale,
      grounds: args.grounds ?? node.grounds,
    });
    return harvested(ws, node.id, prev, outcome.change);
  } catch (error) {
    return writeFailure(error);
  }
}

function escalationResult(id: string, affected: NodeWithDepth[]): WriteResult {
  return {
    ok: false,
    error: `节点 ${id} 位于冻结区，只读`,
    escalation: { id, reason: "node_frozen", affected: affected.map(depthLite) },
  };
}

function invalidConfirmed(value: string): WriteResult {
  return {
    ok: false,
    error: `confirmed 必须是带显式 UTC 偏移的 RFC 3339 时间戳，收到 "${value}"`,
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
