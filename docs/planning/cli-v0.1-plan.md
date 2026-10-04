# Research Explorer CLI v0.1 实施规划（v2.0 项目集）

状态：**C0–C1 已完成，C2–C5 待分阶段实施**
目标产品仓库：`/data0/linsihan/research-explorer-cli`  
核心依赖：`auto-research-agent` 公共 SDK/API  
交互底座：`@earendil-works/pi-coding-agent@1.0.2`

## 1. 背景与现状

现有文档已经确定：

- CLI 默认采用 Codex 式自由聊天；
- 可切换候选模式，候选列表始终保留“其他/自由输入”；
- manual、candidate、auto 共用核心 `ResearchAction` 和强制科研门禁；
- CLI、Web 和游戏只能调用公共 SDK/API；
- v1.5 reference CLI 已证明聊天、候选、Job、审批、报告和插件目录的公共接口可用。

这些内容属于产品原则和接口验证。此前没有确定正式 CLI 的 Pi 复用方式、独立仓库结构、运行时状态、命令/工具映射、版本兼容、发布形式和分阶段门禁。本规划补齐这些实施决定。

## 2. 核心决定：扩展 Pi，不重写终端

首版 CLI 是 **Pi CLI 的官方 extension/package + 一个很薄的 `rexplore` launcher**。

直接复用 Pi：

- TUI、输入编辑器、Markdown 和 tool-call 渲染；
- 流式输出、中断、steer/follow-up；
- 模型 catalog、模型切换、thinking level 和 ChatGPT/Codex OAuth；
- session JSONL、resume、tree、fork、compaction；
- skills、prompt、theme 和 package 发现；
- extension commands、custom tools、input event、生命周期事件；
- `ctx.ui.select/confirm/input`、status、widget 和自定义 renderer；
- print/JSON/RPC 模式。

CLI 自己只实现：

- Core Service 发现、启动、版本协商和重连；
- Pi session 与 Workspace/Project 的轻量绑定；
- ResearchClient 工具、命令和候选交互；
- 科研状态摘要、Job/Artifact/审批展示；
- 插件权限和 SSH Worker 的用户交互；
- CLI 产品配置和兼容性报告。

明确禁止：fork Pi、复制 Pi TUI 组件、另选 Ink/React/Commander 重做交互循环、让 CLI 直接打开 SQLite、从 shell 调用 reference CLI 充当 SDK、在 extension 中复制科研状态机。

参考：[Pi Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)。

## 3. 产品边界

### 3.1 首版目标

1. 用户运行 `rexplore` 后进入完整 Pi 交互界面。
2. 默认输入仍是自由聊天，可正常使用 Pi 的模型、skills 和通用工具。
3. 用户可以创建、打开和切换研究 Project。
4. Pi 能通过受限 research tools 查询状态、提出行动并调用公共 Core API。
5. candidate 模式对普通输入显示合法候选，并始终提供“继续自由聊天/其他输入”。
6. manual/candidate/auto 策略与 Core 的 `ExecutionPolicy` 一致。
7. 长 Job 可以后台运行、流式显示、取消和恢复；退出 CLI 不终止持久 Job。
8. 审批、confirmation、权限扩大和发布门禁必须显式确认。
9. 插件和 SSH Worker 可以搜索、检查和配置，但所有生命周期动作继续由 Core 审计。
10. Linux 和 macOS 使用同一 CLI；Linux 专属实验由 Core 的 SSH Worker 路径处理。

### 3.2 首版非目标

- 不开发新的模型 agent loop；
- 不实现 Web/游戏功能；
- 不在 CLI 内执行科研数据库迁移；
- 不提供中心化账号或云服务；
- 不自动发布论文、Git tag、GitHub Release 或 npm package；
- 不保证 Pi 任意第三方 extension 都与 research extension 兼容，首版建立兼容检查和隔离说明。

## 4. 独立仓库与依赖方向

```text
research-explorer-cli/
├── package.json
├── src/
│   ├── launcher.ts                 # rexplore 入口；启动/连接 Core 后 exec Pi
│   ├── config.ts                   # CLI 自身非敏感配置
│   └── extension/
│       ├── index.ts                # Pi ExtensionAPI 注册入口
│       ├── core-client.ts          # 仅包装公开 ResearchClient
│       ├── state.ts                # 当前 workspace/project/mode
│       ├── input-router.ts         # candidate input event
│       ├── context.ts              # before_agent_start 状态注入
│       ├── commands/               # slash commands
│       ├── tools/                  # LLM 可调用 research tools
│       └── renderers/              # 状态、候选、Job、Artifact 展示
├── tests/
│   ├── fixtures/
│   ├── extension-contract.test.ts
│   ├── candidate-mode.test.ts
│   └── package-smoke.test.ts
└── docs/
```

