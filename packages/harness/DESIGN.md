# @refino/harness 设计

## 职责边界

本包提供：

- 授权上下文校验与冻结区（冻结区 = 指定的冻结约束沿 `grounds` 连同其全部祖先节点；未显式指定时默认取全部根约束及其祖先，见 `defaultAuthorizationContext`）
- 修改空间校验：修改空间是冻结区的补集；约束与前提的更新机制相同，目标位于冻结区内即拒绝并产出结构化升级报告，冻结区以外可自行修改。冻结区沿依据向上封闭，修改空间沿细化方向向下封闭，可修改节点的下游修复不可能触及冻结区，因此无需单独的写路径波及检测
- 冻结区交互原语：`frozenFrontier`（冻结区最下游约束，冻结区的最小表示）与 `freezableConstraints`（尚未冻结的约束候选）；具体界面展示属交互设计，不在本包职责内
- 签发授权文档（`authorization.ts`）：签发文档的单一 schema 与解析（`parseSignedAuthorization`）、默认的物化（`materializeDefaultAuthorization`）、读取侧按当前图收敛（`convergeAuthorization`：被删节点剔除、frontier 归约为最小表示）、严格签发与预览（`applyAuthorization`：冻结计数、解冻根约束警告、frontier 归约）。CLI（通用接入形态）与工具插件共用此抽象
- 待审查派生：前提（或约束）变化后直接依赖它们的约束集合（crg.md 1.6），内存计算、不持久化
- 上下文渲染：稳定标识的上下文块（锚点、全部前提与冻结区，summary 级，两级注入的第一级；冻结约束即使被锚点覆盖也输出只读块）
- 注入规模估算：上下文块数与字符量预估，供授权控制台的签发预览
- 增量 delta：锚点/冻结区变化的事件序列，支持 prompt-cache 友好的增量注入
- `HarnessSession`：批量、部分成功语义的查询工具与边界校验的会话封装

本包不提供：

- 图的解析、存储与文件读写（由 `@refino/storage` 承担）
- 命令行接口
- 可视化组件（由 `@refino/ui` 承担）
- 具体工具（dsh 等）的接入实现（由各 `@refino/<tool>-plugin` 承担）
