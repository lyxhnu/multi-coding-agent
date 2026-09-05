# Task Note Projection 与 Context Rollover 集成 Spec

| 项目 | 内容 |
| --- | --- |
| Spec ID | `task-note-projection` |
| 状态 | Draft |
| 日期 | 2026-09-04 |
| 适用范围 | `packages/coding-agent` |
| 前置能力 | SessionManager、TodoStateStore、ContextProgress、Context Maintenance、Context Rollover、PreparedContinuation、history_get |
| 需求来源 | 长任务跨 Context Epoch 执行时，关键语义不能只依赖 Active Suffix 或单次 Checkpoint |

本文中的“必须”“不得”是实现和验收约束。接口片段描述目标契约，不表示当前代码已存在同名导出。

本 Spec 扩展 [Context Rollover Spec](./context-rollover.md)，不改变其 Context Maintenance 顺序、PreparedContinuation、原子提交、dispatch journal、Strong Progress 和 crash fail-closed 语义。

## 1. 决策摘要

Task Note 不是任务真相、第二个 TodoState 或第二份 Handoff。模型只产生带来源的 Task Note candidate；系统验证后将其作为 append-only Session event 持久化；TaskNoteProjection 在当前 Session 分支和当前任务作用域上确定性折叠有效 event。

完整层级为：

```text
原始 user/tool entry + TodoState + PendingDelivery + ContextProgress
                              │
                              ▼
                         权威事实层
                              │
                  经验证的 TaskNoteEvent
                              │
                              ▼
                     TaskNoteProjection
                         派生语义索引
                              │
                Checkpoint + Active Suffix
                              │
                              ▼
                       HandoffAssembler
                              │
                              ▼
                        唯一 Handoff
                              │
                              ▼
                    PreparedContinuation
                         唯一发送对象
```

核心规则：

- 原始 Session entry、TodoState、PendingDelivery 和 ContextProgress 是权威事实；
- TaskNoteProjection 只负责索引和恢复提示，不能覆盖权威事实；
- Checkpoint 是一个 Context Epoch 前缀的结构化快照；
- Handoff 是唯一注入新 Context Epoch 的任务状态；
- Task Note、Checkpoint 或 Handoff 都不能授予权限、确认交互或证明业务副作用；
- Context Epoch 是 Note 的创建来源，不是默认有效作用域；
- 最终预算只对真实 PreparedContinuation 计算；
- 跨进程恢复保持 dispatch at-most-once，不声称 exactly-once。

## 2. 第一性原理

```text
事实正确性   = 权威 entry + 可验证 evidence
语义可发现性 = TaskNoteProjection
epoch 连续性 = Checkpoint + Active Suffix
执行连续性   = PreparedContinuation + PendingDelivery + dispatch journal
历史完整性   = 原 Session JSONL + 精确 history allowlist
安全连续性   = 不扩大指令优先级、权限和用户授权
```

Task Note 解决的是“重要语义在长上下文中难以再次发现”，不是“缺少事实存储”。因此 Note 可以被重建、失效或忽略，但不得成为完成状态、Todo、队列、权限或外部副作用的权威来源。

系统可以确定性证明 Handoff 的结构、来源、证据、可取回性、覆盖和预算满足约束；系统不能证明模型没有遗漏一条从未被识别的隐含语义。Coverage Sweep 是降低遗漏概率的模型步骤，不是绝对语义完整性证明。

## 3. 目标

- 在正常执行期间，以低频 append-only event 记录关键语义变化。
- 在 Checkpoint Prefire 中使用一次模型输出同时生成 Checkpoint 和 Note update candidates。
- 从 Session 当前分支确定性重建 TaskNoteProjection，支持 resume 和 fork。
- 让有效 Note 跨 Context Epoch 存活，同时避免跨任务和兄弟分支泄漏。
- 对 constraint、decision、state、failed attempt 和 next action 建立明确来源及证据规则。
- 在 Handoff 组装时重新验证 evidence freshness，并显式表达 stale 状态。
- 只校验和注入最终 Handoff，不注入 Ledger、Checkpoint 和 Handoff 三份重复正文。
- 复用现有 PreparedContinuation、revision CAS、PendingDelivery 和 dispatch journal。
- 为 Note 数量、正文、引用和 Handoff token 建立固定上限。
- 让 Note 写入、Projection、Checkpoint batch、Handoff 和 crash 语义可通过模块接口测试。

## 4. 非目标

- 不创建新的 Memory 系统、用户画像或跨 Session 知识库。
- 不把 objective、acceptance criteria、completed work、Todo 或 Task 终态改成 TaskNoteKind。
- 不让模型直接声明 evidence fingerprint、完成状态或授权状态。
- 不从 Note 恢复完整旧历史、完整工具结果或完整 Memory。
- 不使用整个 workspace fingerprint 作为所有 evidence 的统一 freshness 判据。
- 不以 Context Epoch 数字自动判断业务状态过期。
- 不让 Note 写入获得 Strong Progress credit。
- 不新增绕过 Context Rollover 门禁的手动 continuation 路径。
- 不在多个 JSONL entry 之间模拟 Checkpoint 与 Note batch 的原子提交。
- 不承诺识别所有自然语言同义 key 或所有隐含语义冲突。
- 第一版不定义跨多个显式顶层 user prompt 的逻辑任务生命周期。

## 5. 术语与作用域

### 5.1 Task Scope

第一版一个顶层 user prompt 建立一个 Task Scope。其稳定 ID 由启动当前 promptGeneration 的 user entry ID 派生：

```text
taskScopeId = sha256("task-note-scope-v1" + rootUserEntryId)
```

steering、follow-up 和同一 Agent run 内的 custom-user message 不创建新 Task Scope。新的显式顶层 user prompt 创建新的 promptGeneration 和新的 Task Scope。

`taskScopeId` 不得复用 TaskManager 的后台 `taskId`。若未来需要跨多个顶层 prompt 的逻辑任务，必须先定义独立、持久化、用户可观察的任务生命周期；不得通过文本相似度推断两个 prompt 属于同一任务。

### 5.2 Branch Visibility

Task Note 不保存可变的 `branchId` 作为可见性判断。一个 event 仅在以下条件同时成立时可见：

- event 所在 Session entry 是当前 leaf 的祖先或当前 leaf；
- event.scope.taskScopeId 等于当前 Task Scope；
- event.scope.promptGeneration 等于当前 promptGeneration；
- event 未被同一可见分支上的后继 event supersede 或 retract。

因此：

- 从 Note 之后 fork 的分支继承该 Note；
- 从 Note 之前 fork 的分支不继承该 Note；
- 兄弟分支的后续 Note 互不可见；
- resume 只扫描恢复后当前分支。

### 5.3 Context Epoch

`createdInContextEpoch` 只记录 event 产生时的上下文来源。Rollover 后 Context Epoch 增加，不会使有效 Note 自动失效。

不得使用通用 `validThroughEpoch`。临时 state 和 next_action 通过明确 supersede、retract、Todo/Task 转换、消费记录或 evidence freshness 失效。只有纯粹描述某个 epoch 内部机制的 Note 才可以显式使用 `lifetime: "epoch"`；第一版模型工具不开放该字段。

