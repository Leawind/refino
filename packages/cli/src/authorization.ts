import { frozenFrontier, type ApplyPreview, type ModificationCheck } from "@refino/harness";
import { effectiveContext, type ResolvedAuthorization } from "@refino/harness/state";
import type { Graph } from "refino";
import { getAncestors } from "refino";
import type { CliIo } from "./format.js";

/**
 * CLI presentation helpers over the shared authorization state lane
 * (@refino/harness/state): the resolution itself lives in harness so the
 * dsh plugin and the CLI act on one implementation. What remains here is
 * prose-shaped output only.
 */

/**
 * Which signed frontier constraints cover a frozen node: the node itself, or
 * a frontier node whose ancestor closure contains it. Drives the escalation
 * report's "blocking position" line.
 */
export function coveringFrontier(
  graph: Graph,
  resolved: ResolvedAuthorization,
  id: string,
): string[] {
  return frozenFrontier(graph, effectiveContext(graph, resolved))
    .filter((node) => {
      if (node.id === id) return true;
      return getAncestors(graph, node.id).some((a) => a.node.id === id);
    })
    .map((node) => node.id);
}

/** Truncate an id list for prose output. */
export function idList(ids: readonly string[], max = 8): string {
  if (ids.length === 0) return "（无）";
  const head = ids.slice(0, max).join(", ");
  return ids.length > max ? `${head} …等 ${ids.length} 个` : head;
}

/**
 * Model-facing escalation report for a blocked modification (docs/crg.md
 * 3.4): what blocked, where the block comes from, what a change would affect,
 * and the two sanctioned ways forward. Emitted as normal stdout output —
 * being blocked is a structured outcome, not a crash.
 */
export function renderEscalation(
  graph: Graph,
  resolved: ResolvedAuthorization,
  check: ModificationCheck,
  io: CliIo,
  json: boolean,
): void {
  if (json) {
    io.stdout.write(
      `${JSON.stringify({
        ok: false,
        blocked: {
          id: check.id,
          coveringFrontier: coveringFrontier(graph, resolved, check.id),
          affected: check.report?.affected.map((a) => ({ id: a.node.id, depth: a.depth })) ?? [],
        },
      })}\n`,
    );
    return;
  }
  const affected = check.report?.affected ?? [];
  const lines = [
    `越界：节点 ${check.id} 位于冻结区，修改被拒绝。`,
    `- 阻挡位置：被冻结 frontier ${idList(coveringFrontier(graph, resolved, check.id))} 覆盖`,
    affected.length > 0
      ? `- 若修改生效将影响下游约束：${idList(affected.map((a) => a.node.id))}`
      : "- 若修改生效将影响下游约束：（无）",
    "修改空间以内无法完成时：",
    "1. 向用户说明阻挡原因，经用户同意后 `refino auth apply --dry-run` 预演并签发新冻结区；",
    "2. 或在修改空间以内调整方案。",
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
}

/** Preview/summary lines shared by `auth apply` and its dry run. */
export function renderPreview(preview: ApplyPreview): string[] {
  const lines = [`- 冻结区：${preview.frozenConstraints} 个约束、${preview.frozenPremises} 个前提`];
  if (preview.redundantFrontier.length > 0) {
    lines.push(
      `- frontier 归约：移除冗余项 ${preview.redundantFrontier.join(", ")}（被其他 frontier 约束覆盖）`,
    );
  }
  if (preview.unfrozenRoots.length > 0) {
    lines.push(
      `- warning: 以下根约束将解冻，需要项目最高级别的授权确认：${preview.unfrozenRoots.join(", ")}`,
    );
  }
  return lines;
}
