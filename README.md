# My Pi

这是一个基于 [Pi](https://pi.dev) 的 Coding Agent 工程化改造版本。项目重点不是增加更多提示词，而是补齐长任务中的状态管理、上下文控制、记忆可靠性、子代理协议、权限边界和可观测性。

## 我修改了哪些部分

### 1. 上下文预算与失败状态

- 在每次模型请求前统一计算输入、输出预留和安全余量，不再只依据历史 usage 判断是否超限。
- 对 system prompt、tool schema、消息前缀和模型配置生成 usage 指纹，失效 usage 会重新估算。
- 新增结构化 `context_limit` 结果和 `context_budget` 事件；CLI、RPC、SDK 与子代理不会把超限误报为完成。
- 模型因 `length` 截断且尚未产生工具调用时，注入恢复指令并逐级降低 thinking level，避免静默退出。
- 每轮工具调用后对最终 provider 请求执行容量守卫；工作预算用尽时先保存续跑状态，再提交唯一的自动换窗链路。

### 2. Shake、手动压缩与历史回读

- 增加零模型调用的 Shake：将超大的工具结果或文本块替换为带来源的占位符，并把变更持久化到会话日志。
- 修复 split-turn、重复压缩和空摘要场景中的摘要继承问题；无效、截断、取消或空摘要不会提交。
- 自动容量管理不再依赖压缩 checkpoint；显式 `/compact` 仍作为独立的摘要操作。
- 增加统一的只读 `history` 工具，按分支可见性发现、搜索和分页读取消息、完整工具结果与 Todo revision，不重新执行原工具。
- 增加 Append-Only Context 与 StablePrefix，减少无效的上下文重建和 provider prompt cache 失效。

### 3. 记忆系统

- 增加全局记忆、项目记忆、会话笔记、搜索、读取、撤销和手动/自动 flush。
- 所有写入入口共用 secret filter，拒绝疑似密钥和高熵 token；错误与 trace 不回显敏感原文。
- 读取、搜索、embedding 和归档统一使用有效记忆视图，tombstone 在重启和异步检索期间仍然生效。
- 支持向量检索、词法降级、MMR 去重以及 global/project/session 三层记忆。
- 压缩完成后保存带来源和哈希的会话快照；自动归档读取笔记正文，使用锁、提交日志和水位保证并发与故障恢复下的幂等性。

### 4. Agent 状态机与 Subagent

- 强化运行状态：空闲、模型调用、工具执行、压缩、失败和 `context_limit` 能被 CLI/RPC 明确区分。
- 子代理通过结构化提交协议返回结果；未提交、提交格式错误、超限或异常不会被父代理当作成功。
- 支持 `general-purpose`、`explore`、`plan` 子代理，以及前后台运行、轮询、取消、resume、深度限制和能力裁剪。
- 修复前台子代理完成后定时器未释放的问题，避免 Node 进程继续挂起。

### 5. 权限、沙箱与工具执行

- 增加 per-tool 权限策略、allow/deny 规则、审批状态和 JSONL 审计。
- 修复 shell 命令分析中的重定向、前置环境变量、版本化命令、交叉工具链和命令名前缀碰撞问题。
- Plan Mode 使用只读工具集；子代理按能力模式继承对应权限。
- 支持 macOS `sandbox-exec` 和 Linux `bubblewrap` 的 OS 级沙箱配置。应用层权限守卫本身不等同于系统沙箱。
- 增加 Todo/Plan 状态持久化、LSP 崩溃重启、MCP 工具发现，以及 print mode 失败退出码修复。

### 6. Trace 与 CLI 可观测性

- 会话以 append-only JSONL 保存消息、工具结果、Shake、压缩、记忆归档、预算决策和最终状态。
- 内置 `/trace`、`/trace list`、`/trace <index>`，可以在 CLI 内查看当前会话的执行链。
- `/shake` 用于手动缩减上下文，`/memory` 用于检查、flush 和撤销记忆。
- RPC 暴露结构化 run state、预算事件和最终 outcome，便于接入评测或外部控制器。

### 7. 评测与回归

- 增加 faux provider 测试设施，覆盖工具调用、并发结果、会话恢复、压缩、记忆和子代理，不依赖真实 API。
- 增加 Terminal-Bench/Harbor 评测适配、trace 分析、上下文峰值和静默失败检查。
- 记忆与上下文改动使用 faux provider 做确定性回归；当前准确结果见窗口 Spec 的验收记录。

完整改造说明见：

- [Pi-Agent 改造技术文档](PI_AGENT_CHANGES.md)
- [记忆与上下文使用说明](packages/coding-agent/docs/memory-context.md)
- [上下文窗口管理 Spec](packages/coding-agent/docs/specs/context-window-memory-proposal.md)
- [记忆与上下文完整性 Spec](packages/coding-agent/docs/specs/memory-context-integrity.md)
- [实施与测试记录](packages/coding-agent/docs/specs/memory-context-integrity-report.md)

## 项目结构

| 包 | 作用 |
| --- | --- |
| [`packages/ai`](packages/ai) | 多 provider 模型接口、usage 与上下文预算 |
| [`packages/agent`](packages/agent) | Agent 循环、工具调用、状态机和上下文处理 |
| [`packages/coding-agent`](packages/coding-agent) | Coding Agent CLI、会话、压缩、记忆、权限和子代理 |
| [`packages/tui`](packages/tui) | 终端 UI 与增量渲染 |
| [`eval`](eval) | 评测适配、任务和结果分析代码 |

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install --ignore-scripts
npm run check
./test.sh
./pi-test.sh
```

Windows PowerShell 可使用：

```powershell
.\pi-test.ps1
```

常用 CLI 命令：

```text
/trace
/trace list
/trace 0
/shake
/memory
```

## 上游与许可

本项目基于 Pi 的 monorepo 继续开发，保留原项目的包划分和 MIT License。上游文档与版本发布信息以 [pi.dev](https://pi.dev) 为准。
