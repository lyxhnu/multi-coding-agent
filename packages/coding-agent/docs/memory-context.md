# 记忆与上下文

本页描述 `memory-context-integrity` 的运行行为。设计约束见 [Spec](specs/memory-context-integrity.md)，实际测试和未通过项见 [实施记录](specs/memory-context-integrity-report.md)。

## CLI 中查看结果

```text
/trace
/trace list
/trace 0
/compact
/shake
/memory flush 只保留长期项目约定
/memory undo mem-example
```

`/trace` 查看当前分支最近一轮，`list` 选择轮次，数字选择指定轮次；选中事件可查看只读 JSON 副本。它不是新的 bash 工具，也不要求启动 Web 界面。当前分支导出/恢复保留对应 trace，即使首次请求就在预算预检中被阻止。

重点查看以下事件：

| 事件 | 含义 |
| --- | --- |
| `context/budget` | 输入估算、有效 usage 锚点、输出预留、安全余量、模型窗口和判定 |
| `compaction/summary` | `prefix` 或 `commit` 阶段、来源指纹/覆盖范围、完成或丢弃、usage |
| `memory/archive` | 已提交压缩对应的笔记/flush/归档状态，批次与来源、数量和原因码 |
| `turn/end` | 运行结束原因；`context_limit` 不等于任务完成 |

交互 CLI 会报告尚未解决的 `context_limit`；文本和 JSON 单次运行返回退出码 `1`。RPC 先发送 `context_budget`、`agent_end`，可能进行有界压缩重试；收到 `agent_settled` 后，以 `get_state.data.runState.lastOutcome` 判断最终结果。`prompt` 的接受成功不能当作任务完成。完整契约见 [RPC](rpc.md#context_budget-and-context_limit) 和 [SDK](sdk.md#agent-and-agentstate)。

## 请求预算与压缩

最终检查在 transform、消息转换和 append-only 上下文构造之后、provider 调用之前。请求与可变消息/工具 schema 分离；首次输入、并行工具结果、steering 和 follow-up 都要经过检查。

```text
I + R + S <= W
R = min(请求输出上限或模型最大输出, 模型最大输出, 32768)
S = max(4096, ceil(R * 0.2))
```

`I` 包含 system、工具定义、消息和图片；同一安全余量供预检与底层输出裁剪共用。百分比阈值和 `reserveTokens` 是额外触发条件，不叠加成第二份安全余量。元数据不完整时，预算标记 `unknownFields`，不能据此宣称窗口安全。字符估算不是精确 tokenizer。

只有 model/provider、system、tools 和消息前缀指纹一致，历史 usage 才能用作锚点。新增内容在锚点后累计；shake、压缩、上下文改写或换模型后重新验证。

自动缩减沿用 shake、压缩和救援 shake 的有界流程，每次都重新预检。没有进展便停止，不重放原工具、不重复写入同一用户消息。正常完成的回答不会仅为了整理上下文而再跑一轮。

压缩必须先得到完整非空摘要，再校验当前来源和保留边界、提交 entry、重建上下文。空输出、`length`、error、abort、过期来源和无效扩展结果不提交。split-turn 即使没有新历史轮次，也保留旧摘要。没有新增内容时，`/compact` 报告 `Already compacted`，不调用模型或新增边界。

`compaction.twoPassEnabled` 默认关闭。启用后，在自动阈值前 10 个百分点预生成稳定前缀摘要，最多一个在途调用。有效 checkpoint 允许尾部增长；第二阶段只处理摘要与未覆盖部分。换分支、改前缀或换基础压缩边界使其失效。完成的 checkpoint 才能持久化，重启后再次校验。前缀 usage 在生成时计费，复用时不重复累计。

## history_get

这是模型可调用的只读工具，不是 slash command：

```json
{"entryId":"saved-entry-id","blockIndex":0,"offset":0,"limit":4000}
```

- 仅接受当前分支祖先链上的合法 shake 来源；包括之后被压缩移出工作上下文的 entry。
- 多个可读块必须指定 `blockIndex`；字符串内容的块位置为 `-1`。
- `offset`/`limit` 以 Unicode code point 计数，默认 4000、最大 8000，不拆开代理对；超限参数明确拒绝。
- 返回 JSON 文本页及 `details`：`entryId`、`blockIndex`、`unit`、`offset`、`end`、`total`、`nextOffset`、`savedContentOnly`。最后一页 `nextOffset` 为 `null`。
- 只读取实际保存的文本，不重跑工具，不读取原文件的新版本；保存前截掉的部分无法恢复，图片不能伪装成文本回读。
- 不读取兄弟分支、其他会话、trace 或任意文件路径；拒绝 `memory_get` / `memory_search` 的旧结果，必须重新查询当前记忆视图。

默认会话工具包含 `history_get`。显式 allowlist、denylist、`noTools`、Plan Mode 和子代理只读权限仍然生效；未提供或未获准时，新 shake 占位符不承诺可回读。回读结果仍受下一次请求预算限制，也不会解除原有 shake。

## 记忆安全、快照和归档

所有写入入口先执行相同安全规则。拒绝结果包含 `written`、`skipped`、`reasons`，例如 `secret_pattern`、`high_entropy_token`、`empty`；不回显被拒绝的值或其前缀。规则过滤不是“绝对无秘密”的保证。

读取、关键词召回、向量候选、文档 embedding 和正文提炼共享有效视图：解析 Markdown → 撤销检查 → 安全过滤。异步向量查询返回前再次检查候选。撤销 sidecar 损坏会报错，不按空撤销集合处理。构造视图不会重写原文件；撤销也不会物理擦除旧会话里的事实。

`memory.enabled` 继续控制成功压缩后的笔记与 autoDream；不自动激活记忆工具，也不新增会话结束触发器。`compaction.memoryFlushEnabled` 继续单独控制自动摘要写入项目记忆，但写入移到压缩提交之后。手动 `/memory flush` 不压缩当前上下文。自动入口都不写全局记忆。

每份笔记的稳定 ID 来自 `(sessionId, compactionId)`，与日期和会话改名无关。文件首行记录 `id`、`sessionId`、`compactionId`、`contentHash`、`storedHash`；同日多次压缩不会覆盖。相同来源重复写入受锁保护，内容冲突明确拒绝。

autoDream 沿用默认 24 小时间隔和至少 3 个不同未处理 sessionId 的门槛。只选择请求预算能容纳的完整笔记，不截断正文假装已处理。提炼无执行工具，笔记作为不可信数据输入，返回严格结构：

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
