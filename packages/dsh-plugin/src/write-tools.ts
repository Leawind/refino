import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  buildGraph,
  checkGroundsChange,
  generateId,
  getDependents,
  ID_RE,
  isValidConfirmed,
  RefinoError,
  type NodeWithDepth,
  type RefinoNode,
} from "refino";
import { checkModification, frozenDependents, HarnessError } from "@refino/harness";
import {
  createConstraint,
  createPremise,
  deleteNode,
  updateConstraint,
  updatePremise,
} from "@refino/storage";
import { depthLite, issueLite, lite, type EscalationReason, type WriteResult } from "./shapes.js";
import { renderWrite } from "./render.js";
import { requireWorkspace, writeResultSchema } from "./internal.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * CRG write tools (docs/design.md, dsh 插件落地形态). Every write walks the
 * same chain before persisting: engine `checkGroundsChange` (create validates
 * against a prospective graph copy), harness `checkModification` and
 * `frozenDependents` — reaching the frozen zone returns a structured
 * escalation report as a normal tool result, never an error. The target's own
 * sync runs after persisting; its pending-review set rides the result instead
 * of being injected.
 */
export function createWriteTools(get: () => RefinoWorkspace | undefined): ToolDefinition[] {
  return [
    createPremiseTool(get),
    createConstraintTool(get),
    updateNodeTool(get),
    deleteNodeTool(get),
  ];
}

function createPremiseTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_create_premise",
    description: "新增前提节点（项目运作依赖的客观事实）。前提不携带 grounds，不参与约束谱系。",
    parameters: {
      body: { type: "string", required: true, description: "事实内容（Markdown 正文）" },
      summary: { type: "string", description: "独立摘要；省略时取正文首段" },
      confirmed: {
        type: "string",
        description: "确认时间，RFC 3339 带显式 UTC 偏移（如 2026-09-05T00:00:00Z）",
      },
      id: {
        type: "string",
        description: "显式节点 ID（3-16 位 A-Z、0-9、_）；省略则自动生成",
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      const ws = requireWorkspace(get);
      if (args.confirmed !== undefined && !isValidConfirmed(args.confirmed)) {
        return invalidConfirmed(args.confirmed);
      }
      try {
        const id = await createPremise(ws.refinoDir, args);
        const outcome = await ws.sync([id]);
        return { ok: true, id, pending: outcome.pending.map(lite) };
      } catch (error) {
        return writeFailure(error);
      }
    },
  });
}

function createConstraintTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_create_constraint",
    description:
      "新增约束节点（会限制后续实现选择空间的项目决策）。grounds 为依据 ID 列表（上游约束或前提）；省略则创建根约束——根约束默认进入冻结区，只在确有必要时创建。",
    parameters: {
      body: { type: "string", required: true, description: "决策内容（Markdown 正文）" },
      summary: { type: "string", description: "独立摘要；省略时取正文首段" },
      rationale: { type: "string", description: "为什么从依据得出该决策" },
      grounds: {
        type: "array",
        items: { type: "string" },
        description: "依据节点 ID 列表；省略则创建根约束",
      },
      id: {
        type: "string",
        description: "显式节点 ID（3-16 位 A-Z、0-9、_）；省略则自动生成",
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      const ws = requireWorkspace(get);
      const grounds = args.grounds ?? [];
      if (args.id !== undefined && !ID_RE.test(args.id)) {
        return { ok: false, error: `节点 ID 必须是 3-16 位 A-Z、0-9 或 _，收到 "${args.id}"` };
      }
      if (args.id !== undefined && ws.graph.nodes.has(args.id)) {
        return { ok: false, error: `节点 ID "${args.id}" 已被占用` };
      }
      const id = args.id ?? generateId();
      const issues = checkProspectiveGrounds(ws.graph, id, grounds);
      if (issues.length > 0) {
        return { ok: false, error: "grounds 校验未通过", issues: issues.map(issueLite) };
      }
      try {
        const stored = await createConstraint(ws.refinoDir, { ...args, id, grounds });
        const outcome = await ws.sync([stored]);
        return { ok: true, id: stored, pending: outcome.pending.map(lite) };
      } catch (error) {
        return writeFailure(error);
      }
    },
  });
}

function updateNodeTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_update_node",
    description:
      "整体替换节点的可编辑字段：summary 与 body 必填。约束还须提供完整 grounds 列表（无依据传空数组），rationale 省略即清除；前提可带 confirmed，省略即清除。目标在冻结区或修改会波及冻结区内的下游约束时，返回结构化升级报告（正常结果，非报错）。",
    parameters: {
      id: { type: "string", required: true, description: "要修改的节点 ID" },
      summary: { type: "string", required: true, description: "新的独立摘要" },
      body: { type: "string", required: true, description: "新的正文（Markdown）" },
      grounds: {
        type: "array",
        items: { type: "string" },
        description: "约束的新依据 ID 列表（整体替换）；仅约束可用",
      },
      rationale: { type: "string", description: "约束的新理由；省略即清除；仅约束可用" },
      confirmed: { type: "string", description: "前提的新确认时间（RFC 3339 带偏移）；仅前提可用" },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      const ws = requireWorkspace(get);
      const node = ws.graph.nodes.get(args.id);
      if (node === undefined) {
        return { ok: false, error: `节点 "${args.id}" 不存在` };
      }
      const blocked = checkModification(ws.graph, ws.authorizationContext, node.id);
      if (!blocked.allowed) {
        return escalationResult(node.id, "node_frozen", blocked.report!.affected);
      }
      if (node.type === "premise") {
        return updatePremiseNode(ws, node, args);
      }
      return updateConstraintNode(ws, node, args);
    },
  });
}

