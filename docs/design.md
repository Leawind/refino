# 设计决策

本文档记录本项目已确定的设计决策。包结构、职责划分与技术选型以此为准。允许本文内容与具体实现暂时不一致，不一致时以本文为准。

- 概念模型见 [crg.md](./crg.md)
- 仓库级约束见 [AGENTS.md](../AGENTS.md)

## 包结构

| 包                      | 职责                                                                                                                                              | 状态           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `refino`                | 纯引擎：类型定义、图组装、结构校验、查询、最长路径分层、ID 生成与校验、批量查询结果形状、写入前图级校验原语                                       | 已有           |
| `@refino/storage`       | CRG 文件系统存储格式（目录结构、节点文件格式、解析与序列化、摘要提取规则）的定义与实现；Node 存储适配器（加载、创建、更新、删除、原子写）         | 已有           |
| `@refino/cli`           | `refino` 引擎的命令行薄封装                                                                                                                       | 已有           |
| `@refino/testkit`       | 各包测试共用的夹具与工具函数                                                                                                                      | 已有           |
| `@refino/ui`            | CRG 可视化编辑组件库（Vue 3）                                                                                                                     | 已有（脚手架） |
| `@refino/harness`       | 任务界定层（作用域锚点、冻结区与修改空间、授权上下文、冲突检测与越界升级）与 vibe coding 工具插件的公共逻辑（上下文增量生成、模型技能、注入协议） | 已有           |
| `@refino/<tool>-plugin` | 各 vibe coding 工具的插件，如 `@refino/dsh-plugin`（dsh 适配，以 Cordis 插件形式接入，bundle 形式分发）                                           | 设计中         |
| `@refino/desktop`       | 桌面应用                                                                                                                                          | 未来           |
| `@refino/vscode`        | VSCode 插件                                                                                                                                       | 未来           |

在满足公共部分抽离的前提下，包的总数尽量少：只在确实出现第二个消费方时才抽公共包。

## 引擎纯净性

"引擎"专指 `refino` 包。引擎不依赖任何 Node API（`node:fs`、`node:path`、`node:crypto` 等均不允许），全部为纯逻辑，可在浏览器、Web Worker 等任意 JS 环境运行：

- 引擎只包含纯图数据模型与逻辑：类型定义、图组装、结构校验、查询、最长路径分层、ID 生成与校验；
- 随机数使用 Web Crypto（`globalThis.crypto`），因此运行时要求 Node >= 20（或任何提供 `globalThis.crypto` 的环境）；
- CRG 在文件系统中的存储格式——目录结构、节点文件格式、Markdown/YAML 解析、序列化、摘要提取规则——不是引擎的职责，由 `@refino/storage` 定义并实现；引擎只消费其产出的内存图；
- 引擎的类型不携带任何存储路径：节点与图上没有文件字段，文件路径由 `@refino/storage` 依「路径即身份」规则从 `(id, type)` 推导；需要路径信息的文件层（CLI、Web 服务）在自身边界内推导。

## 错误码归属

issue 与错误携带的 `code` 字段是对外的 wire 值（SCREAMING_SNAKE 字符串），类型为 `string`，不构成封闭集合，由**产生方**定义各自的码：

- 引擎的 `IssueCode` 只包含图级语义码（id 规则、grounds 结构、id 唯一性、成环、节点不存在等），供所有产生方复用；
- 存储格式相关的码（frontmatter、节点文件路径形状、`.refino` 目录存在性）由 `@refino/storage` 定义；
- 请求形状相关的码由各请求处理层自行定义，不得借用其他产生方的码。

消费方按需针对具体码做分支（如 HTTP 状态映射、友好提示），展示类消费直接透传字符串。

issue 的其余归属字段同样由产生方定义：引擎 issue 携带 `nodeId`（及 `groundId`、`cycle` 等图级细节字段），不含文件路径；持久化层的 `StorageIssue`（`@refino/storage`）在 `RefinoIssue` 之上额外要求 `file`——对从未解析出节点的文件（如路径形状非法），文件路径是唯一可靠的定位。

## 引擎提供的共享原语

以下原语由引擎统一提供，供 CLI、Web API、harness 等所有消费方复用，避免各自重复实现：

