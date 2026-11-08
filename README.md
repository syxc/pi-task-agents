# pi-task-agents

小型 Pi 子 Agent 插件：父会话派工，子会话保留独立历史，支持续接、查询、输出、取消和完成通知。任务编排沿用 MCode 的 background-task 机制；子会话、工具执行与资源加载复用 Pi SDK，不复刻 MCode 宿主平台。

要求 Node >=22.19.0 和未修改的官方 Pi 1.5.0；主会话须已有可用模型与认证。运行时使用宿主提供的 SDK 和 typebox，无需 SDK 补丁。

## 使用

安装：

```sh
pi install git:github.com/syxc/pi-task-agents
```

安装或更新后执行 `/reload`，再新建子任务，无需配置文件；已有子任务保留配置快照。默认继承当前对话的模型、思考级别和父会话最终提供的 Skills，每个 owner 最多并发 4 个任务，其余排队。运行 `/tasks roles` 查看概况，工具范围见[工具转发限制](#工具转发限制)。

正常使用无需运行 `pnpm install`；格式化和 lint 工具仅用于[开发检查](#开发)，不在插件运行时执行。

## 工具与任务流程

派工须提供背景、文件所有权、交付物和验收条件。子会话不复制父对话；报告应保留结论、必要证据和风险，避免无关日志与简报复述。

| 工具 | 行为 |
| --- | --- |
| task | 创建子任务；默认前台等待，`run_in_background:true` 返回后台准入回执 |
| task_append | 异步续接；运行中 steer，闲置时沿原历史创建新任务 ID |
| task_send | 仅在子会话闲置时同步续接；接受本 owner 的任务 ID 或子 session_id |
| task_query | 查询当前父会话的任务与状态 |
| task_output | 读取持久输出，支持 UTF-8 字节偏移、增量游标和最长 30 秒等待 |
| task_stop | 取消任务；清理未确认时报告状态并保留并发名额 |
| task_agents | 查看角色和资源范围 |

### 结果与通知

- 前台任务和 `task_send` 直接返回完整结果，不另发通知。
- 后台回执仅表示获准执行，不代表成功。结束后，原父会话收到执行状态、关键验证事实和任务句柄。
- 父会话须用 `task_output` 读取持久结果再整合回复，`details` 等元数据不能代替读取；不按长度筛选必要信息或截取报告摘要。
- `task_output` 默认返回完整验证文本及覆盖整个报告的确定性 SHA-256 fingerprint。读过报告后，可用 `known_verification_fingerprint` 回传该值；仅匹配当前报告时省略验证详情文本，缺失或不匹配时返回当前完整报告。省略时仍有 fingerprint、说明和恢复方法，实际输出、状态、错误、游标、截断标志及 `details.verification` 不变。任意有效 `offset`、重试或原父会话恢复后，省略该参数即可重读完整报告；不依赖投递历史。

通知与结果分离：运行期间的完成通知通过 `followUp` 排队并唤醒空闲主会话，不模拟用户提交；启动时仍有待投递通知时，TUI 同样唤醒，print/json/RPC 模式改用 `nextTurn` 排队，避免宿主即将提交首个提示时抢占运行槽。同一投递窗口内的多个终态任务合并为一条通知（最多 32 个任务、8 KiB），避免并发完成时连续唤醒；未取得落盘回执时按 1/2/5 秒快速重试，之后从 60 秒起按指数冷却、最长 300 秒持续重试，直到确认、暂停或会话关闭。`display:false` 只隐藏 TUI 展示，仍进入模型上下文、唤醒空闲主会话，不等于减少 token。`task_output` 不是 Bash 日志流，取消读取不会停止任务。

### 续接与查看状态

续接保留子历史、角色及权限上界。查询保留失败或停止原因；新续接任务另有 `parent_task_id` 和执行模式，后台 append 标为 `append`，旧记录不补推来源。

- 查看：`/tasks list`、`/tasks roles`、`/tasks show <id>`。状态栏显示运行数和排队数；任务区域优先显示状态和任务身份，空间允许时显示目标、耗时及活动。
- 停止：`/tasks stop <id>`、`/tasks stop-all`。
- 恢复通知：`/tasks resume`，清除暂停和重试冷却，不重启任务。

任务超时包含子会话初始化。调用子会话工厂前，插件先持久化初始化所有权标记，落盘失败则不调用工厂。标记沿用已有快照的内部字段 `ownedCommandCleanupPending`。正常初始化完成并交接给 active 任务后，先持久化清除标记再派发提示；这不表示会话已无存活资源，后续仍沿用现有 active 任务和原生命令清理契约。取消中的初始化只在原工厂确证清理后清除标记，不因变为 `lost` 而确认清理。

初始化清理或停止状态未能及时确认时，停止会报告 `cleanup_pending` 或错误。带未确认标记的 owner 重启后长期隔离，结果仍可通过 `task_query`、`task_output` 读取，但不能继续派工；`close()` 会报错并保留 owner 锁。重建 child、空 `dispose()`、新 session 或其他 owner 的清理不能解除旧 owner 的隔离，也不提供人工解除入口。清理确认必须成功落盘，失败时保留锁并在关闭重试时补写回执。插件不能强制终止不配合的 SDK 初始化。

没有该标记的旧快照保持原有 active/lost 恢复语义；插件无法补推历史初始化是否发生，也不把缺少标记当作资源已清理的证明。隔离按 owner 生效，切换 owner 不会清除旧标记，也不能作为原工作已安全恢复的依据。

TUI 使用 Pi 的主题和终端组件；RPC 模式发送纯文本状态与任务行。图形客户端可选择不显示这些信息；此时可通过客户端支持的 `/tasks list` 或 `task_query` 查询。

### 长时间运行的命令

默认使用 Pi 原生前台 `bash`。允许 Bash 且权限快照包含该能力时，Worker、Verifier 和 Mavis 还可使用子会话专属的 `bash_task`；Explore 不开放，旧权限快照不自动新增能力。它与后台运行整个子任务不同：

| `action` | 行为 |
| --- | --- |
| `start` | 启动命令，返回 `command_id` |
| `list` | 查询命令 |
| `output` | 增量读取输出 |
| `stop` | 单独停止命令 |

- 执行：经子会话原生 `executeTool('bash', …)` 和父工具桥执行，与前台 Bash、codemode 共用父管线，保留实际 shell、前缀、环境、超时及权限 hooks。观察器仅复制 `shellPath`、`shellCommandPrefix`，不复制全部父设置。
- 收尾：子 Agent 可继续独立工作，但须在逻辑任务结束前等待所属命令，并在同一任务内接收未读结果提示，不另建跟进任务或依赖模型轮询。
- 句柄：使用 `command_id`，不能控制父任务、其他子会话或其他 Turn 未结束的命令；所属子会话已结束的命令可按历史句柄读取。父 `task_stop` 会取消子任务所属执行，不接管手工脱离原生生命周期的进程。
- 输出：使用私有 `0600` 文件和有界 UTF-8 分段读取；省略 `offset` 使用已提交游标，`offset:0` 可重读，`wait_ms` 最多 30 秒。`truncated` 表示仍有未读字节，不表示命令已结束；`output_incomplete` 表示输出不完整。
- 清理：`cleanup_pending` 表示清理未确认，保留容量与租约。崩溃后不重放命令，不将未知状态当作已清理。验收和适配边界见[核心功能对照](docs/mcode-parity.md)。

### 程序化工具调用

PTC 类调用使用 Pi 原生 codemode，不另建 MCode PTC 运行时。父 Pi 是唯一总开关：父关闭时子也关闭，角色 tools 或 MCP 不能开启；父开启后可批量组合获准工具、筛选结果，简单操作仍直接调用。关闭 MCP 不影响原生组合。

权限 hooks、deny 和历史上界仍生效，旧任务不自动扩权。返回格式、超时和预算沿用 Pi，不承诺 MCode 脚本原样兼容；差异见[核心功能对照](docs/mcode-parity.md)。

## 角色与权限

| 角色 | 用途 | 默认原生工具 |
| --- | --- | --- |
| explore | 定位与证据收集 | read、grep、find、ls、bash |
| worker | 指定范围内实现 | 上述工具及 edit、write |
| verifier | 独立检查 | 与 explore 相同 |
| mavis | 研究与实现 | 与 worker 相同 |

角色指令和原生工具范围是代码内置预设，无需逐项配置。

- 子会话不开放父任务、todo、用户提问、goal 和定时控制，也不加载本插件自身。信息不足时向父会话报告 blocker，不直接询问用户或安排独立后续工作。
- Memory 只可写入明确提供的 child-owned 存储，否则把持久结论交给父会话处理。
- Explore/Verifier 不开放 write/edit；若交付物需要修改文件，应返回 `ROLE_MISMATCH`，由父会话转交 worker。Verifier 只能在任务明确指定的临时目录生成验证产物，不能修改被验证的交付物。
- Bash 和 MCP 不是只读沙箱，仍须遵守任务授权和项目权限。

### Verifier 的结果

`status` 表示任务执行状态，`verification.modelVerdict` 表示模型给出的 `pass`、`fail` 或 `partial`。执行成功不等于验证通过；缺少或冲突的 `VERDICT` 不会被当成 PASS。旧版运行结束信息仅兼容保存，不补推模型判定或文件变化结论。

文件观察与模型判定分开记录，不是路径隔离或通用写审计：

- 范围：覆盖各适用角色的实际工具调用及嵌套 codemode，保存已知目标首次调用前和最后调用后的元数据。Verifier 另保留工作区前后快照；目标不明的 Bash 也可在预算内补充工作区元数据。不读取内容、不跟随符号链接，排除 `.git`、`node_modules` 和 Agent 状态目录。
- 路径：write/edit 按 Pi 规则解析别名；Shell 保留字面空格、纳入非空原生前缀。未解析的父目录遍历及复合命令影响保留不确定性；动态、范围外、排除或不完整目标报告 `uncertain`。
- 上限：工作区单次扫描 20,000 个目录项，循环预算 1 秒；每次工具捕获最多 64 个目标，每轮最多 256 个不同目标。返回最多 200 条去重后的变化路径，优先保留直接观察到差异的工具目标，再以工作区变化补足，选取后按路径排序；目录变化也计入，最终列表或补充的工作区变化列表被截断时均保留 `changed_files_truncated` 提示。
- 解释：采集失败报告 `recording_failed`，不伪造空的已确认变化列表，也不改判模型执行失败。`no_observed_change` 仅表示范围内未见元数据差异，不证明没有瞬时写入或内容变化；并发变化不归因于某个子 Agent。验收与待完成项见[核心功能对照](docs/mcode-parity.md)。

## 配置

### 模型与思考级别

通常无需配置；要覆盖模型或思考级别时，将对应角色写入 `<agentDir>/task-agents.json`。未填写的角色继续继承当前对话：

```json
{
  "roles": {
    "explore": { "model": "provider/model", "thinking": "medium" },
    "worker": { "model": "provider/model", "thinking": "high" }
  }
}
```

`provider/model` 须替换为 Pi 中已可用的模型。任务参数 `model`、`effort` 优先于角色配置；没有任务或角色覆盖时，在准入时继承父会话。解析后的 profile 随任务保存。显式选模型不会静默替换为其他模型，也不沿用旧模型的思考档；未指定思考级别时使用 Pi 对新模型的默认设置。`effort` 可用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，`thinking` 是配置兼容别名；Pi SDK 对不支持的模型或档位报错。

### 并发

无需配置文件即可使用默认并发 4。需要调整时，在全局或已信任项目的 `task-agents.json` 中设置：

```json
{
  "maxConcurrency": 4
}
```

`maxConcurrency` 必须是 1 至 10 的安全整数；10 是防止误配置大量并发的保护上限，不代表模型或机器可承受的推荐值。配置加载与直接构造 `TaskEngine` 使用相同默认值和校验。全局值被已信任项目的显式值覆盖；项目省略时继承全局值，两层都省略时为 4。

名额按当前父会话 owner（对应一个 `TaskEngine`）计数，所有角色共用，不是每个角色 4 个，也不是跨父会话或跨进程的总限额。超过上限的任务保留原有排队行为，运行或停止清理占位释放后才继续；清理失败仍占位，不因默认值变化提前放行。界面显示有效并发上限与排队数。

前台调用有一项保守限制：SDK 确认调用来自另一工具的 `ctx.executeTool()`，或无法确认调用来源（缺失 hook 事件、hook 与执行参数对象不匹配），且当前 owner 的名额已被运行、清理占位或在先排队任务占用时，新的前台 `task` / `task_send` 在创建任务之前返回 `TASK_FOREGROUND_BUSY`（409、可重试、`admitted:false`），不会创建失败任务、返回新任务句柄或执行简报。去重命中的已准入请求仍按原回执处理。有真实匹配 direct hook 的直接调用仍可排队；后台调用、容量充足的调用和已准入请求的去重重放不受此限制。

这是为避免前台等待名额、占槽后台任务又等待同一 SDK nested tool queue 的等待环。分类使用已核验官方 Pi 1.5.0 的逐调用校验参数对象，不按 `toolCallId` 猜测或关联；相同 ID 的并发调用互不覆盖。`agent_end` 不等于权限 hook 已排空，不会清除在途分类；被阻止或取消的调用不因分类而被强引用保留。若调用在 hook 等待期间遇到 session 关闭或替换，则在准入前返回 `TASK_CALL_EXPIRED`，须从当前 session 重试，不能转投新 owner。这不假定运行时 SDK 与开发依赖同版；peer 版本不受固定开发依赖约束。其他 SDK 若缺失事件、复制执行参数或并发复用同一参数对象，将保守标为 unknown，满槽前台不能排队，即使实际上是直接调用。恢复完整 direct 排队能力前须重新核验并适配该 SDK 的关联契约；不能靠猜 ID 或固定开发依赖绕过保护。

官方 SDK 未公开实时调度模式，因此该限制也会拒绝原本可排队的 parallel 嵌套前台调用，不声称两者等价。收到 BUSY 后，等待任务完成或停止清理确认再重试；独立任务可改用 `run_in_background:true`，异步续接可用 `task_append`。不要把该错误当作已执行或已准入，也不要据此重投已有回执的任务。

兼容变化：旧版省略 `maxConcurrency` 时不设插件并发配额；现在默认是 4，超过 4 个任务会排队，可显式设置 5 至 10。原有 1 至 10 的配置保持原值；旧配置中的 11 至 64 现在会使全局或已信任项目配置加载失败，报错含配置路径及合法范围，不会静默忽略、回退或截断。升级前须将其改为 1 至 10；未信任项目配置仍不解析，仅保留忽略诊断。直接构造 `TaskEngine` 也拒绝大于 10 的值。

### 高级覆盖

工具、资源、超时和并发均非入门必填项。加载顺序为默认值 → `<agentDir>/task-agents.json` → 已信任项目的 `.pi/task-agents.json`；未信任项目配置不生效。指令逐层追加，其他字段替换，示例见 [examples/task-agents.json](examples/task-agents.json)。

- 超时：`timeoutMs: 0` 表示不限时。
- 角色名称：裸名配置可覆盖内置角色；自定义 `researcher` 可用 `researcher` 或 `agent:researcher` 调用，`agent:worker` 与内置 `worker` 独立。配置键区分大小写，请求中的内置名按大小写不敏感匹配，因此配置 `"Worker"` 是独立的 `agent:Worker`，而请求 `Worker` 会选择内置 `worker`；自定义角色应使用与调用一致的大小写。
- 兼容性：旧配置的显式模型、工具和空资源列表仍有优先权，不自动迁移；MCode 专有工具名或 effort 值须人工审阅后改用 Pi 能力。

### 资源选择与权限快照

已有角色字段可按需缩小 Skills 和 MCP 范围，无需增加加载机制。例如，仅为 worker 选择父会话已接受的 Skill `code-review` 和 MCP 服务器 `docs`，并为 verifier 关闭两者：

```json
{
  "roles": {
    "worker": { "skills": ["code-review"], "mcpServers": ["docs"] },
    "verifier": { "skills": [], "mcp": false }
  }
}
```

名称须替换为父会话实际可用且已信任的资源；这些字段只能缩小选择，不能绕过父权限、信任检查或恢复任务的历史上界。

- 匹配：`tools`、`disallowedTools`、`mcpServers` 按 trim/NFKC/大小写归一化后的精确名称匹配，不展开通配符。`extensions`、`skills` 按父会话已接受的资源名称或本地路径缩小选择，不执行新的扩展文件。
- 继承与关闭：四个角色默认继承父可用资源；不要为继承填写空列表，空列表会关闭对应资源。`mcp:false` 或 `mcpServers:[]` 禁用 MCP。选择须与父实际工具权限及历史上界相交，本地路径不能复活父已关闭的资源。
- MCP 资源列表：按服务器限制时，调用须显式指定允许的 `server`。
- 权限快照：新任务保存工具、Skill 和扩展来源上界，不保存执行闭包、工厂函数或 MCP 认证配置。恢复续接时重新绑定当前父会话并与旧上界相交，新增工具不自动进入旧子会话；需要额外资源时，应以明确简报派发新任务。旧输出仍可读取。

## 工具转发限制

子会话通过父 Pi 原生工具管线执行，沿用真实权限 hooks；扩展工厂不在子会话重跑，父会话自身的工具不受影响。默认插件路径只转发已核验的官方 Pi 1.5.0 工具：

- 宿主标记为内置的 `read/write/edit/bash/powershell/grep/find/ls`。
- 来源为 `builtin:mcp` 的官方 MCP 工具和资源适配器，包括运行态 MCP 注册；复用父连接，不复制凭据或重连。

来源和名称须同时符合核验范围；名称、namespace、只读提示或 `reachesTools` 声明本身不是证明。普通扩展、同名覆盖、替代 MCP 适配器和 inline MCP 工厂不转发，角色配置也不能重新开启；需要这些工具的工作应留在父会话。未知 SDK 版本关闭父工具转发，升级后须重新核验并回归。

拒绝任意扩展转发是为避免嵌套排队与独立取消信号引发跨 Turn 死锁或取消竞态，权限 hook 不足以阻断。官方叶子实现、工具桥机制与证据见 [Pi 运行态适配](docs/pi-runtime-adapter.md)。

此保证依赖未修改的官方宿主及来源元数据，不是同进程恶意扩展沙箱；自定义宿主伪标 `builtin`、篡改元数据或 SDK 不在保证内。直接使用底层 SDK backend 的嵌入程序可显式提供独立资源加载器，由调用方承担信任与生命周期责任，不代表默认父工具桥开放这些能力。

## 生命周期与边界

- 父 turn abort 会取消前台等待并暂停自动通知，不自动停止已准入的后台任务。停止任务须使用 `task_stop` 或明确的 `/tasks stop-all`。
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

开发使用 Node >=22.19.0、pnpm 11.15.1 和 TypeScript 7.0.2；`packageManager` 固定 pnpm 版本。开发依赖的 Pi SDK 与 `pi-ai` 同版锁定为 1.5.0，工具链及 typebox、Node 类型的固定版本见 [package.json](package.json) 和 [pnpm-lock.yaml](pnpm-lock.yaml)。[pnpm-workspace.yaml](pnpm-workspace.yaml) 将 `markdownlint-cli2` 的传递依赖 `markdownlint` 暂覆盖为修复 ReDoS 的 0.42.1，上游更新后应复核并移除此覆盖。

- `check`：strict 类型、包清单、vendor 哈希、Oxlint、类型感知 lint、Markdown 和 Oxfmt。可分别运行 `pnpm run lint`、`pnpm run lint:type-aware`、`pnpm run lint:markdown`、`pnpm run format:check`；`pnpm run format` 仅格式化自有代码与配置，不改上游锁定源码。
- `test`：直接对未修改的官方 SDK 回归，包含隔离 bundled CLI 的默认派工和权限拒绝测试，不应用 SDK 补丁。开发依赖 alias `typescript-fixture` 固定为 `npm:typescript@5.9.3`，仅用旧 Compiler API 动态编译上游原文 fixture，保留装饰器、CommonJS 和 ESM 转换及全部对照断言；项目 `tsc` 和类型检查仍使用 7.0.2。此兼容依赖须单独维护，迁移 fixture 编译方式后再移除。
- `pack`：运行 `pnpm run pack`（不是 pnpm 内置的 `pnpm pack`），在 `artifacts/` 生成当前包版本的 `.tgz`，包含源码、测试、开发脚本及 pnpm override 配置，不含依赖、任务历史或认证。内部保留 Node 随附的 `npm pack --ignore-scripts`，避免 pnpm 打包时移除清单末尾换行而导致提取包格式检查失败；npm 不用于依赖安装。根锁文件不打包；提取包的 frozen 开发验证须另提供同版本仓库的 `pnpm-lock.yaml`。

离线测试和本地 stdio MCP 只证明受控路径，不代表真实模型、第三方业务 MCP、其他 SDK 版本或平台已验收。真实模型和第三方业务验收须另行授权；其中 `scripts/sdk-smoke.mjs`、`scripts/rpc-smoke.mjs` 使用本机模型认证并消耗额度。

### 上游维护与许可

- 复用源码：`src/vendor/mcode-background-task/` 和 `src/vendor/mcode-child-bash/` 保留 MIT 模块，同步脚本核验哈希与可逆导入适配。
- 单独适配：`src/vendor/mcode-adapters/task-turn-id.ts` 保留上游逐字原文，`file-write-targets.ts` 保留上游 helper 及窄路径适配；由固定快照和源码一致性测试核验，不受上述同步脚本管理。原始快照在 `test/fixtures/`；混合自有逻辑的 `src/task-verification.ts` 不在 vendor 目录。
- 持续检查：`upstream.lock.json` 监测核心参考文件；每周或手动检查只报告变化，不自动移植，契约变化须人工适配。范围、命令及更新步骤见[核心功能对照](docs/mcode-parity.md)。

哈希或离线测试不证明整个 MCode 宿主等价；逐项实现、测试和 Pi 适配边界见[核心功能对照](docs/mcode-parity.md)，许可见 [NOTICE](NOTICE)。
