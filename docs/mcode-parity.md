# MCode 子 Agent 核心功能对照

本文对照 MCode `3c21163c85a9684030cb147bfef48c6284fa3c46`，记录子 Agent 核心契约在 Pi 中的实现与证据，不证明整个 MCode 宿主等价。安装和操作见 [README](../README.md)，工具桥机制见 [Pi 运行态适配](pi-runtime-adapter.md)。

“对应实现”表示行为已有生产调用链及回归；“Pi 适配”允许接口和结构不同，但保留核心工作流；“已接入”表示受管命令和文件观察等适配链路已接通。未满足项标为“待实现”或“部分实现”，不能作为适配边界排除。

## 验收基线

以下为交付目标，不因实现限制或宿主排除项而缩减；正式门禁见[宿主边界与待验收项](#宿主边界与待验收项)。

| 编号 | 要求 | 验收条件 |
| --- | --- | --- |
| C1 | 保留核心任务编排与角色职责 | 前后台任务、队列与并发、请求去重、独立历史、运行中 steering、闲置续接、同步 send、来源关系、取消、失败、恢复及通知均沿真实入口验证；角色职责、Verifier 判定和执行状态分别保留 |
| C2 | 继承模型、资源及权限边界 | 保留显式覆盖、角色配置、父有效选择和 fallback 的优先级；既有子会话选择与权限上界不漂移。Skills、扩展和 MCP 在授权范围内可用，子会话不获得父任务控制或额外授权 |
| C3 | 使用 Pi 原生 codemode 承接程序化工具调用 | 父 Pi 的实际启用状态是唯一总开关，角色与 MCP 不能暗中开启，旧快照不扩权。批量调用、并行取数和结果筛选按收益使用，简单操作保留直接调用，不增加摘要模型或子开关 |
| C4 | 可靠传递必要结果 | 前台及同步续接完整返回；后台结果先持久化，再经 Pi 原生通道通知原 owner，由父会话读取结果后整合。无经验证的更优方案时保持 MCode 契约，不按长度筛选必要信息，不以隐藏元数据代替模型实际读取；执行、判定、观察及清理事实均可追溯 |
| C5 | 支持子 Agent 内的受管后台命令 | 原生前台 Bash 保持默认。Worker、Verifier、Mavis 可启动所属命令、继续独立工作、增量读取输出并单独停止；Explore 保持前台限制。命令归属子会话和逻辑 Turn，不能控制父任务、其他子会话或其他 Turn 尚未结束的命令。结束前等待所属命令并在同一逻辑任务内交付未读结果，不依赖模型轮询或另建跟进任务 |
| C6 | 保留命令输出和清理事实 | 输出采用有界内存、私有持久存储和 UTF-8 增量读取，失败或不完整状态必须显式报告。取消、超时和关闭等待原生执行清理；清理未确认时保留租约与容量。崩溃后不重放命令，未知执行状态不能被当作已停止或已清理 |
| C7 | 提供工具目标级文件观察 | 在现有隐私与扫描预算内覆盖 write/edit、Bash 及嵌套 codemode 调用，保留首次调用前和最后调用后的观察事实。动态、排除、范围外或不完整目标须标明不确定性或采集失败；拒绝、失败、中止及并发变化不能形成虚假的无变化或归因结论。观察不是全文件内容扫描、通用写审计或路径沙箱 |
| C8 | 降低上游同步成本 | 复用源码、薄适配与同步记录分开维护；哈希、可逆转换、生产者监测及人工同步门禁见[上游同步](#上游同步c8) |
| C9 | 保持实现精简与验证充分 | 优先复用上游及 Pi 原生能力，不另建重复宿主、全局调度器或无必要配置。优化须有具体收益，不削弱安全、错误处理或无障碍支持；冻结源码后的验收门禁见下文 |

## 核心契约对照

上游路径相对于[固定版本源码](https://github.com/MiniMax-AI/minimax-code/tree/3c21163c85a9684030cb147bfef48c6284fa3c46)。`AT` 表示 `packages/agent-tools/src/desktop/`，`LR` 表示 `packages/local-runtime/src/`，`V2` 表示 `packages/local-runtime-v2/`。Pi 生产文件未写目录时位于 `src/`，测试文件位于 `test/`。

### 任务编排与续接（C1、C2）

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| Task 标题规范化、允许空 prompt、无效参数拒绝 | `LR/api/local-task-input.ts` | `task-domain.ts`、`config.ts` | 对应实现；`engine.test.ts` 覆盖 Unicode、空 prompt 和输入边界 |
| 默认前台等待，显式后台仅返回准入回执 | `AT/local-task.ts`、`LR/api/local-task-runner.ts` | `extension.ts`、`engine.ts` | 对应实现；`engine.test.ts`、`tool-result-golden.test.ts` |
| 独立子会话，不复制父对话 | `LR/api/local-task-runner.ts`、子会话共享契约 | `pi-backend.ts`、`child-session-file.ts` | 对应实现；`pi-backend.test.ts` 覆盖独立历史与续接 |
| 队列、并发占用、取消排队任务 | `LR/background-task/runner.ts` | `engine.ts`、`engine-admission.ts` | Pi 适配；每个父会话默认并发 4，可配置 1 至 10；`config.test.ts`、`engine.test.ts` 覆盖上限、排队、调度、取消和清理占槽 |
| 已准入请求去重，持久化先于执行 | `LR/api/local-task-append.ts` | `engine-admission.ts`、`engine-append.ts` | 对应实现；`engine.test.ts` 覆盖提交前后崩溃、去重回执和补偿 |
| 运行中 append 合并到原 Turn，排队时不重复派发 | `LR/api/local-task-append.ts`、steering service | `engine-append.ts`、`child-steering.ts` | 对应实现；`engine.test.ts`、`task-lineage.test.ts` |
| 闲置 append 新建任务、沿用子历史及权限快照 | `LR/api/local-task-append-lifecycle.ts` | `engine.ts`、`engine-session-safety.ts` | 对应实现；续接、冻结 profile、重启和历史权限回归 |
| 续接来源及 append 执行模式可追溯 | `LR/api/local-task-append-lifecycle.ts`、`AT/local-task-control.ts` | `types.ts`、`engine.ts`、`store.ts`、`tool-result-control.ts` | 对应实现；`task-lineage.test.ts` 覆盖生产、查询、重启及固定上游查询源码对照；不为旧记录补造关系 |
| 闲置同步 send 不排队、不混入另一 Turn | `AT/local-mavis.ts` 的 session send | `engine.ts`、`task_send` | Pi 适配；仅本 owner 的子会话，不提供通用 Mavis 会话管理；busy、重放及通知回归见 `engine.test.ts` |
| 任务 ID 与 Turn ID 可逆映射 | `LR/background-task/turn-id.ts` | `vendor/mcode-adapters/task-turn-id.ts` | 对应实现；`engine.test.ts` 覆盖固定上游源码和 opaque ID |

### 结果交付、通知与恢复（C1、C4）

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| 输出只来自实际终态结果，单一 writer | `LR/background-task/terminal.ts` | `engine-terminal.ts`、`child-message-window.ts` | 对应实现；终态固定源码、committed history、停止竞态回归；不把工具活动当日志流 |
| 查询恢复 session、来源、执行模式及失败事实 | `AT/local-task-control.ts` | `tool-result-control.ts` | 对应实现；`tool-result-golden.test.ts`、`task-lineage.test.ts` |
| 输出 UTF-8 游标、增量读取、等待及 30 秒上限 | `AT/local-task-control.ts` | `engine-output.ts`、`task-domain.ts`、`tool-result-control.ts` | 对应实现；`engine.test.ts`、golden 测试；取消读取不停止任务 |
| 后台终态通知原 owner，前台及同步 send 不重复通知 | `LR/background-task/conversation-delivery.ts`、`delivery.ts`、`delivery-batch.ts` | `controller.ts`、`controller-owners.ts`、`engine.ts` | 对应实现；Pi 原生通知对模型可见、TUI 隐藏，完整结果由 `task_output` 读取；批量、限流与重试规则见 [README 完成通知](../README.md#完成通知)。`task-result-delivery.test.ts` 覆盖真实 SDK 父子消息、完整证据/末尾风险、持久回执及重启无重放；`controller.test.ts` 覆盖合并、批量回执、限流、冷却、暂停与 resume；`engine.test.ts` 覆盖切 owner 与取消 |
| 停止、超时和关闭落实到所属子执行 | `LR/background-task/task-stop.ts`、append admission | `engine.ts`、`child-steering.ts`、`pi-backend.ts` | 对应实现；真实原生 Bash、认证前取消、compaction、初始化及超时回归 |
| 清理失败保留占用，不能伪装资源已释放 | Task stop 与任务准入生命周期 | `engine-session-safety.ts`、`pi-backend.ts` | 对应实现；进程、租约、cleanup-only owner、关闭重试回归；公开 canceled 不等于清理完成 |
| 重启保留历史、输出及回执，未知执行不自动重放 | `LR/background-task/startup-recovery.ts` | `store.ts`、`engine.ts` | 对应实现；`engine.test.ts`、`store-compatibility.test.ts`；不是跨进程守护服务 |

### 角色职责与委派边界（C1、C2）

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| 四角色及自定义角色分辨 | `V2/assets/agents/builtin-agents.json`、`LR/api/local-task-subagents.ts` | `config.ts`、`prompts/` | Pi 适配；自定义角色使用 Pi 配置，不搬运 MCode Plugin Agent 注册系统；见 `config.test.ts` |
| Explore 只读交付门禁，写文件需求返回 ROLE_MISMATCH | `V2/assets/agents/_v2/explore.md.hbs` | `prompts/explore.md`、角色工具 ceiling | 对应实现；`task-verification.test.ts`、`pi-backend.test.ts`；Bash、MCP 和可信扩展均不是沙箱 |
| Worker 范围、所有权、最小改动及如实验证 | `V2/assets/agents/_v2/worker.md.hbs` | `prompts/worker.md`、项目指令 | 对应实现；原生写入与 SDK 任务链回归；模型是否遵从指令需按任务检查 |
| Verifier 不修改交付物，临时产物仅进指定目录 | `V2/assets/agents/_v2/verifier.md.hbs` | `prompts/verifier.md`、角色工具 ceiling | 对应实现；角色门禁与真实 SDK 验证回归；不是文件系统写入隔离 |
| Verifier 判定、执行状态及观察事实分离 | `AT/task-verification.ts`、`LR/api/injected-conversation-task-turn.ts` | `task-verification.ts`、`pi-backend.ts`、`engine-facts.ts` | 对应实现；固定原始 parser 差分、失败/中止、持久化及公开投影回归 |
| 子 Agent 不再派工或控制父任务 | task-child 工具 surface、共享委派契约 | `resource-selection.ts`、SDK allowlist 和 tool_call guard | 对应实现；`pi-backend.test.ts`、`child-contract.test.ts`；不向子会话开放父 owner 的 task 控制 |
| 子 Agent 不管父 todos/goals，不直接询问用户或安排独立后续工作 | `V2/.../local-turn-tool-catalog.ts`、共享委派契约 | `resource-selection.ts`、`pi-backend.ts` | 对应实现；拦截 `todo/todowrite`、`ask_user/ask_user_question`、`create_goal/get_goal`、`until`；真实 SDK 验证工具不可调用且扩展 hooks 仍运行 |
| 信息不足向父会话报告 blocker，Memory 写入遵守所有权 | `V2/assets/agents/_default/prompt-session-branch.md.hbs` | 所有角色共用的 SDK 附加指令 | Pi 适配；`child-contract.test.ts` 检查真实模型请求中的共享指令；没有 child-owned Memory 时将持久结论交父会话处理，不另建 Memory 宿主 |

### 模型、资源与权限继承（C2）

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| Task 显式模型/思考优先，其次角色配置、父有效选择 | `V2/src/application/session/task-agent-binding-capture.ts` | `config.ts`、`controller.ts`、`pi-backend.ts` | Pi 适配；使用 Pi 的 provider/id、thinking 和原生 registry，不复刻 MCode 模型组管理器；见配置和 SDK 选模回归 |
| 换模型不继承不兼容旧参数，既有子会话不随父切换漂移 | `V2/src/service/model-system/catalog/agent-model-selection.ts` | `resolveProfile`、冻结 profile 与 onProfileResolved | 对应设计；`config.test.ts`、`pi-backend.test.ts`、`engine.test.ts` |
| Skills、扩展、MCP 按允许范围使用并保留权限上界 | binding capture、最终工具 surface | `parent-tools.ts`、`child-parent-tools.ts`、`controller.ts`、`pi-backend.ts` | Pi 适配；最终 Skills 来自官方事件，默认父桥仅转发已核验的官方原生及内置 MCP，不复制工厂或凭据；拒绝普通扩展、同名覆盖及 inline/替代 MCP，不影响父工具。`parent-tools.test.ts`、`runtime-inheritance.test.ts`、`resource-inheritance.test.ts` 覆盖生产链；机制与覆盖细目见 [Pi 运行态适配](pi-runtime-adapter.md) |
| 子执行保留必要父原生 Shell 设置 | Pi 宿主执行上下文 | `parent-tools.ts`、`pi-backend.ts` | 默认插件路径复用父 Bash 执行管线；仅为观察复制 `shellPath`/`shellCommandPrefix`。`runtime-inheritance.test.ts` 比较实际父执行、子前台 Bash、受管命令和 native codemode |
| 原生工具 ceiling 与 Plugin/MCP 来源权限分开 | `V2/.../local-turn-tool-catalog.ts` | `resource-selection.ts`、`resource-tool-inventory.ts` | 对应设计；角色 ceiling、MCP deny、发现与 codemode 回归；外部工具不构成只读沙箱 |

### 受管命令与文件观察（C5、C6、C7）

| 核心契约 | 上游来源 | Pi 生产路径 | 状态及验证 |
| --- | --- | --- | --- |
| 受管后台命令、Turn 归属及结果回收 | `LR/background-task/child-bash-lifecycle.ts`、`LR/api/hosted-agent-capabilities.ts` | `child-commands.ts`、`child-bash-ports.ts`、`pi-backend.ts` | 已接入；复用上游 manager、store、lifecycle 与 waiter，经原生 `executeTool` 执行，在 `agent_before_settle` 等待并交付结果。角色/快照、Turn 隔离及原生 PID 清理见 `child-commands.test.ts`、`child-command-scope.test.ts` |
| 命令持久输出、清理所有权及恢复 | 上述生命周期及 `LR/background-task/` 领域模块 | `command-journal.ts`、`command-output.ts`、`child-commands.ts`、`engine.ts` | 已接入；Engine 启动命令前持久化清理所有权，仅当前 owner 的清理证明或成功处置可解除占用；崩溃后未确认所有权进入隔离。持久输出、故障占用及恢复见 `managed-command-ownership.test.ts`、`command-output.test.ts` |
| 工具目标级文件观察与不确定性分类 | `LR/turns/file-changes.ts` | `tool-file-observation.ts`、`vendor/mcode-adapters/file-write-targets.ts`、`workspace-observation.ts` | 已接入元数据适配；绑定实际工具事件，复用上游纯目标提取函数。`tool-file-observation.test.ts`、`file-write-targets.test.ts` 覆盖目标、不确定性及失败边界；`managed-command-observation.test.ts` 覆盖受管命令与部分写入联动。不提供内容 diff 或通用写审计 |

### 程序化工具调用（C3）：PTC 与 codemode

Pi 适配使用原生 `codemode`，对应 MCode 的 `packages/agent-core/src/tools/ptc.ts` 和 `V2/assets/agents/_v2/PTC_TOOL_CALLS.md.hbs`。两者支持程序化工具组合、并行取数和结果整理，但不保证接口及运行协议相同。

| 项目 | Pi 适配及区别 |
| --- | --- |
| 调用入口 | MCode 使用 `run_code` 及其 JSON 参数；Pi 使用原生 `codemode` 和 JavaScript 输入。脚本调用 `tools.<name>(args)`，不保证原脚本无需修改即可迁移 |
| 工具与结果 | 默认插件路径仅组合获准的官方原生和内置 MCP 工具；显式嵌入 backend 的调用方可另供扩展。Pi read 返回文本，MCode PTC 提示词使用 `r.data.content`，不统一包装格式 |
| 权限 | 角色 ceiling、父控制工具屏蔽、permission hooks、显式 deny 和历史上界仍生效。回到原 owner 后，续接按当前父状态与历史上界重新绑定；父开启不扩权旧快照，父关闭或引擎关闭时阻断后续脚本调用 |
| 总开关与 MCP | 只认父 Pi 当前 active 工具中的 `codemode`，不是仅已注册的定义；父未开启或状态不可验证时关闭，角色和 MCP 不能开启，也不另设子开关。父开启后，`mcp:false` 或 `mcpServers:[]` 只关闭 MCP，不影响原生工具组合 |
| 可见性 | 当前用 Pi 的 `mode: on`，保留直接工具调用；MCode 开启 PTC 的对应 surface 可以只允许程序入口及控制工具。不是逐接口相同 |
| 超时与结果记录 | 使用 Pi 的脚本 `timeout_ms`、取消和输出协议；不复刻 MCode 默认 120 秒、共享 batch 预算或 `details.ptc` 侧信道。脚本失败不会撤销之前已执行的工具副作用 |
| 模型服务 | 子会话 codemode 使用 `models:false`，不开放额外 classifier/image 模型调用；程序化工具组合不因此被关闭 |

生产路径为 `controller.ts`、`controller-owners.ts`、`pi-backend.ts`。验证定位：

- `codemode-switch.test.ts`、`controller.test.ts` 及真实父 SDK 四角色资源继承回归：父总开关与默认关闭。
- `pi-backend-codemode.test.ts`：显式嵌入 backend 的调用方提供原生/扩展组合、关闭 MCP、权限 hooks 及保存上界；默认父桥的受控 MCP 见 `resource-inheritance.test.ts`，不代表默认入口允许普通扩展转发。

受控测试不证明两个宿主的全部超时、预算、媒体和恢复协议等价。

## 宿主边界与待验收项

- 默认插件路径支持未修改的官方 Pi 1.5.0，不依赖自定义 SDK 资源快照；父 runtime 替换前须取消并排空旧后台。`host-peer-sdk.test.ts`、`pi-backend-ui-isolation.test.ts` 覆盖无本地 peer 及双子会话 UI 隔离；父实例的工具/权限 hooks 与扩展生命周期机制见 [Pi 运行态适配](pi-runtime-adapter.md)。
- 不复刻 MCode 的完整进程宿主、全局后台调度器、日志控制界面、部署、通用 Mavis 会话管理、Memory 宿主、完整 TUI 或 SQLite 观察运行时；PTC 由 Pi 原生 codemode 承接。这些排除项不缩减 C5/C6 等核心工作流。
- 准入、permission hooks 和工具门控不能阻止可信第三方扩展自行执行代码，也不是 OS 或网络沙箱。第三方工厂在 SDK 接管之前发生的副作用仍由该工厂负责回滚。
- 命令输出以当前 Pi 原生 Bash 捕获的输出为边界。仅接收本次原生调用的受校验输出源，并固定 `FileHandle` 身份；历史句柄只读取子会话私有日志，不把任意 URI 当作文件授权。宿主输出格式变化导致无法取得完整输出，或记录、解码不完整时，须明确报告，不能静默返回截取内容并宣称完整。
- 原生执行结束与外部副作用回滚不同。主动脱离原生工具生命周期的进程、容器或外部服务不由这些句柄接管，也不能因一个 Bash 执行结束就宣称它们已停止。
- 正式验收仍需 C5/C6 的冻结验收、C7 的完整联动门禁；C9 须在必要行为完成并冻结相关源码后执行项目检查、Node 22/24 回归及提取包验证，`pnpm run pack` 会解包校验。命令见 [README 检查与打包](../README.md#检查与打包)，矩阵见 [CI](../.github/workflows/ci.yml)；既有定向或早期完整门禁不能证明当前全部需求完成。
- 源码对照、离线 SDK、bundled CLI、开发源码、提取包、安装版本、真实模型及外部服务证据须分别记录，不能互相替代，接缝探针也不能代替生产链验收。真实模型探针仅证明当次角色、源码、资源和输入路径，资源元数据可见不证明任意 MCP 业务接口可用；未经授权不执行真实模型或第三方业务验收。未运行完整 MCode 测试套件，未验证所有外部服务或平台。

## 上游同步（C8）

常规同步只管理 `src/vendor/mcode-background-task/` 的 6 个任务领域模块和 `src/vendor/mcode-child-bash/` 的 2 个生命周期/等待模块；[upstream.lock.json](../upstream.lock.json) 记录固定 commit 及原始/适配哈希，由 `scripts/upstream.mjs` 核验可逆转换。

另监测 43 个核心参考文件，覆盖公开工具定义、准入/续接、停止/终态/恢复、角色及模板、模型装配、task-child 工具 surface、PTC、许可及文件观察生产者。其中 `LR/background-task/subagent-task-row.ts` 生成 queued 行和 owner/Turn/执行模式事实，`LR/turns/file-changes.ts` 提供目标提取参考。参考文件仅报警，不打包为宿主实现。

`src/vendor/mcode-adapters/` 不由常规同步管理：`task-turn-id.ts` 保留上游逐字原文，由 `engine.test.ts` 校验固定快照、哈希及源码一致性；`file-write-targets.ts` 仅复用纯目标提取函数，由 `file-write-targets.test.ts` 约束固定原文哈希及函数体一致性。快照位于 `test/fixtures/`；混合自有逻辑的 `src/task-verification.ts` 不放入 vendor，parser 差分见 `task-verification.test.ts`。

目标提取除 Pi 品牌路径外，仅移除裁剪以保留 Shell 字面空格，并将可能跨符号目录的父目录遍历标为不确定；原生 write/edit 别名按 Pi 规则另行解析，不引入 diff/数据库宿主。

```sh
pnpm run upstream:verify
pnpm run upstream:check
```

`upstream:verify` 离线核验本地 vendor 及可逆适配；`upstream:check` 读取上游当前 commit，检查文件变化、移除和任务领域模块清单。[上游检查 workflow](../.github/workflows/upstream.yml) 每周或手动运行，不自动迁移功能、开 PR 或合并。

同步前先人工审查具体 commit，核对受影响契约并适配生产链及测试，再运行 `pnpm run upstream:sync --ref COMMIT` 并完成回归，不能只更新哈希。契约变化默认阻止同步；`--accept-contract-changes` 仅确认人工审查，不替代适配。参考文件删除或移动、模块清单变化须先修正路径或映射，不能用确认参数绕过。

哈希、可逆转换、契约变化阻断及删除/移动处理的回归见 `upstream.test.ts`。监测不是整个仓库的依赖闭包，新依赖的行为变化仍须人工追踪；检查通过不证明全部核心行为已同步。
