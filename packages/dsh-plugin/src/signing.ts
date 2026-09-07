import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  createRenderKit,
  createToolText,
  toolRefs,
  type ApprovalOutcome,
  type AuthorizationOrigin,
  type ContextStatusResult,
  type SignResult,
} from "@refino/harness";
import { createSigningCore, type RefinoWorkspace } from "@refino/harness/host";

/**
 * Dialogue signing tools as dsh native tools (docs/design.md, “冻结区签发
 * （对话签发）”): the model drafts a frozen-zone split, presents it in
 * conversation, and the tool asks dsh's native approval service for an
 * explicit human allow — fail-closed, and refused outright while an
 * orchestrator credential is active. The signing chain lives in the shared
 * core (`createSigningCore`); this file only declares the dsh tool schemas.
 */

export type { ApprovalOutcome, AuthorizationOrigin };

export interface SigningDeps {
  get: () => RefinoWorkspace | undefined;
  /** Ask the host's approval surface; resolves only on an explicit allow. */
  requestApproval: (reason: string) => Promise<ApprovalOutcome>;
  /** Deliver the frozen-zone delta to the conversation (may be undefined). */
  inject: (text: string | undefined) => void;
  /** Read/write the session's authorization-origin record. */
  origin: () => AuthorizationOrigin;
  setOrigin: (origin: AuthorizationOrigin) => void;
  /** Overridable for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const TOOL_PREFIX = "refino_";
const TEXT = createToolText(toolRefs(TOOL_PREFIX));
const kit = createRenderKit(toolRefs(TOOL_PREFIX));

export function createSigningTools(deps: SigningDeps): ToolDefinition[] {
  const core = createSigningCore(deps);
  return [requestAuthorizationTool(core), contextStatusTool(core)];
}

function requestAuthorizationTool(core: ReturnType<typeof createSigningCore>): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}request_authorization`,
    description: TEXT.requestAuthorization,
    parameters: {
      frozen_frontier: {
        type: "array",
        items: { type: "string" },
        required: true,
        description:
          "新冻结区的 frontier 约束 ID 列表（整体替换，冻结区即其全部祖先的闭包）；空列表表示解冻全部",
      },
      rationale: { type: "string", description: "为什么需要这一划分，供用户审阅" },
    },
    output: { schema: signResultSchema(), render: renderSignValue },
    async execute(args) {
      return core.requestAuthorization(args);
    },
  });
}

/** The context tool exists so hosts without the approval surface still get status reporting. */
function contextStatusTool(core: ReturnType<typeof createSigningCore>): ToolDefinition {
  return defineTool({
    name: `${TOOL_PREFIX}context`,
    description: TEXT.context,
    parameters: {},
    output: { schema: contextStatusSchema(), render: renderContextStatusValue },
    async execute() {
      return core.contextStatus();
    },
  });
}

/** Render adapter over the schema-loose value the tool schema hands back. */
function renderSignValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: kit.renderSign(value as SignResult) }];
}

function renderContextStatusValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: kit.renderContextStatus(value as ContextStatusResult) }];
}

function signResultSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      frontier: { type: "array", items: { type: "string" } },
      frozen_constraints: { type: "integer" },
      frozen_premises: { type: "integer" },
      redundant_frontier: { type: "array", items: { type: "string" } },
      unfrozen_roots: { type: "array", items: { type: "string" } },
      outcome: { type: "string" },
      error: { type: "string" },
    },
  } as const;
}

function contextStatusSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string", required: true },
      signed_at: { type: "string", required: true },
      frontier: { type: "array", items: { type: "string" }, required: true },
      frozen_constraints: { type: "integer", required: true },
      frozen_premises: { type: "integer", required: true },
      anchors_complete: { type: "boolean", required: true },
      orchestrator_credential: { type: "boolean", required: true },
    },
  } as const;
}
