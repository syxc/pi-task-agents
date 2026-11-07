# 官方 Pi 运行态适配

插件支持未修改的官方 Pi 1.5.0，不替换安装、修改 SDK、包装全局 prototype 或另建宿主。本文说明默认父工具桥的机制与边界；操作与配置见 [README](../README.md)，开发工具仅用于[开发检查](../README.md#开发)，不是插件运行依赖；MCode 契约与验收见 [核心功能对照](mcode-parity.md)。

## 调度模型

Pi SDK 提供子会话、模型、工具执行和消息队列；插件 Engine 负责调度、所有权、持久化及交付。前后台共用状态机：先保存准入记录，再执行独立子会话。前台等待结果，后台返回任务句柄；终态保存后通知原父会话读取，不回写已返回 Task 结果的 `nestedCalls`，父 Task 消息不是完整后台日志。

运行中追加进入同一逻辑任务；闲置续接创建新任务 ID，保留子历史和权限上界。执行状态、Verifier 判定、输出及清理状态分开记录，崩溃后不自动重放。

## 来源审核与授权边界

`src/parent-tools.ts` 从父运行态读取可调用工具及来源元数据，不重扫目录、不还原扩展工厂或 MCP 配置。转发范围限于已审核的官方 Pi 1.5.0 实现：

- `builtin:<tool>`：`read/write/edit/bash/powershell/grep/find/ls`。
- `builtin:mcp`：MCP 工具及 `list_mcp_resources/list_mcp_resource_templates/read_mcp_resource`，复用父连接，不复制凭据或重启服务器。

审核同时要求 `sourceInfo.source === 'builtin'`、对应路径和已核验实现范围；名称、namespace、annotations 或 `reachesTools` 本身不能证明安全。普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂均不转发，角色配置不能重开，父工具不受影响。未知 SDK 版本关闭转发，接受前须重新审核及回归。

授权逐层取交集：父当前可调用工具 → 角色工具、来源和服务器选择 → 保存的历史上界 → 每次调用的实时检查。父停用或替换工具后，旧快照不能继续调用；续接须重新绑定当前父会话，不能复活被排除资源。聚合 MCP 资源调用受服务器范围限制时，须显式指定允许的 `server`。

Skills 来自 `before_agent_start` 的可变选项，在 `agent_start` 复制最终清单并释放选项引用，再按角色与历史上界筛选；提示词 XML 不授予权限。父权限 hooks 留在原始实例执行，扩展工厂不在子会话重跑。

这些保证信任官方宿主的来源记录，不是密码学证明或同进程恶意扩展沙箱。自定义宿主可将任意 baseTools 或工厂伪标为 builtin，ExtensionAPI 无法识别；篡改来源、SDK 或插件状态不在保证内。

## 串行队列与 signal 限制

官方 1.5.0 的两个机制决定了默认桥不能转发任意扩展：

- `core/nested-tool-calls.js` 在进入工具管线前等待串行队列；`core/agent-session.js` 在 `agent_end` 前清除嵌套 scope。在途扩展随后嵌套串行工具可能丢失持锁祖先、等待自己，且尚未到达 `tool_call` hook。
- `core/extensions/runner.js` 用 `options.signal ?? signal` 创建 context，允许替换继承信号。`pi-agent-core` 虽在全部权限 hooks 后检查 signal，但独立信号可能漏掉后续 hook 等待期间发生的上层取消。

公开 ExtensionAPI 没有排队前拦截器、不可替换的继承信号或最终授权门禁。`reachesTools` 可以省略，执行模式也不足以判定叶子，故须在派发前审核实现，而非仅靠 hook 或声明过滤。Task 的 `reachesTools: all` 只用于 MCP 准备。

获准的官方叶子不通过父 context 嵌套 `executeTool`：原生工具执行本地操作，MCP 适配器调用客户端。子会话自己的 codemode 和受管命令可组合获准工具，但不取得父 context。

## 工具桥与调用作用域

1. 子 SDK 验证参数，检查角色、历史工具上界和当前 codemode 状态。
2. 前台保留真实父调用的 SDK 祖先关系，避免串行 Task 等待自己的队列；后台由私有待派发表通过控制工具 wrapper 构造当前上下文，不重新准入 Task。
3. 目标仅经官方 `executeTool(target, args)` 执行父参数验证、权限及结果 hooks，不直接调用目标 `execute`。scope 仅接受根到获准叶子的一跳，实时检查 owner、来源、元数据、角色及取消信号。
4. 目标沿用所属调用的取消信号，结果写入独立子历史，通知指向持久输出。

私有派发 ID 在父 `agent_end` 后轮换，同一子权限范围共用有界 recorder；历史原生 ID 不作永久拒绝标记，允许父会话合法重用。原 Task context 仅用于前台等待，不是后台持久句柄；父扩展不取得子授权 context。

## 生命周期与取消

同一父 runtime 内，父 Turn 结束或中止不自动停止已准入后台任务；显式停止须取消所属执行并等待清理。切换、新建、fork、重载或退出父会话时，`session_shutdown` 先取消并排空旧 owner，再关闭桥，不跨 runtime 沿用权限或转交任务。

取消不回滚已发生的写入、进程或远端 MCP 请求。权限 hook 不返回、其他父串行工具占队列或服务不响应时，仍可能等待；远端是否结束由服务决定。不能用 `Promise.race` 代替实际排空；清理失败保留资源占用及重试状态。

独立 SDK backend 可由嵌入程序显式提供资源和生命周期，信任责任由调用方承担，不扩大默认桥的转发范围。

## 验证范围

以下测试位于 `test/`，覆盖受控路径，不代表外部服务已验收：

- `official-tool-proxy.test.ts`：复现跨 `agent_end` 串行队列问题；内存探针保留 pending，不宣称 abort 或 dispose 已排空。
- `parent-tools.test.ts`：危险串行及独立 signal 扩展派发前被拒、零嵌套副作用；后续权限 hook 等待期间取消写入，零文件副作用且实际排空；四角色、前后台、父结果过滤与拒绝、ID 重用、过期 context、同名覆盖、续接及 MCP 准备和连接复用。
- `runtime-inheritance.test.ts`、`resource-inheritance.test.ts`：动态及禁用 Skills、父扩展保留而子拒绝、内置 MCP 文件和运行态注册、Shell 设置、受管命令、codemode、模型与恢复上界。
- `child-parent-tools.test.ts`：来源与历史清单、原始 server 名、聚合资源限制。
- `official-cli-task.test.ts`、`host-peer-sdk.test.ts`：未修改 bundled CLI 的默认派工、父权限拒绝与宿主 peer 映射，使用脚本化本地模型。

离线测试和本地 stdio MCP 不覆盖真实模型、第三方业务 MCP、其他 SDK 版本或平台；这些边界仍须相应验收。