依赖固定为：

```text
rexplore launcher / Pi extension
       ↓
auto-research-agent/client + contracts
       ↓
Core Service
```

CLI 不导入 Core 的 domain、application、Store、migration、SQLite 或内部 runtime。两个仓库独立发布；CLI 声明支持的 Core service version、public schema range 和 Pi version range。

### 4.1 实施前必须补齐的公共 API

当前 reference CLI 能验证已知 ID 的单条流程，但正式导航仍缺少少量 read model。C0 先在 Core 以向后兼容方式补齐，CLI 不得用数据库查询或扫描文件绕过：

- `workspace.projects`：列出当前 Workspace 的 Project 摘要、最近更新时间和未决状态；
- `project.pending-actions`：返回当前合法行动和必须人工处理的 gate；
- `job.list`：按 Project、状态和更新时间分页；
- `artifact.export`：经 access policy 将指定 Artifact 导出到用户选择的位置，不能暴露 CAS 内部路径；
- service health/readiness 的公开 SDK 方法。

每个新增接口先进入 Core contracts、Application、Service 和 TypeScript/Python SDK，再由 CLI 使用。若 Core 尚未发布相应版本，CLI 显示 capability unavailable，不实现私有 fallback。

## 5. 运行模型

### 5.1 `rexplore` launcher

`rexplore` 不实现 REPL，只完成：

1. 读取 CLI 配置和命令行 flag；
2. 通过 discovery 连接用户本地 Core，必要时使用 SDK auto-start；
3. 完成 service/schema capability negotiation；
4. 检查 Pi 版本和 research extension；
5. 以固定 extension/package 参数启动 Pi；
6. 透传 Pi 原生 model/session/print/JSON 参数；
7. 将 Pi 退出码原样返回。

首版优先 spawn Pi 官方 CLI。只有需要嵌入测试时才使用 Pi SDK；不得为了 launcher 重建交互 UI。

### 5.2 状态归属

| 状态 | 真源 |
| --- | --- |
| 对话文本、分支、compaction | Pi session JSONL |
| Workspace/Project 当前选择 | Pi extension entry + CLI 配置中的最近选择 |
| ResearchAction、审批、事件 | Core Service |
| Job、日志、Artifact | Core Service / CAS |
| 模型 OAuth/API key | Pi auth /现有 secret provider |
| Service bearer token | Core discovery/secret provider |
| 插件安装与权限 | Core plugin API |

Extension 使用 `pi.appendEntry("research-context", ...)` 保存非敏感绑定，恢复 session 时重建。不得把 bearer token、OAuth token、confirmation token、SSH 私钥或 sealed 数据写入 Pi session。

### 5.3 双重模型调用控制

Pi 是 CLI 的交互模型；Core 仍可能为特定科研能力启动独立模型 session。每次 Core 模型调用必须作为显式 tool/action 展示，并进入核心预算账本。CLI 不得在一次普通聊天中隐式触发第二次模型调用。使用 `openai-codex` 时，两边调用都消耗同一 ChatGPT 计划额度，必须对用户可见。

## 6. 交互模式

### 6.1 Manual

- 普通输入直接进入 Pi 自由聊天。
- Pi 可调用只读 research tools。
- 状态变化 tool 在执行前展示行动、成本、权限和门禁；需要人工批准时调用 `ctx.ui.confirm`。
- Core 仍做最终校验，UI 确认不能替代 Kernel gate。

### 6.2 Candidate

Pi extension 使用官方 `input` event 处理交互输入：

1. extension 将输入发送给 Core `conversation.send`；
2. 若 Core 返回候选，使用 `ctx.ui.select` 展示候选；
3. 列表末尾固定提供：
   - `继续用原输入自由聊天`；
   - `输入其他行动`；
   - `取消`；
4. 选择候选后调用 `candidate.choose`；
5. 选择自由聊天时返回 `continue/transform`，让原生 Pi agent loop 处理；
6. extension 注入的输入必须按 `event.source` 跳过再次拦截，防止递归。

中途 steer/follow-up 不弹候选菜单，避免打断正在运行的 turn；它们继续使用 Pi 原生队列语义。

### 6.3 Auto

