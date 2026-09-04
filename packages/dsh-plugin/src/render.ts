import type {
  FullNodeLite,
  IssueLite,
  ListResult,
  NodeDepthLite,
  NodeLite,
  PendingResult,
  WriteResult,
} from "./shapes.js";

/**
 * Model-facing markdown renderers for the canonical tool values. Pure
 * projections: the canonical value stays programmatic, the text explains.
 * Inputs are the schema-loose shapes (plain `string` where the domain has
 * unions), as the tool schema hands them to `render`.
 */

export function renderList(result: ListResult): string {
  const lines = [`共 ${result.total} 个节点。`];
  if (result.issue_count > 0) {
    lines.push(`注意：图当前带有 ${result.issue_count} 个解析/结构问题，查询结果可能有歧义。`);
  }
  lines.push(...result.nodes.map(nodeLine));
  return lines.join("\n");
}

export function renderEntries<E extends { id: string; error?: string }>(
  entries: E[],
  renderOne: (entry: E) => string[],
): string {
  return entries
    .map((entry) => {
      const body = entry.error !== undefined ? entry.error : renderOne(entry).join("\n");
      return `## ${entry.id}\n${body}`;
    })
    .join("\n\n");
}

export function renderFullNode(node: FullNodeLite): string {
  const lines = [`- ID：${node.id}`, `- 类型：${node.type}`, `- 摘要：${node.summary}`];
  if (node.type === "constraint") {
    lines.push(
      `- 依据：${node.grounds && node.grounds.length > 0 ? node.grounds.join(", ") : "（根约束，无依据）"}`,
    );
    if (node.rationale !== undefined) lines.push(`- 理由：${node.rationale}`);
  } else if (node.confirmed !== undefined) {
    lines.push(`- 确认时间：${node.confirmed}`);
  }
  return [...lines, "", node.body].join("\n");
}

export function renderPending(result: PendingResult): string {
  const lines: string[] = [];
  if (result.unknown_ids.length > 0) {
    lines.push(`未知的节点 ID：${result.unknown_ids.join(", ")}`);
  }
  if (result.pending.length === 0) {
    lines.push("当前没有待审查的约束。");
  } else {
    lines.push("以下约束直接依赖最近变化的节点，进入待审查状态，修改前应先复核：");
    lines.push(...result.pending.map(nodeLine));
  }
  return lines.join("\n");
}

export function renderWrite(result: WriteResult): string {
  if (result.ok) {
    const lines = [`已完成：${result.id}`];
    if (result.pending && result.pending.length > 0) {
      lines.push("以下约束因此进入待审查状态：");
      lines.push(...result.pending.map(nodeLine));
    }
    return lines.join("\n");
  }
  const lines = [`未完成：${result.error ?? "未知原因"}`];
  if (result.issues !== undefined && result.issues.length > 0) {
    lines.push("grounds 校验问题：");
    lines.push(...result.issues.map(renderIssue));
  }
  if (result.escalation !== undefined) {
    lines.push(...renderEscalation(result.escalation));
  }
  if (result.dependents !== undefined && result.dependents.length > 0) {
    lines.push("仍存在下游约束，先更新或删除它们：");
    lines.push(...result.dependents.map(nodeLine));
  }
  return lines.join("\n");
}

export function nodeLine(node: NodeLite): string {
  return `- ${node.id} [${node.type}] ${node.summary}`;
}

export function depthLine(node: NodeDepthLite): string {
  return `- ${node.id} [${node.type}] 深度 ${node.depth} — ${node.summary}`;
}

function renderEscalation(escalation: {
  id: string;
  reason: string;
  affected: NodeDepthLite[];
}): string[] {
  const lines = [
    escalation.reason === "node_frozen"
      ? `节点 ${escalation.id} 位于冻结区，只读；本次授权范围以内不存在修改它的可行方案。`
      : `修改 ${escalation.id} 会波及冻结区内的下游约束；在同一变更中修复它们超出了本次授权范围。`,
  ];
  if (escalation.affected.length > 0) {
    lines.push("受影响的下游约束（ID、相对深度、摘要）：");
    lines.push(...escalation.affected.map(depthLine));
  }
  lines.push(
    "请停止修改，向用户报告越界升级：说明阻挡约束、冻结原因与上述受影响约束，并给出建议的约束调整方案。",
  );
  return lines;
}

function renderIssue(issue: IssueLite): string {
  return `- [${issue.code}] ${issue.message}`;
}
