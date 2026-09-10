import { Command } from "commander";
import type { CliIo } from "../format.js";
import type { RunFn } from "../shared.js";

/**
 * The agent-facing usage guide, printed by `refino guide`: concepts,
 * usage conventions and caveats, complete enough for an agent that has no
 * other context (docs/design.md, "命令行工具"). The text is the single
 * source of its own content — it lives in code next to the commands it
 * describes, so it evolves with the CLI instead of rotting in a separate
 * manual. Keep it terse: agents read it into their context. Commands and
 * their options are deliberately not listed here — `refino --help` covers
 * them; only conventions that no single command's help can state are kept.
 *
 * Self-documentation only: the command never touches the graph and does
 * not require an adopted repository, so it is exempt from the adoption
 * contract that gates every read/write command.
 */
export function guideText(): string {
  return `# refino 使用指南

refino 是管理约束细化图（Constraint Refinement Graph, CRG）的命令行工具。CRG 是一种有向无环图，记录会限制后续实现选择空间的项目决策、支撑这些决策的事实，以及决策之间、决策与事实间的关系。

## 概念

### 节点类型

- 约束（constraint）：会限制后续实现选择空间的项目决策，可继续细化或修改。
- 前提（premise）：项目运作依赖的客观事实，可携带 \`confirmed\` 确认时间。

### 节点属性

共同属性：

- 摘要（summary）：节点的独立摘要，不展开正文即可判断相关性；省略时回退为正文首段。
- 内容（content）：markdown格式的完整内容，允许mermaid, latex等常见的扩展语法

约束节点的属性：

- 依据（grounds）：约束节点上的依据 id 列表，边从抽象指向具体（\`(约束 | 前提) → 约束\`）；grounds 为空的约束是根约束（项目最高层决策）
- 理由（rationale）：仅约束拥有，记录"为什么从依据得出该决策"

前提节点的属性：

- 最后确认时间

### 节点的派生状态或属性

- 受影响下游：某节点变化后可能受影响的约束闭包，是写入后的复核范围

## 规则

- 仅当仓库存在 \`.refino/\` 时使用 refino；为仓库接入是显式动作（\`refino init\`），须经用户明确要求。
- 绝不直接编辑 \`.refino/\` 下的文件，一切读写经 Harness 提供的工具或 refino 命令
- 若当前会话已由 refino 插件（如 dsh 插件）接管，一律使用插件工具：CLI 不校验插件的授权边界（冻结区），不得经 CLI 规避

## 命令行用法约定

命令与参数以 \`refino --help\` 为准。以下是全局约定：

- 全局选项 \`--root <dir>\` 指定项目根（默认当前目录）
- 节点 id 为 3-16 位 A-Z、0-9、_，可自动生成或以 \`--id\` 显式指定
- 查询命令支持批量 id、部分成功：不存在的 id 以错误条目标注，其余照常返回；存在缺失时退出码非零
- 图存在校验问题时查询拒绝执行，先跑 \`validate\`
`;
}

/** `refino guide` — print the agent-facing usage guide. */
export function createGuideCommand(io: CliIo, run: RunFn): Command {
  return new Command("guide")
    .description("print the agent-facing usage guide (concepts, conventions, caveats)")
    .action((_opts, cmd: Command) =>
      run(cmd, async () => {
        io.stdout.write(guideText());
        return 0;
      }),
    );
}
