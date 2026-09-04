# @refino/dsh-plugin

refino 的 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)适配插件：把 CRG 的任务界定层接入 dsh 会话，让 agent 在授权范围内读写约束细化图。以 Cordis 插件形式接入，以 dsh bundle（npm 包）形式分发（见 docs/design.md「harness 与工具插件的分工」）。

## 提供什么

- **会话初始化**：会话启动时从会话工作目录向上定位 `.refino/`，经 `@refino/storage` 加载图；按默认授权上下文（冻结区取全部根约束、前提全量注入、不超过 1024 节点时锚点取全图）构造任务上下文，以 `<system-reminder>` 框架注入初始上下文（摘要级，两级注入的第一级）。
- **模型侧 CRG 工具**：`refino_list` / `refino_show` / `refino_grounds` / `refino_ancestors` / `refino_dependents` / `refino_pending_review` 六个只读查询，与 `refino_create_premise` / `refino_create_constraint` / `refino_update_node` / `refino_delete_node` 四个写入工具。查询均为批量、部分成功语义；写入在落盘前走引擎 grounds 校验与授权上下文边界校验，越界返回结构化升级报告（正常工具结果，非报错）。
- **外部变更同步**：监听 `nodes/` 分片目录，外部修改经重载产出上下文 delta 事件与待审查集并注入会话；模型自身的写入不经注入，其待审查集随工具结果返回。

## v1 边界

- 授权上下文仅取默认值：对话时签发锚点/冻结区（用户命令、模型发起的用户确认、选择器组件）尚未接入。
- 图超过自动锚点预算时不注入初始上下文，仅提供工具。
- resume 会话重挂工具但不重放基线（基线已在会话日志中）；离线期间的外部变更在 resume 时不做基线对账。
- 图带有解析/结构问题时仍照常提供查询（结果可能歧义，列表工具会标注问题数）；写入路径自身校验严格。

## 安装

```
dsh plugin --profile <profile> add @refino/dsh-plugin
```

依赖的 `@deepseek-ai/*` 包以精确版本锁定（dsh 处于 developer preview，接口可能有破坏性变更）；对 dsh 的依赖为薄封装，仅使用 Cordis 上下文、工具定义助手与消息构造助手。

## 职责边界

依赖 [`refino`](../refino)（引擎）、[`@refino/storage`](../storage)（`.refino/` 读写与变更监听）、[`@refino/harness`](../harness)（任务界定层与注入协议）；图数据的解析、校验原语与边界计算全部来自它们，本包不含图逻辑。
