# Pi SDK 资源快照接缝

当前开发工作树需要配套 SDK 源码补丁。原版 SDK 1.5.0 没有完整的父会话资源快照接口，插件不能靠 `getAllTools()`、命令列表或重新扫描磁盘推断纯 hook 扩展、关闭状态和运行态资源。

补丁位于 `sdk-patches/pi-sdk-1.5.0-resource-snapshot.patch`，对应 Pi `v1.5.0` 的固定提交 `f9a26365568127461c47a07a37dcb42c140a3ac5`。`sdk-patches/manifest.json` 保存 7 个文件的原始及补丁后 SHA-256，原文已与该提交逐字核对。许可见 `sdk-patches/LICENSE-PI`。

## 接口返回已接受的资源

新增 `ExtensionAPI.getResources(): Promise<ResourceSnapshot>`，不进行资源发现、连接或模型调用：

| 字段 | 来源与边界 |
| --- | --- |
| `extensions` | 当前 loader 已接受的扩展元数据；保留纯 hook 扩展，inline/builtin 资源携带原始工厂引用。`mcpConnector` 标识快照提供者，不把普通 MCP 事件观察者当作 connector |
| `skills` | 当前有效 Skill 元数据，包含 `resources_discover` 的运行态贡献，不因本地仍有文件而恢复关闭的 Skill |
| `mcp` | 原生 connector 的当前配置快照，包含文件、运行态注册及其有效启停状态；没有快照提供者、MCP 工具或启用的服务器登记时为 `null` |

扩展与 Skill 元数据为副本，MCP 配置通过 `structuredClone` 复制。工厂引用是可信代码，不能序列化，也不构成 JavaScript 闭包或文件系统沙箱。子会话重新执行工厂并提供新的 API，不复用父 handlers、UI 对象或对话历史；文件扩展仍从获准入口重新加载。

原生 MCP 通过只读 `resources_snapshot` 事件交付当前状态，不从磁盘重建批准范围，也不因此调用业务工具。没有快照协议却存在 MCP 工具或启用的服务器登记时明确报错；存在多个提供者时也报错，不伪造完整的空快照。普通 `mcp_servers_change` 观察者本身不证明存在 connector，在父会话未加载 MCP 时仍可保留。SDK 只用自身注册的 MCP 能力发现无法快照的状态并拒绝，不从工具列表推导配置或授权。

MCP 配置可能含认证材料。插件只在宿主可信内存中使用快照，不把原始配置、工厂函数或父设置写入 task profile、任务历史、模型请求或日志。第三方可信扩展自行读取或输出数据不在此保证范围内。

## 默认控制器使用同一条创建链

`registerTaskAgents → TaskController → createPiChildFactory` 在准入时捕获父快照，并检查取消、会话和 owner 边界。取消读取不等待被挂起的 connector，迟到值不能覆盖重新挂接 owner 的批准状态；分离的后台 owner 只保留自己的最近批准值，不读取新会话 API。

资源与角色选择、项目 trust、deny 和已有权限上界相交。本地路径是选择条件，不是额外授权。父关闭的资源不会复活，子扩展重新注册的 MCP 也不能越过父快照。关闭 MCP 时保留不连接服务器的原生管理者，以处理注册生命周期，不向角色开放 MCP 工具。

新 profile 的 `extensionSnapshot` 只保存获准文件或工厂的身份。匿名 inline 工厂另有绑定函数引用的进程内 `factoryId`，位置编号变化不会把批准转交给另一工厂。同一进程可识别移动后的原工厂；新进程无法证明旧匿名工厂身份时不恢复该权限，需跨进程续接的 inline 工厂应稳定命名。实际 SDK reload 后冷恢复旧子会话时，后来新增的 hook 不会执行。需要自动继承扩展但旧记录没有身份事实时，返回 `LEGACY_RESOURCE_SNAPSHOT_REQUIRED`；旧输出仍可读取，需要额外资源时应以明确简报重新派发新任务。

原生设置只继承 `shellPath` 和 `shellCommandPrefix`。前台 Bash、`bash_task` 及 codemode 通过同一原生执行链使用这些设置，不复制包、模型、分析或资源开关等整份设置。父 codemode 的实际 active 状态仍是单独的权限总开关。

## 验证与接入状态

已在隔离目录对原版和补丁版 SDK 进行完整严格类型检查，并用原版 TypeScript 7.0.2 编译未打包 SDK 的 JavaScript、声明和 source maps。插件另以自己的 TypeScript 5.9.3 对原版及补丁版 SDK 声明检查类型。

`npm test` 使用本地已安装的固定版本开发依赖，在临时目录验证 source map 原文哈希、应用同一补丁，并用现有 TypeScript 转译 7 个改动模块。测试不联网或改动已安装 SDK；结果不是 SDK 发行构建证明。公共 API、默认父子创建链、运行态 MCP 的真实工具回复、角色关闭、纯 hook、历史隔离、取消、reload、Shell 设置和 codemode 均有受控回归。测试模型是本地脚本，本地 stdio MCP 是自有夹具，不能替代真实模型或业务服务验收。

SDK 的完整构建、CLI bundle、发行包和用户安装必须分别验证，不能用测试转译层替代。须使用固定上游的官方构建脚本，并在 Node 22/24 验证实际 bundled CLI 的公开 getter、纯 hook、工厂身份、MCP 视图和副本隔离；隔离验证不证明用户安装已更新。源码补丁和插件更新不会自动更换宿主 SDK，`/reload` 也不能替换当前进程的核心代码；SDK 更新后须重启 Pi。缺少接口时，任务准入返回 `PARENT_RESOURCE_SNAPSHOT_REQUIRED`。

准备在独立 SDK 源码仓库接入时，可先检查并应用补丁：

```sh
git apply --check /path/to/pi-task-agents/sdk-patches/pi-sdk-1.5.0-resource-snapshot.patch
git apply /path/to/pi-task-agents/sdk-patches/pi-sdk-1.5.0-resource-snapshot.patch
```

随后须按 SDK 仓库流程重建未打包入口与 CLI bundle，并验证实际启动入口。发布、替换安装和真实服务验收分别需要授权；本包不会自动完成这些操作。`peerDependencies: "*"` 不是所有 Pi SDK 版本均兼容的证明。
