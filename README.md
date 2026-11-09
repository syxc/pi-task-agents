# pi-task-agents

Pi 子 Agent 插件：父会话派工，子会话保留独立历史，支持前后台任务、续接、查询、输出、取消和完成通知。任务编排沿用 MCode 的 background-task 机制；子会话、工具执行和资源加载复用 Pi SDK，不复刻 MCode 宿主平台。

要求 Node >= 22.19.0、未修改的官方 Pi 1.5.0，以及父会话已配置可用模型和认证。运行时使用宿主提供的 SDK 与 typebox，无需补丁。

## 安装

```sh
pi install git:github.com/syxc/pi-task-agents
```

安装或更新后执行 `/reload`，再新建子任务。无需配置文件；已有子任务保留创建时的配置快照。默认继承当前对话的模型、思考级别和父会话最终提供的 Skills；每个父会话 owner 最多并发 4 个任务，其余排队。`/tasks roles` 查看角色概况，工具转发范围见[工具转发限制](#工具转发限制)。

正常使用无需 `pnpm install`；格式化、lint 等工具仅用于[开发](#开发)。

## 任务工具

派工简报须包含背景、文件所有权、交付物和验收条件。用户明确指定角色时沿用该名称；不要让 explore 或 verifier 以创建或修改项目文件作为验收条件。子会话不复制父对话；报告应保留结论、必要证据和风险，避免无关日志与简报复述。

| 工具 | 行为 |
| --- | --- |
| task | 创建子任务。默认前台等待；`run_in_background:true` 返回后台准入回执。可覆盖 `model`、`effort` |
| task_append | 异步续接。运行中 steer 到同一任务 ID，并入该 Turn 的单一最终结果；闲置时创建新任务 ID，沿用同一子会话的历史和冻结 profile。延续同一线索时复用子会话，独立工作才新建任务 |
| task_send | 仅在子会话闲置时同步续接；接受本 owner 的任务 ID 或子 `session_id`，busy 时拒绝且不排队 |
| task_query | 查询本父会话拥有的任务；列表按创建时间倒序，最多返回最新 100 条，可按状态过滤 |
| task_output | 读取持久输出；UTF-8 字节偏移、自动游标、最长 30 秒等待，默认每页 64 KiB |
| task_stop | 取消排队或运行中的任务，等待子会话停止后释放名额；历史与输出保留 |
| task_agents | 查看角色、模型、思考级别和工具范围 |

`description` 须为空白归一化后 1 至 50 个 Unicode 码点；`prompt` 允许为空，但仍应提供自包含的简报。`task_append` 的内容不能为空白；父 turn abort 不影响已准入的异步续接。

## 按任务选择 Skills

父会话已拥有 Skills 目录，可按派工目标通过 `task.skills` 选择首批展示的 Skill 名称，避免每个子会话重复接收完整目录。只传名称，不复制正文或自行拼接路径：

```json
{
  "agent_name": "explore",
  "description": "定位失败原因",
  "skills": ["hunt"],
  "prompt": "只读调查指定错误，按适用 Skill 返回原因、证据与验证结果。"
}
```

父会话目录较大时，完整名称、描述与路径可改用共享路径前缀的紧凑表示；省略的行尾字段按明确默认值恢复：根索引为 `0`，文件路径为 `name/SKILL.md`。非规范路径保留显式字段，不会删去条目或修改传给子会话的资源元数据。已有自定义目录表示，以及 `forceSystemPrompt` 覆盖的提示词，不参与这种改写。

名称必须来自当前角色已获准的 Skills。省略 `task.skills` 保持原来的完整目录；`task.skills: []` 表示初始不展示任何 Skill，并不关闭其他已授权 Skills。它与角色配置的 `skills: []` 不同，后者仍关闭该角色的 Skills。

有未展示的已授权 Skills、子会话有原生文件读取能力且查阅工具未被禁用时，子会话提供 `task_skill_search` 查询其完整名称、描述与路径；再用原生 `read` 或获准的原生 Bash 读取适用的 `SKILL.md`。查询为空可分页查看目录，结果保留总数和后续页信息，不预加载正文。禁止模型自动调用的 Skills 不参与搜索，也不能作为首批选择。未知或不在角色范围内的首批名称会报错，不静默扩权。

首批选择随子会话保存，续接沿用；搜索仍受当前资源和创建时权限上界限制。该功能不删除项目约定、不修改父对话的目录，也不改变 MCP、工具或已有任务的权限。

## 结果与通知

### 结果读取

- 前台任务和 `task_send` 直接返回完整结果，不另发完成通知。
- 后台回执只表示获准执行，不代表成功。终态结果先持久化，再通知原父会话；父会话须用 `task_output` 读取持久结果后整合回复。
- `details` 等元数据不能代替读取；`task_output` 不是 Bash 日志流，取消读取不会停止任务。
- 省略 `offset` 使用当前运行时会话的自动游标；显式 `offset` 不推进游标，`offset:0` 可重读。`wait_ms` 超过 30000 时会被截断，并在结果中报告实际等待时间。
- 验证报告默认完整返回，并带确定性 SHA-256 fingerprint。读完后可回传 `known_verification_fingerprint`；仅与当前报告精确匹配时省略验证文本，并保留 fingerprint 和恢复说明。省略该参数即可在任意有效 `offset`、重试或会话恢复后重读完整报告；实际输出、状态、错误、游标、截断标志及 `details.verification` 不变。

### 完成通知

- 运行期间的完成通知通过 `followUp` 排队并唤醒空闲父会话，不模拟用户提交。启动时仍有待投递通知时，TUI 直接唤醒，print/json/RPC 模式改用 `nextTurn` 排队，避免抢占宿主首个提示的运行槽。
- 同一 60 秒窗口内的终态任务合并通知，每条最多 32 个任务、8 KiB，每窗最多 3 次投递 Turn；超出后延至窗口结束重新合并，避免并发完成时连续唤醒。
- 未确认写入父会话记录时，按 1、2、5 秒快速重试；之后从 60 秒起按指数冷却，最长 300 秒，直到确认、暂停或会话关闭。`/tasks resume` 可清除暂停和重试冷却，不重启任务。
- `display:false` 只隐藏 TUI 展示，通知仍进入模型上下文并唤醒空闲父会话，不等于减少 token。

## 续接与查询

续接保留子历史、角色及权限上界。运行中的 `task_append` 合并到当前 Turn；排队任务并入尚未派发的首个 prompt；闲置续接创建新任务 ID，并记录 `parent_task_id` 和执行模式。后台 append 标为 `append`，旧记录不补推来源。查询保留失败或停止原因。

- 查看：`/tasks list`、`/tasks roles`、`/tasks show <id>`。状态栏显示运行数、有效并发上限和排队数；任务区域优先显示状态和任务身份，空间允许时显示目标、耗时及活动。
- 停止：`/tasks stop <id>`、`/tasks stop-all`。
- 恢复通知：`/tasks resume`。

TUI 使用 Pi 的主题和终端组件；RPC 模式发送纯文本状态与任务行。图形客户端可选择不显示这些信息，此时通过 `/tasks list` 或 `task_query` 查询。

### 初始化与清理

任务超时包含子会话初始化。调用子会话工厂前，插件先持久化初始化所有权标记；落盘失败则不调用工厂。初始化完成并交接给 active 任务后，先持久化清除标记再派发提示；取消中的初始化只在原工厂确证清理后清除。清除标记不表示会话已无存活资源，后续仍沿用 active 任务和原生命令清理契约。

初始化尚未派发提示就超时且清理未确认时，插件先持久化失败输出，再通知父会话；迟到的纯清理回执不重复追加失败文本。已派发的提示仍等待 SDK 结算后交付，以保留迟到结果；清理未确认不代表执行已经结束。

清理或停止未及时确认时，停止会报告 `cleanup_pending` 或错误，并保留并发名额。带未确认标记的 owner 重启后长期隔离：结果仍可通过 `task_query`、`task_output` 读取，但不能继续派工，`close()` 会报错并保留 owner 锁。重建 child、空 `dispose()`、新 session 或其他 owner 的清理不能解除隔离，也不提供人工解除入口。清理确认必须成功落盘，失败时保留锁并在关闭重试时补写回执。插件不能强制终止不配合的 SDK 初始化。

没有该标记的旧快照保持原有 active/lost 恢复语义；插件无法补推历史初始化是否发生，也不把缺少标记当作资源已清理的证明。隔离按 owner 生效，切换 owner 不会清除旧标记，也不能作为原工作已安全恢复的依据。

## 角色与权限

| 角色 | 用途 | 默认原生工具 |
| --- | --- | --- |
| explore | 定位与证据收集 | read、grep、find、ls、bash |
| worker | 指定范围内实现 | 上述工具及 edit、write |
| verifier | 独立检查 | 与 explore 相同 |
| mavis | 研究与实现 | 与 worker 相同 |

角色指令和原生工具范围内置，无需逐项配置。自定义角色继承 mavis 的默认工具范围。

- 子会话不开放父任务、todo、用户提问、goal 和定时控制，也不加载本插件自身。
- 信息不足时向父会话报告 blocker，不直接询问用户或安排独立后续工作。
- Memory 只能写入明确提供的 child-owned 存储；否则把持久结论交给父会话处理。
- Explore 和 Verifier 不开放 write/edit；若交付物需要修改文件，应返回 `ROLE_MISMATCH`，由父会话转交 worker。Verifier 只能在任务明确指定的临时目录生成验证产物，不能修改被验证的交付物。
- Bash 和 MCP 不是只读沙箱，仍须遵守任务授权和项目权限。

### Verifier 结果

`status` 表示任务执行状态，`verification.modelVerdict` 表示模型给出的 `pass`、`fail` 或 `partial`。执行成功不等于验证通过；缺少或冲突的 `VERDICT` 不会被当成 PASS。旧版运行结束信息仅兼容保存，不补推模型判定或文件变化结论。

文件观察与模型判定分开记录，不是路径隔离或通用写审计：

- 范围：覆盖各适用角色的实际工具调用及嵌套 codemode，保存已知目标首次调用前和最后调用后的元数据。Verifier 另保留工作区前后快照；目标不明的 Bash 也可在预算内补充工作区元数据。不读取内容、不跟随符号链接，排除 `.git`、`node_modules` 和 Agent 状态目录。
- 路径：write/edit 按 Pi 规则解析别名；Shell 保留字面空格、纳入非空原生前缀。未解析的父目录遍历及复合命令影响保留不确定性；动态、范围外、排除或不完整目标报告 `uncertain`。
- 上限：工作区单次扫描 20,000 个目录项，循环预算 1 秒；每次工具捕获最多 64 个目标，每轮最多 256 个不同目标。返回最多 200 条去重后的变化路径，优先保留直接观察到差异的工具目标，再以工作区变化补足，选取后按路径排序；目录变化也计入，列表被截断时保留 `changed_files_truncated`。
- 解释：采集失败报告 `recording_failed`，不伪造空的已确认变化列表，也不改判模型执行失败。`no_observed_change` 仅表示范围内未见元数据差异，不证明没有瞬时写入或内容变化；并发变化不归因于某个子 Agent。

## 配置

通常无需配置。全局配置为 `<agentDir>/task-agents.json`；已信任项目可覆盖为 `.pi/task-agents.json`。加载顺序为默认值 → 全局 → 已信任项目；未信任项目配置不生效。指令逐层追加，其他字段替换。配置是严格 JSON：未知键和无效值会直接报错。示例见 [examples/task-agents.json](examples/task-agents.json)。

### 模型与思考级别

为角色覆盖模型或思考级别：

```json
{
  "roles": {
    "explore": { "model": "provider/model", "thinking": "medium" },
    "worker": { "model": "provider/model", "thinking": "high" }
  }
}
```

`provider/model` 须替换为 Pi 中已可用的模型。任务参数 `model`、`effort` 优先于角色配置；没有任务或角色覆盖时，在准入时继承父会话。解析后的 profile 随任务保存。

显式选模型不会静默替换为其他模型，也不会沿用旧模型的思考档；未指定思考级别时使用 Pi 对新模型的默认设置。`effort` 可用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，`thinking` 是配置兼容别名；不支持的模型或档位会报错。

### 并发

`maxConcurrency` 接受 1 至 10 的安全整数，默认 4；10 是防止误配置大量并发的保护上限。沿用上述配置加载顺序，直接构造 `TaskEngine` 时使用相同默认值和校验。

名额按当前父会话 owner 计数，所有角色共用，不是每角色 4 个，也不是跨父会话或跨进程的总限额。超过上限的任务排队，运行或停止清理占位释放后才继续；清理失败仍占位。

前台调用有一项保守限制：当 SDK 确认调用来自另一工具的 `ctx.executeTool()`，或无法确认调用来源，且当前 owner 的名额已被运行、清理占位或在先排队任务占用时，新的前台 `task` / `task_send` 返回 `TASK_FOREGROUND_BUSY`（409、可重试、`admitted:false`），不会创建失败任务、返回新任务句柄或执行简报。已准入请求的去重重放、后台调用和容量充足的调用不受影响。该保护也会拒绝原本可排队的 parallel 嵌套前台调用；收到 BUSY 后等待容量，或改用 `run_in_background:true` / `task_append`。hook 等待期间父会话被关闭或替换时，调用在准入前返回 `TASK_CALL_EXPIRED`（409、可重试、`admitted:false`），须从当前 session 重试，不能转投新 owner。

### 资源与权限

角色字段可缩小 Skills、MCP 和工具范围，不能绕过父权限、信任检查或历史权限上界。例如仅为 worker 选择父会话已接受的 Skill `code-review` 和 MCP 服务器 `docs`，并为 verifier 关闭两者：

```json
{
  "roles": {
    "worker": { "skills": ["code-review"], "mcpServers": ["docs"] },
    "verifier": { "skills": [], "mcp": false }
  }
}
```

名称须替换为父会话实际可用且已信任的资源。

- 匹配：`tools`、`disallowedTools`、`mcpServers` 按 trim/NFKC/大小写归一化后的精确名称匹配，不展开通配符。`extensions`、`skills` 按父会话已接受的资源名称或本地路径缩小选择，不执行新的扩展文件。
- 继承与关闭：四个角色默认继承父可用资源；不要为继承填写空列表，空列表会关闭对应资源。`mcp:false` 或 `mcpServers:[]` 禁用 MCP。按服务器限制时，调用须显式指定允许的 `server`。
- 权限快照：新任务保存工具、Skill 和扩展来源上界，不保存执行闭包、工厂函数或 MCP 认证配置。恢复续接时重新绑定当前父会话并与旧上界相交，新增工具不自动进入旧子会话；需要额外资源时应派发新任务。旧输出仍可读取。

### 其他字段

- `timeoutMs: 0` 表示不限时；默认值为 0。
- 裸名配置可覆盖内置角色；其他键定义 `agent:<name>`。自定义 `researcher` 可用 `researcher` 或 `agent:researcher` 调用，`agent:worker` 与内置 `worker` 独立。
- 配置键区分大小写，请求中的内置名按大小写不敏感匹配。配置 `"Worker"` 是独立的 `agent:Worker`，请求 `Worker` 会选择内置 `worker`；自定义角色应使用与调用一致的大小写。

## 运行边界

### 工具转发限制

子会话通过父 Pi 原生工具管线执行，沿用真实权限 hooks；扩展工厂不在子会话重跑，父会话自身的工具不受影响。默认插件路径只转发已核验的官方 Pi 1.5.0 工具：

- 宿主标记为内置的 `read/write/edit/bash/powershell/grep/find/ls`。
- 来源为 `builtin:mcp` 的官方 MCP 工具和资源适配器，包括运行态 MCP 注册；复用父连接，不复制凭据或重连。

来源和名称须同时符合核验范围；普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂不转发，角色配置也不能重新开启。未知 SDK 版本关闭父工具转发，升级后须重新核验并回归。

拒绝任意扩展转发是为了避免嵌套排队与独立取消信号引发跨 Turn 死锁或取消竞态，权限 hook 不足以阻断。官方叶子实现、工具桥机制与证据见 [Pi 运行态适配](docs/pi-runtime-adapter.md)。

此保证依赖未修改的官方宿主及来源元数据，不是同进程恶意扩展沙箱；自定义宿主伪标 `builtin`、篡改元数据或 SDK 不在保证内。直接使用底层 SDK backend 的嵌入程序可显式提供独立资源加载器，由调用方承担信任与生命周期责任，不代表默认父工具桥开放这些能力。

### 受管后台命令

默认使用 Pi 原生前台 `bash`。允许 Bash 且权限快照包含该能力时，Worker、Verifier 和 Mavis 还可使用子会话专属的 `bash_task`；Explore 不开放，旧权限快照不自动新增能力。

| `action` | 行为 |
| --- | --- |
| `start` | 启动命令，返回 `command_id` |
| `list` | 查询命令 |
| `output` | 增量读取输出 |
| `stop` | 单独停止命令 |

- 执行：经子会话原生 `executeTool('bash', …)` 和父工具桥执行，与前台 Bash、codemode 共用父管线，保留实际 shell、前缀、环境、超时及权限 hooks。观察器仅复制 `shellPath`、`shellCommandPrefix`，不复制全部父设置。
- 归属：命令属于子会话和逻辑 Turn，不能控制父任务、其他子会话或其他 Turn 未结束的命令；所属子会话已结束的命令可按历史句柄读取。父 `task_stop` 会取消子任务所属执行，不接管手工脱离原生生命周期的进程。
- 收尾：子 Agent 可继续独立工作，但须在逻辑任务结束前等待所属命令，并在同一任务内接收未读结果提示，不另建跟进任务或依赖模型轮询。
- 输出：使用私有 `0600` 文件和有界 UTF-8 分段读取；省略 `offset` 使用已提交游标，`offset:0` 可重读，`wait_ms` 最多 30 秒。`truncated` 表示仍有未读字节，不表示命令已结束；`output_incomplete` 表示输出不完整。
- 清理：`cleanup_pending` 表示清理未确认，保留容量与租约。崩溃后不重放命令，不将未知状态当作已清理。

### 程序化工具调用

PTC 类调用使用 Pi 原生 codemode，不另建 MCode PTC 运行时。父 Pi 的实际启用状态是唯一总开关：父关闭时子也关闭，角色 tools 或 MCP 不能开启；父开启后可批量组合获准工具、筛选结果，简单操作仍直接调用。关闭 MCP 不影响原生组合。

权限 hooks、deny 和历史上界仍生效，旧任务不自动扩权。返回格式、超时和预算沿用 Pi，不承诺 MCode 脚本原样兼容。差异见[核心功能对照](docs/mcode-parity.md)。

### 生命周期与取消

- 父 turn abort 会取消前台等待并暂停自动通知，不自动停止已准入的后台任务。停止任务须使用 `task_stop` 或显式的 `/tasks stop-all`。
- 切换、新建、fork、重载或退出父会话时，先取消并排空该 owner 的在途执行，再关闭工具桥。后台任务不跨父 runtime 替换继续运行，不转交新会话；本地任务状态、子历史和输出保留，回到原会话可续接。异常退出后不重放可能已有副作用的执行。
- 清理失败保留资源占用并允许重试；插件不是跨进程任务守护服务。父进程被 SIGKILL 或掉电时无法执行清理，宿主原生 Bash 子进程可能继续运行，需由操作系统或外部进程管理处理。已有子历史不随父会话后来切换模型或思考设置而改变。父扩展生命周期仍由 Pi 管理，插件不接管扩展自行启动的外部进程。
- 取消不撤销已发生的本地或远端副作用；权限 hook 或服务未实际结束时，不能宣称清理完成。
- 不提供自建 Bash/web_fetch、部署、SQLite 文件观测或 MCode TUI。若需要外部工具，通过 Pi 的可信资源配置接入。

## 开发

开发时可直接加载源码；开发副本不会自动替换已安装版本：

```sh
pi -e /path/to/pi-task-agents/src/extension.ts
```

### 检查与打包

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
pnpm run pack
```

开发工具和 Pi 依赖版本见 [package.json](package.json) 与 [pnpm-lock.yaml](pnpm-lock.yaml)，其中 `packageManager` 固定 pnpm 版本，Pi SDK 与 `pi-ai` 同版锁定。[pnpm-workspace.yaml](pnpm-workspace.yaml) 将 `markdownlint-cli2` 的传递依赖 `markdownlint` 暂覆盖为修复 ReDoS 的 0.42.1，上游更新后应复核并移除此覆盖。

- `check`：strict 类型、包清单、vendor 哈希、Oxlint、类型感知 lint、Markdown 和 Oxfmt。可分别运行 `pnpm run lint`、`pnpm run lint:type-aware`、`pnpm run lint:markdown`、`pnpm run format:check`；`pnpm run format` 仅格式化自有代码与配置，不改上游锁定源码。
- `test`：默认离线，不包含 `test/e2e`。直接对未修改的官方 SDK 回归，包含隔离 bundled CLI 的默认派工和权限拒绝测试；固定版本的 `typescript-fixture` 仅用于动态编译上游原文 fixture，不替代项目类型检查。
- `test:e2e`：运行 `pnpm test:e2e`，或追加文件名片段选择[真实模型场景](test/e2e/)（如 `pnpm test:e2e control append`）。前置条件：本机 `pi` CLI 可执行；`openai-codex` provider 的 `apiKey` 为环境变量引用且变量已设置。只使用 `gpt-6.1-terra` 和 `gpt-6-luna`，每次消耗真实额度。在 `mkdtemp` 隔离的 HOME、agent dir、workspace 和 session 中运行，结束后删除；`PI_E2E_KEEP=1` 可保留现场。每个场景检查父/子 token、费用、消息数与耗时预算，可用 `PI_E2E_MAX_PARENT_TOKENS`、`PI_E2E_MAX_CHILD_TOKENS`、`PI_E2E_MAX_COST_USD`、`PI_E2E_MAX_ASSISTANT_MESSAGES`、`PI_E2E_MAX_SCENARIO_MS` 调整阈值。MCP 与第三方 provider 不在真实模型覆盖范围内。
- `test:e2e skills-context`：仅用 `openai-codex/gpt-6-luna`、`high` 对父子会话做 Skills A/B。100 项受控目录下，直接读取、代码实现和未预选依赖发现各跑两轮，并交替测试顺序。Node 22 下整文件超时为 50 分钟，单场景仍为 8 分钟。比较首请求输入、缓存读取、父子累计 token、工具调用和耗时，同时检查实际 Skill 读取与代码行为。设置 `PI_E2E_REPORT_DIR=/path/to/new-report-dir` 可保留不含认证的 JSON 指标；结果不等于本机所有 Skills 或任意任务的收益保证。
- `pack`：运行 `pnpm run pack`（不是 pnpm 内置的 `pnpm pack`），在 `artifacts/` 生成当前包版本的 `.tgz`，包含源码、测试、开发脚本及 pnpm override 配置，不含依赖、任务历史或认证。内部使用 Node 随附的 `npm pack --ignore-scripts`，避免 pnpm 打包时移除清单末尾换行而导致提取包格式检查失败；npm 不用于依赖安装。根锁文件不打包；提取包的 frozen 开发验证须另提供同版本仓库的 `pnpm-lock.yaml`。

离线测试和本地 stdio MCP 只证明受控路径，不代表真实模型、第三方业务 MCP、其他 SDK 版本或平台已验收。真实模型和第三方业务验收须另行授权；`pnpm test:e2e` 以及 `scripts/sdk-smoke.mjs`、`scripts/rpc-smoke.mjs` 使用本机模型认证并消耗额度。

### 上游维护

`upstream.lock.json` 监测核心参考文件；每周或手动运行 `pnpm run upstream:check`，只报告变化，不自动移植。复用范围、固定快照、同步命令及更新保护见[核心功能对照](docs/mcode-parity.md)，许可见 [NOTICE](NOTICE)。

## 文档

- [MCode 核心功能对照](docs/mcode-parity.md)：验收基线、契约对照与上游同步。
- [Pi 运行态适配](docs/pi-runtime-adapter.md)：工具桥、调度与取消边界。
- [CHANGELOG](CHANGELOG.md)、[LICENSE](LICENSE)。
