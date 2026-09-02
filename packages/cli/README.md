# @refino/cli

`refino` 引擎的命令行接口。提供对 Constraint Refinement Graph 的查询、校验与节点创建能力。

引擎本身不包含任何 CLI 逻辑；本包是 `refino` 的薄封装，所有图操作均委托给引擎完成。

## 快速开始

```sh
# 校验当前目录下的 CRG
refino validate

# 列出所有节点
refino list

# 查看某个节点的完整内容
refino show <id>

# 创建节点
refino new premise --body "..." --now
refino new constraint --body "..." --grounds <ids>
```

完整命令列表与参数说明请运行 `refino --help`。

## 职责边界

本包提供：

- 命令行参数解析与输出格式化
- JSON 输出模式（`--json`）
- 自定义项目根目录（`--root`）

本包不提供：

- 图结构解析、校验或查询逻辑（由 `refino` 引擎提供）
- 可视化编辑界面
- 任务界定或权限管理
