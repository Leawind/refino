/**
 * Model-facing self-documentation, emitted by `refino guide` and
 * `refino skill` (docs/design.md, "通用接入形态"). These texts are the
 * single source of their own content: they live in code next to the commands
 * they describe, so they evolve with the CLI instead of rotting in a
 * separate manual. Keep them self-contained — the model reading them may be
 * in a repository that has none of refino's own docs.
 */

/** The full working protocol, printed by `refino guide`. Kept terse: this
 * text is injected into model context, so every byte should earn its place. */
export function guideText(): string {
  return `# refino 工作协议

本仓库用 refino 管理项目决策（约束细化图 CRG）：\`.refino/\` 目录下的版本化
有向图，记录限制后续实现选择空间的决策（约束，constraint）与支撑决策的
事实（前提，premise）。

## 核心概念

- 边从抽象指向具体：\`(约束 | 前提) → 约束\`，由约束节点的 \`grounds\` 字段
  表达。入度为零的约束是根约束（项目最高层决策）。
- 冻结区：本次任务不可修改的节点集合，由若干约束连同其全部祖先构成。
  冻结区以外是修改空间，可在其中修改约束、新增细化；新增节点属于修改
  空间。修改导致下游约束失效时，在同一变更中一并修复。
- 写入被冻结区拒绝时返回越界报告：按报告指引请求解冻，或改走边界内方案。
- 前提全部注入上下文；前提变化后，用 \`git diff --name-only\` 找出被改节点，
  对每个节点运行 \`refino dependents <id>\` 复查下游约束。

## 任务生命周期

1. 开局：运行 \`refino context\` 获取授权上下文（锚点、前提、冻结区，摘要
   级）。大图不带锚点：用 \`refino search\` 定位后经用户确认签发。
2. 按需遍历：先读摘要判断相关性再展开。\`refino show <id>...\` 全文；
   \`refino grounds|ancestors|dependents <id>...\` 沿边追溯；
   \`refino search <关键词>\` 分页搜索。查询支持批量 id，按 id 分组、允许
   部分成功。
3. 修改：\`refino new premise|constraint\`、\`refino update <id>\`（部分更新，
   省略的字段不变）、\`refino delete <id>...\`。写入前经 grounds 与冻结区
   校验。
4. 完成前回答两个问题：产出是否违反任务涉及的约束；过程中的决策是否值得
   长期保留（持续限制未来选择空间、违反代价高）。值得保留的用 \`refino new\`
   沉淀，随正常 Git 流程审核。

## 授权

- 授权上下文由人签发；未签发时默认冻结全部根约束及其祖先。
- \`refino auth show\` 查看生效授权；\`refino auth apply --dry-run\` 预演签发
  （冻结计数、frontier 归约、解冻根约束警告）；人批准后去掉 \`--dry-run\`
  执行。多 agent 并存时加 \`--expect-revision <n>\`。\`refino auth reset\`
  恢复默认。
- 无用户同意不得执行 auth apply 与 auth reset。

## 硬规则

- 不直接编辑 \`.refino/nodes/\` 下的文件，一切读写经 refino 命令。
- 越界被拒后不得绕过（包括直接改文件、改授权文件），唯一出路是报告指引
  的升级流程。
- 约束与前提的变更经 Git 审核生效。

## 输出约定

- \`--json\` 输出紧凑 JSON；\`--root <dir>\` 指定项目根（默认当前目录）。
- 查询在图有校验问题时拒绝执行，先跑 \`refino validate\`。
- 批量查询缺失的 id 以错误条目标注，其余照常返回；有缺失时退出码非零。

## 接入

接入方式按当前环境择一，工作协议与命令面相同：

- 宿主插件：宿主已装 refino 插件时以宿主集成为准，本协议命令用作检查与
  人工操作。
- 通用接入（Skill + CLI）：运行 \`refino skill\` 获取技能内容与安装指引；
  技能只承载指令，读写经本 CLI 命令完成。
`;
}

/**
 * The SKILL.md content proper (not the install guidance around it). Carries
 * only stable routing info — concept, invocation, hard rules, self-serve
 * pointers — so an installed copy going stale is harmless: the protocol
 * source of truth is `refino guide`, fetched fresh at runtime.
 */
export function skillMarkdown(): string {
  return `---
name: refino
description: 本仓库使用 refino（约束细化图，CRG）管理项目决策。当遇到 .refino/ 目录，或任务涉及项目约束、决策谱系、前提变化时使用。通过 refino 命令读写决策图，绝不直接编辑 .refino/ 下的文件。
---

# refino（CRG 项目决策管理）

refino 用版本化文本维护的约束细化图（\`.refino/\` 目录）记录项目的决策
（约束）与事实（前提）及其从抽象到具体的细化关系。约束是必须满足的项目
决策，可被有授权地继续细化或修改。

## 运行方式

refino 是 npm 命令行工具。终端可直接运行 \`refino\` 时直接用；否则用
\`npx -y @refino/cli\`（下文的 \`refino\` 命令均可按此替换）。

## 硬规则

- 绝不直接编辑 \`.refino/nodes/\` 下的文件，一切读写经 \`refino\` 命令。
- 授权（冻结区）由人签发；未经人明确同意，不得执行 \`refino auth apply\`
  或 \`refino auth reset\`。

## 自取其余

- \`refino guide\`：完整工作协议（概念、任务生命周期、命令用法）。
- \`refino context\`：本项目决策上下文，开局先运行。
- \`refino --help\`：命令清单。
`;
}

/** Full stdout of `refino skill`: install guidance first, content after. */
export function skillText(): string {
  return `refino 技能的内容与安装指引。

## 安装指引

1. 将下方内容保存为你的技能机制所要求的形态（多数 harness 是名为
   refino/SKILL.md 的文件，目录位置按宿主约定）。
2. 宿主没有技能机制时，将「硬规则」一节并入常驻指令文件（如 AGENTS.md），
   保留「自取其余」的命令指引。
3. 运行 \`refino context\` 验证命令可用。
4. 技能随 CLI 版本演进：更新 = 重新运行本命令获取最新内容并重装。

## 技能内容

----- 8< ----- 由此行开始（不含此行）-----

${skillMarkdown()}----- 8< ----- 到此行结束（不含此行）-----
`;
}
