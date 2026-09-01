# @refino/cli

CRG 命令行工具。全局选项：

- `--root <dir>`：包含 `.refino/` 的项目根目录（默认当前目录）；
- `--json`：在 stdout 输出机器可读 JSON。

## 命令

### `new`

在 `.refino/` 中创建节点，成功后在 stdout 输出生成的 ID 和文件路径。

```sh
# 创建前提节点
refino new premise --body "PostgreSQL 16 is in use." --confirmed 2026-05-01T00:00:00Z

# 创建约束节点
refino new constraint --body "数据访问必须通过 Repository 层。" --grounds 01ABCDEF,1A2B3C4D --rationale "业务层不得直接依赖数据库。"
```

- `refino new premise`：`--body <text>`（必填），`--confirmed <timestamp>`（RFC 3339，需带时区偏移）或 `--now`（以当前 UTC 时间作为确认时间，二者互斥）。
- `refino new constraint`：`--body <text>`（必填），`--grounds <ids>`（逗号分隔的 ground id），`--rationale <text>`。

ID 由引擎生成并保证不与现有节点冲突。`--json` 时输出 `{ "id": ..., "file": ... }`。

### `validate`

构建图并报告所有校验问题；有问题时退出码为 1。

### `list`

列出所有节点（id、类型、摘要）。`--type premise|constraint` 可按类型过滤。

### `show <id>`

打印节点的完整记录（正文全文）。

### `grounds <id>`

直接依据（按声明顺序解析）。

### `ancestors <id>`

沿 `grounds` 递归追溯的全部祖先（前提与上游约束），附带最小深度。

### `dependents <id>`

直接或间接依赖该节点的约束（传递闭包），附带最小深度。
