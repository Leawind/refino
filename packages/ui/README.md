# @refino/ui

Decision Lineage Graph（DLG）的可视化组件库与可嵌入编辑器应用壳，基于 Vue 3 实现。

宿主负责提供容器与数据通道；本包只关注界面本身。

## 开发

启动带热更新的开发服务（`/api/*` 代理到 `refino web` 后端，经 `REFINO_WEB_HOST` / `REFINO_WEB_PORT` 对齐实际端口）：

```sh
refino web                       # 终端 1：启动后端
pnpm --filter @refino/ui dev     # 终端 2：启动开发服务
```

构建产物为 `dist/` 下的纯本地静态资源，由 `refino web` 托管：

```sh
pnpm --filter @refino/ui build
```

npm 发布物只包含 `dist/`；Vue、Naive UI、Mermaid 等是构建依赖，不会成为下游安装时的运行时依赖。
