# @refino/cli 设计

引擎本身不包含任何 CLI 逻辑；本包是 `refino` 的薄封装，所有图操作均委托给引擎完成。

## 职责边界

本包提供：

- 命令行参数解析与输出格式化
- 读取语义：`list` 与查询命令在图存在校验问题时拒绝执行（结果将有歧义），并以 `validate` 的格式输出问题详情
- `show` 的文本输出包含节点的全部字段（summary、rationale、confirmed 以带标签的行呈现，可选字段缺省时不占行）
- `list --unreferenced`：列出未被任何约束引用的前提（待注入前提）
- 写入前校验：`new constraint` 与 `update` 在落盘前经由引擎 `checkGroundsChange` 原语校验 grounds（引用不存在、重复 id 等即拒绝写入）
- 审核台账：`update` 与 `delete` 成功写入后将受影响下游（存储层 `StoreChange.affected`）记入 `.refino/state/review.json`（见下节），命令输出同步报告影响面
- `update` 的部分更新语义：未指定的字段保持当前值；由 body 派生的 summary 不会被固化进 frontmatter
- `delete` 的删除守卫：目标被其他节点 grounds 引用时拒绝并列出受影响节点（`--force` 覆盖，与 Web API 的 409 语义对应）
- 自定义项目根目录（`--root`）
- `refino web` 的 HTTP 服务：进程内常驻索引（轻量索引常驻、body 按需读取并 LRU 缓存）、画布按需查询、分页搜索、文件监听与 SSE 变更推送（`/api/events`）、权威重建（`/api/reload`）。API 契约与索引架构见 [docs/design.md](../../docs/design.md) 的“Web 界面”一节

本包不提供：

- 图结构解析、校验或查询逻辑（由 `refino` 引擎提供）
- 任务界定的图逻辑（授权上下文校验、冻结区、越界报告、上下文渲染与估算由 `@refino/harness` 提供，供工具插件消费；通用接入形态不实现任务界定层）
- 可视化编辑界面组件（由 `@refino/ui` 提供）
- 任何 harness 的技能安装或配置写入：`skill` 命令只向 stdout 输出内容与指引

## 审核台账

通用接入形态没有授权机制：模型经 CLI 直接读写，写入路径只有引擎 grounds 校验，约束保障是 Git 事后审核（docs/design.md“通用接入形态”）。审核工作的进度记录在工作区状态车道：`update` / `delete` 成功写入后，把存储层 `StoreChange.affected`（变更节点的直接下游、被删节点删除前的下游，即 crg.md 1.6 的待审查原料）合入 `<root>/.refino/state/review.json`（由提交的 `.refino/.gitignore` 排除出版本控制，机器本地、随工作区生灭；原子写）。条目按 id 去重（保留最早记录时间、刷新致因），读取侧按当前图收敛（图中已不存在的节点静默剔除）。`refino pending` 把台账条目与 git 基线派生的待审查集合合并呈现；`refino review ack` 确认移除。台账不是权限：不校验、不阻止任何读写。
