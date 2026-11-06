# MCode 子 Agent 核心功能对照

本清单对照 MCode `3c21163c85a9684030cb147bfef48c6284fa3c46`，用于维护子 Agent 核心契约，不是整个 MCode 宿主的等价证明。`upstream.lock.json` 记录复用模块及受监测源码；上游版本更新后，需要重新审查受影响的行，不能只更新哈希。

“对应实现”表示所列行为已有生产调用链及回归，不代表整套功能已验收。“Pi 适配”允许接口和实现结构不同，但仍须保留核心工作流；尚未满足的行为标为“待实现”或“部分实现”，不能以适配边界代替补齐。源码比较、受控 SDK 回归、真实模型验证和外部服务验证分别记录，不互相替代。

## 架构取舍

- 优先复用 MCode 的源码与设计，将宿主差异限制在薄适配层。核心行为与能力必须保留，实现结构不必一致；有更简洁的 Pi 原生实现时优先采用。
- 定期同步上游更新，分开维护复用源码、适配逻辑和同步记录。控制本地分叉规模，使版本变更可追溯至受影响的接口及验证项，降低升级成本。
- 以可靠性、轻量化、简洁性和执行效率为优化目标，通过增量输出、通知去重和按需工具暴露控制 token 开销，不降低安全性、权限约束或核心能力。必要信息优先通过 Pi 内置通道传递；未证实替代方案更优时遵循 MCode 契约，不以长度判断信息是否必要。优于上游的设计应提供具体收益和验证依据。

## 需求与验收基线

以下要求定义交付目标，后文对照表记录当前实现与证据。需求不能因现有实现的限制而缩减。

| 编号 | 要求 | 验收条件 |
| --- | --- | --- |
| C1 | 保留核心任务编排与角色职责 | 前后台任务、队列与并发、请求去重、独立历史、运行中 steering、闲置续接、同步 send、来源关系、取消、失败、恢复及通知均沿真实入口验证；角色职责、Verifier 判定和执行状态分别保留 |
| C2 | 继承模型、资源及权限边界 | 保留显式覆盖、角色配置、父有效选择和 fallback 的优先级；既有子会话选择与权限上界不漂移。Skills、扩展和 MCP 在授权范围内可用，子会话不获得父任务控制或额外授权 |
| C3 | 使用 Pi 原生 codemode 承接程序化工具调用 | 父 Pi 的实际启用状态是唯一总开关，角色与 MCP 不能暗中开启，旧快照不扩权。批量调用、并行取数和结果筛选按收益使用，简单操作保留直接调用，不增加摘要模型或子开关 |
| C4 | 可靠传递必要结果 | 前台及同步续接完整返回；后台结果先持久化，再经 Pi 原生通道通知原 owner，由父会话读取结果后整合。无经验证的更优方案时保持 MCode 契约，不按长度筛选必要信息，不以隐藏元数据代替模型实际读取；执行、判定、观察及清理事实均可追溯 |
| C5 | 支持子 Agent 内的受管后台命令 | 原生前台 Bash 保持默认。Worker、Verifier、Mavis 可启动所属命令、继续独立工作、增量读取输出并单独停止；Explore 保持前台限制。命令归属子会话和逻辑 Turn，不能控制父任务、其他子会话或其他 Turn 尚未结束的命令。结束前等待所属命令并在同一逻辑任务内交付未读结果，不依赖模型轮询或另建跟进任务 |
| C6 | 保留命令输出和清理事实 | 输出采用有界内存、私有持久存储和 UTF-8 增量读取，失败或不完整状态必须显式报告。取消、超时和关闭等待原生执行清理；清理未确认时保留租约与容量。崩溃后不重放命令，未知执行状态不能被当作已停止或已清理 |
| C7 | 提供工具目标级文件观察 | 在现有隐私与扫描预算内覆盖 write/edit、Bash 及嵌套 codemode 调用，保留首次调用前和最后调用后的观察事实。动态、排除、范围外或不完整目标须标明不确定性或采集失败；拒绝、失败、中止及并发变化不能形成虚假的无变化或归因结论。观察不是全文件内容扫描、通用写审计或路径沙箱 |
| C8 | 降低上游同步成本 | 区分复用源码、薄适配和同步记录，保留原始/适配哈希、可逆转换及关键生产者监测。定期检查上游，审查受影响契约后完成同步与回归；不能只更新锁文件，也不自动合并未经适配的变化 |
| C9 | 保持实现精简与验证充分 | 优先复用上游及 Pi 原生能力，不另建重复宿主、全局调度器或无必要配置。优化以具体收益为依据，不削弱安全、错误处理或无障碍支持。必要行为完成后执行项目检查、Node 22/24 回归和提取包验证，区分开发源码、安装版本与真实服务证据 |

