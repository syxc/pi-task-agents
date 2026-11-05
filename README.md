# pi-task-agents

小型 Pi 子 Agent 插件：父会话派工，子会话保留独立历史，支持续接、查询、输出、取消和完成通知。任务编排沿用 MCode 的 background-task 机制；子会话、工具执行与资源加载复用 Pi SDK，不复刻 MCode 宿主平台。

要求 Node >=22.19.0。开发环境使用 Pi SDK 1.5.0；运行时使用宿主提供的 SDK 和 typebox。

## 使用

安装：

```sh
pi install git:github.com/syxc/pi-task-agents
```

开发时也可直接加载源码：

```sh
pi -e /path/to/pi-task-agents/src/extension.ts
```

安装或更新后执行 `/reload`，新建子任务即可使用，无需创建配置文件。已有子任务保留其配置快照。默认使用当前对话的模型和思考级别，并继承已启用、已授权的 Pi Skills、扩展和 MCP；主会话本身须已有可用模型与认证。运行 `/tasks roles` 查看简洁概况。此开发副本不会自动替换已安装版本。

| 工具 | 行为 |
| --- | --- |
| task | 创建子任务；默认前台等待，`run_in_background:true` 返回后台准入回执 |
| task_append | 异步续接；运行中 steer，闲置时沿原历史创建新任务 ID |
| task_send | 仅在子会话闲置时同步续接；接受本 owner 的任务 ID 或子 session_id |
| task_query | 查询当前父会话的任务与状态 |
| task_output | 读取持久输出，支持 UTF-8 字节偏移、增量游标和最长 30 秒等待 |
| task_stop | 取消任务，等待子会话清理后释放并发名额 |
| task_agents | 查看角色和资源范围 |

后台回执不代表成功；终态会自动通知原父会话。前台及同步续接不重复通知。`task_output` 读取任务结果，不是 Bash 日志流；取消读取不会停止任务。续接保留既有历史、角色及权限上界，不复制父对话。派工时须提供背景、文件所有权、交付物和验收条件。

命令：`/tasks list`、`/tasks roles`、`/tasks show <id>`、`/tasks stop <id>`、`/tasks stop-all`、`/tasks resume`。状态栏显示运行数和排队数；任务区域显示耗时与当前活动。查询结果保留失败或停止原因。

## 角色与权限

| 角色 | 用途 | 默认原生工具 | 默认 Skills |
| --- | --- | --- | --- |
| explore | 定位与证据收集 | read、grep、find、ls、bash | 继承可用资源 |
| worker | 指定范围内实现 | 上述工具及 edit、write | 继承可用资源 |
| verifier | 独立检查 | 与 explore 相同 | 继承可用资源 |
| mavis | 研究与实现 | 与 worker 相同 | 继承可用资源 |

角色指令和原生工具范围作为代码内置预设，不需要用户逐项配置。子会话不开放本插件的父任务入口，也不加载本插件自身。Explore/Verifier 不开放 write/edit；若交付物需要修改文件，应返回 `ROLE_MISMATCH`，由父会话转交 worker。Verifier 只能在任务明确指定的临时目录生成验证产物，不能修改被验证的交付物。Bash、MCP 和可信扩展不是只读沙箱，仍须遵守任务授权和项目权限。

