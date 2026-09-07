import {
  applyAuthorization,
  type ApplyPreview,
  type SignedAuthorization,
} from "./authorization.js";
import { frozenZone } from "./boundary.js";
import { defaultAuthorizationContext } from "./default.js";
import { HarnessError } from "./errors.js";
import { updateText } from "./inject-text.js";
import { orchestratorCredential } from "./state.js";
import type { ApprovalOutcome, ContextStatusResult, SignResult } from "./shapes.js";
import type { AuthorizationOrigin } from "./inject-text.js";
import type { RefinoWorkspace } from "./workspace.js";

/**
 * Dialogue signing core (docs/design.md, “冻结区签发（对话签发）”): the model
 * drafts a frozen-zone split, presents it in conversation, and the host asks
 * its approval surface for an explicit human allow before anything takes
 * effect — fail-closed, and refused outright while an orchestrator
 * credential is active. An approved signing applies to the session and goes
 * out as one delta injection; it lives in process memory only — the plugin
 * forms write no state files anywhere (docs/design.md, “授权状态的作用域”:
 * the plugin form's conversation lane is the session).
 *
 * Host adapters provide the approval surface (dsh: the native approval
 * service; MCP-only hosts: the dialogue-approval protocol, where the
 * presentation-before-call requirement lives in the tool description and
 * skill rules) and the injection channel.
 */

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

export interface SigningCore {
  /** Execute the request-authorization tool for a draft. */
  requestAuthorization(args: {
    frozen_frontier: string[];
    rationale?: string;
  }): Promise<SignResult>;
  /** Execute the context-status tool. */
  contextStatus(): ContextStatusResult;
}

export function createSigningCore(deps: SigningDeps): SigningCore {
  const env = deps.env ?? process.env;
  // Session-local signing counter; purely cosmetic (nothing consumes it),
  // it gives each in-session signing a distinct document revision.
  let sessionRevision = 0;

  async function requestAuthorization(args: {
    frozen_frontier: string[];
    rationale?: string;
  }): Promise<SignResult> {
    const ws = deps.get();
    if (ws === undefined) throw new Error("refino workspace is unavailable");
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
    deps.inject(updateText(delta, [], [], []));
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
  }

  function contextStatus(): ContextStatusResult {
    const ws = deps.get();
    if (ws === undefined) throw new Error("refino workspace is unavailable");
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
  }

  return { requestAuthorization, contextStatus };
}

/** The approval-surface request text the user reviews (with the draft preview). */
export function approvalReason(
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

export const OUTCOME_TEXT: Record<ApprovalOutcome, string> = {
  "allowed-once": "已批准。",
  rejected:
    "用户拒绝了该提议；授权维持现状。不得绕过（包括直接改文件或授权文件），可按用户反馈调整后再次提议。",
  cancelled: "签发请求已取消；授权维持现状。",
  unavailable: "宿主审批面不可用（无应答者或处于免审批策略）：无法获得人的明确批准，签发未生效。",
} as const;
