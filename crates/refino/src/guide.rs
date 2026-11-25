//! The agent-facing usage guide, printed by `refino guide`: concepts, usage
//! conventions and caveats, complete enough for an agent that has no other context.
//! The text is the single source of its own content — it lives in code next to the
//! commands it describes, so it evolves with the CLI instead of rotting in a
//! separate manual. Keep it terse: agents read it into their context. Commands and
//! their options are deliberately not listed here — `refino --help` covers them;
//! only conventions that no single command's help can state are kept.
//!
//! Self-documentation only: the command never touches the graph and does not
//! require an adopted repository, so it is exempt from the adoption contract
//! that gates every read/write command.

pub fn guide_text() -> String {
    r#"# refino 使用指南

refino 是管理决策谱系图（Decision Lineage Graph, DLG）的命令行工具。DLG 是一种有向无环图，记录会限制后续实现选择空间的项目决策、支撑这些决策的事实，以及决策之间、决策与事实间的关系。

## 概念

### 节点类型

- 决策（decision）：项目已作出的、会限制后续实现选择空间的决定，可继续细化或修改。
- 前提（premise）：项目运作依赖的客观事实，可携带 `confirmed` 确认时间。

### 节点属性

共同属性：

- 摘要（summary）：节点的独立摘要，不展开正文即可判断相关性；省略时回退为正文首段。
- 内容（content）：markdown格式的完整内容，允许mermaid, latex等常见的扩展语法

决策节点的属性：

- 依据（grounds）：决策节点上的依据 id 列表，边从抽象指向具体（`(决策 | 前提) → 决策`）；grounds 为空的决策是根决策（项目最高层决策，通常代表项目的最高目标）
- 理由（rationale）：仅决策拥有，记录"为什么从依据得出该决策"
- 探索中（exploring）：仅决策拥有的布尔试行标记，缺省为定案；标记为探索中的决策是当前工作线的试行承诺，预期可能被替换或撤销。新建的根决策默认标记为探索中（试行），复核确认后再转正
- 最后复核时间（reviewed）：决策最近一次复核的时间，缺省表示尚未复核

前提节点的属性：

- 最后确认时间（confirmed）：前提最近一次被确认的时间，缺省表示尚未确认

### 节点的派生状态或属性

- 受影响下游：某节点变化后可能受影响的决策闭包，是写入后的复核范围
- 生效探索状态：决策自身标记探索中、或其任一（传递）依据决策生效探索中，即为生效探索中；上游定案时子树自动随之定案，不在节点中逐节点存储

## 规则

- 仅当仓库存在 `.refino/` 时使用 refino；为仓库接入是显式动作（`refino init`），须经用户明确要求。
- 绝不直接编辑 `.refino/` 下的文件，一切读写经 Harness 提供的工具或 refino 命令
- 若当前会话已由 refino 插件（如 dsh 插件）接管，优先使用插件工具：写入走同一套 grounds 校验，并同步该会话的已知集；直接用 CLI 改图时，会话只能通过外部变更通知得知
- 探索中的决策是试行承诺而非定案决策：列表与查询输出以 `[探索]` 标注生效探索中的节点；删除探索中的决策前，先把其中可复用的发现沉淀为前提
- 不在节点内容中书写日期等时间信息：时间由系统承载——决策有 `reviewed` 最后复核时间、前提有 `confirmed` 最后确认时间，节点的建立与变更历史由 git 维护
- 不在节点内容中引用其他节点：节点间关系一律通过依据（grounds）表达，内容中的引用不构成图关系
- refino 具体用法的唯一权威是所接入 harness 的工具说明与 refino 命令（本指南、`refino --help`）；不要把 refino 用法写进所在项目的文档（如 AGENTS.md）

## 命令行用法约定

命令与参数以 `refino --help` 为准。以下是全局约定：

- 全局选项 `--root <dir>` 指定项目根（默认当前目录）
- 节点 id 为 3-16 位 A-Z、0-9、_，可自动生成或以 `--id` 显式指定
- 长正文不经命令行参数传递：创建或整体重写用 `--body-file <path>`（`-` 表示 stdin，理由用 `--rationale-file`）；局部修改用 `refino edit` 的精确字符串替换（字节精确匹配，多处命中且未指定 `--replace-all` 时拒绝执行）。不要凭记忆重打未读取的正文
- 定位节点的顺序：先 `list` / `search` 以摘要判断相关性，再 `show` 展开全文；搜索匹配 id 前缀与摘要、正文、理由（大小写不敏感），摘要仍承担快速判断相关性的职责，应覆盖正文的关键术语
- 复核维护：`refino stale` 列出该复核的节点——决策按 `reviewed`、前提按 `confirmed` 计龄，超过 `--days`（默认 90 天）的归入超期组，无时间戳的归入从未复核组；`refino update <id> --reviewed <RFC3339>` 记录复核时间（空串清除）
- `delete --force` 会在依赖方留下悬空依据：图随之出现校验问题、查询命令拒绝执行，应随后 `update` 依赖方的 grounds 修复
- 查询命令支持批量 id、部分成功：不存在的 id 以错误条目标注，其余照常返回；存在缺失时退出码非零
- 图存在校验问题时查询拒绝执行，先跑 `validate`
"#
    .to_string()
}
