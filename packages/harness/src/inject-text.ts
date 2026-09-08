import { renderContext } from "./context.js";
import type { Graph, RefinoNode } from "refino";
import type { AuthorizationContext, DeltaEvent, ToolRefs } from "./types.js";

/**
 * Model-facing message texts shared by the tool plugins (docs/design.md,
 * dsh 插件落地形态). Pure rendering: hosts frame these as durable
 * plugin-sourced messages. Texts that name tools cite them through the
 * host's tool-name refs — host-owned names (`refino_*`) or bare short names
 * when the host injects full names itself (MCP hosts); never a hard-coded
 * host prefix.
 */

/**
 * Where the effective authorization came from; surfaced by the context tool
 * and the injected status lines. Session signings carry the moment they were
 * approved; nothing else persists.
 */
export interface AuthorizationOrigin {
  source: "default" | "orchestrator" | "session";
  signedAt: string;
}

/**
 * Wrap text in the plugin-owned `<system-reminder>` frame; exported for
 * host-specific texts that share the frame (e.g. the cc plugin's neutral
 * resume line).
 */
export function reminderFrame(body: string): string {
  return frame(body);
}

/** Wrap rendered context in the plugin-owned `<system-reminder>` frame. */
function frame(body: string): string {
  return `<system-reminder>\n${sanitize(body)}\n</system-reminder>`;
}

/** A repository-controlled closing tag inside node text must not close the frame. */
function sanitize(text: string): string {
  return text.replaceAll("</system-reminder", "</system-reminder\\>");
}

/**
 * The initial task context: anchors (frozen ones marked `[冻结]`) and all
 * premises as summaries, closed by the frozen-marking protocol statement
 * (docs/design.md, 上下文注入协议). The frozen zone is not enumerated —
 * frozen status is annotated wherever a node is rendered. Summaries only
 * (two-level injection) — full bodies are fetched via tools. The trailing
 * origin line carries the signing-ownership check for sequential tasks.
 */
export function initialContextText(
  graph: Graph,
  context: AuthorizationContext,
  tools: ToolRefs,
  origin?: AuthorizationOrigin,
): string {
  return frame(
    [
      "以下是与当前任务相关的 CRG（约束细化图）上下文。约束是项目已作出的、会限制后续实现选择空间的决策；前提是项目运作依赖的客观事实。",
      renderContext(graph, context),
      ownershipLine(origin),
      `以上为摘要级内容，正文与理由未包含。完整内容与上下游经 ${tools.show} 等查询工具按需获取；调整冻结区经 ${tools.requestAuthorization}（须经用户批准）。`,
    ].join("\n\n"),
  );
}

/** Signing-ownership check: sequential tasks must notice a foreign signing. */
function ownershipLine(origin: AuthorizationOrigin | undefined): string | undefined {
  if (origin === undefined) return undefined;
  if (origin.source === "default") return "授权：默认上下文（未签发）。";
  if (origin.source === "session") {
    return `授权：本会话内签发（signedAt ${origin.signedAt}）。`;
  }
  return `授权：编排者凭据（signedAt ${origin.signedAt}，任务内不可自我扩张）。若该签发不属于当前任务，请与用户确认后重新签发。`;
}

/**
 * One-line status for resume: session signings died with the old process, so
 * the model must never act on a grant it remembers from the session log.
 */
export function authorizationStatusText(origin: AuthorizationOrigin, tools: ToolRefs): string {
  const body =
    origin.source === "orchestrator"
      ? `当前授权来自编排者凭据（signedAt ${origin.signedAt}），任务内不可自我扩张。`
      : origin.source === "session"
        ? `当前授权为本会话内签发（signedAt ${origin.signedAt}）。`
        : `当前授权为默认上下文（未签发）；会话内签发不跨 resume，需要调整冻结区时经 ${tools.requestAuthorization} 重新提议。`;
  return frame(`refino：会话已恢复。${body}`);
}

const ORIENTATION_ROOTS = 8;

/**
 * Minimal orientation for graphs above the auto-anchor budget (docs/design.md,
 * dsh 插件落地形态: 超预算时不静默) — enough for the model to locate nodes by
 * search instead of working without any project context.
 */
export function orientationText(graph: Graph, tools: ToolRefs): string {
  const roots = [...graph.nodes.values()]
    .filter((node) => node.type === "constraint" && node.grounds.length === 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ORIENTATION_ROOTS);
  const lines = [
    `已连接 CRG（约束细化图，共 ${graph.nodes.size} 个节点）。图超过自动锚点预算，本次未注入全图摘要。`,
  ];
  if (roots.length > 0) {
    lines.push(
      roots.length === ORIENTATION_ROOTS
        ? `根约束（决策空间顶层）摘要，前 ${ORIENTATION_ROOTS} 个：`
        : "根约束（决策空间顶层）摘要：",
    );
    lines.push(...roots.map((node) => `- ${node.id} ${node.summary}`));
  }
  lines.push(
    `用 ${tools.search} 按摘要或 ID 定位节点、${tools.show} / ${tools.grounds} 按需查询；需要调整冻结区时，先与用户商定划分，再用 ${tools.requestAuthorization} 提议（须经用户批准）。`,
  );
  return frame(lines.join("\n"));
}

/**
 * One injected update: changed/deleted node ids, authorization-context delta
 * events and pending-review ids — pure ids only; summaries live in the anchor
 * block and full records ride the show tool, so re-sending them here is pure
 * duplication. The rendered text is a pure function of its inputs, which the
 * injection-side identical-text guard relies on.
 */
export function updateText(
  delta: DeltaEvent[],
  changed: string[],
  deleted: string[],
  pending: RefinoNode[],
): string | undefined {
  const lines: string[] = [];
  if (changed.length > 0) lines.push(`- 变更: ${changed.join(", ")}`);
  if (deleted.length > 0) lines.push(`- 删除: ${deleted.join(", ")}`);
  for (const event of delta) {
    const label = DELTA_LABELS[event.type];
    if (label) lines.push(`- ${label}: ${event.id}`);
  }
  if (pending.length > 0) {
    lines.push(
      `- 待审查（直接依赖上述节点，修改前先复核）: ${pending.map((node) => node.id).join(", ")}`,
    );
  }
  if (lines.length === 0) return undefined;
  return frame(["CRG 上下文更新：", ...lines].join("\n"));
}

const DELTA_LABELS: Record<DeltaEvent["type"], string> = {
  anchor_added: "新增作用域锚点",
  anchor_removed: "移除作用域锚点",
  frozen_added: "新增冻结约束（只读）",
  frozen_removed: "解除冻结约束（进入修改空间）",
} as const;
