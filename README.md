# refino

本仓库实现 [基于约束细化图（CRG）的项目决策管理方案](docs/crg.md) 中的概念。

该方案的核心是约束细化图（Constraint Refinement Graph, CRG）：以版本化文本维护的有向图，记录会限制后续实现选择空间的项目决策（约束），以及使这些决策成立的项目事实（前提）。

## 在 agent harness 中使用

将以下指令复制给 agent，由 agent 自行完成安装与接入（设计见 [docs/design.md](docs/design.md) 的「通用接入形态」）：

```text
本仓库使用 refino 管理项目决策（约束细化图）。refino 命令经 npm 获取：终端可直接运行 refino 时直接用，否则用 npx -y @refino/cli（下同）。请：

1. 运行 refino skill 获取技能内容与安装指引，并按指引把技能装入你的技能机制；
2. 运行 refino guide 了解工作协议，并按其「接入」一节完成与当前环境的集成；
3. 若本仓库尚无 .refino/ 目录，运行 refino init。

之后一切对项目决策的读写与授权操作都经 refino 完成，不要直接编辑 .refino/ 下的文件；授权（冻结区）变更须经用户同意。
```
