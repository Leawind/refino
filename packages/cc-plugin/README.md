# @refino/cc-plugin

refino 的 [ZCode](https://z.ai) / Claude Code 适配插件：把 CRG 的任务界定层接入 agent 会话，让 agent 在授权范围内读写约束细化图。以 Claude Code 插件规范形态实现（hooks + 插件 MCP server + skill），插件目录分发；ZCode 已验证，Claude Code 及兼容该规范的 harness 设计上支持（未验证）。

## 提供什么

- **会话初始化**：会话启动时自动注入当前仓库的 CRG 上下文（锚点与前提摘要，标注 `[冻结]` 者只读）；图过大时注入极简引导，以搜索定位。未采用 refino 的仓库（无 `.refino/`）完全静默。
- **模型侧 CRG 工具**：`mcp__refino__*` 系列工具——查询（`show` / `search` / `ancestors` / `dependents` / `siblings`…）、待审查、写入（经授权边界校验，越界返回结构化升级报告）、授权查询与对话签发。
- **外部变更同步**：仓库外的图修改会在下一条消息时以增量更新注入会话。
- **技能**：`refino-crg` 讲解 CRG 概念与工具选用时机。

## 安装

要求 Node ≥ 20。先构建产物：

```sh
pnpm --filter @refino/cc-plugin build
```

两种安装方式：

- **内联目录（本机/开发）**：在 `~/.zcode/cli/config.json` 的 `plugins.dirs` 中加入本包目录的绝对路径，重启 ZCode 即生效；改源码后重新 build 再开新会话。
- **marketplace（正式）**：把本仓库添加为插件 marketplace（ZCode：Settings → Plugin Management → Discover → `+` 添加本地目录或 GitHub 仓库），安装 `refino` 插件。

安装后在含 `.refino/` 的仓库开新会话即生效；可在 Settings → MCP 确认内置 `refino` server 已连接。

## 了解更多

- 包内设计细节（通道映射、会话状态、注入队列、构建产物）：[DESIGN.md](./DESIGN.md)
- 接入形态定案与协议：[docs/design.md](../../docs/design.md)；概念模型见 [docs/crg.md](../../docs/crg.md)

## 职责边界

图数据的解析、校验与边界计算来自 [`refino`](../refino)、[`@refino/storage`](../storage)、[`@refino/harness`](../harness)；工具执行核心与注入文本与 dsh 插件同源（`@refino/harness/host` 单一实现）。本包只含宿主绑定。
