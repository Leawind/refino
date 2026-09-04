import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  getAncestors,
  getDependents,
  getGrounds,
  queryGroups,
  requireNode,
  type NodeWithDepth,
  type RefinoNode,
} from "refino";
import type { QueryEntryDepths, QueryEntryFull, QueryEntryNodes } from "./shapes.js";
import { depthLite, fullLite, lite, type ListResult, type PendingResult } from "./shapes.js";
import {
  depthLine,
  nodeLine,
  renderEntries,
  renderFullNode,
  renderList,
  renderPending,
} from "./render.js";
import { requireWorkspace, traversalOptions, traversalParams } from "./internal.js";
import type { RefinoWorkspace } from "./workspace.js";

/** Read-only CRG access tools; every query is batch with partial-success semantics. */
export function createQueryTools(get: () => RefinoWorkspace | undefined): ToolDefinition[] {
  return [
    listTool(get),
    showTool(get),
    groundsTool(get),
    ancestorsTool(get),
    dependentsTool(get),
    pendingReviewTool(get),
  ];
}

function listTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_list",
    description:
      "列出 CRG 中的节点（ID、类型、摘要）。图很大时优先用上下游查询定向获取，不要依赖全量列表。",
    parameters: {
      node_type: {
        type: "string",
        enum: ["premise", "constraint"],
        description: "只列出该类型的节点；省略则全部列出",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", required: true },
          issue_count: {
            type: "integer",
            required: true,
            description: "图当前携带的解析/结构问题数；大于 0 时查询结果可能有歧义",
          },
          nodes: { type: "array", items: nodeLiteSchema(), required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderList(value as ListResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const nodes = ws.session.listNodes(args.node_type);
      const result: ListResult = {
        total: nodes.length,
        issue_count: ws.issues.length,
        nodes: nodes.map(lite),
      };
      return result;
    },
  });
}

function showTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_show",
    description:
      "按 ID 批量读取节点的完整内容（正文、理由、依据、确认时间）。部分成功：不存在的 ID 以错误条目返回。",
    parameters: idListParams("要读取的节点 ID 列表"),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: { type: "array", items: fullEntrySchema(), required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderEntries(value.results as QueryEntryFull[], (entry) =>
            entry.node === undefined ? [] : [renderFullNode(entry.node)],
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const groups = queryGroups(ws.graph, args.ids, (graph, id) => [requireNode(graph, id)]);
      const results: QueryEntryFull[] = groups.map((group) =>
        "error" in group
          ? { id: group.id, error: group.error }
          : { id: group.id, node: fullLite(group.results[0]!) },
      );
      return { results };
    },
  });
}

function groundsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_grounds",
    description: "按 ID 批量读取节点的直接依据（作为其依据的上游约束与前提）。部分成功。",
    parameters: idListParams("要查询依据的节点 ID 列表"),
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: { type: "array", items: nodesEntrySchema(), required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderEntries(value.results as QueryEntryNodes[], (entry) =>
            entry.nodes === undefined ? [] : entry.nodes.map(nodeLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const groups = queryGroups(ws.graph, args.ids, (graph, id) => getGrounds(graph, id));
      return { results: groups.map(toNodesEntry) };
    },
  });
}

function ancestorsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_ancestors",
    description:
      "按 ID 批量读取节点的全部祖先约束与前提（沿依据向上，含相对深度）。用于恢复某个决策的上游背景。部分成功。",
    parameters: traversalParams("要向上追溯的节点 ID 列表"),
    output: {
      schema: depthsResultSchema(),
      render: (_args, value) => [
        {
          type: "text",
          text: renderEntries(value.results as QueryEntryDepths[], (entry) =>
            entry.nodes === undefined || entry.nodes.length === 0 ? [] : entry.nodes.map(depthLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const options = traversalOptions(args.max_depth);
      const groups = queryGroups(ws.graph, args.ids, (graph, id) =>
        getAncestors(graph, id, options),
      );
      return { results: groups.map(toDepthsEntry) };
    },
  });
}

function dependentsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_dependents",
    description:
      "按 ID 批量读取节点的受影响约束集（沿依据边向下的传递闭包，含相对深度）。修改或删除节点前用它判断下游影响范围。部分成功。",
    parameters: traversalParams("要向下追溯的节点 ID 列表"),
    output: {
      schema: depthsResultSchema(),
      render: (_args, value) => [
        {
          type: "text",
          text: renderEntries(value.results as QueryEntryDepths[], (entry) =>
            entry.nodes === undefined || entry.nodes.length === 0 ? [] : entry.nodes.map(depthLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const options = traversalOptions(args.max_depth);
      const groups = queryGroups(ws.graph, args.ids, (graph, id) =>
        getDependents(graph, id, options),
      );
      return { results: groups.map(toDepthsEntry) };
    },
  });
}

function pendingReviewTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_pending_review",
    description:
      "登记最近发生变化的节点 ID，重载图的最新状态，并返回因此进入待审查状态的直接下游约束（修改前应先复核它们）。",
    parameters: {
      changed_ids: {
        type: "array",
        items: { type: "string" },
        required: true,
        description: "发生变化（被修改、新增或删除）的节点 ID 列表",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pending: { type: "array", items: nodeLiteSchema(), required: true },
          unknown_ids: { type: "array", items: { type: "string" }, required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderPending(value as PendingResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const outcome = await ws.sync(args.changed_ids);
      const known = ws.graph.nodes;
      return {
        pending: outcome.pending.map(lite),
        unknown_ids: args.changed_ids.filter((id) => !known.has(id)),
      };
    },
  });
}

// ---- shared parameter/output schemas ----

function idListParams(description: string) {
  return {
    ids: { type: "array", items: { type: "string" }, required: true, description },
  } as const;
}

function nodeLiteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      type: { type: "string", required: true },
      summary: { type: "string", required: true },
    },
  } as const;
}

function nodesEntrySchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      nodes: { type: "array", items: nodeLiteSchema() },
      error: { type: "string" },
    },
  } as const;
}

function fullEntrySchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      node: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          type: { type: "string", required: true },
          summary: { type: "string", required: true },
          body: { type: "string", required: true },
          rationale: { type: "string" },
          grounds: { type: "array", items: { type: "string" } },
          confirmed: { type: "string" },
        },
      },
      error: { type: "string" },
    },
  } as const;
}

function depthsEntrySchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      nodes: { type: "array", items: depthLiteSchema() },
      error: { type: "string" },
    },
  } as const;
}

function depthsResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      results: { type: "array", items: depthsEntrySchema(), required: true },
    },
  } as const;
}

function depthLiteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      type: { type: "string", required: true },
      summary: { type: "string", required: true },
      depth: { type: "integer", required: true },
    },
  } as const;
}

// ---- shared execute helpers ----

function toNodesEntry(
  group: { id: string } & ({ results: RefinoNode[] } | { error: string }),
): QueryEntryNodes {
  return "error" in group
    ? { id: group.id, error: group.error }
    : { id: group.id, nodes: group.results.map(lite) };
}

function toDepthsEntry(
  group: { id: string } & ({ results: NodeWithDepth[] } | { error: string }),
): QueryEntryDepths {
  return "error" in group
    ? { id: group.id, error: group.error }
    : { id: group.id, nodes: group.results.map(depthLite) };
}
