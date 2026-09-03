# @refino/cli

`refino` 引擎的命令行接口。提供对 Constraint Refinement Graph 的查询、校验与节点创建能力。

引擎本身不包含任何 CLI 逻辑；本包是 `refino` 的薄封装，所有图操作均委托给引擎完成。

## 快速开始

```sh
# 校验当前目录下的 CRG
refino validate

# 列出所有节点
refino list

# 查看某个或多个节点的完整内容（查询命令均支持批量传入 id）
refino show <id>...

# 创建节点（--id 可显式指定节点 ID，省略时自动生成）
refino new premise --body "..." --now
refino new constraint --body "..." --grounds <ids>
refino new premise --id <id> --body "..."

# 启动 Web 界面服务（默认 127.0.0.1:5649）
refino web --host 127.0.0.1 --port 5649
```

完整命令列表与参数说明请运行 `refino --help`。

## 职责边界

本包提供：

- 命令行参数解析与输出格式化
- JSON 输出模式（`--json`）
- 自定义项目根目录（`--root`）
- `refino web` 的 HTTP 服务：进程内常驻索引（轻量索引常驻、body 按需读取并 LRU 缓存）、画布按需查询、分页搜索、文件监听与 SSE 变更推送（`/api/events`）、权威重建（`/api/reload`）。API 契约与索引架构见 [docs/design.md](../../docs/design.md) 的「Web 界面」一节

本包不提供：

- 图结构解析、校验或查询逻辑（由 `refino` 引擎提供）
- 可视化编辑界面组件（由 `@refino/ui` 提供）
- 任务界定或权限管理