- **`QueryGroup<T>`**：批量查询的标准结果形状（`{id, results: T[]} | {id, error: string}`），承载部分成功语义。所有批量查询接口（CLI、harness 工具、Web 按需查询）均使用此形状作为返回契约。
- **`checkGroundsChange(graph, id, newGrounds): Issue[]`**：写入前 grounds 校验原语。给定当前图、目标节点 ID 与新 grounds 列表，返回校验问题（引用不存在、成环等）。所有写入路径（CLI 的创建与更新、Web API、harness 插件、未来的桌面端）在落盘前调用此原语，确保图级校验逻辑单一来源。目标节点尚未持久化时（如创建约束），消费方向图的副本插入待写节点后调用原语。

## 存储格式容错

节点 frontmatter 中的未知字段一律忽略，不视为错误而报告 issue；只有引擎已知的字段参与解析与校验，已知字段的清单由 `@refino/storage` 的格式定义给出。这保证存储格式可以在不破坏既有节点文件的前提下向前演进（新增字段时，旧版本引擎仍能正常读取）。

## 摘要与内容分离

摘要（summary）是独立于正文的属性，用于遍历时快速判断节点相关性、节约上下文长度（见 crg.md）。"摘要如何随节点文件存储与维护"（如独立的 frontmatter 字段、缺省时的回退规则）是 `@refino/storage` 的实现细节，crg.md 不作规定。

## 任务层归属

任务界定层概念（作用域锚点、冻结区、修改空间、授权上下文）以及冲突检测与越界升级，仅在与 vibe coding 工作流结合时才有意义，不进入引擎：由 `@refino/harness` 与各工具插件实现，引擎为其提供受影响约束集等纯图查询原语。

引擎的受影响约束集查询（`getDependents`，CLI 命令 `refino dependents <id>`）返回某节点变化后可能受影响的所有约束的传递闭包：CRG 中只有约束携带 `grounds` 边，因此依赖闭包中的节点必然全是约束，无需额外过滤。

## harness 与工具插件功能设计

集成 refino 后，agent 需要面向用户与 AI 模型两组能力。本节确定 `@refino/harness` 与各工具插件（首个为 `@refino/dsh-plugin`）的功能边界。

### 用户侧：授权控制台

锚点与冻结区的选择统一为单个**授权控制台**组件，不再分设两个选择器。控制台是"上下文编译器的前端"：人签发的授权上下文与模型收到的注入上下文是同一对象的两种投影。同一交互覆盖三个时机——开局签发、任务中途调整、越界升级的裁决（升级的解法就是再签发：解冻或改锚后以 delta 续行任务）。

- 冻结区呈现为画布罩层；`frozenFrontier`（冻结区最小表示）节点带锁角标，解冻作用于 frontier；冻结候选来自 `freezableConstraints`。
- 冻结传播可视化：勾选候选时实时高亮将随之人区的全部祖先，并给出「将冻结 N 个约束、M 个前提」的计数，避免只见 id 不见传播；`ctx.userQuestions.ask()` 确认面板沿用同一呈现。
- 注入预览：实时渲染 `renderContext` 文本并估算规模（块数与字符量，harness 提供估算原语），确认后签发。
- 待审查徽标：控制台常驻显示当前待审查集。
- 组件属于 `@refino/ui`（Vue 3），画布以挑选模式复用（罩层、角标、选择回调）；`@refino/harness` 提供状态模型与计算。宿主经注入的数据通道客户端（图查询子集 + 授权操作）与组件通信；`refino web` 不挂载控制台，浏览域不含授权概念。

### 模型侧：CRG 访问工具

模型不通过直接操作 `.refino/` 文件访问 CRG，而是使用 harness 暴露的结构化工具：

