# refino

Constraint Refinement Graph (CRG) 纯引擎：CRG 的图数据模型与纯图逻辑。不依赖任何 Node API，可在浏览器、Web Worker 等任意提供 Web Crypto（`globalThis.crypto`）的 JS 环境运行（Node >= 20）。

概念模型与完整规则见 [docs/crg.md](../../docs/crg.md)。本包当前实现其中第 1 章（决策资产层）的图结构部分。

## 职责边界

本包提供：

- 常驻图数据模型的类型定义：id、type、summary、grounds（父引用）、children（图内派生的子引用）、premise 的 confirmed（epoch 毫秒）
- 图结构的组装（按 ID 索引、grounds↔children 双向引用回填、id 字符串 intern）
- 内存变更原语（`addNode` / `removeNode` / `setGrounds`）：维护 grounds↔children 双向引用一致性
- 图结构的完整性校验（引用解析、环路检测）
- 按 ID 查询节点、遍历依据链与依赖链
- 最长路径分层（`assignLayers`）：按 grounds 方向为节点集计算拓扑层级（上游在前、下游在后），环输入下按确定性规则近似
- 批量查询的标准结果形状与批量执行助手（部分成功语义：按查询 id 分组返回，缺失的 id 以错误条目标注，不阻断其余 id），供 CLI、harness 工具、Web 按需查询等消费方统一使用
- 写入前 grounds 变更校验原语：针对当前图校验一次 grounds 变更（引用不存在、成环等），供所有写入路径在落盘前调用
- ID 规则的定义与校验，及随机 ID 生成（Crockford base32）

本包不提供：

- 节点内容（`body`、`rationale`）的表示与分页供给：引擎类型不携带内容字段，内容按 id 由存储适配层按需提供
- 文件系统读写与存储格式的定义、解析、序列化、摘要提取（由存储适配层承担，引擎只消费其产出的常驻内存图）
- 任务界定（作用域锚点、修改边界、授权上下文）
- 冲突检测与越界升级
- 可视化或编辑界面
- 命令行接口

注意：

- 待审查（Pending Review）是派生状态，通过查询前提的依赖关系确定，由应用在内存中维护，不在节点文件中持久化存储。

## 内存模型

图可能达到 10⁶ 节点规模，引擎按「常驻 + 分页」划分内存：常驻集（id、type、summary、grounds、confirmed、children）始终在内存中，是引擎类型的全部内容；正文与理由等大字段不进引擎内存，由存储层按 id 分页供给。渐进披露（先读摘要判断相关性、再展开全文）因此只需要常驻集即可完成第一级。节点是图附着对象：独立解析出的节点记录与图内节点（携带 children 反向引用）是两个形状，组装（`buildGraph`）负责回填反向引用。详见 docs/design.md 的「渐进披露与常驻集」。

## ID 规则

节点 ID 的生成与校验由本包统一负责，各包统一调用本包，不各自定义规则：

- 字符集：大写 `A-Z`、数字 `0-9`、下划线 `_`；禁止连字符 `-`、点 `.`、空格、小写及其他字符。
- 长度：3–16 字符。
- 随机 ID 自动生成使用 Crockford base32（8 字符），属内部实现细节，不构成对外的 ID 规则；Crockford 字符集是上述规则的子集，生成的 ID 天然合法。

## 校验问题（issues）

issues 是对图做完整性检查后产出的问题列表，归属字段由产生方定义：

- 引擎 issues（`RefinoIssue`）产生于两个阶段：
  - 结构校验阶段：依据引用不存在的节点、约束→约束路径成环；
  - 写入前变更校验阶段：grounds 变更落盘前的引用与成环检查，产出与结构校验同形的 issues，只报告该变更引入的问题，不报告图中既有问题。
- 持久化层 issues（`@refino/storage` 的 `StorageIssue`）产生于加载解析阶段：frontmatter 非法、ID 或文件路径形状非法、重复 ID、`confirmed` 时间戳格式非法等，每条额外携带规范文件路径 `file`；引擎的 `RefinoIssue` 不含任何文件路径词汇。

issues 只描述图及其存储的问题，与任何消费方无关；如何处置（阻断操作或附带展示）由消费方自行决定。