- 只启用 Core `ExecutionPolicy` 已允许的 bounded action；
- 每 turn 自动行动数、已知费用、模型调用、wall time 和 Job 预算均由 Core 限制；
- scope approval、候选冻结、confirmation、权限扩大和最终发布不可自动跨越；
- footer/status 显示 `AUTO`，并提供单键/命令立即切回 manual。

## 7. Pi Extension 设计

### 7.1 生命周期

- `session_start`：连接 Core、恢复 Project 绑定、显示状态 widget。
- `before_agent_start`：注入有界 Project snapshot、当前模式、未决门禁和可用 research tools；不注入完整事件或日志。
- `input`：仅在 candidate 模式拦截 interactive 输入。
- `tool_call`：保护 extension 自己的敏感/写操作；不能替代 Core 权限检查。
- `turn_start/turn_end`：更新 footer，不轮询数据库。
- `session_shutdown`：关闭 SSE、AbortController 和客户端资源。

所有 tool 输出有字符/条数上限；长日志使用分页 Query 或 Artifact，不塞入模型上下文。

### 7.2 首版 research tools

| Tool | 性质 | Core 调用 |
| --- | --- | --- |
| `research_context` | 只读 | capabilities + project.status |
| `research_events` | 只读、分页 | project.events |
| `research_converse` | 可能产生候选 | conversation.send |
| `research_choose_candidate` | 写入 | candidate.choose |
| `research_execute_action` | 写入 | action.execute |
| `research_job` | 只读/取消 | job.get、job.logs、job.cancel |
| `research_capability` | 显式科研调用 | capability.catalog/invoke |
| `research_plugins` | 搜索/检查 | plugin.search/inspect |

插件安装、SSH host approval、confirmation token 和发布相关操作首版只允许 slash command + 用户 UI，不作为模型可自由调用的 tool。

### 7.3 首版 slash commands

```text
/research-new
/research-open
/research-status
/research-mode manual|candidate|auto
/research-actions
/research-events
/research-jobs
/research-job <id>
/research-cancel <id>
/research-approve
/research-plugins
/research-plugin-inspect <id>
/research-plugin-install <id>
/research-ssh
/research-export
/research-doctor
```

命令名称初期使用 `research-` 前缀，避免与 Pi 和第三方 packages 冲突。稳定后可以增加短别名，但不能覆盖 Pi 内置命令。

### 7.4 显示

- title：当前 Project 简称；
- footer status：Core 状态、manual/candidate/auto、运行中 Job 数；
- widget：研究阶段、未决门禁、预算摘要；
- custom renderer：候选、ResearchAction、Job、Artifact、权限 diff；
- 普通模型文本和通用工具继续使用 Pi 原生 renderer。

## 8. 配置与认证

配置优先级：安全默认值 < 用户 CLI 配置 < Project 配置 < 本次启动的收紧 flag。

首版配置：

```yaml
core:
  dataDir: ~/.auto-research-agent/service
  autoStart: true
interaction:
  mode: manual
  candidateLimit: 5
  projectSnapshotMaxChars: 12000
stream:
  eventReconnectMs: 1000
  maxLogLines: 200
pi:
  versionRange: "1.0.x"
```

认证继续复用：

- Core token：ResearchClient discovery/SecretProvider；
- ChatGPT/Codex：Pi `/login` 和 `~/.pi/agent/auth.json`；
- 其他模型：Pi provider catalog、models.json 或环境变量；
- SSH：系统 OpenSSH config/agent/Keychain。

CLI 不提供粘贴、显示或导出 token 的命令。

## 9. 错误、离线与恢复

稳定分类：

- Core 未运行且 auto-start 失败；
- Core/schema/Pi 版本不兼容；
- Project 不存在或来自其他 Workspace；
- provider 未登录、额度耗尽或模型不可用；
- Job queued/running/failed/cancelled/worker_lost；
- SSH host quarantined、Worker missing；
- 插件权限扩大；
- event stream 断开。

网络/SSE 断开时，CLI 显示 degraded 并有界重连；不能把未知显示成成功。Pi session 恢复后必须重新从 Core 查询状态，不信任 session 中的旧 snapshot。退出 CLI 不取消 Core Job。

## 10. 阶段计划

每个阶段独立提交、验收并停下来总结。

### C0：Pi 复用尖峰与独立仓库

执行结果：**2026-10-04 通过**。详见 [`../reports/stages/c0-progress.md`](../reports/stages/c0-progress.md)。Core 公共接口由 Core 仓库独立演进，本阶段登记于 [`../core-api-gaps.md`](../core-api-gaps.md)，未在 CLI 仓库中实现私有替代。

