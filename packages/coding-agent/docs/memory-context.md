# 记忆与上下文

自动容量管理使用稳定窗口和按需检索。设计契约见 [窗口记忆 Spec](specs/context-window-memory-proposal.md)。手动 [/compact](compaction.md) 和确定性 /shake 保持独立。

## 窗口与恢复

首次请求前持久化 windowId。换窗、分支和手动压缩建立新身份，并记录 previousWindowId。自动换窗后的首个请求只包含常规 system/tools 和不超过 512 个估算 token 的 bootstrap：窗口 ID、resume_ref、恢复指令。旧消息后缀、Todo 和 Note 正文不会自动注入。

模型先用 context_note query 解析 resumeRef，再从 history 读取有效任务要求、后续用户约束、Todo 或所需证据。Note 只记录语义变化；默认 query 返回元数据，item 指定 eventId 才读取正文和 freshness。旧成功结果不会自动成为当前状态证明。单次变更和 64 条活跃笔记受限，累计审计事件不设 256 条失效门槛。

new_context({reason}) 仅记录意图。当前 assistant 的整批工具调用和结果完成后，AgentSession 统一处理 model_requested、work_budget_reached、provider_context_rejected。待审批交互和运行中的后台任务会推迟提交。每个来源窗口最多提交一次，每个用户 prompt 最多换窗 8 次；同一请求幂等，实际目标请求必须缩小并满足工作预算。

## 最终请求预算

get_context_remaining 返回最近一次最终请求的 inputTokens、remainingInputTokens、remainingWorkTokens、测量位置和配置修订。未知值是 null，measurement 为 unknown。工具返回本身仍消耗上下文。

请求预检在 transform、消息转换和 append-only 构造之后、provider 调用之前执行。system、工具 schema、图片、整批工具结果和已交付队列都计入输入。usage 只有在模型及请求前缀指纹匹配时才作为估算锚点。

~~~text
输入 I + 输出预留 R + 安全余量 S <= 模型窗口 W
R = min(请求输出上限或模型上限, 模型上限, 32768)
S = max(4096, ceil(R * 0.2))
remainingWork = max(0, min(W * 阈值 - I, remainingInput) - 3072)
~~~

阈值由 compaction.autoCompactThresholdPercent 配置，默认 85%。工作预算用尽且仍有保存空间时，每个窗口和 promptGeneration 只建立一个持久化 save_state 操作；它最多使用 3 次 sampling、2048 个输出 token 和 3072 个查询/结果控制 token。保存阶段只开放 history、context_note、get_context_remaining 和 new_context，额度与次数从日志恢复，不因重启返还。完成的 continuation contract 在提交前还会对并发到达的用户约束、Todo、工具配置和来源 revision 重新验证。

rollover 提交前会用实际 transform、append-only 和完整业务工具定义预检整个恢复工作集。必读 Note、任务要求、History 引用和 Todo 正文无法与正常输出、安全余量及后续保存空间共同容纳时，返回 recovery_workset_too_large 并保留旧窗口。

compaction.enabled=false 关闭自动容量触发，最终容量检查仍然执行。显式工具 allowlist、deny、Plan Mode、子代理可见性均生效；缺少获准的 history/context_note 时不能提交不可恢复窗口。

## history

~~~json
{"operation":"list_windows"}
{"operation":"list_items","windowId":"window-uuid"}
{"operation":"read_item","entryId":"saved-id","blockIndex":0}
{"operation":"search","text":"literal text"}
~~~

所有操作共享当前分支中已向模型公开的投影。搜索只匹配字面文本，返回 entry/block/offset 和短片段。隐藏推理、未交付队列、兄弟分支、内部日志及历史 memory_get/memory_search、history/context_note 结果不进入语料。Todo 仅暴露公开投影；附件返回引用元数据，不展开二进制。

每页连同元数据和 cursor 最多 2048 估算 token，可用 budgetTokens 缩小。read_item 的 offset/end 使用 UTF-16，分页末尾不会拆开代理对。原始字符串 blockIndex=-1，多块内容需指定块。cursor 绑定会话、分支、窗口、查询和可见性版本。搜索扫描也受上限约束，零命中且 exhausted=false 时必须继续 cursor 才能判断整个范围无结果。

回读只返回 Session 保存的内容，不重跑工具、不读取源文件当前版本。当前窗口已返回的片段从工具结果推导并跳过；verify=true 可显式复核。Note 正文回读也按有效投影修订去重。

## 持久化与诊断

