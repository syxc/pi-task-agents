# 官方 Pi 运行态适配

插件支持未修改的官方 Pi 1.5.0，不替换安装、修改 SDK、包装全局 prototype 或另建宿主。本文说明默认父工具桥；操作与配置见 [README](../README.md)，MCode 契约及逐项证据见 [核心功能对照](mcode-parity.md)。

## 调度模型

Pi SDK 提供子会话、模型、工具执行和消息队列；插件 Engine 负责调度、所有权、持久化及交付。前后台共用状态机：先保存准入记录，再执行独立子会话。前台等待结果，后台返回任务句柄；终态保存后通知原父会话读取，不回写已返回 Task 结果的 `nestedCalls`，父 Task 消息不是完整后台日志。

运行中追加进入同一逻辑任务；闲置续接创建新任务 ID，保留子历史和权限上界。执行状态、Verifier 判定、输出及清理状态分开记录，崩溃后不自动重放。

## 默认转发范围

`src/parent-tools.ts` 读取当前可调用工具及官方来源元数据，不还原扩展工厂或 MCP 配置，也不重扫资源目录。

仅转发以下已核验的官方 Pi 1.5.0 实现：

- 来源为 `builtin:<tool>` 的 `read/write/edit/bash/powershell/grep/find/ls`。
- 来源为 `builtin:mcp` 的 MCP 工具及 `list_mcp_resources/list_mcp_resource_templates/read_mcp_resource`。

判断须同时满足 `sourceInfo.source === 'builtin'`、对应路径和已核验实现范围，名称、namespace、annotations 或 `reachesTools` 不足以证明安全。普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂不转发，角色的 `extensions`、`tools` 也不能重开；父工具不受影响。未知 SDK 版本关闭转发，接受前须重新核验及回归。

来源是受信任官方宿主的归属记录，不是密码学证明。自定义嵌入宿主可把任意 baseTools 或工厂标为 builtin，ExtensionAPI 无法识别此替换。同进程扩展有完整代码执行权限；篡改来源、SDK 或插件状态不在隔离保证内。

`before_agent_start` 提供系统提示词的可变选项；到 `agent_start` 时插件复制最终 Skills，释放对选项的引用。子会话按角色和历史上界筛选，不解析提示词 XML 推断授权。父权限 hooks 留在原始实例执行，扩展工厂不在子会话重跑。

官方内置 MCP 继续复用父连接，不复制凭据或重新启动服务器。Task 声明 `reachesTools: all` 仅用于 MCP 准备，不作为叶子证明。角色来源和服务器选择只能缩小范围；聚合资源调用受服务器范围限制时须显式指定允许的 `server`。

## 为什么拒绝任意扩展转发

核验的官方 1.5.0 代码表明：

- `core/nested-tool-calls.js` 的 `execute()` 在调用工具管线前等待串行队列；在 `tool_call` 拦截已太迟。
- `core/agent-session.js` 在向扩展发送 `agent_end` 之前清除嵌套 scope。在途串行扩展随后再嵌套串行工具，可能丢失持锁祖先并等待自己。
- `core/extensions/runner.js` 的 `createToolContext()` 使用 `options.signal ?? signal`，允许扩展替换继承信号。
- `pi-agent-core` 的工具管线在全部权限 hooks 后检查此次调用的 signal。但若扩展已换成独立 signal，较早的委派 hook 检查不能防止取消发生于后续权限 hook 的等待期间。

公开 ExtensionAPI 没有排队前拦截器、不可替换的继承信号或最终授权门禁。任意扩展不一定声明 `reachesTools`，所以不能仅拒绝声明会嵌套的工具，也不能只拒绝标为 sequential 的扩展。

获准的官方叶子不通过工具 context 发起 `executeTool`：原生文件和进程工具执行各自操作，MCP 适配器调用客户端。插件在派发前排除其他实现，不靠排队后的 hook 阻断危险嵌套。子会话自己的 codemode 和受管命令仍可组合获准工具，但不取得父 context。

## 工具桥

1. 子 Pi SDK 验证参数，检查角色、历史工具上界和当前 codemode 状态。
2. 前台等待保留真实父调用的 SDK 祖先关系，避免串行 Task 等待自己的队列。后台调用由插件私有待派发表通过当前控制工具 wrapper 构造上下文，不走 Task 准入分支。
3. 目标仅经官方 `executeTool(target, args)` 执行父参数验证、权限 hooks 和结果 hooks，不直接调用会绕过 hooks 的目标 `execute`。内部 scope 仅接受根到获准叶子的一跳，检查当前 owner、来源、元数据、角色和取消信号。
4. 所有获准目标沿用所属调用的取消信号，真实结果保存在独立子历史中，通知指向持久任务输出。

私有派发 ID 在父 `agent_end` 后轮换，同一子权限范围共享有界 recorder。原 Task context 只用于前台等待，不作后台持久句柄；父扩展不取得子授权 context。历史原生 ID 不留永久拒绝标记，以免误伤父会话合法重用。

父停用或替换工具会拒绝旧快照的新调用；续接重新绑定当前父会话，与保存的工具及来源上界相交，不能复活已排除扩展。

## 生命周期与剩余边界

同一父 runtime 内，父 Turn 结束或中止不自动停止已准入后台任务；显式停止须取消所属执行并等待实际清理。父切换、新建、fork、重载或退出时，`session_shutdown` 先取消并排空旧 owner，再关闭桥，不跨 runtime 使用旧权限或转交新 owner。

取消不回滚已发生的写入、进程或远端 MCP 请求，远端是否结束由服务决定。权限 hook 不返回、无关父串行工具占队列或服务不响应时，执行仍可能等待；不以 `Promise.race` 假装排空。清理失败保留资源占用及重试状态。

独立 SDK backend 仍允许嵌入程序显式提供资源及生命周期。这是调用方承担信任责任的不同入口，不代表默认父工具桥允许普通扩展转发。

## 验证

- `official-tool-proxy.test.ts`：公开 SDK 会话复现未设防的跨 agent_end 串行队列问题；该内存探针保留 pending 事实，不声称 abort 或 dispose 已排空它。
- `parent-tools.test.ts`：危险串行及独立 signal 扩展在父派发前被排除、零嵌套副作用；后续权限 hook 等待时取消原生写入，零文件副作用且实际排空；四角色、嵌套前台串行、后台、父结果过滤及拒绝、ID 重用、过期 context、同名覆盖、续接、MCP 准备与连接复用。
- `runtime-inheritance.test.ts`、`resource-inheritance.test.ts`：动态及禁用 Skills、父扩展保留而子拒绝、官方内置 MCP 的文件和运行态注册、Shell 设置、受管命令、codemode、模型及恢复上界。
- `child-parent-tools.test.ts`：来源、历史清单、原始 server 名和聚合资源限制。
- `official-cli-task.test.ts`、`host-peer-sdk.test.ts`：未修改 bundled CLI、默认插件入口、父权限拒绝和宿主 peer 映射；只用脚本化本地模型。

离线测试和本地 stdio MCP 仅证明受控路径。真实模型、第三方业务 MCP、其他 SDK 版本及其他平台仍须相应验收。
