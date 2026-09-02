# @refino/ui

Constraint Refinement Graph（CRG）的可视化组件库与可嵌入编辑器应用壳，基于 Vue 3 实现。

宿主（CLI 的 `refino web` 服务、工具插件、桌面应用、VSCode webview）负责提供容器与数据通道；本包只关注界面本身。当前处于脚手架阶段，仅包含占位页面。

## 开发

启动带热更新的开发服务（保存源码后浏览器实时刷新）：

```sh
pnpm --filter @refino/ui dev
```

默认在 <http://localhost:5173> 打开。开发服务会将 `/api/*` 请求代理到后端；后端即 `refino web` 服务（默认 `127.0.0.1:5649`），可用 `--host` / `--port` 指定，或通过环境变量 `REFINO_WEB_HOST` / `REFINO_WEB_PORT` 告知代理目标：

```sh
refino web                       # 终端 1：启动后端
pnpm --filter @refino/ui dev     # 终端 2：启动开发服务
```

构建产物为 `dist/` 下的纯本地静态资源（无外部 CDN 依赖，可完全离线运行），由 `refino web` 托管：

```sh
pnpm --filter @refino/ui build
```

## 职责边界

本包提供：

- CRG 可视化与编辑的 Vue 3 组件
- 可嵌入的编辑器应用壳

本包不提供：

- 图结构解析、校验或查询逻辑（由 `refino` 引擎提供）
- HTTP 服务与数据存取（由宿主提供）