### 5.4 TaskNoteCandidate

模型提出的语义更新请求。Candidate 不是持久化事实，不能直接进入 Projection 或 Handoff。系统必须补齐作用域、event ID、创建 epoch 和 evidence stamp，并在持久化前完成校验。

### 5.5 TaskNoteEvent

经系统校验后持久化的 append-only 派生事件。Event 可以 upsert 或 retract 某个稳定 Note identity，不原地修改旧 entry。

### 5.6 TaskNoteProjection

当前 Session 分支、Task Scope 和 promptGeneration 上全部有效 TaskNoteEvent 的确定性折叠结果。Projection 是可重建视图，不单独持久化快照，不拥有另一份可变内存真源。

### 5.7 Evidence Freshness

一个 evidence claim 在被观测时为真，不代表当前仍为真。Freshness adapter 使用 subject-specific input fingerprint 判断目标输入是否仍与观测时一致。

### 5.8 Coverage Sweep

Checkpoint Prefire 中模型针对不可变覆盖前缀和当前 Projection 执行的查漏步骤。它输出 Note update candidates，与 Checkpoint 使用同一次模型调用、同一个严格输出 schema 和单个持久化 entry。

## 6. 权威来源矩阵

| Handoff 语义 | 权威来源 | Task Note 的作用 |
| --- | --- | --- |
| Objective | 启动 Task Scope 的原始 user entry，以及同一 scope 中明确修改目标的最新 user-provenance entry | 可以索引相关约束或决策，不直接提供 objective |
| User constraints | 真实 user 或带 user provenance 的 custom-user entry | 索引、规范化和指出 supersession |
| Acceptance criteria | 用户明确要求，或已有持久化 Task contract | 不能创建新的验收标准 |
| Confirmed decisions | 被引用的 user/assistant decision entry；实验型决策同时要求 evidence | 索引当前有效决策 |
| Completed work | Todo/Task 终态、成功 effect 和后置验证 evidence | 只能帮助定位，不得声明完成 |
| Current state | 最新有效 tool/Task/artifact evidence | 提供语义标签并标记 fresh/stale |
| Failed attempts | 真实失败结果及其策略含义 | 保存历史策略索引 |
| Active Todo | 当前分支最新 TodoState | 不得复制或覆盖 Todo |
| Next action | 最新用户要求和 Active Todo；没有两者时才使用有效 next_action Note | 提供建议性索引 |
| Pending messages | PendingDeliveryStore | 不进入 Note 或 Handoff 正文 |
| Strong Progress | ContextProgress ledger | Note 写入永不产生或消费 credit |

TodoState 的 `content/status/priority` 本身不自动构成 acceptance criteria。没有用户明确要求或持久化 Task contract 时，Handoff 必须表示 `acceptanceCriteria.status = "not_specified"`，不得生成看似权威的验收标准。

任何 Note 与权威来源冲突时，以权威来源为准。冲突无法安全合并时返回 `blocked(handoff_invalid)`，不得静默选择 Note。

## 7. 数据协议

### 7.1 引用

```ts
export interface TaskNoteReference {
  entryId: string;
  blockIndex?: number;
}
```

多文本块 entry 必须指定 `blockIndex`。引用只标识 Session 中已经保存的内容，不授予 history_get 权限；最终 history allowlist 只能从实际进入 Handoff 的 claim 引用规范化派生。

### 7.2 Candidate

```ts
export type TaskNoteKind =
  | "constraint"
  | "decision"
  | "state"
  | "next_action"
  | "failed_attempt";

export type TaskNoteCandidate =
  | {
      operation: "upsert";
      kind: TaskNoteKind;
      key: string;
      text: string;
      sourceRefs: TaskNoteReference[];
      evidenceRefs: TaskNoteReference[];
      supersedesEventId?: string;
    }
  | {
      operation: "retract";
      kind: TaskNoteKind;
      key: string;
      sourceRefs: TaskNoteReference[];
      supersedesEventId: string;
    };
```

模型只能提供 Candidate 字段。它不能提供 scope、eventId、createdInContextEpoch、fingerprint、freshness 或权威状态。

`key` 必须匹配：

```text
^[a-z0-9][a-z0-9._/-]{0,95}$
```

Note identity 为 `(taskScopeId, promptGeneration, kind, key)`。Key 由模型选择，但更新已有 identity 时必须引用当前 active event 的 `supersedesEventId`。系统不通过大小写、相似度或自然语言推断两个不同 key 是同一事实。

### 7.3 Evidence Stamp

```ts
export interface TaskNoteEvidenceStamp {
  reference: TaskNoteReference;
  evidenceKind:
    | "user_confirmation"
    | "workspace_state"
    | "process_result"
    | "task_terminal"
    | "external_readback";
  subjectId: string;
  inputFingerprint: string;
  resultFingerprint: string;
  observedAtEntryId: string;
  outcome: "succeeded" | "failed";
}
```

Evidence Stamp 必须由系统根据 Session entry、ContextProgress 和对应 adapter 生成。模型提供的同名文本或 details 字段不能作为 stamp。

`subjectId` 标识被验证对象；`inputFingerprint` 只覆盖决定该 claim 是否仍有效的输入，不使用整个 workspace 的统一哈希。不同 evidence adapter 可以包含：

- workspace state：规范化目标路径、目标内容 fingerprint、相关配置 fingerprint；
- process result：规范化命令、工作目录、相关输入 fingerprint 和退出状态；
- Task terminal：Task ID、terminal result fingerprint 和终态；
- external read-back：工具 adapter、稳定目标 ID、读取结果 fingerprint；
- user confirmation：user entry ID 和确认对象。

无法稳定标识 subject 或 input 的结果可以作为历史来源，但 freshness 必须为 `unknown`，不得支持“当前已通过”“当前已完成”之类 claim。

### 7.4 Persisted Event

正常执行中的单条 Note 使用 `customType="task-note-event"` 保存：

```ts
export interface TaskNoteEvent {
  version: 1;
  eventId: string;
  scope: {
    taskScopeId: string;
    promptGeneration: number;
  };
  createdInContextEpoch: number;
  operation: "upsert" | "retract";
  kind: TaskNoteKind;
  key: string;
  text?: string;
  sourceRefs: TaskNoteReference[];
  evidence: TaskNoteEvidenceStamp[];
  supersedesEventId?: string;
  source:
    | {
        type: "model_tool";
        toolCallId: string;
      }
    | {
        type: "checkpoint";
        checkpointId: string;
        candidateIndex: number;
      };
}
```

`eventId` 必须由稳定 source ID 和规范化 Candidate 生成，不使用 wall-clock：

```text
eventId = sha256(
  "task-note-event-v1"
  + taskScopeId
  + source.type
  + source.toolCallId
  + canonicalCandidate
)
```

重复提交相同 eventId 不追加第二条 entry；相同 eventId 对应不同 canonical payload 时判定为持久化冲突。

### 7.5 Checkpoint Batch

Checkpoint Prefire 不逐条调用 `context_note`。模型一次输出：

```ts
export interface ContextRolloverCheckpointOutput {
  checkpoint: ContextRolloverNote;
  noteUpdateCandidates: TaskNoteCandidate[];
}
```