- 读取：`list`、`search`（按摘要/ID 关键字分页搜索，语义与 Web `GET /api/search` 对齐；大规模图下 `list` 不可用时的定位手段）、`show`、`grounds`、`ancestors`、`dependents`（受影响约束集）、`siblings`（强兄弟：共享直接依据的约束，供细化时参考同级决策）。
- 待审查查询：前提变化后处于待审查状态的约束集合（派生态，内存计算）。
- 写入：新增、修改、删除节点；`update` 采用部分更新语义（与 CLI `update` 对齐：省略的字段保持不变，传空串即清除），grounds 仍整体替换并经校验，避免模型凭记忆重打未读取的正文。写入前经授权上下文校验；越界（目标落在冻结区）即拒绝，并返回结构化升级报告（阻挡约束及其图上位置、受影响下游约束、建议与替代方案占位）。写入前 grounds 校验经由引擎 `checkGroundsChange` 原语，结构校验经由引擎 `validateGraph`。
- 写入经由 `@refino/storage`。

### 批量查询

面向用户（CLI）与模型（harness 工具）的查询接口应尽量支持批量输入：一次调用可传入多个节点 id，结果按查询 id 分组返回，避免逐个查询带来的交互往返与上下文开销。CLI 的 `show`、`grounds`、`ancestors`、`dependents` 已按此实现。

批量查询采用部分成功语义，返回形状统一为引擎提供的 `QueryGroup<T>`：部分 id 不存在时，存在的 id 仍返回完整结果，缺失的 id 以错误条目标注，整体以非零退出码（CLI）或对应 HTTP 状态码提示有缺失；Web 批量查询端点以 `207 Multi-Status` 表示结果中存在缺失，全部命中时为 `200`。

### 上下文注入协议

- 初始注入：锚点、全部前提与冻结区约束，按两级策略渲染——先注入 summary，模型判定相关后再展开全文；显式区分「冻结区约束：只读」与「冻结区以外：授权修改空间」。
- 模型可访问全图，但初始上下文只含锚点、前提与冻结区，其余靠工具按需拉取。

### 增量更新与缓存友好

多轮对话中用户选择的锚点与冻结区可能变化。注入协议以缓存友好为约束：

- 上下文分为稳定前缀（已注入的快照）与增量 delta；锚点/冻结区变化时只注入 delta 事件（如「约束 X 解除冻结」「新增锚点 Y」），不重述全量快照，保持前缀稳定以利用模型的 prompt cache。
- 协议为每个注入块定义稳定的序号或标识，使 delta 可无歧义地引用既有内容。

### harness 与工具插件的分工

- `@refino/harness`（平台无关）：任务界定层纯图逻辑（授权上下文、冻结区计算、越界校验、升级报告）、上下文渲染与 delta 事件生成、待审查派生、注入协议抽象（宿主适配接口）。
- `@refino/dsh-plugin`（dsh 适配，薄封装）：会话初始化时加载 `.refino/` 并按锚点生成初始上下文；把上述读写能力注册为 dsh 可用的工具。dsh（DeepSeek 官方开源 agent harness，基于 Cordis，developer preview，接口可能有破坏性变更）的接入形态经调研（2026-09）已定案：**以 Cordis 插件形式接入，以 dsh bundle（npm 包）形式分发**；Skill 作为轻量补充，MCP 留作未来面向其他宿主的通用适配层，不作为 dsh 的主接入形态。

#### dsh 接入形态定案依据

refino 的四项接入需求中，两项只有进程内 Cordis 插件能实现，据此排除 MCP 与纯 Skill：

- **初始上下文注入**：dsh 的 MCP 支持只桥接 tools（resources 与 prompts 均不支持），无法在会话初始化时注入锚点上下文；Cordis 插件可监听 `agent/session-start` 并经 `agent.inject()` 注入，注入内容为持久化的 user-role 消息，resume/重放/压缩安全。
- **增量 delta 注入**：dsh 全线按 append-only、KV-cache 前缀稳定设计，`agent.inject()` 排入下一 pre-step 且不唤醒驱动，与 harness 的「稳定前缀 + delta」注入协议同构；MCP 无推送通道。
- **读写工具**：`ctx.tools.register()` 原生工具的结构化结果与 `output.render` 投影贴合 `QueryGroup` 部分成功语义；MCP 工具强制 `mcp__<server>__<tool>` 命名且结果文本化。
- **Skill 不能承载工具**：Skill 本质是按需加载的 Markdown 指令，若只发 Skill，模型需直接操作 `.refino/` 文件，违反「模型不直接访问 CRG 文件」的原则；可用 `ctx.skills.register()` 注册一个讲解 CRG 概念与工具选用时机的技能作为补充。

