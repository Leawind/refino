import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome } from "@deepseek-ai/dsh-user-approval";
import {
  applyAuthorization,
  defaultAuthorizationContext,
  frozenZone,
  HarnessError,
  type ApplyPreview,
  type SignedAuthorization,
} from "@refino/harness";
import { orchestratorCredential } from "@refino/harness/state";
import { renderContextStatus, renderSign } from "./render.js";
import { updateText } from "./inject-text.js";
import { requireWorkspace } from "./internal.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * Dialogue signing tools (docs/design.md, “冻结区签发（对话签发）”): the
 * model drafts a frozen-zone split, presents it in conversation, and the
 * tool asks the host's approval surface for an explicit human allow before
 * anything takes effect — fail-closed, and refused outright while an
 * orchestrator credential is active. An approved signing applies to the
 * session and goes out as one delta injection; it lives in process memory
 * only — the plugin writes no state files anywhere (docs/design.md,
 * “授权状态的作用域”: the plugin form's conversation lane is the session).
 */

/**
 * Where the effective authorization came from; surfaced by refino_context
 * and the injected status lines. Session signings carry the moment they were
 * approved; nothing else persists.
 */
export interface AuthorizationOrigin {
  source: "default" | "orchestrator" | "session";
  signedAt: string;
}

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

export function createSigningTools(deps: SigningDeps): ToolDefinition[] {
  return [requestAuthorizationTool(deps), contextStatusTool(deps)];
}

function requestAuthorizationTool(deps: SigningDeps): ToolDefinition {
  const env = deps.env ?? process.env;
  // Session-local signing counter; purely cosmetic (nothing consumes it),
  // it gives each in-session signing a distinct document revision.
  let sessionRevision = 0;
  return defineTool({
    name: "refino_request_authorization",
    description:
      "提议新的冻结区划分并请求用户批准（对话签发，frontier 整体替换）。调用前必须先在对话中向用户呈现完整的划分草案与理由。用户批准后在会话内立即生效（不落文件，resume 后回落）；拒绝、取消或审批面不可用时授权维持现状。编排者凭据生效时本工具拒绝执行——任务内授权不可自我扩张。",
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
      const ws = requireWorkspace(deps.get);
      const graph = ws.graph;
      if (orchestratorCredential({}, env) !== undefined) {
        return {
          ok: false,
          error:
            "编排者凭据（REFINO_AUTHORIZATION）生效：任务内授权不可自我扩张，调整冻结区须回到签发者。",
        };
      }

      let doc: SignedAuthorization;
      let preview: ApplyPreview;
      try {
        ({ doc, preview } = applyAuthorization(
          graph,
          { frozenFrontier: args.frozen_frontier },
          { revision: sessionRevision + 1 },
        ));
      } catch (error) {
        if (error instanceof HarnessError) return { ok: false, error: error.message };
        throw error;
      }
      sessionRevision += 1;

      const outcome = await deps.requestApproval(approvalReason(args.rationale, doc, preview));
      if (outcome !== "allowed-once") {
        return { ok: false, outcome, error: OUTCOME_TEXT[outcome] ?? "未获批准，授权维持现状。" };
      }

      // Apply to the live session and push the delta: the signed list is the
      // same object shape as the session context's frozen list, and anchors
      // are runtime-derived, so they carry over unchanged.
      const delta = ws.signContext({
        anchors: ws.authorizationContext.anchors,
        frozen: doc.frozenFrontier,
      });
      deps.inject(updateText(delta, []));
      deps.setOrigin({ source: "session", signedAt: doc.signedAt });

      return {
        ok: true,
        frontier: doc.frozenFrontier,
        frozen_constraints: preview.frozenConstraints,
        frozen_premises: preview.frozenPremises,
        ...(preview.redundantFrontier.length > 0 && {
          redundant_frontier: preview.redundantFrontier,
        }),
        ...(preview.unfrozenRoots.length > 0 && { unfrozen_roots: preview.unfrozenRoots }),
      };
    },
  });
}

/** The context tool needs the origin only; it exists so hosts without the approval surface still get status reporting. */
function contextStatusTool(deps: SigningDeps): ToolDefinition {
  const env = deps.env ?? process.env;
  return defineTool({
    name: "refino_context",
    description:
      "重述当前生效的授权：来源与签发时间、冻结 frontier、冻结区计数、锚点注入策略，以及编排者凭据是否生效（生效时签发被拒绝）。",
    parameters: {},
    output: { schema: contextStatusSchema(), render: renderContextStatusValue },
    async execute() {
      const ws = requireWorkspace(deps.get);
      const graph = ws.graph;
      const zone = frozenZone(graph, ws.authorizationContext);
      const origin = deps.origin();
      return {
        source: origin.source,
        signed_at: origin.signedAt,
        frontier: [...ws.authorizationContext.frozen],
        frozen_constraints: zone.filter((n) => n.type === "constraint").length,
        frozen_premises: zone.filter((n) => n.type === "premise").length,
        anchors_complete: defaultAuthorizationContext(graph).complete,
        orchestrator_credential: orchestratorCredential({}, env) !== undefined,
      };
    },
  });
}

function approvalReason(
  rationale: string | undefined,
  doc: SignedAuthorization,
  preview: ApplyPreview,
): string {
  return [
    "refino 冻结区签发请求（对话签发，会话内生效）：",
    rationale !== undefined && rationale.length > 0 ? `理由：${rationale}` : "理由：（模型未提供）",
    `新冻结区：${preview.frozenConstraints} 个约束、${preview.frozenPremises} 个前提`,
    `frontier：${doc.frozenFrontier.length > 0 ? doc.frozenFrontier.join(", ") : "（空，全部解冻）"}`,
    ...(preview.redundantFrontier.length > 0
      ? [`frontier 归约：${preview.redundantFrontier.join(", ")} 被其他 frontier 约束覆盖`]
      : []),
    ...(preview.unfrozenRoots.length > 0
      ? [`警告：以下根约束将解冻，需要项目最高级别的授权：${preview.unfrozenRoots.join(", ")}`]
      : []),
    "批准后在会话内立即生效；拒绝则维持当前授权。",
  ].join("\n");
}

const OUTCOME_TEXT: Record<ApprovalOutcome, string> = {
  "allowed-once": "已批准。",
  rejected:
    "用户拒绝了该提议；授权维持现状。不得绕过（包括直接改文件或授权文件），可按用户反馈调整后再次提议。",
  cancelled: "签发请求已取消；授权维持现状。",
  unavailable: "宿主审批面不可用（无应答者或处于免审批策略）：无法获得人的明确批准，签发未生效。",
};

/** Render adapter over the schema-loose value the tool schema hands back. */
function renderSignValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: renderSign(value as SignResultValue) }];
}

function renderContextStatusValue(_args: unknown, value: unknown) {
  return [{ type: "text" as const, text: renderContextStatus(value as ContextStatusValue) }];
}

interface SignResultValue {
  ok: boolean;
  frontier?: string[];
  frozen_constraints?: number;
  frozen_premises?: number;
  redundant_frontier?: string[];
  unfrozen_roots?: string[];
  outcome?: string;
  error?: string;
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

interface ContextStatusValue {
  source: string;
  signed_at: string;
  frontier: string[];
  frozen_constraints: number;
  frozen_premises: number;
  anchors_complete: boolean;
  orchestrator_credential: boolean;
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
