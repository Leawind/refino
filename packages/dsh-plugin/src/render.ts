import type {
  FullNodeLite,
  IssueLite,
  ListResult,
  NodeDepthLite,
  NodeLite,
  PendingResult,
  SearchResult,
  SiblingsResult,
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
    lines.push(`- 确认时间：${new Date(node.confirmed).toISOString()}`);
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

export function renderSearch(result: SearchResult): string {
  const lines: string[] = [];
  if (result.nodes.length === 0) {
    lines.push(`没有匹配"${result.query}"的节点。`);
  } else {
    lines.push(`匹配"${result.query}"的节点（本页 ${result.nodes.length} 个）：`);
    lines.push(...result.nodes.map(nodeLine));
    if (result.next_cursor !== undefined) {
      lines.push(`结果未完，以 next_cursor=${result.next_cursor} 继续查询。`);
    }
  }
  return lines.join("\n");
}

export function renderSiblings(result: SiblingsResult): string {
  return renderEntries(result.results, (entry) =>
    (entry.nodes ?? []).map(
      (sibling) =>
        `- ${sibling.id} [${sibling.type}] 共享 ${sibling.overlap} 个直接依据 — ${sibling.summary}`,
    ),
  );
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
    `节点 ${escalation.id} 位于冻结区，只读；本次授权范围以内不存在修改它的可行方案。`,
  ];
  if (escalation.affected.length > 0) {
    lines.push("受影响的下游约束（ID、相对深度、摘要）：");
    lines.push(...escalation.affected.map(depthLine));
  }
  lines.push(
    "请停止修改，向用户报告越界升级：说明阻挡约束、冻结原因与上述受影响约束，并给出建议的约束调整方案。",
    "用户裁决为调整冻结区时，用 refino_request_authorization 提议新划分（须经用户批准）；否则改走修改空间以内的替代方案。不得绕过冻结区（包括直接改文件）。",
  );
  return lines;
}

function renderIssue(issue: IssueLite): string {
  return `- [${issue.code}] ${issue.message}`;
}

const ORIGIN_LABEL: Record<string, string> = {
  orchestrator: "编排者凭据",
  workspace: "工作区签发",
  default: "默认（未签发；全部根约束及其祖先被冻结）",
} as const;

/** Model-facing rendering of `refino_request_authorization` results. */
export function renderSign(result: {
  ok: boolean;
  revision?: number;
  frontier?: string[];
  frozen_constraints?: number;
  frozen_premises?: number;
  redundant_frontier?: string[];
  unfrozen_roots?: string[];
  outcome?: string;
  error?: string;
}): string {
  if (!result.ok) {
    return [
      `签发未生效：${result.error ?? "未知原因"}`,
      result.outcome !== undefined && result.outcome !== "allowed-once"
        ? `审批结果：${result.outcome}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  const lines = [
    `已签发 revision ${result.revision}，写入用户级授权状态并即时生效。`,
    `- 冻结区：${result.frozen_constraints} 个约束、${result.frozen_premises} 个前提`,
    `- frontier：${result.frontier && result.frontier.length > 0 ? result.frontier.join(", ") : "（空，全部解冻）"}`,
  ];
  if (result.redundant_frontier !== undefined && result.redundant_frontier.length > 0) {
    lines.push(`- frontier 归约：${result.redundant_frontier.join(", ")} 被覆盖`);
  }
  if (result.unfrozen_roots !== undefined && result.unfrozen_roots.length > 0) {
    lines.push(
      `- warning: 以下根约束已解冻（项目最高级别授权已在批准时确认）：${result.unfrozen_roots.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** Model-facing rendering of `refino_context` results. */
export function renderContextStatus(result: {
  source: string;
  revision: number;
  signed_at: string;
  state_path?: string;
  frontier: string[];
  frozen_constraints: number;
  frozen_premises: number;
  anchors_complete: boolean;
  orchestrator_credential: boolean;
}): string {
  const origin =
    result.source === "workspace"
      ? `工作区签发（${result.state_path ?? "用户级状态"}）`
      : (ORIGIN_LABEL[result.source] ?? result.source);
  const lines = [
    `授权来源：${origin}`,
    `revision：${result.revision}（signedAt ${result.signed_at}）`,
    `冻结 frontier：${result.frontier.length > 0 ? result.frontier.join(", ") : "（空，全部解冻）"}`,
    `生效冻结区：${result.frozen_constraints} 个约束、${result.frozen_premises} 个前提`,
    `锚点注入策略：${result.anchors_complete ? "全图摘要" : "图超预算，概览加搜索按需定位"}`,
    result.orchestrator_credential
      ? "编排者凭据生效：签发被拒绝，调整冻结区须回到签发者。"
      : "调整冻结区：refino_request_authorization（提议后须经用户批准）。",
  ];
  return lines.join("\n");
}