系统验证并规范化为：

```ts
export interface TaskNoteBatch {
  version: 1;
  batchId: string;
  events: TaskNoteEvent[];
}

export interface ContextRolloverCheckpointEnvelope {
  version: 1;
  checkpoint: ContextRolloverCheckpoint;
  taskNoteBatch: TaskNoteBatch;
}
```

`ContextRolloverCheckpointEnvelope` 必须作为单个 `context-rollover-checkpoint` custom entry 同步追加。不得先写 Note events 再写 Checkpoint，也不得先写 Checkpoint 再补 Note events。

既有 two-pass compaction 复用所需的 prefix identity、summary 和 usage 必须写入 `checkpoint.compactionPrefix`，与语义 Checkpoint 和 TaskNoteBatch 在同一个 Envelope 中原子提交。不得追加独立的 `two-pass-prefire` entry。

Batch event ID 使用 `checkpointId + candidateIndex + canonicalCandidate` 生成。Projection 折叠所有已提交 Checkpoint Envelope 中的 batch，不只折叠当前被选中的最新 Checkpoint。

Checkpoint 或任一 Candidate 校验失败时，整个 Envelope 无效且不持久化正文。不得只丢弃无效 Candidate 后提交剩余内容。

## 8. 模块与接口

### 8.1 Seam

外部 seam 仍然是现有 Context Rollover 模块。新增包内支持模块：

```text
packages/coding-agent/src/core/task-note-projection.ts
packages/coding-agent/src/core/tools/context-note.ts
```

不得从包顶层导出通用 `ContextNoteStore` port。当前只有 SessionManager 这一种持久化 adapter；引入公共 Store interface 只会把 scope、branch ancestry、evidence 和 revision 规则扩散给调用方。

`task-note-projection.ts` 提供包内深模块接口：

```ts
export interface TaskNoteProjectionSnapshot {
  scope: {
    taskScopeId: string;
    promptGeneration: number;
  };
  revision: string;
  items: ReadonlyArray<{
    eventId: string;
    kind: TaskNoteKind;
    key: string;
    text: string;
    sourceRefs: readonly TaskNoteReference[];
    evidence: readonly TaskNoteEvidenceStamp[];
    freshness: "fresh" | "stale" | "unknown" | "not_applicable";
  }>;
}

export function acceptTaskNoteCandidate(
  candidate: TaskNoteCandidate,
  context: TaskNoteAcceptanceContext,
): TaskNoteAcceptanceResult;

export function buildTaskNoteProjection(
  input: TaskNoteProjectionInput,
): TaskNoteProjectionResult;
```

接口返回值必须包含明确失败原因；不得在验证失败时静默忽略 Candidate 或部分引用。

### 8.2 Projection Revision

Projection revision 对以下规范化内容计算：

```text
scope
+ 当前分支上参与折叠的 eventId 顺序
+ active identity -> eventId 映射
+ 每项 freshness 状态和当前 input fingerprint
```

Projection revision 用于诊断和 Handoff source fingerprint。它不是独立权威 CAS。因为所有 TaskNoteEvent 和 Checkpoint Envelope 都是 Session entry，提交前的 `sessionLeafId` CAS 已覆盖并发 Note append；新增 Note 导致第一次 proposal superseded，并按现有规则最多重新组装一次。

由 Agent 观察到的 freshness 变化必须先产生对应 Session/ContextProgress entry，因此也会改变 session 或 progress revision。Session 外部的并发修改无法由该 CAS 锁定；Handoff 只能表达“在 fingerprint X 上已观测”，并要求执行副作用前按现有规则读取目标当前状态。

## 9. Candidate 验证

### 9.1 通用规则

每个 Candidate 必须通过：

- TypeBox strict schema；
- scope 与当前 Task Scope 一致；
- key、正文和引用数量上限；
- source/evidence entry 存在且位于当前分支祖先；
- source/evidence entry 位于当前允许覆盖前缀、Active Suffix 或上一 Handoff provenance closure；
- 多块引用的 blockIndex 合法；
- Secret 和敏感凭据检查；
- 不包含系统提示词、工具定义、权限扩大、未决授权或 Pending Delivery 正文；
- supersedesEventId 与当前 active identity 精确匹配；
- upsert 已有 identity 时必须 supersede，retract 必须指向当前 active event；
- evidence 类型、结果和 claim kind 匹配。

### 9.2 Kind 规则

| Kind | Source | Evidence | Freshness |
| --- | --- | --- | --- |
| constraint | 至少一个真实 user 或 user-provenance entry | 通常为空 | 由后续 user supersede/retract，不按 epoch 过期 |
| decision | 至少一个真实 decision 来源；实验决策必须引用实验 evidence | 可选或必需，取决于 claim | 证据型决策随 evidence 标记 fresh/stale |
| state | 必须有能支持该状态的真实 evidence | 必需 | 必须计算 fresh/stale/unknown |
| failed_attempt | 必须引用真实失败结果，不能仅引用模型解释 | 必需且 outcome=failed | 历史失败事实不失效；“当前仍失败”需新 evidence |
| next_action | Agent 计划允许无强 evidence，但必须有当前执行来源 | 可选 | Todo、用户方向或目标 fingerprint 变化时 supersede/retract |

以下 Candidate 必须拒绝：

- `state:test = passed` 引用非零退出命令；
- constraint 只引用 assistant 文本；
- completed、authorized、approved 等事实只引用 Note、Checkpoint、Compaction 或 Rollover entry；
- next_action 试图确认 PendingInteraction 或授予工具权限；
- failed_attempt 没有真实失败结果；
- 模型提供的 fingerprint 与系统解析结果不一致；
- 引用不在当前 branch ancestry 或超出 provenance closure。

### 9.3 限额

第一版使用固定上限：

```text
MAX_TASK_NOTE_EVENTS_PER_SCOPE = 256
MAX_ACTIVE_TASK_NOTES = 64
MAX_CHECKPOINT_NOTE_CANDIDATES = 16
MAX_TASK_NOTE_TEXT_CHARS = 2000
MAX_TASK_NOTE_SOURCE_REFS = 8
MAX_TASK_NOTE_EVIDENCE_REFS = 8
```

达到上限时 `context_note` 返回明确 `note_limit`，不追加 entry。Checkpoint batch 超限时整个 Checkpoint output 为 `invalid_output`。不得截断正文、引用、Candidate 或 Projection。

TaskNoteProjection 不单独获得 Handoff token 额度。最终进入 Handoff 的所有 Note 派生正文与 Checkpoint 正文共同受 Context Rollover 的 10% Handoff/Checkpoint Note 上限约束。

## 10. Projection 折叠规则

Projection 构造必须是纯确定性过程：

1. 从 SessionManager 取得当前 branch path；
2. 读取 `task-note-event` 和所有 `context-rollover-checkpoint` Envelope 中的 TaskNoteBatch；
3. 严格验证持久化 schema、scope、eventId 和 batchId；
4. 只保留当前 Task Scope 可见 event；
5. 按 Session entry 顺序和 batch 内 index 排序；
6. 以 `(kind, key)` 建立 identity；
7. create 只能用于不存在 active event 的 identity；
8. update/retract 必须精确 supersede 当前 active event；
9. retract 后 identity 不进入 active items；
10. 对 active item 重新计算 freshness；
11. 生成 canonical snapshot 和 revision。

