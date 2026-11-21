# @refino/cli 设计

本包是 `refino` 命令的 npm 渠道分发壳（docs/design.md，"命令行工具"）：命令面由 Rust crate `refino` 实现，本包只负责把平台二进制装到用户机器上并以透明转发的方式执行它。引擎、存储与命令逻辑一概不在本包内。

## 分发模式

采用 esbuild / Biome 的平台包模式：壳声明 `optionalDependencies`，npm 依平台包的 `os` / `cpu` / `libc` 字段自动选择并安装唯一匹配项；`bin/refino.js` 运行时解析平台包内的二进制并执行。

决策与理由：

- **平台包是 workspace 成员**（`packages/cli-<平台>-<架构>/`），而非发布期生成的临时目录：本地 `pnpm install` 只解析 workspace 内部引用，不触碰 registry——平台包尚未首次发布时，仓库的日常安装与锁文件不受影响。CI 在 `pnpm -r publish` 前把各平台构建产物复制进对应目录的 `bin/`，拓扑序保证平台包先于壳发布。
- **版本单一来源**：壳与全部平台包的 `version` 相同，由测试（manifest contract）强制同步；发布时人工一并更新。`optionalDependencies` 以 `workspace:*` 声明，`pnpm publish` 替换为精确版本——与 esbuild / Biome 一致，杜绝版本漂移的混装。
- **无 postinstall 脚本**：现代 npm / pnpm / yarn 均已正确处理按平台过滤的 optionalDependencies；esbuild 的安装脚本与下载回退是 yarn 旧缺陷的遗留。省去 postinstall 同时兼容 `--ignore-scripts` 安装，避开 pnpm 的构建脚本审批（onlyBuiltDependencies）。安装损坏在首次运行时以可操作的错误信息暴露（缺失平台包的常见原因与修复路径）。
- **libc 变体预留**：当前发布 gnu（glibc）构建；musl 构建的 triples 已在解析器候选序中（musl 主机优先尝试 `-musl` 后缀，静态 musl 二进制亦可回退运行于 glibc），发布 musl 平台包只需增加 matrix 行与对应 workspace 目录。
- **`REFINO_BINARY_PATH`**：显式覆盖解析（开发与 CI），同 esbuild 的 `ESBUILD_BINARY_PATH`。
- **退出码与信号**：stdio 继承、退出码透传；二进制被信号终止时按 128+n 约定映射，保证脚本可区分 SIGINT 等中断与普通失败。

## `refino web` 的界面资产

原生 `refino web` 从运行根向上查找 `node_modules/@refino/ui/dist`，或读取 `REFINO_UI_DIR`。npm 渠道由壳负责：壳声明 `@refino/ui` 运行时依赖，启动时经 Node 解析把构建目录写入子进程的 `REFINO_UI_DIR`，使本地与全局安装都开箱可用（显式设置的 `REFINO_UI_DIR` 优先）。两者皆无时，终端打印警告，浏览器得到一页说明如何补齐资产。

## 职责边界

本包不提供：

- 图结构解析、校验或查询逻辑（Rust 引擎提供）
- 命令行参数解析（clap，在 Rust crate 内）
- 任务界定的图逻辑（`@refino/harness` 提供，供工具插件消费）
- 可视化编辑界面组件（由 `@refino/ui` 提供）
