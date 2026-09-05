# Agent 指南

## 最高约束

最高约束由用户（人类开发者）亲自编写，Agent 不得擅动。

- 本仓库用于实现 [CRG](docs/crg.md) 中的概念。
- 本仓库不用 refino 管理自身的决策、项目约束或前提。refino 尚不成熟，本仓库仅采用传统的 `AGENTS.md` 作为 Agent 指南，具体的设计方案位于 docs/design.md
- 仓库中的文档代表目标，可超前于代码实现，不可滞后
- 如果执行任务时发现现有文档存在错误、矛盾、过时、缺失等问题而应当修改，但用户没预料到，应向用户请示，不能编写超前于文档的实现或擅自修改文档
- 当前项目未发布正式版本，允许任意破坏兼容性的更改
  - 废弃的旧代码、文档应彻底移除
  - 不要试图兼容旧实现

## 其他

- AGENTS-LOCAL.md 中存放本地开发环境下所用工具链相关的经验，建议阅读
- packages/ 中的包应有自己的 README，简单介绍包的作用、职责范围，不罗列易变的实现细节
- 包的 README 中可以引用该包依赖的其他包，但不能引用依赖它的包
- 所有包都必须是跨平台的，不能假设文件路径是 Unix 或 Windows 风格：平台相关的路径操作一律通过 `node:path` 等平台抽象完成
- 文档用中文，代码注释用英文
- 修改文件时注意单个源码文件通常不多于500行，若过长可考虑拆分、重构相关逻辑，但若理由充分也可保留较长的文件
- 执行任务时应适时提交更改，而非完成全部任务后一次性提交
  - 提交前必须执行 `pnpm format && pnpm check` 格式化并检查，通过后才能提交
- 若踩到值得记录的坑，可在任务完成后报告

## 踩坑记录

实现中踩过并确认的坑，供后续任务避让；条目应写清现象与结论，不罗列排查过程。

- Node `fs.watch` 的 FSWatcher 触发的 EventEmitter 事件名只有 `'change'`；`'rename'` / `'change'` 是回调第一个参数（eventType）的取值，不是事件名。用 `.on("rename", ...)` 注册的监听器永远不会触发；不用 callback 简写形式时极易踩中。参见 `packages/storage/src/watcher.ts`。
- 排查"事件没触发 / 回调没执行"类问题时：先让出错的代码与能工作的参照代码逐字符对齐注册方式，再做环境假设（运行环境、平台、时序等）；对照实验一次只允许改变一个变量，否则极易把归因引向错误方向。
- naive-ui 的 `useMessage` / `useDialog` 等 provider 类 composable，不能在渲染 `<NMessageProvider>` 的组件自身的 setup 中调用：会在挂载时抛 "No outer \<n-message-provider /\>"，失败面是整个应用挂载失败（黑屏），而非仅消息功能不可用。这类 composable 必须放在 provider 内部的专用子组件中调用（参见 `packages/ui/src/components/WorkspaceToasts.vue`）；jsdom 组件测试暴露不了此问题，需要真实浏览器冒烟。
- WebGL `vertexAttribPointer` 的 stride 是**每实例字节数**，不是缓冲容量：误传容量会让实例属性越界读取，`drawArraysInstanced` 被**整体静默丢弃**——控制台零输出，唯一线索是 `gl.getError()` 返回 1282（INVALID_OPERATION）。stride 应由字段布局求和得出；传 0 也不是"交错排列"，而是"各属性分别紧密排列"。画布内容缺失而代码看似正常时，第一步查 `gl.getError()`。参见 `packages/ui/src/graph/render/renderer.ts`。
- WebGL 着色器的编译/链接错误只在浏览器运行时暴露，默认表现是**画布静默空白**（无任何报错，jsdom 组件测试无法发现）。本次实际踩中的两种触法：使用 GLSL 保留字（如 `half`）作变量名；顶点与片段着色器的 varying 声明不一致（一侧删了 `v_color` 传递、另一侧还在读）。`GraphRenderer.create` 已捕获初始化异常并回落 DOM 提示、控制台输出 `getShaderInfoLog`/`getProgramInfoLog`，但修改着色器仍必须真实浏览器冒烟。参见 `packages/ui/src/graph/render/shaders.ts`。
- vite dev 下经 HMR 更新过的模块，应用内部持有的是带 `?t=` 时间戳 URL 的实例；此后在页面里用裸 URL 动态 `import()` 同一模块会得到**独立副本**，读写它的状态都与应用无关——表现为"控制台里改了状态、界面纹丝不动，读回的状态也是假象"。要在页面里直接操作/检查应用状态，必须先整页刷新（消除 HMR 时间戳），再注入脚本。
- monorepo 中下游包的测试消费的是依赖包的 **dist 而非 src**：修改了依赖包的源码并让依赖包自身测试通过后，下游包的测试仍跑在旧 dist 上，表现为"修复在依赖包内可复现验证、在下游测试中却像没生效"。改完被依赖的包必须先重新构建它的 dist，再跑下游测试；跨包排查"改动无效"类问题时第一步核对 dist 新旧。
- 同一 id 在外部被删除后以**另一类型重建**（如约束删了、同 id 建前提），投影增量应用时若走"就地更新"原语会被静默丢弃——引擎 `updateNode` 的契约是节点类型固定、类型不匹配直接返回。换类型必须 remove + add 整体替换。图节点类型切换类变更不生效时先查应用路径是否绕过了类型检查。参见 `packages/storage/src/store.ts` 的 `putEntry`。
