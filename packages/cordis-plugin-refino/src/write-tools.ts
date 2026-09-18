import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createRenderKit,
  createToolText,
  PARAM_TEXT,
  toolRefs,
  type WriteResult,
} from "@refino/harness";
import {
  runCreateConstraint,
  runCreatePremise,
  runDeleteNode,
  runUpdateNode,
  type RefinoWorkspace,
} from "@refino/harness/host";
import { requireWorkspace, writeResultSchema } from "./internal.js";

/**
 * CRG write tools as dsh native tools: schema declarations over the shared
 * write cores (docs/design.md, dsh 插件落地形态). The write chain — engine
 * grounds validation, harness boundary check, structured escalation reports
 * — lives in the cores, shared with every other host.
 */

const TOOL_PREFIX = "refino_";
const TEXT = createToolText(toolRefs(TOOL_PREFIX));
const kit = createRenderKit(toolRefs(TOOL_PREFIX));

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
    name: `${TOOL_PREFIX}create_premise`,
    description: TEXT.createPremise,
    parameters: {
      body: { type: "string", required: true, description: PARAM_TEXT.bodyPremise },
      summary: { type: "string", description: PARAM_TEXT.summary },
      confirmed: {
        type: "string",
        description: PARAM_TEXT.confirmed,
      },
      id: {
        type: "string",
        description: PARAM_TEXT.explicitId,
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      return runCreatePremise(requireWorkspace(get), args);
    },
  });
}

function createConstraintTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}create_constraint`,
    description: TEXT.createConstraint,
    parameters: {
      body: { type: "string", required: true, description: PARAM_TEXT.bodyConstraint },
      summary: { type: "string", description: PARAM_TEXT.summary },
      rationale: { type: "string", description: PARAM_TEXT.rationaleCreate },
      grounds: {
        type: "array",
        items: { type: "string" },
        description: PARAM_TEXT.grounds,
      },
      id: {
        type: "string",
        description: PARAM_TEXT.explicitId,
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      return runCreateConstraint(requireWorkspace(get), args);
    },
  });
}

function updateNodeTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}update_node`,
    description: TEXT.updateNode,
    parameters: {
      id: { type: "string", required: true, description: PARAM_TEXT.updateId },
      summary: {
        type: "string",
        description: PARAM_TEXT.updateSummary,
      },
      body: { type: "string", description: PARAM_TEXT.updateBody },
      grounds: {
        type: "array",
        items: { type: "string" },
        description: PARAM_TEXT.updateGrounds,
      },
      rationale: {
        type: "string",
        description: PARAM_TEXT.updateRationale,
      },
      confirmed: {
        type: "string",
        description: PARAM_TEXT.updateConfirmed,
      },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      return runUpdateNode(requireWorkspace(get), args);
    },
  });
}

function deleteNodeTool(get: () => RefinoWorkspace | undefined): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}delete_node`,
    description: TEXT.deleteNode,
    parameters: {
      id: { type: "string", required: true, description: PARAM_TEXT.deleteId },
    },
    output: { schema: writeResultSchema(), render: renderWriteValue },
    async execute(args) {
      return runDeleteNode(requireWorkspace(get), args.id);
    },
  });
}

function renderWriteValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: kit.renderWrite(value as WriteResult) }];
}