发现格式损坏、重复 ID 不同 payload、断裂 supersedes chain 或非法 scope 时返回 `projection_invalid`，不得静默跳过并继续 Rollover。没有任何 TaskNoteEvent 是合法的空 Projection。

Projection 不做自然语言合并。两个不同 key 即使文本相似也保留为不同 identity；如果它们使最终 Handoff 无法形成一致陈述，Handoff validation 必须失败，而不是猜测模型意图。

## 11. 正常执行中的 context_note

### 11.1 触发条件

只有发生以下语义变化时模型才应调用 `context_note`：

- 用户新增、修改或撤销约束；
- 技术或业务决策正式确定或撤回；
- 工具或 Task evidence 验证了对后续执行重要的状态；
- 一次真实失败改变后续策略；
- 当前执行方向或唯一下一动作发生明显变化。

普通过程不得记录：

- 读取文件、搜索文本或查看代码；
- 尚未验证的推测；
- 普通 terminal 输出；
- 已由 TodoState 完整表达的逐项状态；
- 已由 PendingDelivery 保存的消息；
- 只为增加 Rollover 资格而产生的文本变化。

判断规则：

```text
如果该语义在几十轮后不可见，会不会改变继续执行的正确方向？
是 -> 提交 Candidate
否 -> 不记录
```

### 11.2 Tool 语义

`context_note` 是 session-scoped metadata write，不是业务副作用工具。执行流程：

```text
model tool call
  -> 校验 Candidate
  -> 系统解析 evidence stamp
  -> 同步 appendCustomEntry("task-note-event", event)
  -> 返回最小 NoteReceipt
```

```ts
export interface TaskNoteReceipt {
  eventId: string;
  operation: "upsert" | "retract";
  kind: TaskNoteKind;
  key: string;
}
```

工具结果不得回显 Note 正文、原始 evidence 或凭据。append 失败时工具调用失败，不更新任何内存 Projection。

当 `context_note` active 时，每次普通 provider request 都附加一个有界、metadata-only 的 Task Note reference catalog，使模型能够取得 `sourceRefs` 和 `evidenceRefs` 所需的持久化 `entryId`。目录只包含 entry 类型、role、工具调用坐标和 evidence 分类等定位信息，不包含消息正文、工具结果正文、fingerprint 或凭据；它不写入 Session、不参与权威性判定，本身也不能被引用。目录内容及顺序必须由当前分支确定性生成，以保证 PreparedContinuation crash recovery 的 request fingerprint 可复现。工具不 active 时不得附加该目录。

该工具：

- 默认注册到 Coding Agent 的 session-bound tools；
- 只有在 active tool 集合包含它时才向模型提示主动记录规则；
- 显式 tools allowlist 未包含时不得绕过限制；
- 可以在 Plan Mode 使用，因为它不修改业务目标；
- 子代理只写自己的 Session，不能直接写父 Session 的 Projection；
- 不生成 `non_read_effect`、verification 或 Strong Progress credit；
- custom event 本身不进入 LLM context，也不进入 Context Maintenance source fingerprint；
- 对应 assistant tool call/result 仍按普通 Tool Transaction 进入 Session context。

## 12. Checkpoint Prefire 与 Coverage Sweep

Checkpoint Prefire 继续使用 Context Rollover Spec 的阈值、共享后台总结槽、操作额度、不可变前缀和 Tool Transaction 规则。

单次模型输入包含：

- 不可变 Checkpoint 覆盖前缀；
- 当前 TaskNoteProjection；
- Checkpoint 输出 schema；
- Note Candidate 输出 schema；
- 当前 Todo 仅用于理解，模型仍不得复制或改写 TodoState；
- 允许引用的前缀和 provenance closure。

模型执行：

```text
覆盖前缀 + 当前 Projection
        │
        ├─ 生成 ContextRolloverNote
        │
        └─ 检查即将离开上下文但 Projection 未索引的重要语义
                    │
                    └─ 生成 0..16 个 Note update candidates
```

系统随后：

1. 校验 Checkpoint schema、evidence、Secret、大小和完整 Tool Transaction；
2. 校验全部 Note candidates；
3. 为 Candidate 生成 evidence stamp 和稳定 eventId；
4. 验证 supersedes chain 在同一 batch 内和当前 Projection 上连续；
5. 确认覆盖前缀、Todo、request config 和 Task Scope 未变化；
6. 将 Checkpoint 与 TaskNoteBatch 作为单个 Envelope append。

模型调用失败、超时、输出无效、任一 Candidate 无效或来源变化时，不写 Envelope，且 Checkpoint operation 额度不返还。不得在 Maintenance blocked 后为 Coverage Sweep 新开模型请求。

Coverage Sweep 不能声明“已经发现全部重要语义”。其可验收结果是：输出符合 schema，所有 claim 有合法来源，系统最终 Handoff 门禁通过。

## 13. Handoff 组装

### 13.1 输入

HandoffAssembler 读取同一 revision proposal 下的：

```text
当前权威 user/tool/Task evidence
+ 当前 TodoState
+ 当前 PendingDelivery revision
+ 当前 ContextProgress revision
+ 当前 TaskNoteProjection
+ 当前有效 Checkpoint
+ 当前 Active Suffix
+ 当前 request config
```

TaskNoteProjection 不以独立消息注入。Checkpoint 原文也不直接注入。Assembler 只生成一份最终 ContextRolloverNote/Handoff。

### 13.2 Acceptance Criteria

ContextRolloverNote 增加：

```ts
export interface ContextRolloverAcceptanceCriteria {
  status: "specified" | "not_specified";
  items: Array<{
    text: string;
    sourceEntryIds: string[];
    taskContractIds: string[];
  }>;
}
```

规则：

- `specified` 时至少一项，且每项必须有 user source 或持久化 Task contract；
- `not_specified` 时 items 必须为空；
- Todo content 不能自动提升为 acceptance criterion；
- Task Note 不能新增或修改 acceptance criterion。

### 13.3 确定性优先级

| 字段 | 合并规则 |
| --- | --- |
| objective | 当前 Task Scope 的最新明确用户目标；Checkpoint 只提供带来源的结构化表达 |
| userConstraints | 最新 user provenance 优先；Projection 只索引有效 revision；冲突无法解析则 handoff_invalid |
| acceptanceCriteria | 只来自用户或 Task contract |
| decisions | 当前有效 decision Note 与 Checkpoint 合并，以明确 supersession 和最新合法来源排序 |
| completedWork | 只接受满足现有完成 evidence 规则的 claim；Note 不产生完成项 |
| currentState | fresh state claim 可作为当前状态；stale/unknown 必须明确降级表述 |
| failedAttempts | 按 identity 和 evidence 去重；只陈述历史失败，不自动推断当前仍失败 |
| activeTodos | 始终来自提交时最新 TodoState，忽略 Note 和 Checkpoint 副本 |
| nextAction | 最新用户要求 / Active Todo > fresh next_action Note > Checkpoint nextAction |
| historyRefs | 只保留最终 Handoff 实际 claim 所需且满足 provenance closure 的精确 entry/block 引用 |

