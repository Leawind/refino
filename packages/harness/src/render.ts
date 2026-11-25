import type {
  FullNodeLite,
  IssueLite,
  ListResult,
  NodeDepthLite,
  NodeLite,
  PendingResult,
  SearchResult,
  SiblingsResult,
  StaleResult,
  WriteResult,
} from "./shapes.js";

/**
 * Model-facing markdown renderers for the canonical tool values. Pure
 * projections: the canonical value stays programmatic, the text explains.
 * Inputs are the schema-loose shapes (plain `string` where the domain has
 * unions), as a host tool schema hands them to `render`.
 */

export interface RenderKit {
  renderList(result: ListResult): string;
  renderEntries<E extends { id: string; error?: string }>(
    entries: E[],
    renderOne: (entry: E) => string[],
  ): string;
  renderFullNode(node: FullNodeLite): string;
  renderPending(result: PendingResult): string;
  renderSearch(result: SearchResult): string;
  renderSiblings(result: SiblingsResult): string;
  renderStale(result: StaleResult): string;
  renderWrite(result: WriteResult): string;
  nodeLine(node: NodeLite): string;
  depthLine(node: NodeDepthLite): string;
}

export function createRenderKit(): RenderKit {
  const mark = (node: NodeLite): string => (node.exploring === true ? " [探索]" : "");
  const nodeLine = (node: NodeLite): string =>
    `- ${node.id} [${node.type}]${mark(node)} ${node.summary}`;
  const depthLine = (node: NodeDepthLite): string =>
    `- ${node.id} [${node.type}]${mark(node)} 深度 ${node.depth} — ${node.summary}`;

  function renderList(result: ListResult): string {
    const lines = [`共 ${result.total} 个节点。`];
    if (result.issue_count > 0) {
      lines.push(`注意：图当前带有 ${result.issue_count} 个解析/结构问题，查询结果可能有歧义。`);
    }
    lines.push(...result.nodes.map(nodeLine));
    return lines.join("\n");
  }

  function renderEntries<E extends { id: string; error?: string }>(
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

  function renderFullNode(node: FullNodeLite): string {
    const lines = [`- ID：${node.id}`, `- 类型：${node.type}`, `- 摘要：${node.summary}`];
    if (node.type === "decision") {
      lines.push(
        `- 依据：${node.grounds && node.grounds.length > 0 ? node.grounds.join(", ") : "（根决策，无依据）"}`,
      );
      if (node.rationale !== undefined) lines.push(`- 理由：${node.rationale}`);
      if (node.exploring === true) {
        lines.push("- 状态：试行（探索中，可能被替换或撤销；可复用知识应沉淀为前提）");
      }
      if (node.reviewed !== undefined) {
        lines.push(`- 复核时间：${new Date(node.reviewed).toISOString()}`);
      }
    } else if (node.confirmed !== undefined) {
      lines.push(`- 确认时间：${new Date(node.confirmed).toISOString()}`);
    }
    return [...lines, "", node.body].join("\n");
  }

  function renderPending(result: PendingResult): string {
    const lines: string[] = [];
    if (result.unknown_ids.length > 0) {
      lines.push(`未知的节点 ID：${result.unknown_ids.join(", ")}`);
    }
    if (result.pending.length === 0) {
      lines.push("当前没有待审查的决策。");
    } else {
      lines.push("以下决策直接依赖最近变化的节点，进入待审查状态，修改前应先复核：");
      lines.push(...result.pending.map(nodeLine));
    }
    return lines.join("\n");
  }

  function renderSearch(result: SearchResult): string {
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

  function renderSiblings(result: SiblingsResult): string {
    return renderEntries(result.results, (entry) =>
      (entry.nodes ?? []).map(
        (sibling) =>
          `- ${sibling.id} [${sibling.type}]${mark(sibling)} 共享 ${sibling.overlap} 个直接依据 — ${sibling.summary}`,
      ),
    );
  }

  function renderStale(result: StaleResult): string {
    const lines: string[] = [];
    if (result.overdue.length === 0 && result.never.length === 0) {
      lines.push("当前没有需要复核的节点。");
      return lines.join("\n");
    }
    if (result.overdue.length > 0) {
      lines.push(`超过 ${result.days} 天未复核（${result.overdue.length} 个，最旧的在前）：`);
      lines.push(
        ...result.overdue.map((node) => `${nodeLine(node)} — 距今 ${node.age_days ?? "?"} 天`),
      );
    }
    if (result.never.length > 0) {
      lines.push(`从未复核（${result.never.length} 个）：`);
      lines.push(...result.never.map(nodeLine));
    }
    lines.push(
      "复核后应为节点写入复核时间，并复核其上游依据与下游影响：无复核时间的节点按从未复核处理。",
    );
    return lines.join("\n");
  }

  function renderWrite(result: WriteResult): string {
    if (result.ok) {
      const lines = [`已完成：${result.id}`];
      if (result.pending && result.pending.length > 0) {
        lines.push("以下决策因此进入待审查状态：");
        lines.push(...result.pending.map(nodeLine));
      }
      return lines.join("\n");
    }
    const lines = [`未完成：${result.error ?? "未知原因"}`];
    if (result.issues !== undefined && result.issues.length > 0) {
      lines.push("grounds 校验问题：");
      lines.push(...result.issues.map(renderIssue));
    }
    if (result.dependents !== undefined && result.dependents.length > 0) {
      lines.push("仍存在下游决策，先更新或删除它们：");
      lines.push(...result.dependents.map(nodeLine));
    }
    return lines.join("\n");
  }

  function renderIssue(issue: IssueLite): string {
    return `- [${issue.code}] ${issue.message}`;
  }

  return {
    renderList,
    renderEntries,
    renderFullNode,
    renderPending,
    renderSearch,
    renderSiblings,
    renderStale,
    renderWrite,
    nodeLine,
    depthLine,
  };
}
