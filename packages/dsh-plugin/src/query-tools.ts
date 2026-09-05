import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { pendingReview } from "@refino/harness";
import {
  getAncestors,
  getDependents,
  getGrounds,
  getSiblings,
  queryGroups,
  requireNode,
  type NodeWithDepth,
  type RefinoNode,
} from "refino";
import type {
  QueryEntryDepths,
  QueryEntryFull,
  QueryEntryNodes,
  QueryEntrySiblings,
} from "./shapes.js";
import {
  depthLite,
  fullLite,
  lite,
  type ListResult,
  type PendingResult,
  type SearchResult,
  type SiblingsResult,
} from "./shapes.js";
import {
  depthLine,
  nodeLine,
  renderEntries,
  renderFullNode,
  renderList,
  renderPending,
  renderSearch,
  renderSiblings,
} from "./render.js";
import { requireWorkspace, traversalOptions, traversalParams } from "./internal.js";
import type { RefinoWorkspace } from "./workspace.js";

/** Read-only CRG access tools; every query is batch with partial-success semantics. */
export function createQueryTools(get: () => RefinoWorkspace | undefined): ToolDefinition[] {
  return [
    listTool(get),
    searchTool(get),
    showTool(get),
    groundsTool(get),
    ancestorsTool(get),
    dependentsTool(get),
    siblingsTool(get),
    pendingReviewTool(get),
  ];
}

function searchTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_search",
    description:
      "按关键字分页搜索 CRG 节点（匹配 ID 前缀与摘要子串）。大规模图中定位节点的首选方式；图很小或已给出确切 ID 时可直接用 refino_show。",
    parameters: {
      q: { type: "string", description: "关键字；匹配 ID 前缀或摘要子串，省略匹配全部" },
      node_type: {
        type: "string",
        enum: ["premise", "constraint"],
        description: "只搜索该类型的节点；省略则全部",
      },
      limit: { type: "integer", description: "每页条数（1-500，默认 50）" },
      cursor: {
        type: "string",
        description: "上一页结果返回的 next_cursor；从该 ID 之后继续",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", required: true },
          nodes: { type: "array", items: nodeLiteSchema(), required: true },
          next_cursor: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderSearch(value as SearchResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      return ws.session.search({
        q: args.q,
        type: args.node_type,
        limit: args.limit,
        cursor: args.cursor,
      });
    },
  });
}

function siblingsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: "refino_siblings",
    description:
      "按 ID 批量读取节点的强兄弟（共享至少一个直接依据的约束，含共享数，按重叠数降序）。细化决策前用它参考同一问题下的同级决策，保持方案一致。部分成功。",
    parameters: {
      ...idListParams("要查询强兄弟的节点 ID 列表"),
      limit: { type: "integer", description: "每个 ID 最多返回的兄弟数；省略则全部" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: { type: "array", items: siblingsEntrySchema(), required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text: renderSiblings(value as SiblingsResult),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ws = requireWorkspace(get);
      const groups = queryGroups(ws.graph, args.ids, (graph, id) => {
        const all = getSiblings(graph, id);
        const kept = args.limit === undefined ? all : all.slice(0, args.limit);
        return kept.map(({ node, overlap }) => ({ ...lite(node), overlap }));
      });
      const results: QueryEntrySiblings[] = groups.map((group) =>
        "error" in group
          ? { id: group.id, error: group.error }
          : { id: group.id, nodes: group.results },
      );
      return { results } satisfies SiblingsResult;
    },
  });
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
      const results: QueryEntryFull[] = [];
      for (const group of groups) {
        if ("error" in group) {
          results.push({ id: group.id, error: group.error });
          continue;
        }
        // Body and rationale are paged content; fetch them per id.
        const content = await ws.content(group.id);
        results.push({ id: group.id, node: fullLite(group.results[0]!, content) });
      }
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
      const known = ws.graph.nodes;
      const changedKnown = args.changed_ids.filter((id) => known.has(id));
      const pending = changedKnown.length > 0 ? pendingReview(ws.graph, changedKnown) : [];
      return {
        pending: pending.map(lite),
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
          confirmed: { type: "number" },
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

function siblingsEntrySchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", required: true },
      nodes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            type: { type: "string", required: true },
            summary: { type: "string", required: true },
            overlap: { type: "integer", required: true },
          },
        },
      },
      error: { type: "string" },
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