type UpdateArgs = {
  id: string;
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
};

async function updatePremiseNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "premise" },
  args: UpdateArgs,
): Promise<WriteResult> {
  if (args.grounds !== undefined) {
    return { ok: false, error: "前提不携带 grounds" };
  }
  if (args.rationale !== undefined) {
    return { ok: false, error: "前提不携带 rationale" };
  }
  if (args.confirmed !== undefined && !isValidConfirmed(args.confirmed)) {
    return invalidConfirmed(args.confirmed);
  }
  const downstream = frozenDependents(ws.graph, ws.authorizationContext, [node.id]);
  if (downstream.length > 0) {
    return escalationResult(node.id, "downstream_frozen", downstream);
  }
  try {
    await updatePremise(ws.refinoDir, node.id, {
      body: args.body,
      summary: args.summary,
      confirmed: args.confirmed,
    });
  } catch (error) {
    return writeFailure(error);
  }
  const outcome = await ws.sync([node.id]);
  return { ok: true, id: node.id, pending: outcome.pending.map(lite) };
}

async function updateConstraintNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "constraint" },
  args: UpdateArgs,
): Promise<WriteResult> {
  if (args.confirmed !== undefined) {
    return { ok: false, error: "confirmed 仅适用于前提节点" };
  }
  if (args.grounds === undefined) {
    return {
      ok: false,
      error: "约束更新必须提供完整的 grounds 列表（保持不变也要原样传入；无依据时传空数组）",
    };
  }
  const issues = checkGroundsChange(ws.graph, node.id, args.grounds);
  if (issues.length > 0) {
    return { ok: false, error: "grounds 校验未通过", issues: issues.map(issueLite) };
  }
  const downstream = frozenDependents(ws.graph, ws.authorizationContext, [node.id]);
  if (downstream.length > 0) {
    return escalationResult(node.id, "downstream_frozen", downstream);
  }
  try {
    await updateConstraint(ws.refinoDir, node.id, {
      body: args.body,
      summary: args.summary,
      rationale: args.rationale,
      grounds: args.grounds,
    });
  } catch (error) {
    return writeFailure(error);
  }
  const outcome = await ws.sync([node.id]);
  return { ok: true, id: node.id, pending: outcome.pending.map(lite) };
}

function deleteNodeTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_delete_node",
    description:
      "删除节点。目标在冻结区时返回升级报告；仍有下游约束时拒绝并附受影响列表——先处理下游，再删除。",
    parameters: {
      id: { type: "string", required: true, description: "要删除的节点 ID" },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      const ws = requireWorkspace(get);
      const node = ws.graph.nodes.get(args.id);
      if (node === undefined) {
        return { ok: false, error: `节点 "${args.id}" 不存在` };
      }
      const blocked = checkModification(ws.graph, ws.authorizationContext, node.id);
      if (!blocked.allowed) {
        return escalationResult(node.id, "node_frozen", blocked.report!.affected);
      }
      const dependents = getDependents(ws.graph, node.id);
      if (dependents.length > 0) {
        return {
          ok: false,
          error: `节点 ${node.id} 仍有下游约束，不能删除`,
          dependents: dependents.map((dependent) => lite(dependent.node)),
        };
      }
      try {
        await deleteNode(ws.refinoDir, node.id);
      } catch (error) {
        return writeFailure(error);
      }
      await ws.sync([node.id]);
      return { ok: true, id: node.id, pending: [] };
    },
  });
}

// ---- shared write helpers ----

function renderWriteValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: renderWrite(value as WriteResult) }];
}

/** Validate a prospective creation: insert the new node into a graph copy, then use the engine primitive. */
function checkProspectiveGrounds(
  graph: RefinoWorkspace["graph"],
  id: string,
  grounds: string[],
): ReturnType<typeof checkGroundsChange> {
  const synthetic: RefinoNode = {
    id,
    type: "constraint",
    file: "",
    summary: "",
    body: "",
    grounds,
  };
  const prospective = buildGraph(graph.refinoDir, [...graph.nodes.values(), synthetic]);
  return checkGroundsChange(prospective, id, grounds);
}

function escalationResult(
  id: string,
  reason: EscalationReason,
  affected: NodeWithDepth[],
): WriteResult {
  return {
    ok: false,
    error:
      reason === "node_frozen"
        ? `节点 ${id} 位于冻结区，只读`
        : `修改 ${id} 会波及冻结区内的下游约束`,
    escalation: { id, reason, affected: affected.map(depthLite) },
  };
}

function invalidConfirmed(value: string): WriteResult {
  return {
    ok: false,
    error: `confirmed 必须是带显式 UTC 偏移的 RFC 3339 时间戳，收到 "${value}"`,
  };
}

function writeFailure(error: unknown): WriteResult {
  if (error instanceof RefinoError) {
    return { ok: false, error: `${error.code}: ${error.message}` };
  }
  if (error instanceof HarnessError) {
    return { ok: false, error: error.message };
  }
  throw error;
}
