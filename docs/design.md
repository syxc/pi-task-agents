# 设计不变量与宿主适配

默认实现支持未修改的官方 Pi 1.5.0，不替换安装、修改 SDK、包装全局 prototype 或另建宿主。本文记录改动时必须维持的契约、机制与官方宿主限制；用户操作见 [README](../README.md)，MCode 对照与验收见[核心功能对照](mcode-parity.md)。

## 职责划分

Pi SDK 提供子会话、模型、工具执行和消息队列；插件 Engine 负责调度、所有权、持久化及交付。前后台共用状态机。结果与续接的使用语义见 [结果与通知](../README.md#结果与通知) 和 [续接与查询](../README.md#续接与查询)。

## 来源审核与授权边界

[`src/parent-tools.ts`](../src/parent-tools.ts) 从父运行态读取可调用工具及来源元数据，不重扫目录、不还原扩展工厂或 MCP 配置。转发范围限于已核验的官方 Pi 1.5.0 实现：

- `builtin:<tool>`：`read/write/edit/bash/powershell/grep/find/ls`。
- `builtin:mcp`：MCP 工具及 `list_mcp_resources/list_mcp_resource_templates/read_mcp_resource`，复用父连接，不复制凭据或重启服务器。

审核同时要求 `sourceInfo.source === 'builtin'`、对应路径和已核验实现范围；名称、namespace、annotations 或 `reachesTools` 本身不能证明安全。普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂均不转发，角色配置不能重开，父工具不受影响。未知 SDK 版本关闭转发；升级后须重新审核并回归。

授权逐层取交集：父当前可调用工具 → 角色工具、来源和服务器选择 → 保存的历史上界 → 每次调用的实时检查。父停用或替换工具后，旧快照不能继续调用；续接须重新绑定当前父会话，不复活被排除资源。按服务器限制 MCP 时，聚合资源调用须显式指定允许的 `server`。

Skills 来自 `before_agent_start` 的可变选项，在 `agent_start` 复制最终清单并释放选项引用，再按角色与历史上界筛选；提示词 XML 不授予权限。父权限 hooks 留在原始实例执行，扩展工厂不在子会话重跑。

这些保证信任官方宿主的来源记录，不是密码学证明或同进程恶意扩展沙箱。自定义宿主可把任意 baseTools 或工厂伪标为 builtin，篡改来源、SDK 或插件状态不在保证内。

## 串行队列与 signal 限制

官方 1.5.0 的两个机制决定了默认桥不能转发任意扩展：

- `core/nested-tool-calls.js` 在进入工具管线前等待串行队列；`core/agent-session.js` 在 `agent_end` 前清除嵌套 scope。在途扩展随后嵌套串行工具可能丢失持锁祖先、等待自己，且尚未到达 `tool_call` hook。
- `core/extensions/runner.js` 用 `options.signal ?? signal` 创建 context，允许替换继承信号。`pi-agent-core` 虽在全部权限 hooks 后检查 signal，独立信号仍可能漏掉后续 hook 等待期间的上层取消。

公开 ExtensionAPI 没有排队前拦截器、不可替换的继承信号或最终授权门禁；`reachesTools` 可以省略，执行模式也不足以判定叶子，故须在派发前审核实现，而非仅靠 hook 或声明过滤。本插件的 `task`、`task_append`、`task_send` 声明 `reachesTools: all`，仅用于 MCP 准备。

获准的官方叶子不通过父 context 嵌套 `executeTool`：原生工具执行本地操作，MCP 适配器调用客户端。子会话自己的 codemode 和受管命令可组合获准工具，但不取得父 context。

## 工具桥与调用作用域

1. 子 SDK 验证参数，检查角色、历史工具上界和当前 codemode 状态。
2. 前台保留真实父调用的 SDK 祖先关系，避免串行 Task 等待自己的队列；后台由私有待派发表通过控制工具 wrapper 构造当前上下文，不重新准入 Task。
3. 目标仅经官方 `executeTool(target, args)` 执行父参数验证、权限及结果 hooks，不直接调用目标 `execute`。scope 仅接受根到获准叶子的一跳，实时检查 owner、来源、元数据、角色及取消信号。
4. 目标沿用所属调用的取消信号，结果写入独立子历史，通知指向持久输出。

私有派发 ID 在父 `agent_end` 后轮换，同一子权限范围共用有界 recorder；历史原生 ID 不作永久拒绝标记，允许父会话合法重用。原 Task context 仅用于前台等待，不是后台持久句柄；父扩展不取得子授权 context。

## 准入、所有权与恢复

派工先持久化准入记录和请求回执，再执行独立子会话；同一请求的重放返回原回执。续接复用已有子会话历史：准入提交前检查子会话文件，缺失时返回 `TASK_CHILD_NOT_FOUND`（404），不静默重建历史，也不留下任务行或已消费的请求回执。运行中的 `task_append` 并入当前 Turn；排队任务并入尚未派发的首个 prompt；闲置续接创建新任务 ID，复用子会话历史、角色与冻结 profile，并记录来源关系和执行模式。来源与执行模式只对新记录生效，不为旧记录补造。

任务超时包含子会话初始化。调用子会话工厂前，插件先持久化初始化所有权标记；落盘失败则不调用工厂。初始化完成并交接给 active 任务后，先持久化清除标记再派发提示；取消中的初始化只在原工厂确证清理后清除。清除标记不表示会话已无存活资源，后续仍沿用 active 任务和原生命令清理契约。

初始化尚未派发提示就超时且清理未确认时，插件先持久化失败输出，再通知父会话；迟到的纯清理回执不重复追加失败文本。已派发的提示仍等待 SDK 结算后交付，以保留迟到结果；清理未确认不代表执行已经结束。

清理或停止未及时确认时，停止会报告 `cleanup_pending` 或错误，并保留并发名额。带未确认标记的 owner 重启后长期隔离：结果仍可通过 `task_query`、`task_output` 读取，但不能继续派工，`close()` 会报错并保留 owner 锁。重建 child、空 `dispose()`、新 session 或其他 owner 的清理不能解除隔离，也不提供人工解除入口。清理确认必须成功落盘，失败时保留锁并在关闭重试时补写回执。插件不能强制终止不配合的 SDK 初始化。

没有该标记的旧快照保持原有 active/lost 恢复语义；插件无法补推历史初始化是否发生，也不把缺少标记当作资源已清理的证明。隔离按 owner 生效，切换 owner 不会清除旧标记，也不能作为原工作已安全恢复的依据。

## 通知与投递

后台终态结果先持久化，再经 Pi 原生通道通知原父会话，不模拟用户提交。批量窗口、单条上限、投递次数、启动排队方式与重试节奏是对外行为，定义见 [README 完成通知](../README.md#完成通知)；实现须保持先持久化后投递，未确认写入时按该节奏重试，`/tasks resume` 只清除暂停与冷却，不重启任务。

## 生命周期与关闭

同一父 runtime 内，父 Turn 结束或中止不自动停止已准入后台任务；显式停止须取消所属执行并等待清理。切换、新建、fork、重载或退出父会话时，`session_shutdown` 先取消并排空旧 owner，再关闭桥，不跨 runtime 沿用权限或转交任务。本地任务状态、子历史和输出保留，回到原会话可续接；异常退出后不重放可能已有副作用的执行。

取消不回滚已发生的写入、进程或远端 MCP 请求。权限 hook 不返回、其他父串行工具占队列或服务不响应时仍可能等待，远端是否结束由服务决定；不能用 `Promise.race` 代替实际排空。清理失败保留资源占用及重试状态。父进程被 SIGKILL 或掉电时无法执行清理，宿主的原生 Bash 子进程可能继续运行，需由操作系统或外部进程管理处理。独立 SDK backend 可由嵌入程序显式提供资源和生命周期，信任责任由调用方承担，不扩大默认桥的转发范围。

## Skills 目录的紧凑表示

父会话目录较大时，完整名称、描述与路径使用共享路径前缀的紧凑表示；省略的行尾字段按明确默认值恢复（根索引为 `0`，文件路径为 `name/SKILL.md`）。非规范路径保留显式字段，不删条目或修改传给子会话的资源元数据；已有自定义目录表示及 `forceSystemPrompt` 覆盖的提示词不参与改写。该优化只减少重复 token，不改变授权范围、历史权限上界或角色禁用。

## 文件观察预算

文件观察是元数据级记录，不是内容扫描、通用写审计或路径隔离。工作区单次扫描上限为 20,000 个目录项，循环预算 1 秒（[`workspace-observation.ts`](../src/workspace-observation.ts)）；每次工具捕获最多 64 个目标，每轮最多 256 个不同目标，返回最多 200 条去重后的变化路径（[`tool-file-observation.ts`](../src/tool-file-observation.ts)）。返回时优先保留直接观察到差异的工具目标，再以工作区变化补足，按路径排序；目录变化也计入，列表被截断时保留 `changed_files_truncated`。达到上限、采集失败或目标不确定时须显式报告，不能伪造空的已确认变化列表。

## 验证范围

验收矩阵见[核心功能对照](mcode-parity.md#核心契约对照)。工具桥的专项证据：

- [`official-tool-proxy.test.ts`](../test/official-tool-proxy.test.ts)：复现跨 `agent_end` 串行队列问题；内存探针保留 pending，不证明 abort 或 dispose 已排空。
- [`parent-tools.test.ts`](../test/parent-tools.test.ts)：危险串行及独立 signal 扩展在派发前被拒、零嵌套副作用；后续权限 hook 等待期间取消写入，零文件副作用且实际排空。
- [`official-cli-task.test.ts`](../test/official-cli-task.test.ts)、[`host-peer-sdk.test.ts`](../test/host-peer-sdk.test.ts)：使用脚本化本地模型验证未修改 bundled CLI 的派工、父权限拒绝及宿主 peer 映射。

离线测试和本地 stdio MCP 不覆盖真实模型、第三方业务 MCP、其他 SDK 版本或平台；这些边界仍须相应验收。