## 对照清单

上游路径均相对于 [固定版本源码](https://github.com/MiniMax-AI/minimax-code/tree/3c21163c85a9684030cb147bfef48c6284fa3c46)。`AT` 表示 `packages/agent-tools/src/desktop/`，`LR` 表示 `packages/local-runtime/src/`，`V2` 表示 `packages/local-runtime-v2/`。

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| Task 标题规范化、允许空 prompt、无效参数拒绝 | `LR/api/local-task-input.ts` | `task-domain.ts`、`config.ts` | 对应实现；`engine.test.ts` 的 Unicode、空 prompt 和输入边界回归 |
| 默认前台等待，显式后台仅返回准入回执 | `AT/local-task.ts`、`LR/api/local-task-runner.ts` | `extension.ts`、`engine.ts` | 对应实现；`engine.test.ts`、`tool-result-golden.test.ts` |
| 独立子会话，不复制父对话 | `LR/api/local-task-runner.ts`、子会话共享契约 | `pi-backend.ts`、`child-session-file.ts` | 对应实现；`pi-backend.test.ts` 的独立历史与续接 |
| 队列、并发占用、取消排队任务 | `LR/background-task/runner.ts` | `engine.ts`、`engine-admission.ts` | 对应实现；`engine.test.ts` 的并发、排队、取消回归；省略并发参数不新增插件配额 |
| 已准入请求去重，持久化先于执行 | `LR/api/local-task-append.ts` | `engine-admission.ts`、`engine-append.ts` | 对应实现；`engine.test.ts` 的提交前后崩溃、去重回执和补偿回归 |
| 运行中 append 合并到原 Turn，排队时不重复派发 | `LR/api/local-task-append.ts`、steering service | `engine-append.ts`、`child-steering.ts` | 对应实现；`engine.test.ts`、`task-lineage.test.ts` |
| 闲置 append 新建任务、沿用子历史及权限快照 | `LR/api/local-task-append-lifecycle.ts` | `engine.ts`、`engine-session-safety.ts` | 对应实现；续接、冻结 profile、重启和历史权限回归 |
| 续接来源及 append 执行模式可追溯 | `LR/api/local-task-append-lifecycle.ts`、`AT/local-task-control.ts` | `types.ts`、`engine.ts`、`store.ts`、`tool-result-control.ts` | 对应实现；`task-lineage.test.ts` 覆盖生产、查询、重启及固定上游查询源码对照；不为旧记录补造关系 |
| 闲置同步 send 不排队、不混入另一 Turn | `AT/local-mavis.ts` 的 session send | `engine.ts`、`task_send` | Pi 适配；仅本 owner 的子会话，不提供通用 Mavis 会话管理；busy、重放及通知回归见 `engine.test.ts` |
| 任务 ID 与 Turn ID 可逆映射 | `LR/background-task/turn-id.ts` | `task-turn-id.ts` | 对应实现；`engine.test.ts` 的固定上游源码和 opaque ID 回归 |
| 输出只来自实际终态结果，单一 writer | `LR/background-task/terminal.ts` | `engine-terminal.ts`、`child-message-window.ts` | 对应实现；终态固定源码、committed history、停止竞态回归；不把工具活动当日志流 |
| 查询恢复 session、来源、执行模式及失败事实 | `AT/local-task-control.ts` | `tool-result-control.ts` | 对应实现；`tool-result-golden.test.ts`、`task-lineage.test.ts` |
| 输出 UTF-8 游标、增量读取、等待及 30 秒上限 | `AT/local-task-control.ts` | `engine-output.ts`、`task-domain.ts`、`tool-result-control.ts` | 对应实现；`engine.test.ts`、golden 测试；取消读取不停止任务 |
| 后台终态通知原 owner，前台及同步 send 不重复通知 | `LR/background-task/conversation-delivery.ts` | `controller.ts`、`controller-owners.ts`、`engine.ts` | 对应实现；Pi 原生 `sendMessage`/`followUp` 传递模型可见、TUI 隐藏的完成通知，完整结果由 `task_output` 读取，不按长度分流或截取。`task-result-delivery.test.ts` 验证真实 SDK 父子消息、完整必要证据/末尾风险、持久回执及重启无重放；`controller.test.ts`、`engine.test.ts` 覆盖切 owner 与取消 |
| 停止、超时和关闭落实到所属子执行 | `LR/background-task/task-stop.ts`、append admission | `engine.ts`、`child-steering.ts`、`pi-backend.ts` | 对应实现；真实原生 Bash、认证前取消、compaction、初始化及超时回归 |
| 清理失败保留占用，不能伪装资源已释放 | Task stop 与任务准入生命周期 | `engine-session-safety.ts`、`pi-backend.ts` | 对应实现；进程、租约、cleanup-only owner、关闭重试回归；公开 canceled 不等于清理完成 |
| 重启保留历史、输出及回执，未知执行不自动重放 | `LR/background-task/startup-recovery.ts` | `store.ts`、`engine.ts` | 对应实现；`engine.test.ts`、`store-compatibility.test.ts`；不是跨进程守护服务 |
| 四角色及自定义角色分辨 | `V2/assets/agents/builtin-agents.json`、`LR/api/local-task-subagents.ts` | `config.ts`、`prompts/` | Pi 适配；自定义角色使用 Pi 配置，不搬运 MCode Plugin Agent 注册系统；见 `config.test.ts` |
| Explore 只读交付门禁，写文件需求返回 ROLE_MISMATCH | `V2/assets/agents/_v2/explore.md.hbs` | `prompts/explore.md`、角色工具 ceiling | 对应实现；`task-verification.test.ts`、`pi-backend.test.ts`；Bash 和可信扩展不是沙箱 |
| Worker 范围、所有权、最小改动及如实验证 | `V2/assets/agents/_v2/worker.md.hbs` | `prompts/worker.md`、项目指令 | 对应实现；原生写入与 SDK 任务链回归；模型是否遵从指令需按任务检查 |
| Verifier 不修改交付物，临时产物仅进指定目录 | `V2/assets/agents/_v2/verifier.md.hbs` | `prompts/verifier.md`、角色工具 ceiling | 对应实现；角色门禁与真实 SDK 验证回归；不是文件系统写入隔离 |
| Verifier 判定、执行状态及观察事实分离 | `AT/task-verification.ts`、`LR/api/injected-conversation-task-turn.ts` | `task-verification.ts`、`pi-backend.ts`、`engine-facts.ts` | 对应实现；固定原始 parser 差分、失败/中止、持久化及公开投影回归 |
| 子 Agent 内受管后台命令及同逻辑任务结果回收 | `LR/background-task/child-bash-lifecycle.ts`、`LR/api/hosted-agent-capabilities.ts` | `child-commands.ts`、`command-journal.ts`、`command-output.ts`、`child-bash-ports.ts`、`pi-backend.ts`、`engine.ts` | 已接入 C5/C6；复用上游 manager、store、lifecycle 与 waiter，通过原生 `executeTool` 启动、读取和停止命令，并在 `agent_before_settle` 等待和交付结果。`child-commands.test.ts`、`child-command-scope.test.ts`、`managed-command-ownership.test.ts`、`command-output.test.ts` 验证角色/快照、Turn 隔离、持久输出、原生 PID 清理、故障占用及恢复；发布前按 C9 执行冻结验收 |
| 工具目标级文件观察与不确定性分类 | `LR/turns/file-changes.ts` | `tool-file-observation.ts`、`file-write-targets.ts`、`workspace-observation.ts` | 已接入 C7 的元数据适配；`tool-file-observation.ts` 绑定实际工具事件，复用上游纯目标提取函数，覆盖其他适用角色及嵌套调用。`managed-command-observation.test.ts` 验证受管命令与部分写入的联动；`tool-file-observation.test.ts`、`file-write-targets.test.ts` 验证目标合并、动态/范围外目标、拒绝、失败、中止及并发变化；不提供内容 diff 或通用写审计，发布前按 C9 执行完整联动门禁 |
| 子 Agent 不再派工或控制父任务 | task-child 工具 surface、共享委派契约 | `resource-selection.ts`、SDK allowlist 和 tool_call guard | 对应实现；`pi-backend.test.ts`、`child-contract.test.ts`；不向子会话开放父 owner 的 task 控制 |
| 子 Agent 不管父 todos/goals，不直接询问用户或安排独立后续工作 | `V2/.../local-turn-tool-catalog.ts`、共享委派契约 | `resource-selection.ts`、`pi-backend.ts` | 对应实现；拦截 `todo/todowrite`、`ask_user/ask_user_question`、`create_goal/get_goal`、`until`；真实 SDK 验证工具不可调用且扩展 hooks 仍运行 |
| 信息不足向父会话报告 blocker，Memory 写入遵守所有权 | `V2/assets/agents/_default/prompt-session-branch.md.hbs` | 所有角色共用的 SDK 附加指令 | Pi 适配；`child-contract.test.ts` 检查真实模型请求中的共享指令；没有 child-owned Memory 时将持久结论交父会话处理，不另建 Memory 宿主 |
| Task 显式模型/思考优先，其次角色配置、父有效选择 | `V2/src/application/session/task-agent-binding-capture.ts` | `config.ts`、`controller.ts`、`pi-backend.ts` | Pi 适配；使用 Pi 的 provider/id、thinking 和原生 registry，不复刻 MCode 模型组管理器；见配置和 SDK 选模回归 |
| 换模型不继承不兼容旧参数，既有子会话不随父切换漂移 | `V2/src/service/model-system/catalog/agent-model-selection.ts` | `resolveProfile`、冻结 profile 与 onProfileResolved | 对应设计；`config.test.ts`、`pi-backend.test.ts`、`engine.test.ts` |
| Skills、扩展、MCP 按允许范围加载并保留权限上界 | binding capture、最终工具 surface | `resource-*.ts`、`pi-backend.ts` | Pi 适配；`resource-inheritance.test.ts` 通过真实 SDK 主会话及四角色执行受控 Skill、扩展与 stdio MCP；关闭、trust 和快照不扩大 |
| 原生工具 ceiling 与 Plugin/MCP 来源权限分开 | `V2/.../local-turn-tool-catalog.ts` | `resource-selection.ts`、`resource-tool-inventory.ts` | 对应设计；角色 ceiling、MCP deny、发现与 codemode 回归；外部工具不构成只读沙箱 |
| codemode 总开关由父 Pi 控制，不由角色或 MCP 另行开启 | Pi 原生 active 工具状态 | `controller.ts`、`controller-owners.ts`、`pi-backend.ts` | 对应实现；`codemode-switch.test.ts`、`controller.test.ts` 和真实父 SDK 四角色资源继承回归；无父状态默认关闭，无新增用户配置开关 |
| PTC 类程序化工具调用、并行组合及结果整理 | `packages/agent-core/src/tools/ptc.ts`、`V2/assets/agents/_v2/PTC_TOOL_CALLS.md.hbs` | Pi 原生 `codemode` | Pi 适配，不是能力排除；`pi-backend-codemode.test.ts` 覆盖四角色原生/扩展组合、显式关闭 MCP、权限 hooks 和已保存上界；受控 MCP 调用另见 `resource-inheritance.test.ts` |
| 原生安装、资源启动和多子会话不能共享错误 UI 状态 | Pi 宿主适配责任 | `resource-mcp.ts`、`pi-backend.ts` | Pi 适配；`host-peer-sdk.test.ts`、`pi-backend-ui-isolation.test.ts` 覆盖无本地 peer 和保留双会话 |

## 适配限制与验收要求

- C5/C6 的命令运行时已接入，受控验证覆盖范围、关闭和资源故障路径；接缝探针不能代替生产链验收。Engine 在原生命令启动前持久化清理所有权；只有当前 owner 的清理证明或成功处置才能解除占用。崩溃后的未确认所有权进入隔离，不重放执行。
- C7 的目标观察已接入各适用角色，并验证受管命令的已知目标和停止后的部分写入。仍须参加最终冻结验收；元数据变化不等于内容差异，报告不归因并发写入。
- C8 当前配置为定期变更检查，更新仍需契约审查、适配和回归。`LR/turns/file-changes.ts` 已纳入监测，抽取的目标函数由固定原文哈希及函数体一致性测试保护；检查通过仍不代表所有核心行为都已同步。
- C9 的最终验收须在相关生产链补齐后冻结源码并执行。既有定向测试或早期完整门禁只覆盖各自快照，不代表当前全部需求已完成。

## 实现边界

- 不复刻 MCode 的完整进程宿主、全局后台调度器或日志控制界面，但必须用原生能力和薄适配满足 C5/C6 的命令工作流。
- MCode 的部署、通用 Mavis 会话管理、Memory 宿主、完整 TUI 和 SQLite 观察运行时不在本插件范围。PTC 类能力由 Pi 原生 codemode 承接，不另建 PTC 宿主。核心任务行为由上表对应生产链提供，不因排除宿主而直接删除。
- 准入、permission hooks 和工具门控不能阻止可信第三方扩展自行执行代码，也不是 OS 或网络沙箱。第三方工厂在 SDK 接管之前发生的副作用仍由该工厂负责回滚。
- 命令输出以当前 Pi 原生 Bash 捕获的输出为边界。仅接收本次原生调用的受校验输出源，并固定 `FileHandle` 身份；历史句柄只读取子会话私有日志，不把任意 URI 当作文件授权。宿主输出格式变化导致无法取得完整输出，或记录、解码不完整时，须明确报告，不能静默返回截取内容并宣称完整。
- 原生执行结束与外部副作用回滚不同。主动脱离原生工具生命周期的进程、容器或外部服务不由这些句柄接管，也不能因一个 Bash 执行结束就宣称它们已停止。
- 真实模型探针仅能证明当次角色、源码、资源和输入路径；资源元数据可见不证明任意 MCP 业务接口可用。未经授权不执行真实模型或第三方业务验收。

## PTC 与 codemode 的对应关系

MCode PTC 和 Pi codemode 都让模型用程序组合多个工具调用、并行取数并整理结果。这里核对能力，不把不同产品或名称当成缺失，也不要求复制 MCode 的 PTC 运行时。

| 项目 | Pi 适配及区别 |
| --- | --- |
| 调用入口 | MCode 使用 `run_code` 及其 JSON 参数；Pi 使用原生 `codemode` 和 JavaScript 输入。脚本调用 `tools.<name>(args)`，不保证原脚本无需修改即可迁移 |
| 工具与结果 | 调用当前子会话获准的原生、扩展和 MCP 工具；Pi read 返回文本，MCode PTC 提示词使用 `r.data.content`。使用各自的原生返回契约，不假装包装格式相同 |
| 权限 | 不增加任何工具权限。角色 ceiling、父控制工具屏蔽、permission hooks、显式 deny 和已保存上界仍生效。父开启不会给旧快照自动新增 codemode；父关闭会阻断既有子会话的后续脚本调用，已经执行的副作用不撤回 |
| 使用时机 | 父已开启且独立调用批量执行或大结果筛选有收益时优先使用；单次简单操作用直接工具。不强制套脚本，不额外调用模型生成摘要 |
| 总开关 | 只认父 Pi 当前实际启用的 `codemode`，读取 active 工具而不是仅已注册的工具定义。父关闭或没有可验证的父状态时，子不能自行启用；不另设子 Agent 开关 |
| MCP 可选性 | 父 Pi 开启后，子可用 codemode 组合获准工具，不要求角色再写启用项。`mcp:false` 或 `mcpServers:[]` 只关闭 MCP；开启 MCP 或角色显式选择不能反过来开启父开关 |
| 可见性 | 当前用 Pi 的 `mode: on`，保留直接工具调用；MCode 开启 PTC 的对应 surface 可以只允许程序入口及控制工具。不是逐接口相同 |
| 超时与结果记录 | 使用 Pi 的脚本 `timeout_ms`、取消和输出协议；不复刻 MCode 默认 120 秒、共享 batch 预算或 `details.ptc` 侧信道。脚本失败不会撤销之前已执行的工具副作用 |
| 模型服务 | 子会话 codemode 使用 `models:false`，不开放额外 classifier/image 模型调用；程序化工具组合不因此被关闭 |

同一父会话的开关变化实时约束后续调用；切换父会话时，后台任务保留原 owner 最近批准状态，不去读取新会话或失效 API。重新回到原 owner 时读取当前父 Pi 状态；关闭引擎时不再批准新的 codemode 调用。

上述受控测试证明列出的工具调用与权限路径，不证明两个宿主的全部超时、预算、媒体和恢复协议完全等价。

## 持续同步

保留 8 个上游任务领域模块，另复用 2 个 child-Bash 生命周期/等待模块，由 Pi 原生命令适配器接入执行与同逻辑任务结果回收。这 10 个文件均有原始/适配哈希和可逆转换核验；另监测 42 个核心参考文件，覆盖公开工具定义、准入/续接、停止/终态/恢复、角色定义及模板、模型装配、实际 task-child 工具 surface、PTC 公共契约、文件观察生产者和许可。文件目标提取仅复用纯函数，以固定原文和函数体一致性测试约束本地差异，不引入 diff/数据库宿主。参考文件只用于变化报警，不打包成另一套宿主实现。

```sh
npm run upstream:verify
npm run upstream:check
```

前者离线核验本地 vendor 及可逆适配，后者读取上游当前 commit，检查文件变化、移除和任务领域模块清单。GitHub workflow 每周或手动运行检查，不自动迁移功能、开 PR 或合并。

需要更新时，先核对具体 commit 的变化，对上表相关生产链和测试完成适配，再运行带明确 `--ref COMMIT` 的同步命令。受监测契约变化默认阻止同步；`--accept-contract-changes` 只确认已人工审查，不替代适配。删除或移动的参考文件必须先修正路径，不能靠确认参数忽略。

监测覆盖的是列明的核心入口和生产链，不是整个仓库的依赖闭包。新依赖中的行为变化仍可能需要人工追踪；检查通过不能单独证明全量功能等价。没有运行完整 MCode 测试套件，也没有验证所有外部服务或平台。
