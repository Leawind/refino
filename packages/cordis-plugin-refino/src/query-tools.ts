import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createRenderKit,
  createToolText,
  PARAM_TEXT,
  toolRefs,
  type ListResult,
  type PendingResult,
  type QueryEntryDepths,
  type QueryEntryFull,
  type QueryEntryNodes,
  type SearchResult,
  type SiblingsResult,
} from "@refino/harness";
import {
  runAncestors,
  runDependents,
  runGrounds,
  runList,
  runPendingReview,
  runSearch,
  runShow,
  runSiblings,
} from "@refino/harness/host";
import type { RefinoWorkspace } from "@refino/harness/host";
import { requireWorkspace } from "./internal.js";

/**
 * Read-only CRG access tools as dsh native tools: schema declarations over
 * the shared execution cores (docs/design.md, 模型侧：CRG 访问工具). Every
 * query is batch with partial-success semantics.
 */

/** dsh tool names are `<prefix><verb>`; injected texts cite the same names. */
const TOOL_PREFIX = "refino_";
const TOOLS = toolRefs(TOOL_PREFIX);
const TEXT = createToolText(TOOLS);
const kit = createRenderKit(TOOLS);

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
    name: `${TOOL_PREFIX}search`,
    description: TEXT.search,
    parameters: {
      q: { type: "string", description: PARAM_TEXT.searchQ },
      node_type: {
        type: "string",
        enum: ["premise", "constraint"],
        description: PARAM_TEXT.searchNodeType,
      },
      limit: { type: "integer", description: PARAM_TEXT.searchLimit },
      cursor: {
        type: "string",
        description: PARAM_TEXT.searchCursor,
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
      render: (_args, value) => [{ type: "text", text: kit.renderSearch(value as SearchResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runSearch(requireWorkspace(get), {
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
    name: `${TOOL_PREFIX}siblings`,
    description: TEXT.siblings,
    parameters: {
      ...idListParams(PARAM_TEXT.idsSiblings),
      limit: { type: "integer", description: PARAM_TEXT.siblingsLimit },
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
          text: kit.renderSiblings(value as SiblingsResult),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runSiblings(requireWorkspace(get), args.ids, args.limit);
    },
  });
}

function listTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}list`,
    description: TEXT.list,
    parameters: {
      node_type: {
        type: "string",
        enum: ["premise", "constraint"],
        description: PARAM_TEXT.listNodeType,
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
      render: (_args, value) => [{ type: "text", text: kit.renderList(value as ListResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runList(requireWorkspace(get), args.node_type);
    },
  });
}

function showTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}show`,
    description: TEXT.show,
    parameters: idListParams(PARAM_TEXT.idsShow),
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
          text: kit.renderEntries(value.results as QueryEntryFull[], (entry) =>
            entry.node === undefined ? [] : [kit.renderFullNode(entry.node)],
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runShow(requireWorkspace(get), args.ids);
    },
  });
}

function groundsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}grounds`,
    description: TEXT.grounds,
    parameters: idListParams(PARAM_TEXT.idsGrounds),
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
          text: kit.renderEntries(value.results as QueryEntryNodes[], (entry) =>
            entry.nodes === undefined ? [] : entry.nodes.map(kit.nodeLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runGrounds(requireWorkspace(get), args.ids);
    },
  });
}

function ancestorsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}ancestors`,
    description: TEXT.ancestors,
    parameters: traversalParams(PARAM_TEXT.idsAncestors),
    output: {
      schema: depthsResultSchema(),
      render: (_args, value) => [
        {
          type: "text",
          text: kit.renderEntries(value.results as QueryEntryDepths[], (entry) =>
            entry.nodes === undefined || entry.nodes.length === 0
              ? []
              : entry.nodes.map(kit.depthLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runAncestors(requireWorkspace(get), args.ids, args.max_depth);
    },
  });
}

function dependentsTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}dependents`,
    description: TEXT.dependents,
    parameters: traversalParams(PARAM_TEXT.idsDependents),
    output: {
      schema: depthsResultSchema(),
      render: (_args, value) => [
        {
          type: "text",
          text: kit.renderEntries(value.results as QueryEntryDepths[], (entry) =>
            entry.nodes === undefined || entry.nodes.length === 0
              ? []
              : entry.nodes.map(kit.depthLine),
          ),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runDependents(requireWorkspace(get), args.ids, args.max_depth);
    },
  });
}

function pendingReviewTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}pending_review`,
    description: TEXT.pendingReview,
    parameters: {
      changed_ids: {
        type: "array",
        items: { type: "string" },
        required: true,
        description: PARAM_TEXT.changedIds,
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
      render: (_args, value) => [{ type: "text", text: kit.renderPending(value as PendingResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return runPendingReview(requireWorkspace(get), args.changed_ids);
    },
  });
}

/** Parameter schema for batch traversals (`ids` plus an optional depth bound). */
function traversalParams(description: string) {
  return {
    ids: { type: "array", items: { type: "string" }, required: true, description },
    max_depth: { type: "integer", description: PARAM_TEXT.maxDepth },
  } as const;
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

function depthsResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            nodes: { type: "array", items: depthLiteSchema() },
            error: { type: "string" },
          },
        },
        required: true,
      },
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
