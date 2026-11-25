import type { ToolRefs } from "./types.js";

/**
 * Shared model-facing descriptions for the DLG tools. Host adapters assemble their
 * own tool schemas (each host has its schema DSL) but cite these texts so the
 * semantics stay single-sourced. Texts that name another tool are parameterized by
 * the host's tool-name refs.
 */

export interface ToolText {
  list: string;
  search: string;
  show: string;
  grounds: string;
  ancestors: string;
  dependents: string;
  siblings: string;
  pendingReview: string;
  stale: string;
  createPremise: string;
  createDecision: string;
  updateNode: string;
  deleteNode: string;
}

export function createToolText(tools: ToolRefs): ToolText {
  return {
    list: "列出 DLG 中的节点（ID、类型、摘要）。图很大时优先用上下游查询定向获取，不要依赖全量列表。",
    search: `按关键字分页搜索 DLG 节点（匹配 ID 前缀、摘要、正文与理由子串，大小写不敏感）。大规模图中定位节点的首选方式；图很小或已给出确切 ID 时可直接用 ${tools.show}。`,
    show: "按 ID 批量读取节点的完整内容（正文、理由、依据、确认/复核时间）。部分成功：不存在的 ID 以错误条目返回。",
    grounds: "按 ID 批量读取节点的直接依据（作为其依据的上游决策与前提）。部分成功。",
    ancestors:
      "按 ID 批量读取节点的全部祖先决策与前提（沿依据向上，含相对深度）。用于恢复某个决策的上游背景。部分成功。",
    dependents:
      "按 ID 批量读取节点的受影响决策集（沿依据边向下的传递闭包，含相对深度）。修改或删除节点前用它判断下游影响范围。部分成功。",
    siblings:
      "按 ID 批量读取节点的强兄弟（共享至少一个直接依据的决策，含共享数，按重叠数降序）。细化决策前用它参考同一问题下的同级决策，保持方案一致。部分成功。",
    pendingReview:
      "登记最近发生变化的节点 ID，重载图的最新状态，并返回因此进入待审查状态的直接下游决策（修改前应先复核它们）。",
    stale: `列出长期未复核的节点：决策按复核时间、前提按确认时间计算，分成"超期"与"从未复核"两组。维护图谱时先看这份清单，复核后把复核时间写回节点（${tools.show} 可见当前值）。`,
    createPremise: "新增前提节点（项目运作依赖的客观事实）。前提不携带 grounds，不参与决策谱系。",
    createDecision:
      "新增决策节点（会限制后续实现选择空间的项目决策）。grounds 为依据 ID 列表（上游决策或前提）；省略则创建根决策——根决策默认标记为试行，须经复核后转正。",
    updateNode:
      "部分更新节点的可编辑字段：省略的字段保持不变，传空串清除该可选属性（summary 清除后回退为正文首段派生）。决策的 grounds 提供时整体替换并经校验，省略则保持不变。至少提供一个字段。",
    deleteNode: "删除节点。仍有下游决策时拒绝并附受影响列表——先处理下游，再删除。",
  };
}

/** Host-agnostic parameter descriptions (no tool cross-references). */
export const PARAM_TEXT = {
  idsShow: "要读取的节点 ID 列表",
  idsGrounds: "要查询依据的节点 ID 列表",
  idsAncestors: "要向上追溯的节点 ID 列表",
  idsDependents: "要向下追溯的节点 ID 列表",
  idsSiblings: "要查询强兄弟的节点 ID 列表",
  maxDepth: "最大遍历深度：1 只含直接依据/依赖，0 不含任何节点；省略则不限",
  siblingsLimit: "每个 ID 最多返回的兄弟数；省略则全部",
  listNodeType: "只列出该类型的节点；省略则全部列出",
  searchQ: "关键字；匹配 ID 前缀、摘要、正文与理由子串，省略匹配全部",
  searchNodeType: "只搜索该类型的节点；省略则全部",
  searchLimit: "每页条数（1-500，默认 50）",
  searchCursor: "上一页结果返回的 next_cursor；从该 ID 之后继续",
  staleDays: "超期阈值（天，默认 90）；决策按复核时间、前提按确认时间计算",
  changedIds: "发生变化（被修改、新增或删除）的节点 ID 列表",
  bodyPremise: "事实内容（Markdown 正文），可为空字符串",
  bodyDecision: "决策内容（Markdown 正文），可为空字符串",
  summary: "独立摘要；省略时取正文首段",
  confirmed: "确认时间，RFC 3339 带显式 UTC 偏移（如 2026-09-05T00:00:00Z）",
  reviewed: "最后复核时间，RFC 3339 带显式 UTC 偏移；仅决策可用",
  explicitId: "显式节点 ID（3-16 位 A-Z、0-9、_）；省略则自动生成",
  grounds: "依据节点 ID 列表；省略则创建根决策（默认试行）",
  rationaleCreate: "为什么从依据得出该决策",
  exploring: "标记为试行承诺（探索中，可能被替换或撤销）；省略时根决策默认试行、其余定案",
  updateId: "要修改的节点 ID",
  updateSummary: "新的独立摘要；省略保持不变；空串清除（回退为正文派生）",
  updateBody: "新的正文（Markdown）；省略保持不变；空串清空正文",
  updateGrounds: "决策的新依据 ID 列表（整体替换并校验）；省略保持不变；仅决策可用",
  updateRationale: "决策的新理由；省略保持不变；空串清除；仅决策可用",
  updateConfirmed: "前提的新确认时间（RFC 3339 带偏移）；省略保持不变；空串清除；仅前提可用",
  updateReviewed: "决策的新复核时间（RFC 3339 带偏移）；省略保持不变；空串清除；仅决策可用",
  updateExploring:
    "决策的试行标记；true 标记探索中、false 转正（移除标记）；省略保持不变；仅决策可用",
  deleteId: "要删除的节点 ID",
} as const;