stale state 必须转写为历史观测，例如：

```text
Auth tests previously passed for input fingerprint X.
Relevant inputs changed afterwards; revalidation is required.
```

不得保留为：

```text
Auth tests passed.
```

### 13.4 最终门禁

`validateFinalHandoff()` 只校验最终产物：

- objective 非空且有当前 Task Scope 的 user provenance；
- 每个关键用户约束被表达且来源有效；
- acceptanceCriteria 状态与权威来源一致；
- active Todo 与最新 TodoState 完全一致；
- completedWork 和 currentState 的 evidence 类型正确；
- stale/unknown evidence 没有被陈述为当前成功；
- failed attempt 有真实失败来源；
- nextAction 非空且不与用户/Todo 冲突；
- 必需的 source/evidence 可以通过 Active Suffix 或精确 history allowlist 取回；
- historyRefs 满足当前 Handoff provenance closure 和数量上限；
- Handoff 不包含 Pending Delivery 正文、Secret、系统提示词、工具定义或授权扩大；
- Handoff 与 Active Suffix 不重叠且不切开 Tool Transaction；
- Handoff/Checkpoint Note 总 token 不超过 context window 10%。

“某信息存在于 Ledger、Checkpoint、Todo、Active Suffix 或 historyRef 任一处”不是合法门禁。historyRef 只能证明可取回性，不能替代最终 Handoff 中的目标、约束或下一动作。

门禁通过表示结构、来源、证据和可恢复性约束已满足，不表示系统证明了不存在任何未被模型识别的隐含事实。

## 14. PreparedContinuation、预算和提交顺序

必须使用以下唯一顺序：

```text
读取同一批权威 revision
  -> 构建 TaskNoteProjection
  -> 组装最终 Handoff
  -> 校验结构、来源、evidence freshness、安全和 Strong Progress
  -> 构建候选 Session context
  -> Agent.prepareContinuation()
       - reserve PendingDelivery
       - transformContext
       - convertToLlm
       - apply system/tools/model/thinking
       - apply append-only context
       - calculate real request budget/fingerprint
  -> 校验 prepared budget/fingerprint
  -> 同步 revision CAS + appendContextRollover()
  -> post-commit base/request fingerprint 校验
  -> append dispatch_started(reservedDeliveryIds)
  -> dispatchPreparedContinuation(同一个 handle)
  -> append dispatch_finished
```

预算门禁保持：

```text
preparedBudget.decision == fits
AND preparedBudget.tokens <= floor(contextWindow * 0.50)
AND preparedRequestFingerprint != sourceRequestFingerprint
AND preparedBudget.tokens < sourceBudget.tokens
```

不得在 `prepareContinuation()` 之前用 Handoff 字符串估算替代真实预算。Preview 和第一次 Provider Request 必须消费同一个 PreparedContinuation，不得重新 drain queue、转换 context 或计算请求。

Task Note event append 会改变 session leaf。若 Note 在 prepare 期间追加，现有同步 `sessionLeafId` CAS 必须使 proposal superseded；释放 preparation 后按 Context Rollover Spec 最多重新组装一次，第二次变化返回 `blocked(source_changed)`。

## 15. Persistence、Resume 与 Fork

### 15.1 权威记录

权威持久化记录只有：

- 正常路径的 `task-note-event` custom entry；
- Checkpoint Envelope 内的 TaskNoteBatch；
- 现有 Todo、PendingDelivery、ContextProgress、Rollover 和 Dispatch entries。

不得持久化第二份 TaskNoteProjection snapshot。内存缓存只按 `(sessionLeafId, taskScopeId, promptGeneration, freshness revision)` 使用，任一输入变化即丢弃并重建。

`SessionManager.inMemory()` 只保证进程内语义；没有 Session 文件时不得声称 Note 或 dispatch journal 可以跨进程恢复。

### 15.2 Resume

恢复时：

1. 从当前 Session branch 重建 Task Scope coordinates；
2. 重建 Todo、PendingDelivery、ContextProgress 和 Dispatch 状态；
3. 从当前 branch ancestry 重建 TaskNoteProjection；
4. 恢复最近有效 ContextRollover boundary；
5. 按现有 dispatch journal 状态决定是否自动 dispatch。

Dispatch 恢复保持：

| 持久化状态 | 动作 |
| --- | --- |
| rollover prepared，无 dispatch_started | 使用 reservedDeliveryIds 重建同一 PreparedContinuation；全部指纹和预算一致才允许自动 dispatch |
| dispatch_started，无 dispatch_finished | `blocked(dispatch_outcome_unknown)`，不得自动重放 |
| dispatch blocked/cancelled | 不自动 dispatch |
| dispatch_finished=completed | 不自动 dispatch |
| dispatch_finished=context_limit | 只进入 target epoch 的 Context Maintenance |
| dispatch_finished=aborted/failed | 保持任务未完成 |

Task Note 不改变以上状态，也不能作为“工具尚未执行”或“工具已执行”的证明。

### 15.3 Fork

- fork 只继承 fork point 之前的 Note event 和 Checkpoint batch；
- fork 后兄弟分支的 supersede/retract 互不影响；
- Projection revision 必须在子分支重新计算；
- 从 rollover 后 fork 继承 Handoff boundary、Note ancestry、Todo、queue、额度和 dispatch 状态；
- 从 rollover 前 fork 不继承后续 Handoff 或 Note event。

## 16. Evidence Freshness

### 16.1 计算

Assembler 时对每个 active evidence-backed Note 调用对应 freshness adapter：

```text
currentInputFingerprint == evidence.inputFingerprint
  -> fresh

currentInputFingerprint != evidence.inputFingerprint
  -> stale

无法读取当前 fingerprint
  -> unknown
```

Freshness adapter 是 Task Note 模块的内部 seam。至少存在 workspace、process、Task 和 external read-back 多种 adapter，因此该 seam 具有真实替换需求；不得由 HandoffAssembler 分散实现各类判断。

### 16.2 语义

- constraint：由 user supersession/retraction 决定，不因文件变化 stale；
- decision：纯用户决策由 supersession 决定；实验性决策的依据可以 stale；
- state：fresh 才能陈述为当前状态；stale/unknown 必须要求重新验证；
- failed_attempt：失败发生过是历史事实，不因输入变化消失；当前是否仍失败需要新 evidence；
- next_action：用户方向、Todo、Task 或目标输入变化后必须 supersede、retract 或降级为 stale。

一次无关 subject 的变化不得使其他 evidence stale。整个 workspace 任意变化导致全部测试失效不是合法实现。

### 16.3 外部并发限制

Session revision CAS 只保护 Session 管理的状态，不能锁定进程外文件或外部系统。Handoff 中的 verified state 必须带观测对象和 fingerprint 语义；新 Epoch 执行业务副作用前仍需按现有规则读取目标当前状态。不得把一次 freshness check 表述为对未来状态的锁定保证。

## 17. 安全

