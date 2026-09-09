---
name: refino-crg
description: 用 refino 插件管理项目决策。当仓库存在 .refino/ 目录、或任务涉及项目约束、决策谱系、前提变化时使用；经 refino 的 MCP 工具读写，绝不直接编辑 .refino/ 下的文件。
---

# refino（插件形态）

本插件以约束细化图（CRG）管理项目决策：`.refino/` 目录中版本化的有向图，记录会限制后续实现选择空间的项目决策（约束），以及使决策成立的项目事实（前提）及其从抽象到具体的细化关系。会话开始时已注入初始上下文（锚点与前提摘要，标注 `[冻结]` 者只读）；完整概念见仓库的 docs/crg.md。

## 工具

插件经 MCP 提供 14 个工具，一切读写经它们进行。宿主会把工具连同实际全名注入工具清单，以宿主注入的名称为准；下文以短名指称：

- 按需查询：`show`（完整内容）、`search`（大图定位）、`list`、`grounds` / `ancestors`（上游背景）、`dependents`（下游影响，修改前必查）、`siblings`（同级决策参考）
- 待审查：`pending_review`（最近变化的节点及其直接下游约束）
- 写入：`create_premise` / `create_constraint` / `update_node` / `delete_node`；目标在冻结区时返回结构化升级报告——停止修改、向用户报告，不得绕过
- 授权：`context`（当前生效授权）、`request_authorization`（对话签发）

## 硬规则

- 仓库下不存在 `.refino/` 目录时，本插件不接管（工具会报告未激活）；仅当用户明确要求时才经 `refino init`（CLI）为仓库启用 refino
- 绝不直接编辑 `.refino/` 下的文件，一切读写经上述工具
- 冻结区（授权）由人签发：调用 `request_authorization` 前必须先在对话中向用户呈现完整划分草案与理由并获得明确同意；未经同意不得擅自调整冻结区
- 外部修改过的图会有更新注入提示；重要修改前先以 `pending_review` 复核待审查约束
