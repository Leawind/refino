# @refino/cc-plugin 设计

跨包的设计决策（接入形态定案、注入协议、授权模型）位于 docs/design.md 的“harness 与工具插件功能设计”与“cc 插件落地形态”；本文只记录包内的设计细节。

## 职责边界

本包是 Claude Code 插件规范形态的宿主绑定层：hooks 的输入输出适配、MCP 协议层（schema 组装与文本渲染）、跨进程注入队列与插件工件（manifest、`.mcp.json`、hooks、skill）。图逻辑、工具执行核心、签发链与注入文本全部来自 `@refino/harness/host`（与 dsh 插件单一实现）；本包不含图逻辑。

## 组件与启动链路

| 组件                            | 形态                            | 生命周期                                                  |
| ------------------------------- | ------------------------------- | --------------------------------------------------------- |
| MCP server（`src/mcp.ts` 入口） | `.mcp.json` 声明的 stdio 子进程 | 宿主每会话 spawn 一个，`node dist/mcp.js`，cwd 为项目目录 |
| session-start hook              | 一次性命令进程                  | 每次会话启动/恢复/压缩时由宿主拉起                        |
| sync hook                       | 一次性命令进程                  | 每条用户消息时由宿主拉起                                  |
| skill（`refino-crg`）           | 指令文本                        | 随插件加载                                                |

项目定位：server 从 `REFINO_PROJECT_DIR ?? CLAUDE_PROJECT_DIR ?? ZCODE_PROJECT_DIR ?? process.cwd()` 起向上 `findRefinoDir`；`.mcp.json` 的 `cwd: ${CLAUDE_PROJECT_DIR}` 保证进程工作目录即项目。

## 会话初始化（hook.ts）

- 按 payload 分支：`startup`/`clear`（及未知来源）注入基线上下文（超自动锚点预算时注入极简引导）；`resume`/`compact` 注入一行**中性**状态——当前授权以 `context` 工具查询为准，不凭会话历史中的授权记忆行动。中性措辞是必然而非折衷：hook 为一次性进程，读不到 MCP server 内存中的会话内签发，任何断言（“当前为默认上下文”）都可能失真。
- 只读加载（`loadGraph`，不开 watcher）——常驻投影归 server 进程所有。
- fail-open：hook 失败只写 stderr、退出 0，绝不阻塞会话；无 `.refino/` 完全静默（采用契约）。
- stdin 的读取以子命令匹配为前提（`argv[2]` 为 `session-start`/`sync` 才进入 main），否则模块被 import 时会因等待 stdin 永远挂起——这是测试直接 import hook.ts 的前提。

## MCP server（server.ts / tools.ts）

三模块分层：`tools.ts` 是协议无关的工具表（名字、JSON Schema、防御性参数矫正、execute/render 对），`server.ts` 把表绑到 MCP 的 `tools/list`/`tools/call`，`mcp.ts` 只是 stdio 入口。测试直接调 `execute`，另有一条经 SDK in-memory transport 的协议往返。

- 工具为 14 个短名（宿主侧 `mcp__refino__<tool>`）；注入/渲染文本中的工具指称经 `ToolRefs` 参数化（`tool-names.ts` 是模型侧名字的单一来源），宿主侧真实全名如与假设不符只改这一处。
- workspace 惰性打开：首次工具调用时 `RefinoWorkspace.open`（watcher 开），此后复用；找不到 `.refino/` 时所有工具以“未激活”错误文本返回，不接管。
- 工具结果为 markdown 文本（harness render kit 的投影），MCP `isError` 仅用于执行异常（未知工具、参数形状非法、未激活）。
- 签发 core 的 `get` 绑定到可变 holder：core 的接口是同步取 workspace，而表的 `obtainWorkspace` 是异步的——每次签发/context 调用前先 `await requireWs` 再写入 holder。

## 会话状态与隔离

签发状态（origin 记录、已签发的授权上下文、降噪累积）在 server 进程内存。宿主为每会话 spawn 独立 server 子进程，因此签发是会话作用域的。同项目并发会话：各自 server 各自签发（写边界互不影响），但注入队列共享（见下）；并发任务的正式隔离手段是 worktree（不同 `.refino/` 物理隔离）。

## 跨进程注入队列（queue.ts）

宿主对插件 MCP server 无推送通道，外部变更与签发 delta 经队列投递：

- 位置在系统临时目录（`tmpdir()/refino-cc/`），按 `.refino` 目录路径的哈希分文件；机器本地、不含签发数据、随系统临时目录清理——这是 design.md 不变量中明示豁免的唯一下载外文件。
- 写入原子（临时文件 + rename）；队列内文本以 chunk 合并（更新文本是单块、不含空行，`\n\n` 分隔无歧义），与已排队 chunk 完全相同的入队被丢弃（identical-text guard 在队列侧的实现）。
- 消费是先取者得：任一会话的下一条用户消息 drain 整个队列，其余会话不再看到——v1 明示边界。
- server 侧的降噪（`DeltaCoalescer`，2s）在入队前合并 watcher 批次。

## 对话签发

批准门为对话批准协议（与通用接入形态同构、同水位）：先在对话中呈现完整草案并获用户明确同意是调用 `request_authorization` 的前置义务（工具描述与技能硬规则承载），宿主的 MCP 工具权限面是可选的机械层。core 的 `requestApproval` 默认实现恒返回 `allowed-once`（协议前置而非门内校验），编排者凭据生效时 core 直接拒绝。签发 delta 同时出现在工具结果（即时反馈）与注入队列（持久记录）。

## 构建产物

esbuild 打包 `dist/mcp.js` 与 `dist/hook.js`（platform node、target node20、ESM、全依赖内联）。banner 注入 `createRequire`：内联的 CJS 依赖（`yaml`）会 `require("process")`，ESM 输出中 esbuild 自带的 shim 对此抛 "Dynamic require is not supported"，banner 提供真实 `require` 后 shim 会转发。`tsc --noEmit` 只做类型检查。产物在 `.gitignore`（根已全局忽略 `dist/`），源码安装需先构建。

## v1 边界与后续课题

- 外部变更投递颗粒度为“用户消息间”；每会话各得一份需要宿主向 MCP server 提供会话身份（stdio 环境无此通道）。
- 把签发批准升级为宿主权限面强制询问（PermissionRequest hook 匹配签发工具名）留作后续增强。
- marketplace 的发布工程（git 直装免构建、CI 产物）是后续课题。
