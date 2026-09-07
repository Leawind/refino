import type { RefinoWorkspace } from "@refino/harness/host";

/** Helpers shared by the query and write tool modules. */

export function requireWorkspace(get: () => RefinoWorkspace | undefined): RefinoWorkspace {
  const workspace = get();
  if (workspace === undefined) {
    throw new Error("refino workspace is unavailable for this agent");
  }
  return workspace;
}

/** Canonical output schema shared by the four write tools. */
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