- TaskNoteEvent 和 Checkpoint Envelope 使用 strict schema；
- Note text、source 和 evidence 在持久化前执行 Secret 检查；
- 校验失败的正文不得进入有效 custom entry 或 Trace；
- Trace 只记录 event count、kind、operation、phase、reasonCode 和 token 数，不记录 text、引用正文、Todo、队列、工具参数/结果或系统提示词；
- Handoff 开头继续声明其为 low-privilege task state，不是 system instruction；
- Note 不能改变 active tools、permissions、model、thinking、system prompt 或 PendingInteraction；
- user-provenance 引用只证明来源类型，不能提升 Note 的指令优先级；
- Handoff 与权威 entry 冲突时权威 entry 优先，无法确定时 fail closed；
- history_get 只开放最终 Handoff 精确列出的 entry/block，不开放整个 Projection 的全部引用；
- memory_search/memory_get 始终查询当前 Memory 视图，Note 不回放旧 Memory tool result。

## 18. Context Maintenance 与 Strong Progress

正常顺序不变：

```text
Default Shake
  -> Soft Compaction × 最多 3 / epoch
  -> Rescue Shake
  -> eligible blocked
  -> Context Rollover evaluation
```

Task Note 不增加新的维护方法，也不改变唯一 Rollover 入口。

以下均为 Weak Progress，不能产生 Strong Progress credit：

- 新建、更新或撤销 Task Note；
- Projection revision 或 Handoff 文本变化；
- Coverage Sweep 补记 Note；
- Todo 文案变化；
- 普通 workspace write、变化输出、Checkpoint 或 Rollover。

第二次及后续 Rollover 继续只消费 Context Rollover Spec 定义的未消费 Strong Progress credit。Note 只能引用 credit 的 evidence，不能创建、复制或重复消费 credit。

## 19. 并发、取消与失败

- 同一个 AgentSession 同时最多一个 Checkpoint summary operation、一个 Rollover operation 和一个未结算 PreparedContinuation；
- `context_note` 同步 append 可以发生在后台 Checkpoint 期间；Checkpoint 提交时必须通过 source/session revision 校验发现变化；
- Checkpoint Envelope append 是单一线性化点，append 前不得改变 Projection 缓存；
- Rollover 的 CAS 与 appendContextRollover 之间仍不得 `await`；
- 用户 abort 取消未提交的 Checkpoint/Rollover，不回滚已经成功追加的正常 TaskNoteEvent；
- 已提交 rollover、未 started 时的取消必须写 dispatch cancelled；
- dispatch_started 后 crash 保持 outcome unknown，不因 Note 存在而自动重放；
- source superseded 最多重新组装一次；
- 无法验证 Projection、Handoff、freshness、预算或 dispatch 一致性时停止，不生成替代路径。

新增失败原因：

```ts
export type TaskNoteFailureReason =
  | "invalid_input"
  | "invalid_scope"
  | "invalid_key"
  | "invalid_source"
  | "invalid_evidence"
  | "supersedes_mismatch"
  | "unsafe_content"
  | "note_limit"
  | "source_changed"
  | "append_failed";

export type TaskNoteProjectionFailureReason =
  | "projection_invalid"
  | "event_id_conflict"
  | "supersedes_chain_invalid"
  | "freshness_unavailable";
```

Context Rollover 继续使用现有 `handoff_invalid`、`source_changed`、`prepared_over_half_window`、`no_strong_progress`、`post_commit_mismatch`、`dispatch_prepare_mismatch` 和 `dispatch_outcome_unknown`，不得新增同义失败码。

`freshness_unavailable` 只有在 claim 必须作为当前事实才能安全继续时阻塞；可以安全表达为“需要重新验证”的 state 返回 `unknown`，不属于降级或静默忽略。

## 20. Trace、CLI、RPC 与子代理

Trace 增加 `context/task_note` metadata event：

```ts
{
  type: "context/task_note";
  data: {
    eventId?: string;
    batchId?: string;
    promptGeneration: number;
    contextEpoch: number;
    kind?: TaskNoteKind;
    operation?: "upsert" | "retract" | "project";
    outcome: "accepted" | "rejected" | "rebuilt";
    activeCount?: number;
    staleCount?: number;
    reasonCode?: TaskNoteFailureReason | TaskNoteProjectionFailureReason;
  };
}
```

要求：

- Trace 不含 Note text、source/evidence 正文、fingerprint 原值或凭据；
- `/trace` 可以显示 Note accept/reject、Projection 数量和 stale 数量；
- RPC get_state 只暴露 active/stale count 和最后失败原因，不暴露绕过校验的 Note mutation 接口；
- 子代理的 Note 只属于子代理 Session；父 Agent 只能通过已提交的 Task terminal result 获取子代理结论；
- Note 不能使 blocked、unknown、context_limit 或未完成子代理映射为 completed。

## 21. 测试规范

### 21.1 通用要求

- 使用 faux provider、临时 Session 文件、确定性 ID factory 和确定性 evidence adapter；
- 不调用真实 Provider、外部系统或付费模型；
- Projection 测试只通过模块接口和 Session 可观察结果，不读取私有缓存；
- resume 测试必须销毁原 AgentSession/SessionManager 后从 JSONL 创建新实例；
- fork 测试必须创建真实分支 ancestry；
- 并发和 crash window 使用 barrier/deferred promise，不使用长 sleep；
- 每个集成测试断言 Session entry 顺序、Provider 请求次数、首次请求 fingerprint、Todo、queue receipt、Trace 和 runState；
- Trace 安全测试扫描序列化 JSONL，确认正文和凭据不进入 Trace。

### 21.2 Candidate 与 Projection

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| TN01 | 有效 constraint candidate | 先验证 user source，再追加一个 task-note-event，返回最小 receipt |
| TN02 | 同 key update 带正确 supersedesEventId | Projection 只返回新 revision，旧 event 保留审计 |
| TN03 | retract 当前 active event | Projection 不再返回该 identity |
| TN04 | update/retract 指向非 active event | supersedes_mismatch，不追加 entry |
| TN05 | 相同 eventId 相同 payload 重试 | 不重复追加，返回同一 receipt |
| TN06 | 相同 eventId 不同 payload | event_id_conflict |
| TN07 | event 创建于 epoch 0，当前 epoch 2 | 仍然 active，createdInContextEpoch 只作 provenance |
| TN08 | 新顶层 prompt | 新 Task Scope 不读取旧 scope Note |
| TN09 | fork point 位于 Note 前/后 | 只有 Note 后 fork 继承；兄弟分支更新互不影响 |
| TN10 | JSONL resume | Projection items、顺序、freshness 和 revision 一致 |
| TN11 | 非法持久化 event 或断裂 chain | projection_invalid，Rollover 不继续 |
| TN12 | 达到数量/正文/引用上限 | 明确 note_limit，不截断 |

### 21.3 Evidence

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| EV01 | constraint 只引用 assistant | invalid_source |
| EV02 | state 声明测试通过，process exitCode=0 | 系统生成 process evidence stamp |
| EV03 | state 声明测试通过，process exitCode!=0 | invalid_evidence |
| EV04 | evidence 后相关 subject input 改变 | Projection freshness=stale，Handoff 要求重验 |
| EV05 | 无关 subject 改变 | 原 evidence 保持 fresh |
| EV06 | 无法生成稳定 input fingerprint | freshness=unknown，不陈述当前成功 |
| EV07 | failed_attempt 引用真实失败 | 历史失败保留；输入变化不改写成当前仍失败 |
| EV08 | 模型伪造 fingerprint | 忽略模型值，以系统 stamp 为准或拒绝 schema |
| EV09 | external effect 无 read-back | 不能生成 current succeeded state |

