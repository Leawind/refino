# refino

本仓库实现 [基于约束细化图（CRG）的项目决策管理方案](docs/crg.md) 中的概念。

该方案的核心是约束细化图（Constraint Refinement Graph, CRG）：以版本化文本维护的有向图，记录会限制后续实现选择空间的项目决策（约束），以及使这些决策成立的项目事实（前提）。

## 接入 Harness

将以下指令复制给 agent：

```text
请为当前环境安装 refino：安装 @refino/cordis-plugin-refino 插件。
```
