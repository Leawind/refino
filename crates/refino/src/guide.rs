//! The agent-facing usage guide, printed by `refino guide`: concepts, usage
//! conventions and caveats, complete enough for an agent that has no other
//! context (docs/design.md, "命令行工具"). The text is the single source of
//! its own content — it lives in code next to the commands it describes, so
//! it evolves with the CLI instead of rotting in a separate manual. Keep it
//! terse: agents read it into their context. Commands and their options are
//! deliberately not listed here — `refino --help` covers them; only
//! conventions that no single command's help can state are kept.
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

- 依据（grounds）：决策节点上的依据 id 列表，边从抽象指向具体（`(决策 | 前提) → 决策`）；grounds 为空的决策是根决策（项目最高层决策）
- 理由（rationale）：仅决策拥有，记录"为什么从依据得出该决策"
- 探索中（exploring）：仅决策拥有的布尔试行标记，缺省为定案；标记为探索中的决策是当前工作线的试行承诺，预期可能被替换或撤销

前提节点的属性：

- 最后确认时间

### 节点的派生状态或属性

- 受影响下游：某节点变化后可能受影响的决策闭包，是写入后的复核范围
- 生效探索状态：决策自身标记探索中、或其任一（传递）依据决策生效探索中，即为生效探索中；上游定案时子树自动随之定案，不在节点中逐节点存储

## 规则

- 仅当仓库存在 `.refino/` 时使用 refino；为仓库接入是显式动作（`refino init`），须经用户明确要求。
- 绝不直接编辑 `.refino/` 下的文件，一切读写经 Harness 提供的工具或 refino 命令
- 若当前会话已由 refino 插件（如 dsh 插件）接管，一律使用插件工具：CLI 不校验插件的授权边界（冻结区），不得经 CLI 规避
- 探索中的决策是试行承诺而非定案决策：列表与查询输出以 `[探索]` 标注生效探索中的节点；删除探索中的决策前，先把其中可复用的发现沉淀为前提

## 命令行用法约定

命令与参数以 `refino --help` 为准。以下是全局约定：

- 全局选项 `--root <dir>` 指定项目根（默认当前目录）
- 节点 id 为 3-16 位 A-Z、0-9、_，可自动生成或以 `--id` 显式指定
- 查询命令支持批量 id、部分成功：不存在的 id 以错误条目标注，其余照常返回；存在缺失时退出码非零
- 图存在校验问题时查询拒绝执行，先跑 `validate`
"#
    .to_string()
}