- 创建 `research-explorer-cli` 独立仓库和 package。
- 固定 Pi 1.0.2 与 Core schema/service 兼容范围。
- 验证 extension load、command、tool、input event、before_agent_start、appendEntry、renderer、取消和 session resume。
- 记录 ADR，证明不需要自研 TUI/agent loop。
- 为正式导航补齐 `workspace.projects`、`project.pending-actions`、`job.list`、`artifact.export` 和 health SDK；先在 Core 独立提交并验收。

门禁：真实 Pi TUI 中 extension 可加载；package-only 安装可运行；无 Core internal import。

### C1：Launcher 与 Project 上下文

执行结果：**2026-10-04 通过**。详见 [`../reports/stages/c1-progress.md`](../reports/stages/c1-progress.md) 和 [ADR 002](../architecture/decisions/002-core-service-boundary.md)。

- `rexplore` launcher、Core auto-start/attach、doctor。
- `/research-new/open/status`。
- Project 绑定持久化和恢复。
- title/footer/widget。

门禁：Linux/macOS 创建和恢复 Project；Core 重启后状态一致；token 不进入 Pi session。

### C2：自由聊天、Candidate 与 Auto

- research tools、system snapshot 注入。
- manual/candidate/auto。
- candidate 的“继续自由聊天/其他行动/取消”。
- 强制审批 UI。

门禁：三种入口产生同一 Core ResearchAction；candidate 永远保留自由输入；不可绕过 scope/confirmation/release gate。

### C3：Job、事件与远程 Worker

- SSE 事件/日志、后台 Job、取消和恢复。
- Artifact 展示。
- SSH profile/Worker 配置向导。
- confirmation token 只通过临时隐藏输入传给 Core。

门禁：退出/restart CLI 后 Job 仍运行；取消、掉线、stale lease 正确；Mac→Linux 小任务可从 CLI 完成。

### C4：插件、Bundle 与项目管理

- 插件 search/inspect/install/enable/disable/update。
- 权限 diff 和显式确认。
- Project fork、Bundle export/import、依赖缺失展示。
- Pi package 与 Core research plugin 在 UI 中明确区分。

门禁：浏览插件不执行代码；权限扩大必须确认；导入不会恢复 SSH/OAuth/secret 环境。

### C5：产品验收与 v0.1

- 原生 Linux x64、macOS arm64/x64 CI。
- print/JSON 基础自动化模式；RPC 只做兼容 smoke，不作为首版内部架构。
- session/tree/fork/compaction 回归。
- package、license、secret、升级/回滚、离线和文档。

门禁：一个真实科研 Project 从创建到报告可完全经正式 CLI 驱动；CLI 只使用公开 Core API；Pi 原生聊天、模型登录、session 和 skills 不退化。

## 11. 测试矩阵

| 层 | 测试 |
| --- | --- |
| 单元 | 状态恢复、输入路由、候选 other 分支、输出截断、错误分类 |
| 契约 | 所有 tool/command 只使用 Core public schema |
| Pi 集成 | extension、command、input、renderer、session resume、interrupt |
| Core 集成 | action、审批、Job、plugin、SSH、Bundle |
| 原生平台 | Linux x64、macOS arm64/x64 |
| package-only | 干净目录安装 CLI + Core + Pi，禁止仓库源码依赖 |
| 安全 | token/session 泄露、恶意 tool 参数、权限扩大、prompt injection 边界 |
| 真实场景 | 低成本 exploration + confirmation + 报告 |

测试不得通过 snapshot 大面积锁定 Pi TUI 文本；应验证事件、Core 状态、tool 结果和稳定错误码。

## 12. 完成定义

CLI v0.1 只有在以下条件全部成立时完成：

1. 用户可以通过 Pi 原生自由聊天完成研究交互；
2. candidate 模式始终有自由输入；
3. manual/candidate/auto 共用 Core action 和门禁；
4. Project、Job、Artifact、插件和 SSH Worker 都可管理；
5. 重启后 Pi session 与 Core Project 正确恢复；
6. Linux/macOS 原生验收通过；
7. CLI 不接触 Core 内部模块或数据库；
8. 没有自研 TUI、复制 Pi agent loop 或 fork Pi；
9. 凭据、confirmation token 和 sealed data 不进入 session、日志或 Bundle；
10. 独立 package、文档、升级和回滚路径完整。

CLI 完成后再启动 Web 工作台；Web 可复用相同 Core SDK，但不依赖 CLI extension 内部代码。Pi RPC 可作为自动化或调试接口，不能成为 Web 与 Core 之间的长期私有协议。
