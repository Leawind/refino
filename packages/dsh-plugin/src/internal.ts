import type { TraversalOptions } from "refino";
import type { RefinoWorkspace } from "./workspace.js";

/** Helpers shared by the query and write tool modules. */

export function requireWorkspace(get: () => RefinoWorkspace | undefined): RefinoWorkspace {
  const workspace = get();
  if (workspace === undefined) {
    throw new Error("refino workspace is unavailable for this agent");
  }
  return workspace;
}

/** Parameter schema for batch traversals (`ids` plus an optional depth bound). */
export function traversalParams(description: string) {
  return {
    ids: { type: "array", items: { type: "string" }, required: true, description },
    max_depth: {
      type: "integer",
      description: "最大遍历深度：1 只含直接依据/依赖，0 不含任何节点；省略则不限",
    },
  } as const;
}

/** Hand-checked constraint the schema DSL cannot express (cookbook: validate by hand). */
export function traversalOptions(maxDepth: number | undefined): TraversalOptions {
  if (maxDepth === undefined) return {};
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`max_depth must be a non-negative integer, got ${maxDepth}`);
  }
  return { maxDepth };
}

/** Canonical output schema shared by the three write tools. */
export function writeResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      id: { type: "string" },
      pending: { type: "array", items: nodeLiteSchema() },
      error: { type: "string" },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            code: { type: "string", required: true },
            message: { type: "string", required: true },
          },
        },
      },
      escalation: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          reason: { type: "string", required: true },
          affected: { type: "array", items: depthLiteSchema(), required: true },
        },
      },
      dependents: { type: "array", items: nodeLiteSchema() },
    },
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