对 dsh 的依赖保持薄封装：运行时仅 `@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/dsh-llm`（`createUserMessage`，注入消息须经官方工厂生成稳定 id）；`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`（`Agent` 接口与 `agent/*` 事件声明）、`@deepseek-ai/dsh-session`（会话头类型）仅作类型依赖。

#### dsh 插件落地形态

- **分发**：npm 包声明 `dsh.bundle` manifest 指向包内 `cordis.patch.yml`，用户经 `dsh plugin --profile <name> add <包>` 安装；git 直装需自包含 `prepare` 构建脚本，发 npm 或 tarball 则免构建许可。
- **默认授权上下文**：默认值仅在未显式签发时使用——冻结区默认取全部根约束连同其祖先，前提全部注入；图节点数不超过 1024 时锚点取全部节点（初始注入即全图摘要），超过 1024 则要求显式锚点。签发后授权上下文是会话状态：外部变更不再重置为默认值，仅做收敛（签发列表中被删除的节点随之移除，其余保持）。
- **会话初始化**：监听 `agent/session-start`，取会话 cwd 定位 `.refino/`，经 `@refino/storage` 加载图，按默认或已签发的授权上下文构造 `HarnessSession`，按两级策略渲染并以 `<system-reminder>` 框架注入（显式区分「冻结区约束：只读」与「冻结区以外：授权修改空间」）。图超自动锚点预算时不静默：注入极简引导（图已连接、节点数、根约束摘要、以搜索定位并经确认签发锚点），使模型能协助人选锚点。
- **工具**：`refino_list` / `refino_search`（按摘要/ID 分页搜索，语义与 Web `GET /api/search` 对齐，大规模图下的定位手段）/ `refino_show` / `refino_grounds` / `refino_ancestors` / `refino_dependents` / `refino_siblings`（强兄弟，供细化时参考同级决策）/ `refino_pending_review` 与写入工具；`refino_update_node` 采用部分更新语义（与 CLI `update` 对齐：省略即不变，传空串即清除），grounds 仍整体替换并经校验。写入内部走引擎 `checkGroundsChange` + `validateGraph` + harness `checkModification`，越界（目标落在冻结区）返回结构化升级报告（正常工具结果，非报错）。修改空间沿细化方向向下封闭（见 crg.md 2.4），写入无需下游波及冻结区的检查。
- **增量同步**：监听 `.refino/nodes/` 分片目录，变更经增量重载产出待审查集与 delta 事件后注入；无监听能力时降级为 touch 驱动（参照 dsh `agent-instructions` 的 `tools/result` 模式）。delta 注入降噪：合并多批事件并设最小注入间隔。
- **锚点/冻结区签发**：主交互面为授权控制台组件（`@refino/ui`，见「用户侧：授权控制台」），经 dsh Web Client 的 slots/Conversation 节点扩展点挂载；辅助面为 `ctx.commands` 用户命令与工具内 `ctx.userQuestions.ask()` 模型发起的多选确认（dsh 限制仅运行时根 agent 可发起）。命令面：`/refino` 打开控制台、`/refino-anchor` 设锚点、`/refino-freeze` / `/refino-unfreeze`（作用于 frontier 语义并回显传播结果）、`/refino-context` 重述当前上下文、`/refino-pending` 列待审查、`/refino-changes` 列本会话 agent 写入清单。升级报告在宿主支持结构化渲染时呈现为升级卡片（阻挡约束、原因、受影响下游、打开控制台等操作），无宿主 UI 时降级为文本并引导运行 `/refino`。
- **版本策略**：dsh 处于 developer preview，`@deepseek-ai/*` 依赖锁精确版本，CI 对 dsh 升级跑插件冒烟。

## 命名约定

vibe coding 工具插件统一命名为 `@refino/<tool>-plugin`，`<tool>` 为工具缩写，在此登记以避免命名漂移：

| 缩写  | 包名                 | 工具             |
| ----- | -------------------- | ---------------- |
| `dsh` | `@refino/dsh-plugin` | DeepSeek harness |

## 前端技术栈