模型和 thinking 默认在任务准入时继承父会话，并随解析后的 profile 保存。显式指定 `model: "provider/id"` 不静默替换模型，也不继续沿用旧模型的 effort。`effort` 使用 Pi 档位：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`；`thinking` 是配置中的兼容别名。不支持的模型或档位报错。

### Verifier 的结果

`status` 表示任务执行状态，`verification.modelVerdict` 表示模型给出的 `pass`、`fail` 或 `partial`。执行成功不等于验证通过；缺少或冲突的 `VERDICT` 不会被当成 PASS。旧版运行结束信息仅兼容保存，不补推模型判定或文件变化结论。

文件变化使用工作区元数据前后快照，不读取文件内容、不展开符号链接条目，排除 `.git`、`node_modules` 及 Agent 状态目录。单次扫描最多 20,000 个目录项，扫描循环预算为 1 秒。达到限制或读取失败时报告 `recording_failed`，不伪造“没有变化”，也不将采集失败改成模型执行失败。`no_observed_change` 仅表示本次范围内未观察到差异，不能证明没有瞬时写入；并发变化也不归因于某个子 Agent。扫描不是路径访问隔离机制。

### 长时间运行的命令

使用 Pi 原生 Bash。需要父会话继续工作时，将整个子任务设为 `run_in_background:true`，完成后自动通知父会话；父会话可用 `task_stop` 停止仍在运行的任务。这里没有另建 MCode 的后台 Bash 任务池，也不会向子会话开放父 owner 的任务控制。手工脱离工具生命周期的进程不属于本插件的任务句柄。

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

`provider/model` 须替换为 Pi 中已可用的模型。工具、资源、超时和并发不属于入门必填项；不要为了继承资源而填写空列表。显式选择另一模型但不指定思考级别时，使用 Pi 对该模型的默认设置，不沿用旧模型的思考档。

### 高级覆盖

按顺序加载默认值、`<agentDir>/task-agents.json` 和已信任项目的 `.pi/task-agents.json`。未信任项目配置不生效。指令逐层追加，其他字段替换。极简示例见 [examples/task-agents.json](examples/task-agents.json)。高级字段只在确有覆盖需求时填写。
`maxConcurrency` 可选，范围 1 至 64；省略时不施加插件自己的并发配额。`timeoutMs: 0` 表示不限时。

`tools`、`disallowedTools`、`mcpServers` 按 trim/NFKC/大小写归一化后的精确名称匹配，不展开通配符。`extensions`、`skills` 支持已发现的资源名称或现有本地路径；扩展路径须指向 JS/TS 入口。四个角色均默认继承可用资源。资源省略表示继承可用范围，空列表表示不加载；`mcp:false` 或 `mcpServers:[]` 禁用 MCP。资源选择受项目 trust 和保存的权限上界限制。MCP 通过 Pi SDK 接入，不包含独立 MCP 客户端或 MCode 恢复协议。目前 SDK 未在根入口导出配置 loader，唯一非根接缝为 `extensions/mcp/config.js`；升级 Pi 后须重跑 MCP 回归。

裸名可覆盖内置角色；自定义 `researcher` 可通过 `researcher` 或 `agent:researcher` 调用，`agent:worker` 与内置 `worker` 独立。旧配置中的显式模型、工具和空资源列表仍有优先权；本次清理不自动迁移用户配置。旧的 MCode 专有工具名或 effort 值须人工审阅后改用 Pi 能力。

## 生命周期与边界

- 父 turn abort 会取消前台等待并暂停自动通知，不自动停止已准入的后台任务。停止任务须使用 `task_stop` 或明确的 `/tasks stop-all`。
- 同一 Pi 进程内切换会话时，旧任务归原 owner 所有，不向新会话投递。退出或重载扩展会关闭引擎；异常退出后不自动重放可能已有副作用的执行。
- 任务状态和独立子历史保存在本地。清理失败保留资源占用并允许重试；已保存的输出仍可读取。插件不是跨进程任务守护服务。模型和思考设置在任务准入时捕获，已有子历史不会因父会话之后切换模型而自动改变。扩展工厂自身抛错前的副作用须由扩展自行回滚；插件只能接管 SDK 已交付的生命周期资源。
- 不提供自建 Bash/web_fetch、部署、PTC、SQLite 文件观测或 MCode TUI。若需要外部工具，通过 Pi 的可信资源配置接入。

## 开发

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm run pack
```

`check` 检查 strict 类型、包清单和 vendor 哈希；`test` 运行离线回归；`pack` 生成 `artifacts/pi-task-agents-0.1.0.tgz`，不含依赖、任务历史或认证。`scripts/sdk-smoke.mjs`、`scripts/rpc-smoke.mjs` 会使用本机模型认证并消耗额度，须另行授权运行。

`src/vendor/mcode-background-task/` 保留八个 MIT 任务领域模块。`upstream.lock.json` 和维护脚本仅跟踪这些模块与任务协议参考，不以哈希或离线测试宣称整个 MCode 宿主等价。许可与改编范围见 [NOTICE](NOTICE)。
