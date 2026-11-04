# pi-task-agents

将 MCode 的子 Agent 任务机制适配为 Pi Coding Agent 扩展。父会话可并行派发任务，子会话保留独立历史、角色配置和工具范围。

要求 Node >=22.19.0，已在 Pi 1.5.0 验收。运行时使用宿主的 Pi SDK 和 typebox，源码以严格 TypeScript 维护。

## 安装

从 GitHub 安装固定版本：


```
pi install git:github.com/syxc/pi-task-agents@v0.1.0
```

也可从 [Releases](https://github.com/syxc/pi-task-agents/releases) 下载压缩包，解压后运行 `pi install ./pi-task-agents`。本地源码可直接加载：


```
pi -e /path/to/pi-task-agents/src/extension.ts
```

重启或重载 Pi 后，用 `/tasks roles` 查看角色，再向父模型提出需要委派的任务。

## 角色与工具

| 角色 | 用途 | 默认模型 | thinking | 默认工具 |
| --- | --- | --- | --- | --- |
| explore | 只读定位和证据收集 | openai-codex/gpt-6.1-terra | medium | read、grep、find、ls |
| worker | 指定范围内实现功能 | openai-codex/gpt-6.1-sol | high | 上述工具及 bash、edit、write |
| verifier | 独立检查既有成果 | openai-codex/gpt-6.1-sol | xhigh | read、grep、find、ls |
| mavis | 研究、解释与实现 | openai-codex/gpt-6.1-sol | xhigh | 与 worker 相同 |

在 Pi 中配置模型与认证，或按下节覆盖模型。未知模型、不支持的 thinking 或 SDK 降档会报错。角色提示词位于 `prompts/`，所有子会话均不能继续派工。Explore 拒绝写入任务，Verifier 拒绝修改待检查成果，均返回 `ROLE_MISMATCH`。Verifier 默认不运行 shell 测试，必要时须显式配置 bash 并限定任务范围。

| 工具 | 行为 |
| --- | --- |
| task | 创建任务，默认后台；`run_in_background:false` 等待终态 |
| task_append | 运行中追加；空闲时沿原历史创建新任务 ID |
| task_query | 查询当前父会话的任务，可按 ID 或状态过滤 |
| task_output | 读取 UTF-8 字节输出，支持增量游标及最长 30 秒等待 |
| task_stop | 取消任务，子会话停止后释放并发名额 |
| task_agents | 查看角色、模型、thinking 和工具范围 |

`task` 与 `task_append` 返回 ID 只表示接收。后台完成后会通知并继续父会话，前台结果不重复通知。子模型不继承父对话，任务须包含背景、文件所有权、交付物和验收条件。创建时冻结配置，后续配置变化不影响该任务及其续接。可通过 `model: "provider/id"` 与 `effort` 覆盖模型和思考档位。

人工命令：`/tasks list`、`/tasks roles`、`/tasks show <id>`、`/tasks stop <id>`、`/tasks stop-all`、`/tasks resume`。TUI 显示任务状态。`stop-all` 或用户中止父运行会停止活动子任务并暂停通知；新用户请求、新任务或 `/tasks resume` 恢复通知。暂停状态在重载后保留，切换父会话或关闭扩展会停止原父会话的活动任务。

## 配置

依次加载默认值、`<Pi agentDir>/task-agents.json`、已信任项目的 `<cwd>/.pi/task-agents.json`。全局目录通常为 `~/.pi/agent`。未信任的项目配置只产生诊断，修改后重载扩展。完整四角色示例见 [examples/task-agents.json](examples/task-agents.json)。


```
{
  "maxConcurrency": 4,
  "roles": {
    "worker": {
      "model": "openai-codex/gpt-6.1-sol",
      "thinking": "high",
      "instructions": "遵循项目约定，完成指定范围。",
      "tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
      "extensions": [],
      "skills": [],
      "mcp": false,
      "timeoutMs": 0
    }
  }
}
```

`maxConcurrency` 为 1 至 64，`timeoutMs` 为 0 时不限时，最大 2147483647。`thinking` 支持 `off|minimal|low|medium|high|xhigh|max`，还须由所选模型支持。未知字段、错误类型和重复列表项会报错。指令逐层追加，其他字段和数组替换。资源路径相对配置文件，须指向现有本地资源；扩展须指定 JS/TS 入口文件。

裸名覆盖内置角色。自定义键 `researcher` 定义 `agent:researcher`，调用时须带 `agent:`，并继承未经覆盖的 Mavis 默认值。`agent:worker` 与内置 `worker` 独立。

默认不继承用户扩展、技能或 MCP，仅加载 Pi 项目上下文。显式启用 MCP 时只读取全局 MCP 配置，还须在 `tools` 指定具体工具名，不支持通配符。插件自身、递归任务工具和白名单外工具会被拒绝。MCP 使用 Pi 1.5.0 内部配置接口，其他 Pi 版本尚未验收。

工具白名单不是操作系统沙箱。内置 Explore/Verifier 禁止直接配置 write/edit，但显式开放的 bash、扩展与 MCP 仍可写文件或产生外部副作用，须由调用者限定范围。

## 数据与恢复

数据保存在 `<Pi agentDir>/task-agents/sessions/<parent-hash>/`，包括 `tasks.json` 与 Pi JSONL 子历史。目录权限为 0700，文件为 0600；仅原父会话可查询、续接或取消任务。同机进程锁防止重复接管，不支持跨机器共享存储。

状态为 `queued/running/stopping/succeeded/failed/canceled/lost`。异常退出后未完成任务标记为 `lost`，不自动重跑；恢复父会话后可读取结果或用 `task_append` 明确续接。正常退出会取消任务。

输出默认使用持久游标，`offset:0` 重读，`next_offset` 继续，UTF-8 字符不会截断。失败前的输出仍可读取。读取输出不确认通知，通知持久写入父历史后才确认；投递失败保留待投递状态，核对回执后最多尝试三次，可用 `/tasks resume` 或重载重试。

输出含可见文本与工具活动摘要，不转发思考正文或完整工具参数。原始 Pi 历史仍可能含私密任务与工具内容。任务调用 ID 用于去重，但不保证外部副作用的跨进程事务。完整输出保存在状态 JSON 中，长输出会增加写盘成本。

## 开发与上游维护


```
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm run pack
```

`check` 检查生产源码 strict 类型、包清单与 vendor 哈希；`test` 运行离线测试。`pack` 生成 `artifacts/pi-task-agents-0.1.0.tgz`，不含依赖、任务历史和认证。`scripts/sdk-smoke.mjs` 与 `scripts/rpc-smoke.mjs` 使用本机 Pi 认证执行真实模型验收，会消耗模型额度。

`src/vendor/mcode-background-task/` 直接复用 [MCode](https://github.com/MiniMax-AI/minimax-code) 的八个纯领域模块。仅将相对导入扩展名改为 `.ts`，并将一个 constructor 参数属性展开为等价字段，以支持 Node 原生类型擦除。Pi 的调度、持久化、取消封口和父通知由宿主适配层处理。

`upstream.lock.json` 固定上游 commit、原始与适配哈希，并监测角色和宿主契约。GitHub Actions 每周及手动检查上游变化，CI 离线核验 vendor；发现变化后由维护者审阅并同步：


```
npm run upstream:check
npm run upstream:sync -- --ref <full-40-character-commit>
npm run check
npm test
```

同步检查本地修改，并拒绝未登记模块和缺失路径。安装时保留 `.upstream-old-*` 原文件恢复副本，核对更新与检查结果后再清理；同步期间应暂停编辑 vendor。角色或宿主契约变化须人工核对，完成适配后才可加 `--accept-contract-changes` 更新基线；此参数不会自动移植契约。更新后重跑真实 Pi 验收，再发布版本。

采用 MIT 许可，上游出处见 [NOTICE](NOTICE)，许可全文见 [LICENSE](LICENSE)。