可视化界面统一使用 Vue 3。`@refino/ui` 定位为"组件库 + 可嵌入的编辑器应用壳"，宿主（工具插件、桌面应用、VSCode webview）负责提供容器与数据通道。

## Web 界面（`refino web`）

`refino web` 是面向人类的 CRG 浏览、编辑与变更审阅工具：通过 CLI 启动本地 HTTP 服务，在浏览器中访问。它只提供对 CRG 本身的访问，与 agent 任务执行无关——作用域锚点选择、冻结区签发（授权控制台）等任务界定功能属于工具插件宿主的交互组件，不在本界面范围内。

跨包的设计决策与契约如下；界面结构、页面与交互细节见 `@refino/ui` 的 README。

### 技术选型

组件库选用 Naive UI：Element Plus 生态最大、文档最全，但主题定制依赖 SCSS 且包体偏大；Naive UI TypeScript 支持与 tree-shaking 最好、主题用 JS 配置对象即可完成、包体小。本项目是 TS strict monorepo，优先类型体验与体积。前端所有资源以本地依赖打包，不使用 CDN，保持完全离线可用。

### 后端 API 契约（v1，由 `@refino/cli` 的 web 服务实现，`@refino/ui` 消费）

全量读写（保留，画布不再调用，仅适用于小规模图或兼容场景）：

- `GET /api/graph`：全量节点、边与校验 issues。
- `POST /api/nodes/premise`、`POST /api/nodes/constraint`：创建，复用 `createPremise`/`createConstraint`。
- `PUT /api/nodes/:id`：更新节点；写入前经由引擎 `checkGroundsChange` 校验 grounds，可携带 revision（类似 `If-Match`），不一致返回 409。
- `DELETE /api/nodes/:id`：删除节点；存在下游约束时返回 409 并附受影响约束列表。
- `GET /api/validate`：独立校验。

#### 服务端常驻索引架构

画布按需查询在 10⁶ 规模下要求服务端具备索引化的按需读取能力。v1 采用进程内常驻索引：

- **两层内存**：id、type、grounds、summary 构成的轻量索引常驻；body 凭"路径即身份"规则按需读取并 LRU 缓存。
- **校验与 issues**：加载时执行一次 `validateGraph`，issues 缓存；API 写入后增量复检并更新缓存。
- **索引更新**：API 写入与外部文件事件走同一个增量更新入口。
- **变更检测**：以轻量字段加文件 mtime 判定内容是否变化；纯 body 编辑对轻量字段不可见，mtime 保证这类修改同样递增 revision 并经 SSE 推送，使乐观并发（409）覆盖正文级外部修改。mtime 是保守信号：同内容重写文件亦视为变更。
- **全量重建**：`POST /api/reload` 触发完整重扫与索引重建，作为监听不可用或服务重启后的权威恢复通道。

当前 `@refino/storage` 的全量目录扫描只适合小规模图；大规模索引的方案（持久化索引等）是后续设计课题，落地前以常驻内存索引为 v1 实现。

#### 画布按需查询

界面中央的 CRG 交互式可视化区域（下称"画布"）不默认全量加载：一个项目可能包含 10⁶ 量级的约束节点，全量拉取不可行。画布以选择驱动按需展开，工作集与渲染预算等细节见 `@refino/ui` README；跨包的查询契约如下，均沿用批量、部分成功语义，返回形状为 `QueryGroup<T>`：

- `POST /api/query/neighbors`：`{ ids, ancestorDepth, descendantDepth, limit? }` → 各节点的邻域（含相对深度 `depth`），按近者优先截断，返回 `truncated` 标志。邻域含锚点自身（`depth` 为 0）；邻域内祖先必含约束与前提；后代只含约束。
- `POST /api/query/grounds`：`{ ids }` → 各节点的直接依据（悬停时单跳拉取）。
- `POST /api/query/range`：`{ focusId, clickedId, budget }` → `{ mode, nodes }`。`mode` 取值：
  - `ancestor`：一端是另一端的祖先，`nodes` 为「祖先的后代约束集 ∩ 后代的祖先约束集」加两个端点自身，有序去重；
  - `branches`：不同分支，`nodes` 为两节点各自到最近公共祖先的路径上的约束节点加两个端点自身，有序去重；搜索预算内找不到公共祖先时退化为仅含被点击节点；
  - `disconnected`：预算内无法判定关系，`nodes` 仅含被点击节点。
    返回的节点序列只含约束节点与两个端点自身（端点为前提时保留）。
