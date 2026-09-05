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
import { checkModification, HarnessError } from "@refino/harness";
import {
  createConstraint,
  createPremise,
  deleteNode,
  readNode,
  updateConstraint,
  updatePremise,
} from "@refino/storage";
import { depthLite, issueLite, lite, type WriteResult } from "./shapes.js";
import { renderWrite } from "./render.js";
import { requireWorkspace, writeResultSchema } from "./internal.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * CRG write tools (docs/design.md, dsh 插件落地形态). Every write walks the
 * same chain before persisting: engine `checkGroundsChange` (create validates
 * against a prospective graph copy) and harness `checkModification` — a
 * frozen-zone target returns a structured escalation report as a normal tool
 * result, never an error. The modification space closes downwards along
 * dependents (docs/crg.md 2.4), so no downstream-freeze check exists. The
 * target's own sync runs after persisting; its pending-review set rides the
 * result instead of being injected.
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
      "部分更新节点的可编辑字段：省略的字段保持不变，传空串清除该可选属性（summary 清除后回退为正文首段派生）。约束的 grounds 提供时整体替换并经校验，省略则保持不变。至少提供一个字段。目标在冻结区（只读）时返回结构化升级报告（正常结果，非报错）。",
    parameters: {
      id: { type: "string", required: true, description: "要修改的节点 ID" },
      summary: {
        type: "string",
        description: "新的独立摘要；省略保持不变；空串清除（回退为正文派生）",
      },
      body: { type: "string", description: "新的正文（Markdown）；省略保持不变" },
      grounds: {
        type: "array",
        items: { type: "string" },
        description: "约束的新依据 ID 列表（整体替换并校验）；省略保持不变；仅约束可用",
      },
      rationale: {
        type: "string",
        description: "约束的新理由；省略保持不变；空串清除；仅约束可用",
      },
      confirmed: {
        type: "string",
        description: "前提的新确认时间（RFC 3339 带偏移）；省略保持不变；空串清除；仅前提可用",
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      const ws = requireWorkspace(get);
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
    },
  });
}

type UpdateArgs = {
  id: string;
  summary?: string;
  body?: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
};

/**
 * The updated summary per the partial semantics (docs/design.md): an omitted
 * summary keeps an explicit one and stays body-derived otherwise, so updating
 * the body alone keeps the fallback in sync; an empty string clears the
 * explicit summary. Reads the file for the explicit-summary flag, which the
 * in-memory graph does not carry.
 */
async function mergedSummary(
  ws: RefinoWorkspace,
  id: string,
  args: UpdateArgs,
): Promise<string | undefined | WriteResult> {
  const read = await readNode(ws.refinoDir, id);
  if (read.node === null) return { ok: false, error: `节点 "${id}" 不存在` };
  if (args.summary === undefined)
    return read.summaryExplicit === true ? read.node.summary : undefined;
  return args.summary === "" ? undefined : args.summary;
}

async function updatePremiseNode(
  ws: RefinoWorkspace,
  node: RefinoNode & { type: "premise" },
  args: UpdateArgs,
): Promise<WriteResult> {
  if (args.body !== undefined && args.body === "") {
    return { ok: false, error: "body 不能为空" };
  }
  if (args.confirmed !== undefined && args.confirmed !== "" && !isValidConfirmed(args.confirmed)) {
    return invalidConfirmed(args.confirmed);
  }
  // Rationale and grounds do not apply to premises; per the misplaced-field
  // policy they are silently ignored instead of rejected.
  const summary = await mergedSummary(ws, node.id, args);
  if (typeof summary === "object") return summary;
  try {
    await updatePremise(ws.refinoDir, node.id, {
      body: args.body ?? node.body,
      summary,
      confirmed:
        args.confirmed === undefined
          ? node.confirmed
          : args.confirmed === ""
            ? undefined
            : args.confirmed,
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
  if (args.body !== undefined && args.body === "") {
    return { ok: false, error: "body 不能为空" };
  }
  // `confirmed` does not apply to constraints; per the misplaced-field policy
  // it is silently ignored instead of rejected.
  if (args.grounds !== undefined) {
    const issues = checkGroundsChange(ws.graph, node, args.grounds);
    if (issues.length > 0) {
      return { ok: false, error: "grounds 校验未通过", issues: issues.map(issueLite) };
    }
  }
  const summary = await mergedSummary(ws, node.id, args);
  if (typeof summary === "object") return summary;
  try {
    await updateConstraint(ws.refinoDir, node.id, {
      body: args.body ?? node.body,
      summary,
      rationale:
        args.rationale === undefined
          ? node.rationale
          : args.rationale === ""
            ? undefined
            : args.rationale,
      grounds: args.grounds ?? node.grounds,
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
    summary: "",
    body: "",
    grounds,
  };
  const prospective = buildGraph([...graph.nodes.values(), synthetic]);
  return checkGroundsChange(prospective, synthetic, grounds);
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
  if (error instanceof RefinoError) {
    return { ok: false, error: `${error.code}: ${error.message}` };
  }
  if (error instanceof HarnessError) {
    return { ok: false, error: error.message };
  }
  throw error;
}
