import { renderContext } from "@refino/harness";
import type { Graph } from "refino";
import type { AuthorizationContext, DeltaEvent } from "@refino/harness";
import type { RefinoNode } from "refino";

/**
 * Model-facing message texts for the refino plugin (docs/design.md, dsh 插件落地形态).
 * Pure rendering: hosts frame these as durable plugin-sourced user messages.
 */

const PLUGIN_LABEL = "refino";

/** Wrap rendered context in the plugin-owned `<system-reminder>` frame. */
function frame(body: string): string {
  return `<system-reminder>\n${sanitize(body)}\n</system-reminder>`;
}

/** A repository-controlled closing tag inside node text must not close the frame. */
function sanitize(text: string): string {
  return text.replaceAll("</system-reminder", "</system-reminder\\>");
}

/**
 * The initial task context: anchors, all premises and the read-only frozen
 * zone as summaries, with the modification-space complement statement.
 * Summaries only (two-level injection) — full bodies are fetched via tools.
 */
export function initialContextText(graph: Graph, context: AuthorizationContext): string {
  return frame(
    [
      "以下是与当前任务相关的 CRG（约束细化图）上下文。约束是项目已作出的、会限制后续实现选择空间的决策；前提是项目运作依赖的客观事实。",
      renderContext(graph, context),
      "以上仅为摘要。需要某个节点的完整内容、理由或上下游关系时，用 refino_show / refino_grounds / refino_ancestors / refino_dependents 查询。",
    ].join("\n\n"),
  );
}

const ORIENTATION_ROOTS = 8;

/**
 * Minimal orientation for graphs above the auto-anchor budget (docs/design.md,
 * dsh 插件落地形态: 超预算时不静默) — enough for the model to help the user
 * pick anchors instead of working without any project context.
 */
export function orientationText(graph: Graph): string {
  const roots = [...graph.nodes.values()]
    .filter((node) => node.type === "constraint" && node.grounds.length === 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, ORIENTATION_ROOTS);
  const lines = [
    `已连接 CRG（约束细化图，共 ${graph.nodes.size} 个节点）。图超过自动锚点预算，本次未注入初始决策上下文。`,
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
    "用 refino_search 按摘要或 ID 定位节点、refino_show / refino_grounds 按需查询；请与用户确认任务相关的作用域锚点后再展开工作。",
  );
  return frame(lines.join("\n"));
}

/** One injected update: authorization-context delta events plus pending-review constraints. */
export function updateText(delta: DeltaEvent[], pending: RefinoNode[]): string | undefined {
  const lines: string[] = [];
  for (const event of delta) {
    const label = DELTA_LABELS[event.type];
    if (label) lines.push(`- ${label}: ${event.id}`);
  }
  if (pending.length > 0) {
    lines.push("以下约束直接依赖最近变化的节点，进入待审查状态，修改前应先复核：");
    for (const node of pending) lines.push(`- ${node.id} [${node.type}] ${node.summary}`);
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

/** Stable plugin identity used as the message source for every injection. */
export const REFINO_PLUGIN_SOURCE = { kind: "plugin", plugin: PLUGIN_LABEL } as const;