- `POST /api/query/siblings`：`{ ids, limit? }` → 各节点的强兄弟（共享 ≥1 个直接 grounds 的约束，不含自身与前提），按重叠数降序、id 升序截断。
- `GET /api/search`：资源浏览器、命令面板与依据选择器的分页搜索，`?q=&type=&limit=&cursor=&roots=`，轻量返回（id、类型、摘要）；`roots` 过滤仅返回 grounds 为空的约束，供项目概览冷启动。
- `GET /api/stats`：项目概览计数（节点总数、约束数、前提数、根约束数），常驻索引直接聚合。
- `GET /api/pending`：待审查约束清单。服务端在变更批处理入口以 harness `pendingReview` 相同的派生逻辑维护「自最近一次 `POST /api/reload`（或服务启动）以来直接依赖过变更节点的约束」；被删除的变更节点以其旧图下游计入。确认状态存于客户端偏好（按 id+revision 键，节点再变更自动重新挂起），不进图数据（派生态不持久化）。

资源浏览器与命令面板不得全量渲染，须经 `/api/search` 分页。

#### 外部变更同步

工具插件经由 `@refino/storage` 直接写入 `.refino/`，不经过 web 服务，因此服务端内存索引必然与磁盘漂移。同步机制如下：

- **检测**：监听 `.refino/nodes/` 下的分片目录（分片目录数量有界，watch 数随之有界），事件按 500ms 安静期去抖后批量应用；API 写入与外部文件事件走同一个索引更新入口。监听初始化失败时静默降级为纯手动刷新。
- **推送**：服务端维护单调递增的图修订号（revision），任何来源的变更应用后递增；通过 SSE（`/api/events`）向客户端推送 `{ revision, changed: string[], deleted: string[], origin }`，`origin: "api" | "file"` 标注变更入口（界面/API 写入或外部文件事件），供变更审阅标注来源，不承诺区分具体客户端。SSE 断线重连后按当前 revision 全量比对刷新。
- **节点历史（后续课题）**：存储「路径即身份」，节点文件路径稳定，可经 git 提供 per-node log/diff，支撑编辑器中的历史与差异视图；依赖服务端 git 集成，单独立项。
- **手动刷新**：保留为权威重建通道（服务重启后的累积变更、监听不可用的平台），对应 `POST /api/reload`。
- **存储写入原子化**：`@refino/storage` 的写入改为临时文件 + rename，避免监听触发的读取撞上写了一半的文件。

#### 编辑冲突处理

编辑器（模态）打开节点时记录 base 快照。外部变更到达该节点时：

- 编辑器未打开或无改动：静默更新记录与表单。
- 有改动且外部只改了用户未动过的字段：静默字段级合并（未动字段取外部值，已动字段保留用户值），轻提示"已合并外部更改"。
- 有改动且外部改了用户同一字段：提示冲突，提供两个选项：① 载入外部版本（丢弃我的改动）；② 保留我的改动（保存时覆盖）。不提供差异查看。
- 节点被外部删除且有未保存改动：提示以我的内容重新创建该 id，或放弃。
- **乐观并发控制**：`PUT` 可携带打开时记录的 revision（类似 `If-Match`），服务端保存前重读文件比对，不一致返回 409，防止用户在冲突提示后保存时再次被无声覆盖。

#### 读取语义

Web 读接口在图存在 issues 时照常返回数据并附带 issues；CLI 查询则在存在 issues 时拒绝执行（结果有歧义）。

画布以问题角标呈现，不因 Agent 任务执行中的瞬态无效状态阻塞浏览。

编辑功能的写入经由 `@refino/storage` 的 update/delete 写 API（原子写，grounds 引用有效性在落盘前校验）；PUT 到一个尚不存在的合法 id 则以该 id 创建，用于外部删除后的同 id 重建。

## 测试工具

`@refino/testkit`：`private: true`，不发布，直接以 TS 源码作为 exports，避免构建顺序问题。各包以 devDependency 引入。
