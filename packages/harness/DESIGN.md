# @refino/harness 设计

## 职责边界

本包提供：

- 授权上下文校验与冻结区（冻结区 = 指定的冻结约束沿 `grounds` 连同其全部祖先节点；未显式指定时默认取全部根约束及其祖先，见 `defaultAuthorizationContext`）
- 修改空间校验：修改空间是冻结区的补集；约束与前提的更新机制相同，目标位于冻结区内即拒绝并产出结构化升级报告，冻结区以外可自行修改。冻结区沿依据向上封闭，修改空间沿细化方向向下封闭，可修改节点的下游修复不可能触及冻结区，因此无需单独的写路径波及检测
- 冻结区交互原语：`frozenFrontier`（冻结区最下游约束，冻结区的最小表示）与 `freezableConstraints`（尚未冻结的约束候选）；具体界面展示属交互设计，不在本包职责内
- 签发授权文档（`authorization.ts`）：签发文档的单一 schema 与解析（`parseSignedAuthorization`，只含冻结区 frontier——锚点是注入策略参数，不进入签发文档）、默认的物化（`materializeDefaultAuthorization`）、读取侧按当前图收敛（`convergeAuthorization`：被删节点剔除、frontier 归约为最小表示）、严格签发与预览（`applyAuthorization`：冻结计数、解冻根约束警告、frontier 归约），供工具插件消费
- 编排者凭据解析（`state.ts`，Node 专属子路径导出 `@refino/harness/state`）：`REFINO_AUTHORIZATION` 环境变量指向的凭据文件读取与解析，供工具插件在会话边界兑现编排车道。对话车道属插件形态自持（会话内签发），不进入本包；浏览器消费方走主入口，不经此子路径
- 待审查派生：前提（或约束）变化后直接依赖它们的约束集合（crg.md 1.6），内存计算、不持久化
- 上下文渲染：稳定标识的上下文块（锚点、全部前提与冻结区，summary 级，两级注入的第一级；冻结约束即使被锚点覆盖也输出只读块）
- 注入规模估算：上下文块数与字符量预估，供授权控制台的签发预览
- 增量 delta：锚点/冻结区变化的事件序列，支持 prompt-cache 友好的增量注入
- `HarnessSession`：批量、部分成功语义的查询工具与边界校验的会话封装
- 工具插件公共核心（`@refino/harness/host` 子路径，Node 专属）：`RefinoWorkspace`（基于 `@refino/storage` Store 的会话工作区：常驻投影 + 默认/已签发授权上下文的收敛 + 外部变更同步）、`DeltaCoalescer`（delta 注入降噪）、会话开局授权解析（`resolveAuthorization`：编排者凭据 → 默认值）、CRG 工具执行核心（只读查询、写入链、对话签发，批量 + 部分成功语义）、注入文本渲染（初始上下文、超预算引导、resume 状态行、更新通知；工具指称经 `ToolRefs` 参数化——dsh 传实名前缀 `refino_`，文本不硬编码宿主前缀）、canonical 结果形状与模型侧 markdown 渲染、工具与参数描述文本。工具插件只保留宿主绑定（工具 schema 声明、会话事件、审批面与注入通道）；主入口保持浏览器安全，本子路径与 `state` 一样仅限 Node 消费方

本包不提供：

- 图的解析、存储与文件读写（由 `@refino/storage` 承担）
- 命令行接口
- 可视化组件（由 `@refino/ui` 承担）
- 具体工具（dsh 等）的接入实现（由各工具适配插件承担，包名遵循各宿主生态的插件命名约定，登记见 docs/design.md“命名约定”）
