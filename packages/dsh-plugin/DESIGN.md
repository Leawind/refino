# @refino/cordis-plugin-refino 设计

对 dsh 的薄适配层：把 `@refino/harness` 的任务界定能力接进 dsh 会话。跨包契约（注入协议、签发机制、工具语义、v1 边界）见 [docs/design.md](../../docs/design.md) 的“harness 与工具插件功能设计”，本文只记录包内结构与决策。

## 职责边界

本包提供：

- Cordis 插件入口（`index.ts` 的 `apply`）：`agent/session-start` 时从会话 cwd 向上定位 `.refino/`、打开 workspace、在 agent 作用域注册全部工具、按会话来源注入初始上下文或授权状态行；`agent/disposed` 时释放 workspace 与合并器
- 模型侧工具的宿主声明（`query-tools.ts` / `write-tools.ts` / `signing.ts`）：dsh DSL 的参数/输出 schema 与工具名，execute/render 转发到 harness 执行核心与渲染套件
- 审批面调用（`index.ts` 的 `requestApproval`）与消息注入（`createUserMessage` + `agent.inject()`）

会话工作区（`RefinoWorkspace`）、外部变更降噪（`DeltaCoalescer`）、工具执行核心、签发链、注入文本与结果形状/渲染均来自 `@refino/harness/host` 子路径——与 cc 插件单一实现，本包不再持有这些模块。

本包不提供：

- 图数据模型、解析、校验、查询（`refino` 引擎）
- `.refino/` 读写、原子写、文件监听、`.refino/` 定位（`@refino/storage`）
- 授权上下文计算、冻结区与修改空间判定、上下文渲染与 delta 事件、工具执行核心（`@refino/harness` 及其 `host` 子路径）
- 任何持久化签发状态：对话签发只存在于会话内存，插件不产生文件
- 授权控制台 UI（后继增强，见 docs/design.md）

## 会话态

- 每 agent 一个 `RefinoWorkspace`（来自 `@refino/harness/host`），以 `WeakMap<Agent, …>` 持有；工具经惰性 `get()` 解析 workspace，注册顺序无关，agent 销毁后调用得到结构化错误（`internal.ts` 的 `requireWorkspace`）而非崩溃
- 授权来源记录（`AuthorizationOrigin`：default / orchestrator / session，含 signedAt，类型来自 harness）：`refino_context` 工具与注入行共同消费；编排者凭据在会话启动时经 `resolveAuthorization` 解析一次（凭据 → 默认值），失败回落默认并告警
- resume 不重放基线（已在会话日志中），只注入一行当前授权状态——会话内签发随旧进程消亡，模型不得凭会话日志中的记忆行事
- 图超过自动锚点预算时不静默：注入极简引导（图已连接、节点数、前 8 个根约束摘要、以搜索定位）

## 注入

- 所有注入是 durable 的 plugin-sourced 用户消息（`createUserMessage` + 稳定 source 身份）；对已销毁 agent 的注入静默丢弃
- 注入文本以 `<system-reminder>` 框架包裹（harness `inject-text`）；节点文本内的闭合标签会被转义（`sanitize`），仓库内容不能提前闭合框架
- 文本中的工具指称经 `ToolRefs`（`refino_` 前缀）参数化：注入/渲染文本与工具名单一来源，模型看到的名字与可调用的名字一致
- 更新通知为纯 ID 形态（变更 / 删除 / delta 事件 / 待审查，不重发摘要——锚点块已有、详情经查询工具按需取）；渲染文本是 changed/deleted/delta/pending 的纯函数，因此“与上一次注入相同 ⟺ 零增量信息”，共享注入点（外部同步与签发两条车道）据此丢弃重复文本
- 外部变更链路：Store watcher → `SyncOutcome`（携带 changed/deleted/delta/pending）→ `DeltaCoalescer`（2 秒 trailing-edge，多批合并为一次注入）→ 更新文本注入；模型自身的写入不经注入，其待审查集随工具结果返回

## 对话签发

- 宿主审批面经 `Partial<Context>` 访问：宿主未装审批服务时不抛异常，fail-closed 返回 `unavailable`（失败面是签发未生效，不是工具报错）
- 批准即签署：会话内即时生效、以 delta 注入新冻结区；拒绝 / 取消 / 不可用一律维持现状；编排者凭据生效时直接拒绝——任务内授权不可自我扩张
- 会话内的签发 revision 计数纯装饰性（无消费方），只为让每次签发文档有互不相同的 revision

## 工具面

- 查询工具全部批量、部分成功：未知 ID 以逐条错误返回，不阻断其余结果
- 写入工具在落盘前走同一条链（harness 核心）：引擎 `checkGroundsChange`（对 prospective 图校验 grounds）+ harness `checkModification`（冻结区判定）；越界返回结构化升级报告作为正常工具结果，非报错
- dsh 的输出 schema DSL 表达不了的约束（如非负整数的 `max_depth`）在执行核心里手工校验并抛错（宿主以工具错误呈现）；输出 schema 字面量内联在各工具定义中，DTO 形状与 lite 映射集中在 harness `shapes.ts`

## 测试

- 本包单元层（tools / signing）：依赖经接口注入（`SigningDeps`），testkit 临时 `.refino/` 夹具；workspace / 注入文本 / 定位（locate）的测试随模块迁至 `@refino/harness` 与 `@refino/storage` 的测试
- 宿主层（`test/host.test.ts`）：真实裸 Cordis `Context`（无参可实例化，自带事件总线与 logger）+ 手写 Agent 切片（只实现插件真正触及的 `session.header.cwd` / `ctx.tools.register` / `inject`），驱动真实 `apply()`；假审批服务经 `Context.extend()` 注入。覆盖事件接线、按会话来源的注入选择、watcher → coalesce → 注入全链路、去重回归（mtime 重写）、审批回落与销毁停止同步
- 未覆盖、需真实 dsh 冒烟：scope 过滤派发语义、`inject()` 落入真实会话日志的行为、工具 schema 与真实 tools 服务的兼容
- 注意：凡涉及 `findRefinoDir` 的测试不能从仓库路径出发——开发机家目录可能存在真实 `.refino/`，向上查找会命中用户数据；须用干净的 `mkdtemp` 目录

## 依赖策略

- `@deepseek-ai/*` 以精确版本锁定（peerDependencies 与 devDependencies 一致）：dsh 处于 developer preview，宿主版本一变即安装失败（fail-fast），而非运行时静默漂移；每次 dsh 升级需人工核对后整体前移
- 对 dsh 的依赖面刻意收窄：仅 Cordis 上下文、工具定义助手（`defineTool`）与消息构造（`createUserMessage`）
