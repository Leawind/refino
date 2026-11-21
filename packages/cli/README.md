# @refino/cli

npm 渠道的 `refino` 命令：一个分发壳，负责把平台原生二进制安装到你的机器上并转发命令。命令本身由 Rust 实现（[crates/refino](../../crates/refino)），对 Decision Lineage Graph（DLG）做查询、校验、节点读写与本地 Web 界面服务。

```sh
npm install -g @refino/cli
refino --help
```

具体用法与概念的权威是命令自身：`refino --help` 与 `refino guide`（面向 agent 的使用指南）。

## 工作方式

安装时，npm 依据本机的平台从 `optionalDependencies` 中自动选择一个平台包（内含预编译的 `refino` 二进制）：

| 平台包                     | 系统    | 架构  | libc  |
| -------------------------- | ------- | ----- | ----- |
| `@refino/cli-win32-x64`    | Windows | x64   | —     |
| `@refino/cli-darwin-x64`   | macOS   | x64   | —     |
| `@refino/cli-darwin-arm64` | macOS   | arm64 | —     |
| `@refino/cli-linux-x64`    | Linux   | x64   | glibc |
| `@refino/cli-linux-arm64`  | Linux   | arm64 | glibc |

运行时，`bin/refino.js` 解析已安装的平台包并以其身份执行二进制：stdio 原样继承、退出码原样透传。平台包与壳的版本严格一致。

- **没有装上二进制？** 常见于 `--omit=optional` / `--no-optional` 安装，或 `node_modules` 被跨机器复制。重新安装即可；错误信息会列出期望的平台包。
- **musl 系统（Alpine 等）**：暂未发布 musl 构建，请 `cargo install refino`（crates.io 渠道）或自行编译。
- **`REFINO_BINARY_PATH`**：设为二进制路径可跳过解析（开发与 CI 场景），同 esbuild 的 `ESBUILD_BINARY_PATH`。
- **`refino web` 的界面资产**：壳依赖 `@refino/ui`，启动时把构建产物目录经 `REFINO_UI_DIR` 传给原生二进制，本地与全局安装都可直接使用；显式设置 `REFINO_UI_DIR` 可覆盖。

## 了解更多

- 包内设计细节：[DESIGN.md](./DESIGN.md)
- 项目整体设计：[docs/design.md](../../docs/design.md)