### 21.4 Checkpoint 与 Coverage Sweep

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| NC01 | Checkpoint + 0 candidates | 单个 Envelope entry，Checkpoint 有效 |
| NC02 | Checkpoint + 多个有效 candidates | 单个 Envelope entry，Projection 折叠全部 batch event |
| NC03 | 任一 Candidate 无效 | 整个输出无 entry，不存在部分 batch |
| NC04 | crash 于 Envelope append 前 | Checkpoint 和 batch 均不存在 |
| NC05 | Envelope append 成功后 crash | resume 同时看到 Checkpoint 和完整 batch |
| NC06 | batch 内连续两次更新同 identity | supersedes chain 按 index 连续且确定 |
| NC07 | 生成期间 source/Todo/config 变化 | discarded(source_changed)，不提交 Envelope |
| NC08 | Maintenance blocked 后没有既有 Checkpoint operation | 不为 Coverage Sweep 新开模型请求 |
| NC09 | Candidate 超过 16 或 Projection 超限 | invalid_output/note_limit，不截断 |

### 21.5 Handoff

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| NH01 | Note 与原始 toolResult 冲突 | 原始 evidence 胜出，错误 Note 不进入最终 Handoff |
| NH02 | Note 与最新用户约束冲突 | 最新 user provenance 胜出或 handoff_invalid |
| NH03 | Note 声称 Todo completed，Store 仍 pending | 最终 Todo 保持 pending，completedWork 不接受 Note |
| NH04 | acceptance criteria 未明确提供 | status=not_specified，items 为空 |
| NH05 | acceptance criteria 来自用户/Task contract | status=specified，来源完整 |
| NH06 | state evidence stale | 最终 Handoff 明确 previously/needs revalidation |
| NH07 | state evidence unknown | 不陈述当前成功 |
| NH08 | history references | 只 allowlist 最终 claim 所需 entry/block |
| NH09 | Projection、Checkpoint 和 Handoff 都含同一语义 | Provider context 只出现一次最终 Handoff 表达 |
| NH10 | 原材料中存在事实但最终 Handoff 缺必填语义 | validateFinalHandoff 失败 |
| NH11 | historyRef 存在但 objective/constraint 未表达 | validateFinalHandoff 失败 |
| NH12 | Handoff + Note 派生正文超过 10% | handoff_invalid，不截断 |

### 21.6 PreparedContinuation、并发与 crash

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| ND01 | Note 在 prepare 后、CAS 前追加 | session leaf mismatch，释放 preparation 并重组一次 |
| ND02 | 第二次 source 变化 | blocked(source_changed) |
| ND03 | queue/transform/convert 使最终请求超过 50% | prepared_over_half_window，不提交 rollover |
| ND04 | Preview 和 dispatch | request fingerprint 相同，转换只执行一次 |
| ND05 | rollover prepared、无 started 后 crash | 指纹一致才自动 dispatch 一次 |
| ND06 | started、无 finished 后 crash | dispatch_outcome_unknown，不自动重放 |
| ND07 | context_note 写入 | 不产生 ContextProgress 或 Strong Progress credit |
| ND08 | 第二次 rollover 只有 Note 变化 | no_strong_progress |
| ND09 | append Checkpoint Envelope 失败 | 无 Checkpoint、无 batch、Projection 不变 |
| ND10 | in-memory Session 重建新进程 | 不声称支持，测试只验证进程内行为 |

### 21.7 安全与协议

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| NS01 | Note 包含 Secret | unsafe_content，不持久化正文 |
| NS02 | Note 尝试修改 system/tools/permissions | invalid_input/unsafe_content |
| NS03 | Note 引用未决确认 | 不能形成 authorized/approved claim |
| NS04 | Trace JSONL 扫描 | 不含 Note text、引用正文、fingerprint 原值或凭据 |
| NS05 | 未授权普通历史引用 | 不进入 history allowlist |
| NS06 | 子代理记录 Note | 父 Session Projection 不包含该 event |
| NS07 | context_note 不在 active tools | 模型提示不要求调用，工具不可执行 |
| NS08 | Plan Mode 调用 context_note | 只写 Session metadata，不获得业务写权限 |

## 22. 系统不变量

| ID | 约束 |
| --- | --- |
| N01 | Task Note 是派生索引，不是 objective、Todo、completion、queue、progress 或授权的权威来源 |
| N02 | Context Epoch 只记录创建来源，不是默认 Note 有效作用域 |
| N03 | Branch 可见性只由当前 Session ancestry 决定 |
| N04 | Projection 必须从 Session entry 确定性重建，不持久化第二份可变快照 |
| N05 | 模型只能产生 Candidate，fingerprint、scope、event ID 和 freshness 由系统生成 |
| N06 | 已有 identity 的 update/retract 必须精确 supersede 当前 active event |
| N07 | Checkpoint 与 Coverage Sweep 使用一次模型调用和一个 JSONL Envelope append |
| N08 | 任一 Candidate 无效时不得部分提交 Checkpoint batch |
| N09 | Final Handoff 是唯一注入的新 epoch 任务状态，不注入 Projection 或 Checkpoint 副本 |
| N10 | 完整性门禁只校验最终 Handoff，不以任一原材料存在代替最终表达 |
| N11 | state evidence 必须在 Handoff 组装时重新判断 fresh/stale/unknown |
| N12 | Todo 始终来自当前分支最新 TodoState |
| N13 | acceptance criteria 只来自用户或持久化 Task contract；缺失时明确 not_specified |
| N14 | history allowlist 只包含最终 Handoff 实际使用并满足 provenance closure 的 entry/block |
| N15 | Note 写入、更新、撤销和 Projection 变化都不是 Strong Progress |
| N16 | Handoff 预算和首次真实请求必须使用同一个 PreparedContinuation |
| N17 | 并发 Note append 必须由现有 session leaf CAS 检出，不增加平行权威 revision |
| N18 | dispatch_started 无 finished 时 fail closed，Task Note 不能触发自动重放 |
| N19 | Note 不扩大系统指令、工具权限、PendingInteraction 或用户授权 |
| N20 | 达到固定限额时明确失败，不静默截断、丢弃或摘要 Note |

## 23. 代码改动范围

### 23.1 新增

- `packages/coding-agent/src/core/task-note-projection.ts`
- `packages/coding-agent/src/core/tools/context-note.ts`
- `packages/coding-agent/test/suite/task-note-projection.test.ts`
- `packages/coding-agent/test/suite/task-note-evidence.test.ts`
- `packages/coding-agent/test/suite/task-note-checkpoint.test.ts`
- `packages/coding-agent/test/suite/task-note-handoff.test.ts`

### 23.2 修改

- `packages/coding-agent/src/core/context-rollover.ts`
  - Checkpoint output 增加 Note candidates；
  - 单 entry Checkpoint Envelope；
  - HandoffAssembler 接收 Projection；
  - 最终 Handoff validation 和 acceptance criteria。
