# @refino/cordis-plugin-refino

refino 的 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)适配插件：把 CRG 的任务界定层接入 dsh 会话，让 agent 在授权范围内读写约束细化图。以 Cordis 插件形式接入，以 dsh bundle（npm 包）形式分发。

## 提供什么

- **会话初始化**：会话启动时自动注入当前仓库的 CRG 上下文（锚点与前提摘要，标注 `[冻结]` 者只读）；图过大时注入极简引导，以搜索定位。未采用 refino 的仓库（无 `.refino/`）不接管。
- **模型侧 CRG 工具**：`refino_*` 系列工具——查询（`refino_show` / `refino_search` / `refino_ancestors` / `refino_dependents`…）、待审查、写入（经授权边界校验，越界返回结构化升级报告）、授权查询（`refino_context`）与对话签发（`refino_request_authorization`）。
- **对话签发**：模型起草冻结区划分并呈现在对话中，经 dsh 原生审批服务获得人的明确批准后生效；编排者凭据生效时拒绝签发。
- **外部变更同步**：仓库外的图修改经降噪合并，以增量更新即时注入会话。

## 安装

从 npm 安装：

```sh
dsh plugin --profile <profile> add @refino/cordis-plugin-refino
```

从源码安装：

```sh
pnpm --filter @refino/cordis-plugin-refino build

dsh plugin --profile <profile> add /path/to/refino/packages/dsh-plugin
```

安装后可用 `dsh --profile <profile> --dump-config` 确认合成配置中出现本插件的补丁层。`link:` 安装是活的，但 dsh 加载的是 `dist`：修改本插件或其 workspace 依赖的源码后，需重建对应包的 `dist` 并重启 dsh。

## 了解更多

- 包内设计细节（会话态、注入、签发、依赖策略）：[DESIGN.md](./DESIGN.md)
- 接入形态定案与协议：[docs/design.md](../../docs/design.md)；概念模型见 [docs/crg.md](../../docs/crg.md)

## 职责边界

图数据的解析、校验与边界计算来自 [`refino`](../refino)、[`@refino/storage`](../storage)、[`@refino/harness`](../harness)；工具执行核心与注入文本经 `@refino/harness/host` 与 cc 插件单一实现。本包只含 dsh 宿主绑定，对宿主的依赖保持薄封装。
