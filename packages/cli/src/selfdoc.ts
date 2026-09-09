/**
 * Model-facing self-documentation, emitted by `refino guide` and
 * `refino skill` (docs/design.md, "通用接入形态"). These texts are the
 * single source of their own content: they live in code next to the commands
 * they describe, so they evolve with the CLI instead of rotting in a
 * separate manual. Keep them self-contained — the model reading them may be
 * in a repository that has none of refino's own docs.
 */

/**
 * The SKILL.md content proper (not the install guidance around it). Carries
 * only stable routing info — concept, invocation, hard rules, self-serve
 * pointers — so an installed copy going stale is harmless: the protocol
 * source of truth is `refino guide`, fetched fresh at runtime.
 */
export function skillMarkdown(): string {
  return `---
name: refino
description: 用 refino 管理项目决策。当任务涉及项目约束、决策谱系、前提变化时使用；仅在已有 .refino/ 的仓库使用，绝不直接编辑 .refino/ 下的文件。
---

# refino

refino 在\`.refino/\` 目录中维护的约束细化图（CRG），记录项目的决策（约束，constraint）与事实（前提，premise）及其从抽象到具体的细化关系。约束是必须满足的项目决策，可继续细化或修改；变更经 Git 流程审核。

## 运行方式

refino 是 npm 命令行工具，可访问特定目录下的CRG。终端可直接运行 \`refino\` 时直接用；否则用 \`npx -y @refino/cli\`（下文的 \`refino\` 命令均可按此替换）。

## 硬规则

- 如果仓库下不存在 \`.refino/\` 目录，视为不使用 refino 管理项目决策
- 仅当用户明确要求时，可以通过 \`refino init\` 为仓库启用 refino
- 除非 refino 调试需要，绝不直接编辑 \`.refino/\` 下的文件，一切读写经 \`refino\` 命令
- 修改或删除节点后，主动向用户报告 \`refino pending\` 显示的影响面；审核确认（\`refino review ack\`）由用户执行，不代替用户确认

## 自取其余

- \`refino guide\`：完整工作协议（概念、任务生命周期、命令用法）
- \`refino context\`：本项目决策概览，开局先运行
- \`refino --help\`：命令清单
`;
}

/** The full working protocol, printed by `refino guide`. Kept terse: this
 * text is injected into model context, so every byte should earn its place. */
export function guideText(): string {
  return `# refino 工作协议

refino 在\`.refino/\` 目录中维护的约束细化图（CRG），记录项目的决策（约束，constraint）与事实（前提，premise）及其从抽象到具体的细化关系。约束是必须满足的项目决策，可继续细化或修改；变更经 Git 流程审核。

## 核心概念

- 边从抽象指向具体：\`(约束 | 前提) → 约束\`，由约束节点的 \`grounds\` 字段表达。入度为零的约束是根约束（项目最高层决策）。
- 读写不受权限校验：变更直接生效并记录于 git（可 diff、可回滚），人工审核发生在事后而非写入前。修改导致下游约束失效时，在同一变更中一并修复。
- 前提或约束变化后，运行 \`refino pending [--base <git-ref>]\`（缺省对比 HEAD，即未提交改动）列出已改节点及其下游待审查约束，逐一复核。

## 任务生命周期

1. 开局：运行 \`refino context\` 获取决策概览（图规模与根约束，摘要级）。大图不注入全图摘要：用 \`refino search\` 按需定位任务相关节点。
2. 按需遍历：先读摘要判断相关性再展开。\`refino show <id>...\` 全文；\`refino grounds|ancestors|dependents <id>...\` 沿边追溯；\`refino search <关键词>\` 分页搜索。查询支持批量 id，按 id 分组、允许部分成功。
3. 修改：\`refino new premise|constraint\`、\`refino update <id>\`（部分更新，省略的字段不变）、\`refino delete <id>...\`。写入前经 grounds 校验；删除被引用节点须 \`--force\` 并修复下游。
4. 完成前回答两个问题：产出是否违反任务涉及的约束；过程中的决策是否值得长期保留（持续限制未来选择空间、违反代价高）。值得保留的用 \`refino new\` 沉淀，随正常 Git 流程审核。

## 审核

- 一切节点变更都是普通项目变更，经 Git 工作流审核生效（diff 可审可回滚）。
- 修改或删除节点后，受影响下游自动记入审核台账（机器本地，git 忽略）：\`refino review\` 列出台账，\`refino review ack <ids...>\`（或 \`--all\`）确认移除——确认是人的动作，不代替用户执行。
- 修改或删除节点后向用户报告 \`refino pending\` 的影响面：git 基线以来的已改节点、下游待审查约束与台账条目（前提变化规则见 crg.md 1.6），由用户逐一复核。

## 硬规则

- 仅在仓库已有 \`.refino/\` 时使用 refino；为仓库接入 refino 须经用户明确要求。
- 不直接编辑 \`.refino/nodes/\` 下的文件，一切读写经 refino 命令。
- 约束与前提的变更经 Git 审核生效；影响面的复核与审核确认由用户完成，不代替用户确认。

## 输出约定

- \`--root <dir>\` 指定项目根（默认当前目录）。
- 查询在图有校验问题时拒绝执行，先跑 \`refino validate\`。
- 批量查询缺失的 id 以错误条目标注，其余照常返回；有缺失时退出码非零。

## 接入

接入方式按当前环境择一，工作协议与命令面相同：

- 宿主插件：宿主已装 refino 插件时以宿主集成为准，本协议命令用作检查与人工操作。
- 通用接入（Skill + CLI）：运行 \`refino skill --output <技能目录>\` 生成技能目录并登记进宿主技能机制（宿主级或仓库级随 git 分发均可，技能仅在含 .refino/ 的仓库激活）；技能只承载指令，读写经本 CLI 命令完成。
`;
}

/** Full stdout of `refino skill`: install guidance only — the SKILL.md
 * content itself is materialized by `skill --output`, never echoed. */
export function skillText(): string {
  return `## 为 Harness 接入 refino

1. 若当前环境是 DeepSeek Harness：安装 @refino/cordis-plugin-refino 插件。
2. 若当前环境是 ZCode 或 Claude Code（或兼容 Claude Code 插件规范的 harness）：将 refino 仓库（https://github.com/Leawind/refino，需先构建 packages/cc-plugin 的 dist）添加为插件 marketplace，安装 refino 插件。
3. 否则：运行 npx -y @refino/cli skill --output <dir> 生成技能目录，将 <dir> 替换为适合你的环境的路径，SKILL.md将位于 <dir>/refino/SKILL.md。
`;
}