- `packages/coding-agent/src/core/agent-session.ts`
  - Task Scope coordinates；
  - context_note 依赖注入；
  - Checkpoint/Coverage Sweep 集成；
  - prepare 前 Projection 构造和 source revision。
- `packages/coding-agent/src/core/session-manager.ts`
  - task-note-event schema；
  - Checkpoint Envelope 和 branch projection；
  - session format 类型。
- `packages/coding-agent/src/core/messages.ts`
  - 最终 Handoff 的 acceptance/freshness 表达；
  - 不增加独立 Note 注入消息。
- `packages/coding-agent/src/core/tools/index.ts` 或当前工具注册位置
  - 注册 session-bound context_note。
- `packages/coding-agent/src/core/plan/plan-state.ts`
  - Plan Mode 允许 context_note metadata write。
- `packages/coding-agent/src/core/trace.ts`
- `packages/coding-agent/src/extensions/trace/index.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/docs/session-format.md`
- `packages/coding-agent/docs/specs/context-rollover.md`
- `packages/coding-agent/CHANGELOG.md`

不得新增公共 ContextNoteStore、独立 Handoff 注入路径、Note 权威状态、旧 Checkpoint 双格式读取分支或第二套 continuation 实现。

## 24. 实施顺序

| 阶段 | 工作 | 阶段出口 |
| --- | --- | --- |
| S0 | 固化 Candidate、event ID、scope、ancestry、supersedes 和 freshness 纯规则测试 | TN/EV 测试按缺失能力失败 |
| S1 | 实现 task-note-projection 深模块和 strict schemas | TN01-TN12、EV01-EV09 通过 |
| S2 | 实现 session-bound context_note 和 event persistence | 工具写入、resume、fork、Plan Mode 测试通过 |
| S3 | 将 Checkpoint 改为单 Envelope，接入 Coverage Sweep batch | NC01-NC09 通过，不存在部分提交路径 |
| S4 | 扩展 HandoffAssembler、acceptance criteria 和 freshness 表达 | NH01-NH12 通过，只注入唯一 Handoff |
| S5 | 接入 PreparedContinuation、revision CAS 和预算门禁 | ND01-ND04 通过，无 preview/actual 双路径 |
| S6 | 验证 dispatch journal、crash、Strong Progress 不受 Note 影响 | ND05-ND10 通过 |
| S7 | 接入 Trace、RPC、子代理隔离和 Secret 检查 | NS01-NS08 通过 |
| S8 | 删除临时双格式、平行 Store 或独立 Note 注入路径 | 搜索确认只有一个 Projection 和 Handoff seam |
| S9 | 更新 Session format、Context Rollover Spec 和 Changelog | 文档与实际 schema 一致 |
| S10 | 运行定向测试、npm run check 和完整离线回归 | 所有输出无 error、warning、info |

## 25. 验收标准

### 25.1 权威性与作用域

- [ ] Note 与原始 user/tool/Todo/Task evidence 冲突时不能覆盖权威事实。
- [ ] Note 跨 Context Epoch 保持有效，contextEpoch 只作创建 provenance。
- [ ] 新 Task Scope、fork 前后和兄弟分支的可见性符合 Session ancestry。
- [ ] Projection 可以完全从 JSONL 当前分支重建，不依赖内存字符串或第二份 snapshot。
- [ ] objective、acceptance criteria、completed work 和 Todo 没有被建模为 TaskNoteKind。

### 25.2 Evidence 与 Handoff

- [ ] 模型不能提供权威 fingerprint 或 freshness。
- [ ] 相关输入变化使 state evidence stale，无关 subject 变化不影响它。
- [ ] stale/unknown state 不会在最终 Handoff 中陈述为当前成功。
- [ ] Final Handoff validation 覆盖目标、约束、验收状态、Todo、当前状态、下一动作和必要历史可取回性。
- [ ] historyRef 存在不能替代最终 Handoff 的语义表达。
- [ ] Provider context 只包含一份最终 Handoff，不包含 Projection 或 Checkpoint 副本。

### 25.3 Checkpoint、并发和恢复

- [ ] Checkpoint 与 Note candidates 使用一次模型调用和一个 Envelope append。
- [ ] 任一 Candidate 无效或 crash 于 append 前都不会留下部分 batch。
- [ ] Note 在 prepare 期间追加会触发 session leaf CAS superseded。
- [ ] PreparedContinuation 是预算 Preview 和第一次 Provider Request 的唯一对象。
- [ ] dispatch prepared/started/finished 和 crash 恢复保持现有 at-most-once/fail-closed 语义。
- [ ] Note 变化不能产生 Strong Progress 或绕过 rollover 次数上限。

### 25.4 安全与成本

- [ ] Note 不能写入 Secret、系统提示词、工具定义、Pending Delivery 正文或未决授权。
- [ ] Trace 不包含 Note/evidence 正文或 fingerprint 原值。
- [ ] Note event、active Projection、Candidate、正文和引用均有固定上限。
- [ ] Handoff/Checkpoint Note 总量不超过 window 10%，首次 PreparedContinuation 不超过 window 50%。
- [ ] 超限和不一致均明确失败，不存在静默截断或兼容分支。

## 26. 测试命令

在 `packages/coding-agent` 目录运行：

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/suite/task-note-projection.test.ts \
  test/suite/task-note-evidence.test.ts \
  test/suite/task-note-checkpoint.test.ts \
  test/suite/task-note-handoff.test.ts \
  test/suite/context-rollover-checkpoint.test.ts \
  test/suite/context-rollover-handoff.test.ts \
  test/suite/context-rollover-dispatch.test.ts \
  test/suite/context-rollover-persistence.test.ts \
  test/suite/context-rollover-policy.test.ts
```

代码实现完成后在仓库根目录运行：

```bash
npm run check
bash ./test.sh
```

不得运行未经隔离的完整 Vitest。Windows 无法执行 `bash ./test.sh` 时必须记录为未验证，不能用定向测试代替完整离线回归。

## 27. 交付证据

实现交付必须包含：

- 每个 TN/EV/NC/NH/ND/NS 测试 ID 到具体测试名称的映射；
- Note 跨 epoch、Task Scope 隔离和 fork ancestry 的 JSONL 证据；
- supersede/retract 和重复 eventId 幂等证据；
- Checkpoint + Note batch 单 entry、无部分提交的 crash 证据；
- evidence fresh -> stale 和无关 subject 不失效的证据；
- Note 与 raw toolResult/Todo 冲突时权威事实胜出的证据；
- Final Handoff 缺字段或只有 historyRef 时被拒绝的证据；
- Projection/Checkpoint 正文没有重复进入 Provider context 的证据；
- prepare 后 Note append 被 CAS 拒绝并只重组一次的证据；
- Preview/actual request fingerprint 相等证据；
- dispatch started 无 finished 后不自动重放的证据；
- Note 操作不产生 Strong Progress 的证据；
- Trace/JSONL Secret 和正文扫描结果；
- `npm run check`、全部定向测试和 `bash ./test.sh` 的实际输出；
- 所有未执行项和环境限制，不得计为通过。