提交前校验恢复引用和 session/Todo/queue/progress/config/Note 修订；来源变化最多重试一次。持久化 rollover 后，使用预检得到的同一个 PreparedContinuation 续发。dispatch_started 与预留队列收据在发送前写入；完成后记录 finished。

已提交但未 started 的恢复必须重新得到相同请求指纹、预算和队列集合，才能发送一次。started 没有 finished 表示 outcome_unknown，禁止自动重放。完整的无末尾换行 JSONL 条目可继续追加；不完整的最后一条记录阻止自动恢复。此顺序保证针对进程崩溃；未使用 fsync，不承诺断电持久性。

/trace 可检查 context/budget、context/rollover、context/task_note、compaction/summary、memory/archive 和 turn/end。未解决的 context_limit 或 context_transition 表示任务尚未完成；print/JSON 模式返回退出码 1。SDK/RPC 应在 agent_settled 后检查 runState.lastOutcome 和 contextRolloverState，而非把 prompt 接受成功当作完成。

## 记忆安全、快照和归档

所有写入入口先执行相同安全规则。拒绝结果包含 `written`、`skipped`、`reasons`，例如 `secret_pattern`、`high_entropy_token`、`empty`；不回显被拒绝的值或其前缀。规则过滤不是“绝对无秘密”的保证。

读取、关键词召回、向量候选、文档 embedding 和正文提炼共享有效视图：解析 Markdown → 撤销检查 → 安全过滤。异步向量查询返回前再次检查候选。撤销 sidecar 损坏会报错，不按空撤销集合处理。构造视图不会重写原文件；撤销也不会物理擦除旧会话里的事实。

`memory.enabled` 控制手动压缩后的会话笔记及 Memory 工具注册，不自动激活工具。手动 `/memory flush` 不压缩当前上下文。自动换窗不生成摘要、不写入跨会话 Memory，也不触发自动提炼。

每份笔记的稳定 ID 来自 `(sessionId, compactionId)`，与日期和会话改名无关。文件首行记录 `id`、`sessionId`、`compactionId`、`contentHash`、`storedHash`；同日多次压缩不会覆盖。相同来源重复写入受锁保护，内容冲突明确拒绝。

MemoryStore 的显式 `maybeConsolidate` 接口使用默认 24 小时间隔和至少 3 个不同未处理 sessionId 的门槛。只选择请求预算能容纳的完整笔记，不截断正文假装已处理。提炼无执行工具，笔记作为不可信数据输入，返回严格结构：

```json
{"facts":[{"text":"项目约定","sourceNoteIds":["note-source-id"]}]}
```

未知字段、空文本、空来源、非本批来源、无效 JSON 或敏感事实均不提交。`facts: []` 是合法的 `processed_no_facts`，会推进水位但不生成空记忆。

项目排他锁覆盖资格检查、生成和提交。提交前再次验证来源正文和有效视图；稳定批次 ID、提交日志和幂等条目 ID 让“事实已写、水位未写”的重试收敛，不重复追加。锁竞争明确返回未运行；失败、取消或超时不伪报处理成功。

只有成功处理的笔记才能进行既有 30/180 天分层老化；老化保留来源身份和已处理水位。压缩成功与记忆归档失败分别记录，后者不回滚有效压缩。

## 接口和已有数据

- `writeSessionNote(cwd, slug, sessionId, content, compactionId)` 返回写入结果，调用方必须检查 `written`，不能把返回值当路径字符串。
- `maybeConsolidate` 的提炼器接收完整 `NoteSnapshot[]` 与 `AbortSignal`，返回经过校验的 `MemoryExtraction`。模型调用方提供整批输入预算判定。
- `.dream-state.json` 使用 `lastConsolidatedAt` 和 `processed: { [noteId]: contentHash }`；`.dream-commit.json` 是尚待收敛的提交日志。文件写入分别原子替换，不宣称跨文件原子事务。
- 不提供旧水位格式兼容层，不自动迁移或清理已有文件。旧格式水位会明确拒绝自动归档；无来源元数据的旧/人工笔记仍可通过有效视图读取，但不会冒充成功压缩快照参加自动归档。
- JSONL 原始消息不被 shake/compaction 改写。新增 trace 是 log-only，不推进逻辑叶子；不能用“文件最后一个 entry”替代“当前分支叶子”。

真实模型语义保留率、事实召回率和幻觉数量需要另行授权的固定数据集评估；本轮 faux 测试不证明这些质量指标。
