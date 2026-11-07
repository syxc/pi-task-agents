# pi-task-agents

小型 Pi 子 Agent 插件：父会话派工，子会话保留独立历史，支持续接、查询、输出、取消和完成通知。任务编排沿用 MCode 的 background-task 机制；子会话、工具执行与资源加载复用 Pi SDK，不复刻 MCode 宿主平台。

要求 Node >=22.19.0 和未修改的官方 Pi 1.5.0；运行时使用宿主提供的 SDK 和 typebox，无需 SDK 补丁。

## 使用

安装：

```sh
pi install git:github.com/syxc/pi-task-agents
```

开发时也可直接加载源码：

```sh
pi -e /path/to/pi-task-agents/src/extension.ts
```

主会话须已有可用模型与认证。安装或更新后执行 `/reload`，新建子任务即可使用，无需配置文件；已有子任务保留配置快照。默认继承当前对话的模型、思考级别和父会话最终提供的 Skills；工具范围见[工具转发限制](#工具转发限制)。运行 `/tasks roles` 查看概况。开发副本不会自动替换已安装版本。

| 工具 | 行为 |
| --- | --- |
| task | 创建子任务；默认前台等待，`run_in_background:true` 返回后台准入回执 |
| task_append | 异步续接；运行中 steer，闲置时沿原历史创建新任务 ID |
| task_send | 仅在子会话闲置时同步续接；接受本 owner 的任务 ID 或子 session_id |
| task_query | 查询当前父会话的任务与状态 |
| task_output | 读取持久输出，支持 UTF-8 字节偏移、增量游标和最长 30 秒等待 |
| task_stop | 取消任务，等待子会话清理后释放并发名额 |
| task_agents | 查看角色和资源范围 |

后台回执只表示获准执行，不代表成功。后台任务结束后，Pi 原生消息队列向原父会话发送执行状态、关键验证事实和任务句柄；父会话须用 `task_output` 读取持久结果后整合回复，`details` 等元数据不能代替实际读取。此流程沿用 MCode 的通知与结果分离设计，不按长度筛选必要信息或截取报告摘要。通知以原生扩展消息通过 `followUp` 排队，不模拟用户提交；`display:false` 只隐藏 TUI 展示，仍进入模型上下文、唤醒空闲主会话，不等于减少 token。前台任务及同步续接直接返回完整结果，不另发通知。

`task_output` 读取任务结果，不是 Bash 日志流；取消读取不会停止任务。子会话不复制父对话，续接保留历史、角色及权限上界。派工须提供背景、文件所有权、交付物和验收条件；报告保留结论、必要证据和风险，避免无关日志与简报复述。

命令：`/tasks list`、`/tasks roles`、`/tasks show <id>`、`/tasks stop <id>`、`/tasks stop-all`；`/tasks resume` 恢复自动通知，不重启任务。状态栏显示运行数和排队数，任务区域显示耗时与当前活动。查询保留失败或停止原因；新续接任务另有 `parent_task_id` 和执行模式，后台 append 标为 `append`，旧记录不补推来源。

## 角色与权限

| 角色 | 用途 | 默认原生工具 |
| --- | --- | --- |
| explore | 定位与证据收集 | read、grep、find、ls、bash |
| worker | 指定范围内实现 | 上述工具及 edit、write |
| verifier | 独立检查 | 与 explore 相同 |
| mavis | 研究与实现 | 与 worker 相同 |

角色指令和原生工具范围作为代码内置预设，不需要用户逐项配置。子会话不开放父任务、todo、用户提问、goal 和定时控制，也不加载本插件自身。信息不足时向父会话报告 blocker，不直接询问用户或安排独立后续工作。Memory 只可写入明确提供的 child-owned 存储，否则把持久结论交给父会话处理。Explore/Verifier 不开放 write/edit；若交付物需要修改文件，应返回 `ROLE_MISMATCH`，由父会话转交 worker。Verifier 只能在任务明确指定的临时目录生成验证产物，不能修改被验证的交付物。Bash 和 MCP 不是只读沙箱，仍须遵守任务授权和项目权限。

### Verifier 的结果

`status` 表示任务执行状态，`verification.modelVerdict` 表示模型给出的 `pass`、`fail` 或 `partial`。执行成功不等于验证通过；缺少或冲突的 `VERDICT` 不会被当成 PASS。旧版运行结束信息仅兼容保存，不补推模型判定或文件变化结论。

文件观察覆盖各适用角色的实际工具调用及嵌套 codemode，保存已知目标首次调用前和最后调用后的元数据。write/edit 按 Pi 规则解析路径别名；Shell 保留字面空格、纳入非空原生前缀，未解析的父目录遍历及复合命令影响保留不确定性。动态、范围外、排除或不完整目标报告 `uncertain`。Verifier 另保留工作区前后快照，目标不明的 Bash 也可在预算内补充工作区元数据。观察不读取内容、不跟随符号链接，排除 `.git`、`node_modules` 和 Agent 状态目录。

工作区单次扫描上限为 20,000 个目录项，循环预算 1 秒；每次工具捕获最多 64 个目标，每轮最多 256 个不同目标，返回最多 200 条变化路径。采集失败报告 `recording_failed`，不伪造空的已确认变化列表，也不改判模型执行失败。`no_observed_change` 只表示范围内未见元数据差异，不证明没有瞬时写入或内容变化；并发变化不归因于某个子 Agent。观察不是路径隔离或通用写审计，验收与待完成项见[核心功能对照](docs/mcode-parity.md)。

### 长时间运行的命令

默认仍使用 Pi 原生前台 `bash`。允许 Bash 且权限快照包含该能力时，Worker、Verifier 和 Mavis 还可使用子会话专属的 `bash_task`：`action=start` 启动命令并返回 `command_id`，`list` 查询，`output` 增量读取，`stop` 单独停止命令。Explore 不开放该控制工具，旧权限快照也不会自动新增能力。

受管命令经子会话原生 `executeTool('bash', …)` 和父工具桥执行，与前台 Bash、codemode 共用父管线，保留实际 Bash 的 shell、前缀、环境、超时及权限 hooks。观察器只读取白名单设置 `shellPath`、`shellCommandPrefix`，不复制全部父设置。子 Agent 可继续独立工作，但须在逻辑任务结束前等待所属命令，在同一任务内接收未读结果提示，不另建跟进任务或依赖模型轮询。句柄不能控制父任务、其他子会话或其他 Turn 未结束的命令；所属子会话的已结束命令可按历史句柄读取。

输出使用私有 `0600` 文件和有界 UTF-8 分段读取：省略 `offset` 使用已提交游标，`offset:0` 可重读，`wait_ms` 最多 30 秒。`truncated` 表示仍有未读字节，不表示命令已结束；`output_incomplete` 表示输出不完整，`cleanup_pending` 表示清理未确认，后者保留容量与租约。崩溃后不重放命令，不将未知状态当作已清理。父 `task_stop` 会取消子任务所属执行；`bash_task` 与后台运行整个子任务是两种能力，不接管手工脱离原生生命周期的进程。验收和适配边界见[核心功能对照](docs/mcode-parity.md)。

## 配置

通常不需要配置。只在要覆盖模型或思考级别时填写对应角色，未填写的角色继续继承当前对话：

```json
{
  "roles": {
    "explore": { "model": "provider/model", "thinking": "medium" },
    "worker": { "model": "provider/model", "thinking": "high" }
  }
}
```

`provider/model` 须替换为 Pi 中已可用的模型。任务参数 `model`、`effort` 优先于角色配置；没有任务或角色覆盖时，在准入时继承父会话。解析后的 profile 随任务保存。显式选模型不会静默替换为其他模型，也不沿用旧模型的思考档；未指定思考级别时使用 Pi 对新模型的默认设置。`effort` 可用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，`thinking` 是配置兼容别名；Pi SDK 对不支持的模型或档位报错。

工具、资源、超时和并发均非入门必填项；不要为继承资源填写空列表。

### 高级覆盖

按默认值 → `<agentDir>/task-agents.json` → 已信任项目的 `.pi/task-agents.json` 加载；未信任项目配置不生效。指令逐层追加，其他字段替换，示例见 [examples/task-agents.json](examples/task-agents.json)。`maxConcurrency` 可选，范围 1 至 64，省略时不施加插件并发配额；`timeoutMs: 0` 表示不限时。

`tools`、`disallowedTools`、`mcpServers` 按 trim/NFKC/大小写归一化后的精确名称匹配，不展开通配符。`extensions`、`skills` 可按父会话已接受的资源名称或本地路径缩小选择，不会执行新的扩展文件。四个角色的资源均默认继承父可用范围，空列表关闭对应资源；`mcp:false` 或 `mcpServers:[]` 禁用 MCP。选择还须与父实际工具权限及历史上界相交，本地路径不能复活父已关闭的资源。按服务器限制 MCP 资源列表时，调用须显式指定允许的 `server`。直接使用底层 SDK backend 的嵌入程序可显式提供独立资源加载器，这与默认父工具桥是不同入口。

裸名配置可覆盖内置角色；自定义 `researcher` 可用 `researcher` 或 `agent:researcher` 调用，`agent:worker` 与内置 `worker` 独立。旧配置的显式模型、工具和空资源列表仍有优先权，不自动迁移；MCode 专有工具名或 effort 值须人工审阅后改用 Pi 能力。

新任务保存工具、Skill 和扩展来源上界，不保存执行闭包、工厂函数或 MCP 认证配置。恢复续接时重新绑定当前父会话并与旧上界相交，新增工具不自动进入旧子会话。旧输出仍可读取；需要额外资源时，应以明确简报派发新任务，不能自动扩大历史权限。

## 工具转发限制

子会话通过父 Pi 原生工具管线执行，沿用真实权限 hooks；扩展工厂不在子会话重跑，父会话自身的工具不受影响。默认插件路径只转发已核验的官方 Pi 1.5.0 工具：

- 宿主标记为内置的 `read/write/edit/bash/powershell/grep/find/ls`。
- 来源为 `builtin:mcp` 的官方 MCP 工具和资源适配器，包括运行态 MCP 注册；复用父连接，不复制凭据或重连。

来源和名称须同时符合核验范围；名称、namespace、只读提示或 `reachesTools` 声明本身不是证明。普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂不转发，角色配置也不能重新开启；需要这些工具的工作应留在父会话。未知 SDK 版本关闭父工具转发，升级后须重新核验并回归。

任意扩展的嵌套排队和独立取消信号可能造成跨 Turn 死锁或取消竞态，权限 hook 不足以阻断；获准的官方叶子实现不嵌套调用父 `executeTool`。子会话原生 codemode 和受管命令仍可组合获准工具，经父权限管线执行。具体机制和证据见 [Pi 运行态适配](docs/pi-runtime-adapter.md)。

此保证依赖未修改的官方宿主及来源元数据，不是同进程恶意扩展沙箱；自定义宿主伪标 `builtin`、篡改元数据或 SDK 不在保证内。取消不撤销已发生的本地或远端副作用；权限 hook 或服务未实际结束时，不能宣称清理完成。

## 生命周期与边界

- 父 turn abort 会取消前台等待并暂停自动通知，不自动停止已准入的后台任务。停止任务须使用 `task_stop` 或明确的 `/tasks stop-all`。
- 切换、新建、fork、重载或退出父会话时，先取消并排空该 owner 的在途执行，再关闭工具桥，避免使用失效权限。后台任务不跨父 runtime 替换继续运行，也不转交新会话；已保存的历史和输出保留，回到原会话后可续接。异常退出后不自动重放可能已有副作用的执行。
- 任务状态和独立子历史保存在本地，输出保留可读。清理失败保留资源占用并允许重试；插件不是跨进程任务守护服务。已有子历史不随父会话后来切换模型或思考设置而改变。父扩展生命周期仍由 Pi 管理，插件不接管扩展自行启动的外部进程。
- PTC 类调用使用 Pi 原生 codemode，不另建 MCode PTC 运行时。父 Pi 是唯一总开关：父关闭时子也关闭，角色 tools 或 MCP 不能开启；父开启后可批量组合获准工具、筛选结果，简单操作仍直接调用，关闭 MCP 不影响原生组合。权限 hooks、deny 和历史上界仍生效，旧任务不自动扩权。返回格式、超时和预算沿用 Pi，不承诺 MCode 脚本原样兼容。
- 不提供自建 Bash/web_fetch、部署、SQLite 文件观测或 MCode TUI。若需要外部工具，通过 Pi 的可信资源配置接入。

## 开发

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run pack
```

开发工具锁定为 TypeScript 5.9.3、Oxlint 1.92.0、oxlint-tsgolint 7.0.2006、Oxfmt 0.77.0、markdownlint-cli2 0.24.0；开发 SDK 为 Pi 1.5.0，typebox 1.3.27，Node 类型为 22.20.5。`markdownlint-cli2` 的传递依赖 `markdownlint` 暂覆盖为修复 ReDoS 的 0.42.1，上游更新后应复核并移除此覆盖。

- `check`：strict 类型、包清单、vendor 哈希、Oxlint、类型感知 lint、Markdown 和 Oxfmt。可分别运行 `npm run lint`、`npm run lint:type-aware`、`npm run lint:markdown`、`npm run format:check`；`npm run format` 仅格式化自有代码与配置，不改上游锁定源码。
- `test`：直接对未修改的官方 SDK 回归，包含隔离 bundled CLI 的默认派工和权限拒绝测试，不应用 SDK 补丁。
- `pack`：生成 `artifacts/pi-task-agents-0.1.0.tgz`，不含依赖、任务历史或认证。

`scripts/sdk-smoke.mjs`、`scripts/rpc-smoke.mjs` 使用本机模型认证并消耗额度，须另行授权。离线测试和本地 stdio MCP 只证明受控路径，不代表真实模型、第三方业务 MCP、其他 SDK 版本或平台已验收；真实模型和第三方业务验收须另行授权。

`src/vendor/mcode-background-task/` 保留八个 MIT 任务领域模块；`src/vendor/mcode-child-bash/` 另复用两个生命周期/等待模块，由子会话命令适配器接入 Pi 原生执行与结果回收。十个复用文件的哈希及可逆导入适配由同步脚本核验。`src/vendor/mcode-adapters/task-turn-id.ts` 保留上游逐字原文，`src/vendor/mcode-adapters/file-write-targets.ts` 保留上游 helper 及窄路径适配；两者由固定上游快照和源码一致性测试核验，不属于上述同步脚本管理的两个目录。原始快照留在 `test/fixtures/` 作为测试资产；混合自有逻辑的 `src/task-verification.ts` 不在 vendor 目录。`upstream.lock.json` 另监测 43 个核心参考文件，包括生成 Task 行及 owner/Turn/执行模式事实的 `subagent-task-row.ts`，覆盖任务协议及生产链、角色模板、模型装配、task-child 工具边界和 PTC 公共契约。每周或手动检查只报告变化，不自动移植功能；契约变化须人工适配。不以哈希或离线测试宣称整个 MCode 宿主等价。逐项对应实现、测试和 Pi 适配边界见 [核心功能对照](docs/mcode-parity.md)，许可见 [NOTICE](NOTICE)。
