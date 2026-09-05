# 上下文维护状态机 Spec

| 项目 | 内容 |
| --- | --- |
| Spec ID | `context-maintenance-state-machine` |
| 状态 | 已实现 |
| 日期 | 2026-09-02 |
| 适用范围 | `packages/coding-agent`，复用 `packages/ai` 与 `packages/agent` 现有预算和 Shake 能力 |
| 需求来源 | 将自动上下文缩减统一为“执行后验证、失败后前进、无进展时停止”的有界状态机 |

本文中的“必须”“不得”是实现和验收约束。接口片段描述目标契约，不表示已经存在同名导出。

## 1. 背景

当前项目已经具备以下能力：

- 最终请求发送前使用 `I + R + S <= W` 判断上下文预算；
- `context_limit` 是结构化运行结果，不伪装成 assistant 消息；
- 阈值路径先执行 Default Shake，空间仍不足时执行模型摘要压缩；
- 单次用户请求最多执行 3 次中途压缩；
- 压缩额度耗尽后执行 Rescue Shake；
- Shake 和压缩完成后会重建上下文；
- 压缩提交有来源指纹校验，Shake 和压缩结果能够持久化。

但是自动维护判断分散在 `_handlePostAgentRun()`、`_checkCompaction()` 和 `_runAutoCompaction()` 中，并主要通过 `boolean` 表达结果。调用方无法直接区分：

- 当前请求已经安全；
- 某种方法不可执行，需要尝试下一种方法；
- 方法执行失败，但没有修改上下文；
- 方法声称成功，但实际预算没有下降；
- 有进展但仍未达到请求安全条件；
- 已耗尽有界额度，必须停止；
- 当前回答已经完成，只需要整理下一轮上下文，不能续跑 Agent。

这会使相同判断在不同入口重复实现，也使“是否继续 Agent”与“是否完成过一次压缩”混在同一个布尔值中。

## 2. 目标

- 所有自动上下文缩减入口使用同一个状态推进器。
- 每次实际修改上下文后，基于重建后的真实请求快照重新计算预算。
- 单个缩减方法失败或不可用时，按固定顺序前进，不重新执行已经失败的方法。
- 方法提交后没有实际 token 进展时立即停止，不继续提交同一个超预算请求。
- 所有自动循环具有固定上限，不能因等待、失败或重复事件无限增加模型调用。
- 状态机只表达“请求是否已经具备继续条件”；每个调用方根据自己的续跑意图独立决定 `continue/wait/stop`。
- 同一请求快照的并发维护只能执行一次；不同请求快照不得复用旧结果。
- 自动压缩额度归属于当前用户 prompt，不能因重新进入状态机而重置。
- CLI、RPC、Trace 和子代理能够识别最终 `blocked`，不得将其映射为任务完成。
- 保留现有 Shake、Soft Compaction、Checkpoint、历史回读和预算公式，不增加新的压缩算法。

## 3. 非目标

- 不实现 Remote Compaction、Snapcompact、Handoff 或模型自动升级。
- 不增加可配置的压缩方法顺序、插件式策略注册器或通用工作流引擎。
- 不改变手动 `/compact` 的产品语义；手动操作继续由现有手动压缩路径处理。
- 不改变 `DEFAULT_SHAKE_CONFIG`、`RESCUE_SHAKE_CONFIG` 和最多 3 次中途压缩的现有默认值。
- 不更改 token 估算公式、usage 锚点规则、摘要内容协议或 Memory 归档策略。
- 不引入旧逻辑与新状态机并存的兼容路径；迁移完成后删除分散的自动调度逻辑。
- 不通过降低输出预留、安全余量或上下文阈值使请求表面上通过。

## 4. 第一性原理与系统不变量

自动上下文维护的唯一目标是：

```text
在不重复执行用户任务的前提下，把下一次真实请求转换为可提交状态；
如果无法证明请求可提交，则有界停止。
```

| 不变量 ID | 约束 |
| --- | --- |
| I01 | 缩减方法返回成功，不等于上下文已经安全；必须重新预算后才能决定下一步 |
| I02 | 预算必须来自缩减提交并重建后的请求快照，不能从旧预算减去 `tokensSaved` 推导 |
| I03 | 每个方法在一次维护运行中只能从当前游标向前执行，不得回到已经失败的方法 |
| I04 | 方法已提交但 `tokensAfter >= tokensBefore` 时视为无进展，立即进入 `blocked` |
| I05 | 方法未修改上下文且不可用或失败时，可以前进到下一种方法，但不得重发原超预算请求 |
| I06 | 有进展但仍超限时，可以前进或在额度内再次压缩；每次都必须重新预算 |
| I07 | 自动摘要压缩每个用户 prompt 最多 3 次；每个有效请求快照的 Default Shake 最多 1 次、Rescue Shake 最多 1 次 |
| I08 | `ready`、`blocked` 和 `cancelled` 是不同终态；`blocked` 不等于任务完成 |
| I09 | 正常完成的 assistant 回答不得因为整理下一轮上下文而自动续跑 |
| I10 | 因 `context_limit`、可重试 overflow 或未完成 tool-use 停止时，只有恢复成功才能续跑 |
| I11 | 状态机不能重复持久化用户消息、重复消费队列或重新执行已经完成的工具调用 |
| I12 | Shake、压缩边界和 Checkpoint 仍以 SessionManager 的持久化记录为唯一事实来源 |
| I13 | 取消在任意阶段发生后，不再启动后续方法，不提交未完成摘要，不继续 Agent |
| I14 | Trace 必须能够还原每次方法选择、预算前后值、终止原因和续跑决定，但不得记录被卸载正文 |
| I15 | Provider 已明确返回 overflow 时，即使本地预算为 `fits` 或 `unknown`，也必须执行至少一种缩减方法 |
| I16 | 并发维护结果只有在请求指纹一致时才能共享；调用方的 `continuation` 不属于共享结果 |
| I17 | 来源快照失效不属于普通方法失败；必须基于新快照重新测量，不得直接修改新分支 |
| I18 | Compaction 提交点之后发生的扩展、UI 或 Memory 错误只能作为 warning，不能把已提交结果改写为失败 |
| I19 | 相同 token 数不等于相同请求；重复请求检测必须使用覆盖 model、system、tools、messages 和预算参数的指纹 |

## 5. 固定策略顺序

自动维护只使用以下固定顺序：

```text
Default Shake
      ↓ 未恢复
Soft Compaction，最多使用当前用户请求剩余额度
      ↓ 失败、无可压缩内容或额度耗尽
Rescue Shake
      ↓ 未恢复
Blocked
```

### 5.1 Default Shake

- 每个有效请求快照最多执行一次；来源失效后重新测量得到的新快照重新计数。
- 对阈值、预检 `context_limit` 和可重试 overflow 使用相同入口。
- 没有 eligible region 时返回 `unavailable`，直接前进到 Soft Compaction。
- 写入 Shake entry 后必须调用 SessionManager 重建上下文并重新预算。
- 只有重新预算为 `fits`，或满足第 8.3 节的显式 overflow 未知预算规则，才能进入 `ready`。

### 5.2 Soft Compaction

- 复用现有 `_runAutoCompaction()` 内的模型选择、两阶段 Checkpoint、超时、摘要重试、来源指纹和提交逻辑。
- 每次成功提交 compaction entry 后必须重建请求并重新预算。
- 若仍为 `context_limit`，且本用户请求的压缩额度未耗尽、仍存在可压缩范围，则允许再次执行 Soft Compaction。
- `prepareCompaction()` 无结果属于 `unavailable`，不得当作成功。
- 摘要调用失败且没有提交 compaction entry 属于 `failed`，前进到 Rescue Shake。
- 摘要已提交但预算没有严格下降属于 `no_progress`，立即停止，不执行 Rescue Shake 掩盖该正确性错误。
- `session_before_compact` 明确取消属于 `vetoed`，立即停止；不得继续 Rescue Shake 绕过扩展决定。
- 生成期间来源失效属于 `superseded`，不前进到 Rescue Shake；按第 8 节规则基于新快照重新测量。
- 每次实际启动 Soft Compaction operation 都消耗一次当前 prompt 的额度，不因失败、超时或取消返还。

### 5.3 Rescue Shake

- 每个有效请求快照最多执行一次；同一指纹不得因重新进入状态机再次执行。
- 使用现有 `RESCUE_SHAKE_CONFIG`，允许进入最近保护区处理单个超大 turn。
- 只在 Soft Compaction 失败、不可用或本用户请求压缩额度耗尽时执行。
- 提交后重新预算；恢复则结束，否则进入 `blocked`。
- 没有 eligible region 时直接进入 `blocked`。
- Rescue Shake 只能处理同一请求快照；若进入该状态前快照已变化，必须先返回重新测量。

## 6. 状态、快照与结构化协议

### 6.1 状态

```ts
export type ContextMaintenanceState =
  | "idle"
  | "measuring"
  | "default_shake"
  | "soft_compaction"
  | "rescue_shake"
  | "superseded"
  | "ready"
  | "blocked"
  | "cancelled";
```

状态是单次自动维护运行的局部状态，不作为另一套长期 Session 状态持久化。已经提交的 Shake 和 Compaction 继续由 SessionManager 持久化；进程中断后不得恢复半完成状态机。

当前用户 prompt 的额度不是局部状态，必须由 AgentSession 持有并传入每次状态机运行：

```ts
export interface ContextMaintenanceBudget {
  promptGeneration: number;
  softCompactionOperationsStarted: number;
  rejectedRequestFingerprints: Set<string>;
  continuedRequestFingerprints: Set<string>;
  overflowRetriesUsed: number;
}
```

- 新用户 prompt 开始时创建新额度。
- 同一 prompt 内的 `agent.continue()`、工具后续轮次和多次维护运行共享同一额度。
- 启动 Soft Compaction operation 前递增 `softCompactionOperationsStarted`；失败、超时和取消不返还。
- Provider 请求实际重试次数与 Soft Compaction operation 次数分别计量，见第 13.3 节。

### 6.2 触发输入

触发原因和执行阶段必须分开表达：

```ts
export type ContextMaintenanceCause = "budget_limit" | "provider_overflow" | "threshold";
export type ContextMaintenancePhase = "pre_prompt" | "mid_run" | "post_run";
export type ContinuationIntent = "required" | "forbidden";

export interface ContextMaintenanceTrigger {
  triggerId: string;
  cause: ContextMaintenanceCause;
  phase: ContextMaintenancePhase;
  continuation: ContinuationIntent;
  signal?: AbortSignal;
}
```

`continuation` 由触发位置确定：

| 场景 | cause | phase | continuation |
| --- | --- | --- | --- |
| 正常完成回答后仅为下一轮整理上下文 | `threshold` | `post_run` | `forbidden` |
| 最终 assistant 为 `toolUse`，运行被预算 guard 中断 | `budget_limit` | `mid_run` | `required` |
| 新 prompt 提交前发现预算不足 | `budget_limit` | `pre_prompt` | `required` |
| Provider overflow error 且允许一次恢复重试 | `provider_overflow` | 当前阶段 | `required` |
| Provider 成功返回完整回答，但报告 usage 超窗口 | `provider_overflow` | `post_run` | `forbidden` |

### 6.3 请求快照与指纹

每次测量返回不可变快照：

```ts
export interface ContextMaintenanceSnapshot {
  fingerprint: string;
  sourceFingerprint: string;
  budget: ContextBudget;
}
```

`fingerprint` 必须覆盖：

- provider、model ID、API 和 base URL；
- system prompt；
- 实际暴露的工具名称、描述和 schema；
- `convertToLlm()` 后的消息；
- `outputReserveTokens`、`thresholdPercent` 和 `reserveTokens`。

实现可以复用 `packages/ai` 的 `contextFingerprint()`，但必须把预算选项加入最终维护指纹。`sourceFingerprint` 覆盖当前 Session 分支中会影响 LLM 上下文或压缩来源的有效 entry，用于提交前检测来源变化。

Trace、维护诊断和其他 log-only entry 必须从 `sourceFingerprint` 排除。状态机在生成期间会持续追加 Trace；如果直接对完整 `getBranch()` JSON 计算指纹，诊断事件会使自己的压缩结果失效。提交前校验和初始快照必须调用同一个规范化来源函数。

相同 token 数但指纹不同的请求不是重复请求。只有指纹完全相同的并发维护才能共享缩减工作。

### 6.4 方法结果

```ts
export type ReductionMethod = "default_shake" | "soft_compaction" | "rescue_shake";

export type ReductionUnavailableReason = "no_candidate" | "no_compactable_range" | "attempt_limit";
export type ReductionFailureReason =
  | "provider_failed"
  | "authorization_failed"
  | "wall_clock_exhausted"
  | "invalid_summary"
  | "extension_failed";
export type ReductionWarning =
  | "extension_notification_failed"
  | "memory_archive_failed"
  | "ui_notification_failed";
export type BudgetVerification = "fits" | "still_limited" | "unknown" | "estimated_progress";
export type ContextMaintenanceBlockedReason =
  | "no_progress"
  | "methods_exhausted"
  | "attempt_limit"
  | "reduction_failed"
  | "verification_unknown"
  | "extension_veto"
  | "superseded";
export type ContextMaintenanceReasonCode =
  | ReductionUnavailableReason
  | ReductionFailureReason
  | ReductionWarning
  | ContextMaintenanceBlockedReason
  | "regressed";

export type ReductionAttemptResult =
  | {
      outcome: "committed";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      tokensBefore: number;
      tokensAfter: number;
      budgetAfter: ContextBudget;
      verification: BudgetVerification;
      warnings: ReductionWarning[];
    }
  | {
      outcome: "unavailable";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      tokensBefore: number;
      reason: ReductionUnavailableReason;
    }
  | {
      outcome: "failed";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      tokensBefore: number;
      reason: ReductionFailureReason;
    }
  | {
      outcome: "superseded";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      currentFingerprint: string;
      tokensBefore: number;
    }
  | {
      outcome: "vetoed";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      tokensBefore: number;
      reason: "extension_veto";
    }
  | {
      outcome: "cancelled";
      method: ReductionMethod;
      attemptIndex: number;
      requestFingerprint: string;
      tokensBefore: number;
    };
```

约束：

- `committed` 表示持久化修改已经完成，不表示预算已经恢复。
- `tokensAfter` 和 `budgetAfter` 必须来自重新构造的请求快照。
- `failed` 只能表示提交点之前的失败，不得在已经写入 Compaction 或 Shake entry 后返回。
- `superseded` 不属于失败；不得基于旧预算继续下一个方法。
- `vetoed` 是扩展明确阻止自动压缩，必须终止本次维护，不得继续 Rescue Shake。
- 提交点之后的错误进入 `warnings`，不能改变 `committed`。
- 所有 reason 和 warning 都是封闭原因码，不得包含摘要正文、工具结果正文或密钥。

### 6.5 状态机终态结果

```ts
export type ContextMaintenanceOutcome =
  | {
      outcome: "ready";
      changed: boolean;
      verification: "fits" | "not_required" | "estimated_progress";
      requestFingerprint: string;
      budget: ContextBudget;
      attempts: ReductionAttemptResult[];
    }
  | {
      outcome: "blocked";
      requestFingerprint: string;
      budget: ContextBudget;
      reason: ContextMaintenanceBlockedReason;
      attempts: ReductionAttemptResult[];
    }
  | {
      outcome: "cancelled";
      requestFingerprint: string;
      budget: ContextBudget;
      attempts: ReductionAttemptResult[];
    };

export type ContextMaintenanceAction = "continue" | "wait" | "stop";

export function resolveContextMaintenanceAction(
  outcome: ContextMaintenanceOutcome,
  continuation: ContinuationIntent,
): ContextMaintenanceAction;
```

动作规则：

- `ready + continuation=required` → `continue`；
- `ready + continuation=forbidden` → `wait`；
- `blocked/cancelled` → `stop`。

`ready + changed=false` 取代原 `not_needed`。即使没有执行缩减，只要调用方原本因中断而要求续跑，仍然返回 `continue`。

状态机返回共享的 `ContextMaintenanceOutcome`，不包含调用方动作。每个调用方使用自己的 `continuation` 调用 `resolveContextMaintenanceAction()`，不得把一个调用方的 `wait` 复用给另一个调用方。

`resolveContextMaintenanceAction()` 只计算期望动作。AgentSession 真正执行 `agent.continue()` 前，必须以 outcome 对应的最终请求指纹原子检查 `continuedRequestFingerprints`：

- 指纹尚未被继续：登记指纹并执行一次 `agent.continue()`；
- 指纹已经被继续：本调用方只复用既有执行，不再次调用 `agent.continue()`；
- 新消息使请求指纹变化后，可以针对新指纹再次继续。

因此，两个 `continuation=required` 调用方共享同一 outcome 时，最多产生一次实际续跑。

## 7. 状态转移

| 当前状态 | 条件 | 下一状态 | 动作 |
| --- | --- | --- | --- |
| `idle` | 收到自动维护请求 | `measuring` | 构造真实请求预算 |
| `measuring` | cause 不是 `provider_overflow` 且预算不是 `context_limit` | `ready` | 返回 `ready(changed=false, verification=not_required)` |
| `measuring` | cause 是 `provider_overflow`，无论本地预算判定为何 | `default_shake` | 强制执行缩减，禁止原请求不变重试 |
| `measuring` | 预算为 `context_limit` | `default_shake` | 执行一次 Default Shake |
| `default_shake` | 取消 | `cancelled` | 停止 |
| `default_shake` | 重新预算为安全 | `ready` | 返回 `ready(changed=true, verification=fits)` |
| `default_shake` | 已提交但无 token 下降 | `blocked` | 原因 `no_progress` |
| `default_shake` | 不可用、失败或有进展但仍不足 | `soft_compaction` | 使用剩余摘要额度 |
| `default_shake` | 快照失效 | `superseded` | 不执行后续方法 |
| `soft_compaction` | 取消 | `cancelled` | 停止 |
| `soft_compaction` | 扩展 veto | `blocked` | 原因 `extension_veto` |
| `soft_compaction` | 重新预算为安全 | `ready` | 返回 `ready(changed=true, verification=fits)` |
| `soft_compaction` | 已提交但无 token 下降 | `blocked` | 原因 `no_progress` |
| `soft_compaction` | 有进展、仍不足且额度和可压缩范围都存在 | `soft_compaction` | 再执行一次并重新验证 |
| `soft_compaction` | 失败、不可用或额度耗尽 | `rescue_shake` | 执行一次 Rescue Shake |
| `soft_compaction` | 快照失效 | `superseded` | 不执行 Rescue Shake |
| `rescue_shake` | 取消 | `cancelled` | 停止 |
| `rescue_shake` | 重新预算为安全 | `ready` | 返回 `ready(changed=true, verification=fits)` |
| `rescue_shake` | 已提交但无 token 下降 | `blocked` | 原因 `no_progress` |
| `rescue_shake` | 有进展但仍不足 | `blocked` | 原因 `methods_exhausted` |
| `rescue_shake` | 快照失效 | `superseded` | 不使用旧测量结果 |
| `superseded` | 本次尚未重新测量过 | `measuring` | 获取新快照并从 Default Shake 重新开始 |
| `superseded` | 本次已经重新测量过一次 | `blocked` | 原因 `superseded`，防止持续变更形成循环 |

任何没有列出的转移都是实现错误。

进入 `superseded → measuring` 后，先前 attempt 保留在诊断中，但方法游标和 Default/Rescue Shake 的本次运行计数针对新快照重新开始；prompt 级 Soft Compaction 额度不重置。

对任何 `committed` 结果，转移判断顺序固定为：取消或 superseded 检查 → `tokensAfter < tokensBefore` 进展检查 → 预算 verification。即使预算判定变为 `fits`，只要 committed 方法没有产生 token 下降，仍按 I04 进入 `blocked(no_progress)`。

## 8. 预算验证规则

### 8.1 验证对象

每次验证必须按以下顺序执行：

1. 确认方法的持久化提交已经完成。
2. 通过 `SessionManager.buildSessionContext()` 重建消息。
3. 更新 `agent.state.messages`。
4. 执行 `convertToLlm()`。
5. 使用当前 model、system prompt、tools 和输出预算构造新的 `ContextMaintenanceSnapshot`。
6. 比较新旧 `tokens`、请求指纹和来源指纹。
7. 写入 Trace 后再决定转移。

不得使用 `CompactionResult.estimatedTokensAfter` 或 `ShakeEntry.tokensSaved` 代替第 5 步。它们只能用于展示和交叉诊断。

### 8.2 进展定义

```text
progress = tokensAfter < tokensBefore
```

- `context_limit → fits` 必然属于进展。
- `tokensAfter === tokensBefore` 属于无进展。
- `tokensAfter > tokensBefore` 属于无进展，并在 Trace 标记 `regressed`。
- 不设置人为最小下降量；次数上限负责约束“小幅下降但仍不足”的情况。
- `unavailable` 和未提交的 `failed` 不参与 token 进展比较，可以向下一方法前进。
- 指纹变化不代表空间有进展；空间进展仍只由真实预算 token 严格下降定义。
- 防止重复 Provider 请求不能只比较 token。只有请求指纹完全一致时，才能判断为同一个超限请求。

### 8.3 `unknown` 预算

- `unknown` 不主动触发阈值维护。
- 非 overflow 维护执行后得到 `unknown`，不能宣称已经证明安全；即使 token 有下降也进入 `blocked(verification_unknown)`。
- 对 Provider 已明确返回 overflow 的请求，若缩减后预算仍为 `unknown`，只允许在 token 严格下降、请求指纹已经变化且当前 prompt 的 `overflowRetriesUsed` 为 0 时重试一次。
- 该结果返回 `ready(verification=estimated_progress)`，不能记录为 `fits`；调用方消费重试机会时将 `overflowRetriesUsed` 设为 1。
- 第二次 overflow 直接 `blocked`，不得再次进入状态机。

### 8.4 重复请求阻止

- 底层因预算或 Provider overflow 拒绝一个请求时，把完整请求指纹加入当前 prompt 的 `rejectedRequestFingerprints`。
- 状态机返回 `ready` 后，如果准备提交的请求指纹仍在集合中，则不得调用 Provider，必须继续缩减或进入 `blocked(no_progress)`。
- token 数相同但请求指纹不同，不属于重复请求；必须按新快照重新判断。
- 请求指纹相同但 Trace turn 或调用入口不同，仍属于同一请求，不得绕过阻止。

## 9. 并发、取消和提交边界

- 同一个 AgentSession 同时最多存在一个自动维护运行。
- AgentSession 使用 `{ fingerprint, promise }` 记录正在执行的维护。
- 新触发的请求指纹与在途指纹一致时，共享同一个 `ContextMaintenanceOutcome`；每个调用方仍使用自己的 `continuation` 计算动作。
- 新触发的请求指纹不一致时，等待在途维护完成，然后从新快照重新测量；不得复用旧 outcome，也不得并行执行第二次 Shake 或 Compaction。
- 手动 abort 必须取消当前摘要请求以及状态机后续转移。
- 两阶段预摘要在进入 Soft Compaction 前沿用现有逻辑取消或认领，不新增第二份 checkpoint 生命周期。
- 每次 Compaction 提交继续执行现有来源指纹校验；来源失效返回 `superseded`，不得写入边界或直接执行 Rescue Shake。
- Compaction 执行必须明确划分“生成与校验 → 提交 → 预算验证 → 后处理”。`appendCompaction()` 成功是不可逆提交点。
- Shake 与 Compaction 已成功提交后发生扩展通知、UI 或 Memory 后处理失败，不回滚上下文提交；错误加入 `warnings`，方法结果保持 `committed`。
- `session_before_compact` 的 cancel 发生在提交点之前，返回 `vetoed`；`session_compact` 发生在提交点之后，其错误只能成为 warning。
- 状态机不持有原始工具结果副本；历史恢复仍通过 SessionManager 和 `history_get`。

## 10. 模块修改方案

### 10.1 新增状态机模块

新增：

`packages/coding-agent/src/core/compaction/context-maintenance.ts`

职责：

- 定义第 6 节结构化类型；
- 实现固定状态转移和方法游标；
- 消费 AgentSession 传入的 prompt 级 `ContextMaintenanceBudget`；
- 调用注入的预算、Shake、Compaction 和取消能力；
- 返回不包含调用方续跑动作的唯一终态 outcome；
- 提供纯函数 `resolveContextMaintenanceAction()`。

不承担：

- token 公式；
- Session JSONL 结构；
- 摘要 Prompt；
- Memory 归档；
- CLI 文案。

采用函数和字符串联合类型，不使用 `enum`、参数属性或动态 import。

### 10.2 AgentSession

修改：

`packages/coding-agent/src/core/agent-session.ts`

- `_handlePostAgentRun()` 和 `_checkCompaction()` 不再直接编排 Shake/Compaction。
- 两个入口只构造 `ContextMaintenanceTrigger`、取得共享 outcome，再使用各自的 `continuation` 计算 action。
- 将 `_runAutoCompaction()` 拆成“执行一次 Soft Compaction”的方法，返回 `ReductionAttemptResult`，不再决定是否续跑。
- Soft Compaction 的 try/catch 以 `appendCompaction()` 为提交点拆分；提交后的扩展、UI 和 Memory 错误只产生 warning。
- `_validateCompactionCommit()` 改用排除 trace/log-only entry 的规范化来源指纹；初始快照与提交校验共享同一个实现。
- 将 `shake()` 保留为公开手动能力；自动调用通过适配函数返回结构化结果。
- AgentSession 持有 prompt 级 `ContextMaintenanceBudget` 和按请求指纹标识的 single-flight promise；状态机本身不隐式保存跨调用额度。
- 删除 `_midPromptCompactions`，由 `softCompactionOperationsStarted` 统一替代。
- 删除 `_lastLimitedInput`，由 `rejectedRequestFingerprints` 和真实预算进展共同替代。
- 删除 `_overflowRecoveryAttempted`，由 prompt 级 `overflowRetriesUsed` 统一替代。
- `_runAgentPrompt()` 在新用户 prompt 开始时创建新额度；内部 `agent.continue()` 不重置。
- Provider overflow 的失败 assistant 必须在初始快照构建前按现有规则移出工作上下文；原始 Session 记录继续保留。

### 10.3 Compaction 导出

修改：

`packages/coding-agent/src/core/compaction/index.ts`

- 导出状态机内部需要的类型和执行函数。
- 不从包顶层公共 SDK 暴露状态机，除非现有 SDK 调用方确实需要消费结果。

### 10.4 Trace

修改：

`packages/coding-agent/src/core/trace.ts`

新增单一事件：

```ts
{
  type: "context/maintenance";
  data: {
    maintenanceId: string;
    triggerId?: string;
    turn: number;
    promptGeneration: number;
    cause: ContextMaintenanceCause;
    phase: ContextMaintenancePhase;
    state: ContextMaintenanceState;
    method?: ReductionMethod;
    attemptIndex?: number;
    requestFingerprint: string;
    outcome:
      | "entered"
      | "committed"
      | "unavailable"
      | "failed"
      | "superseded"
      | "vetoed"
      | "ready"
      | "blocked"
      | "cancelled"
      | "dispatched";
    tokensBefore?: number;
    tokensAfter?: number;
    budgetDecision?: ContextBudget["decision"];
    verification?: BudgetVerification;
    continuation?: ContinuationIntent;
    nextAction?: ContextMaintenanceAction;
    dispatchStatus?: "executed" | "coalesced";
    reasonCode?: ContextMaintenanceReasonCode;
  };
}
```

- 现有 `context/budget` 和 `compaction/summary` 继续记录各自事实，不重复塞入完整预算或摘要正文。
- `context/maintenance` 负责串起调度顺序和终态。
- 每个 `maintenanceId` 必须恰好有一个 `ready`、`blocked` 或 `cancelled` 终态事件。
- 每个调用方使用共享 outcome 计算 action 后，写一条带自身 `triggerId`、`continuation`、`nextAction` 和 `dispatchStatus` 的 `dispatched` 事件。
- 同一 turn 内的多次维护通过 `maintenanceId` 区分；不得只依赖 turn 推断顺序。

### 10.5 CLI、RPC 与子代理

- CLI 在 `blocked` 时显示：上下文维护已用尽且任务未完成，并提示减少上下文或切换更大窗口模型。
- RPC 继续通过结构化 `context_limit` 表达停止，不把状态机内部方法暴露成需要客户端控制的协议。
- 子代理收到 `blocked` 时保持 `failed/context_limit`，不得映射为 `completed`。
- 正常回答后的 `ready + wait` 不产生新的模型请求。

## 11. 关键流程

### 11.1 大工具结果导致预检超限

```text
Agent 返回 context_limit
→ measure: context_limit
→ Default Shake 提交
→ rebuild + measure
→ fits
→ ready(fits)
→ continuation=required
→ continue
```

不得调用摘要模型，不得重复执行原工具。

### 11.2 Shake 有进展但仍不足

```text
measure: 127k
→ Default Shake
→ measure: 118k，仍 context_limit
→ Soft Compaction
→ measure: 72k，fits
→ ready(fits)
```

### 11.3 摘要方法失败

```text
Default Shake unavailable
→ Soft Compaction 请求失败，未提交边界
→ Rescue Shake
→ 重新预算
→ ready 或 blocked
```

失败的方法不得重新执行，原上下文不得被部分摘要替换。

### 11.4 方法声称成功但没有进展

```text
Soft Compaction 已提交
→ tokensBefore = 110k
→ tokensAfter = 110k
→ blocked(no_progress)
```

不得继续 Rescue Shake，也不得重新发送原请求。该状态代表实现或估算一致性问题，需要通过 Trace 调查。

### 11.5 正常回答后的阈值整理

```text
assistant stop
→ maintenance(threshold, continuation=forbidden)
→ ready
→ resolve action=wait
```

压缩完成后等待用户下一条消息，不能调用 `agent.continue()`。

### 11.6 Provider overflow 与本地估算不一致

```text
Provider 返回 overflow
→ 本地 measure: fits
→ cause=provider_overflow，仍强制 Default Shake
→ 若没有恢复则继续 Soft Compaction / Rescue Shake
→ 请求指纹变化且验证满足规则后，最多重试一次
```

不得因为本地估算为 `fits` 而返回 `ready(changed=false)`，也不得原样重试已被 Provider 拒绝的指纹。

### 11.7 来源变化

```text
Soft Compaction 生成中分支变化
→ 提交校验失败
→ superseded
→ 对新快照重新 measure
→ 最多重新启动一次
```

`superseded` 不进入 Rescue Shake。第二次来源变化直接 `blocked(superseded)`。

### 11.8 提交后扩展失败

```text
摘要生成并校验
→ appendCompaction 成功
→ session_compact 扩展通知失败
→ committed(warnings=[extension_notification_failed])
→ 重建并验证预算
→ ready 或继续下一状态
```

不得返回 `failed`，不得因此追加第二个 Compaction 或执行 Rescue Shake。

## 12. 测试规范

### 12.1 测试方法

- 使用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider。
- 不调用真实 Provider，不读取真实认证信息，不消耗付费 token。
- 状态机单元测试使用确定性依赖，直接控制预算序列、方法结果和取消点。
- 集成测试断言实际 Session entry、Agent 请求次数、队列消费、Trace 和最终 runState。
- 不只断言事件存在；必须断言预算前后值和方法调用顺序。
- 取消和并发使用可控 Promise，不使用长时间 sleep。
- 恢复测试使用临时 JSONL 会话文件重新创建 SessionManager。

### 12.2 状态机单元测试

新增：

`packages/coding-agent/test/context-maintenance-state-machine.test.ts`

| 测试 ID | 场景 | 必须断言 |
| --- | --- | --- |
| SM01 | 初始预算为 `fits`，cause 不是 overflow | 无方法调用；结果 `ready(changed=false, not_required)` |
| SM02 | Default Shake 后恢复 | 调用顺序为 measure/shake/measure；不调用 Soft Compaction |
| SM03 | Default Shake 无候选 | 前进到 Soft Compaction，不重复 Shake |
| SM04 | Default Shake 有下降但仍不足 | 使用重新预算值进入 Soft Compaction |
| SM05 | Default Shake 已提交但 token 未下降 | 立即 `blocked(no_progress)`；无后续方法 |
| SM06 | Soft Compaction 失败且未提交 | 前进到 Rescue Shake |
| SM07 | Soft Compaction 成功但仍不足 | 在额度内再次压缩，每次重新预算 |
| SM08 | Soft Compaction 第 3 次后仍不足 | 不执行第 4 次；进入 Rescue Shake |
| SM09 | Soft Compaction 已提交但 token 上升 | `blocked(no_progress)`，Trace 标记 `regressed` |
| SM10 | Rescue Shake 恢复 | `ready(fits)`，不再执行其他方法 |
| SM11 | Rescue Shake 无候选或仍不足 | `blocked(methods_exhausted)` |
| SM12 | 任意方法期间取消 | `cancelled + stop`，无后续方法 |
| SM13 | `ready + continuation=required` | action 为 `continue`，无论 changed 是否为 false |
| SM14 | `ready + continuation=forbidden` | action 为 `wait` |
| SM15 | 非 overflow 得到 `unknown` | 不宣称 `fits`，按规则停止 |
| SM16 | overflow 缩减后为 `unknown` 且有进展 | 最多允许一次 `estimated_progress` 重试 |
| SM17 | Provider overflow 但本地初始预算为 `fits` | 仍进入 Default Shake，不返回未修改 ready |
| SM18 | Provider overflow 但本地初始预算为 `unknown` | 仍进入缩减策略，不原样重试 |
| SM19 | 同一指纹、不同 continuation 的并发触发 | 共享一个 outcome，分别得到 `continue` 和 `wait` |
| SM20 | 在途维护期间到达不同指纹 | 等待后重新测量，不复用旧 outcome |
| SM21 | Compaction 来源失效一次 | 返回 `superseded` attempt，基于新快照重新测量，不执行 Rescue |
| SM22 | 同一维护连续两次来源失效 | 有界停止为 `blocked(superseded)` |
| SM23 | Compaction 已提交后扩展通知失败 | 结果仍为 `committed`，warning 正确，继续预算验证 |
| SM24 | 相同 token、不同请求指纹 | 不按重复请求阻止；使用新快照正常判定 |
| SM25 | 相同请求指纹再次准备提交 | 不调用 Provider，进入后续缩减或 `blocked(no_progress)` |
| SM26 | 两次状态机运行共享 prompt 额度 | Soft Compaction operation 总数不超过 3 |
| SM27 | 生成期间只追加 trace/log-only entry | 来源指纹保持有效，不返回错误 superseded |

### 12.3 AgentSession 集成测试

新增：

`packages/coding-agent/test/suite/context-maintenance-state-machine.test.ts`

| 测试 ID | 场景 | 必须断言 |
| --- | --- | --- |
| IM01 | 大工具结果触发底层 `context_limit` | Shake 后只续跑一次；原工具调用次数不增加 |
| IM02 | Shake 不足后摘要恢复 | entry 顺序为 shake 后 compaction；下一请求预算为 `fits` |
| IM03 | 没有 Shake 候选 | 直接执行一次摘要，不写空 Shake entry |
| IM04 | 摘要连续有进展但三次仍不足，faux provider 无内部重试 | Soft Compaction operation 和摘要 Provider 调用均为 3 次，之后只执行一次 Rescue Shake |
| IM05 | 所有方法耗尽 | 最终 runState 为 `context_limit`；Agent 不再请求 Provider |
| IM06 | 相同超限请求指纹再次触发 | 不重发相同请求，不增加 Provider 调用 |
| IM07 | 正常 `stop` 后维护成功 | 不调用 `agent.continue()` |
| IM08 | `toolUse` 中途停止后维护成功 | 调用一次 `agent.continue()`，工具结果不重复持久化 |
| IM09 | overflow error 恢复 | 移除失败 assistant 后重试一次；第二次 overflow 停止 |
| IM10 | 压缩来源在生成期间变化一次 | 不提交过期 compaction；对新快照重新测量，不直接 Rescue |
| IM11 | 用户取消 | 无后续摘要、Shake、续跑或队列重复消费 |
| IM12 | 相同指纹、不同 continuation 的两个入口同时到达 | 只有一组缩减提交；两个入口分别计算 action |
| IM13 | Shake/Compaction 后重启 | 重建结果与提交后预算一致；不恢复半完成状态 |
| IM14 | 子代理最终被阻塞 | 返回 `failed/context_limit`，不返回 `completed` |
| IM15 | 两个不同指纹的维护入口先后到达 | 第二个入口等待后重新测量，不复用第一个预算 |
| IM16 | 同一 prompt 多次进入状态机 | Soft Compaction operation 累计最多 3 次，不因重新进入而重置 |
| IM17 | token 数相同但 messages、tools 或输出预算不同 | 指纹不同，不被 `_lastLimitedInput` 式数值判断误拦截 |
| IM18 | Compaction 已提交后 `session_compact` 抛错 | 只有一个 compaction entry；不执行 Rescue；warning 可见 |
| IM19 | Provider overflow 且本地预算为 fits | 至少执行一种缩减，原请求指纹的 Provider 调用不重复 |
| IM20 | Provider 内部摘要重试 | operation 次数与实际 Provider 请求次数分别受各自上限约束 |
| IM21 | 相同指纹的两个 `continuation=required` 调用方 | 只有一次实际 `agent.continue()`；另一调用方记录 coalesced |
| IM22 | Compaction 生成期间持续写 maintenance Trace | Trace 不使提交指纹失效；有效上下文变化仍会使其失效 |

### 12.4 Trace 和协议测试

更新：

- `packages/coding-agent/test/suite/agent-session-trace.test.ts`
- `packages/coding-agent/test/suite/agent-session-compaction.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`

| 测试 ID | 场景 | 必须断言 |
| --- | --- | --- |
| TR01 | Shake → Compaction → ready | Trace 状态顺序、方法顺序和预算值完整 |
| TR02 | 无进展停止 | 恰好一个 `blocked` 终态，原因 `no_progress` |
| TR03 | 方法失败后前进 | `failed` 后只出现下一方法，不回到旧方法 |
| TR04 | 取消 | 恰好一个 `cancelled` 终态 |
| TR05 | 敏感工具结果被 Shake | Trace 不包含原正文或占位符之外的恢复内容 |
| TR06 | CLI/RPC/子代理消费 blocked | 三处均不把任务标记完成 |
| TR07 | 同一 turn 多次维护 | `maintenanceId`、`attemptIndex` 和请求指纹可以区分各运行 |
| TR08 | 同一 outcome 被不同 trigger 消费 | 每个 `triggerId` 都有独立 dispatched action |
| TR09 | 提交后后处理失败 | committed 与 warning 同时存在，不出现错误 failed |
| TR10 | estimated progress overflow 重试 | 明确标记 `estimated_progress`，不伪装为 `fits` |
| TR11 | 两个 required 调用方共享 outcome | 两条 dispatched 事件中只有一条 `executed`，另一条 `coalesced` |

### 12.5 现有回归测试迁移

以下现有测试必须迁移到结构化结果断言，不保留调用私有布尔方法的旧测试分支：

- `test/suite/shake-threshold-avoids-compaction.test.ts`
- `test/suite/shake-compaction-budget-exhausted.test.ts`
- `test/suite/grok-alignment/mid-prompt-compaction.test.ts`
- `test/suite/context-budget-integrity.test.ts`
- `test/suite/agent-session-compaction.test.ts`
- `test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`

原有行为覆盖不得减少：

- Shake 足够时不调用摘要模型；
- Shake 不足时继续摘要；
- 第三次摘要后不调用第四次；
- 无可缩减内容时明确停止；
- 新 prompt 重置额度；
- 正常回答压缩后不自动续跑；
- tool-use 中断恢复后继续执行。

## 13. 验收标准

### 13.1 功能验收

- [ ] 所有自动缩减入口只调用统一状态机，不再各自编排 Shake 和 Compaction。
- [ ] 自动路径不再使用 `boolean` 同时表达“发生压缩”和“应该续跑”。
- [ ] 每个 committed 方法后都有一次基于重建请求的预算验证。
- [ ] 可前进的 `failed/unavailable` 只向下一方法推进；`superseded/vetoed/cancelled` 按各自终态处理。
- [ ] 任意 committed 方法无 token 下降时立即 `blocked`。
- [ ] 每个用户 prompt 跨全部维护运行最多 3 次 Soft Compaction operation；每个有效快照最多一次 Default Shake 和一次 Rescue Shake。
- [ ] `blocked` 后 Provider 请求数、摘要请求数和工具执行数不再增加。
- [ ] `ready` 的调用方按自身 continuation 计算动作；正常回答不续跑，未完成运行继续执行。
- [ ] 相同最终请求指纹的多个 required 调用方最多执行一次 `agent.continue()`。
- [ ] Provider overflow 即使本地预算为 `fits/unknown` 也执行缩减，已拒绝指纹不得原样重试。
- [ ] 相同 token 但不同请求指纹不会被误判为重复；相同指纹不会重复提交。
- [ ] 来源失效重新测量且最多重启一次，不直接进入 Rescue Shake。
- [ ] Compaction 提交后发生后处理错误仍返回 committed，且不会产生第二次缩减提交。
- [ ] 取消、overflow、并发、重启和分支变化路径均有确定终态。
- [ ] CLI、RPC、Trace 和子代理保持 `context_limit != completed`。

### 13.2 可观测性验收

- [ ] 每个 `maintenanceId` 恰好一个 `ready`、`blocked` 或 `cancelled` 终态。
- [ ] Trace 能通过 maintenanceId、triggerId、promptGeneration、attemptIndex 和请求指纹还原状态转移与调用方动作。
- [ ] Trace 不记录摘要输入全文、Shake 原文、历史回读正文或认证信息。
- [ ] `tokensSaved`、`estimatedTokensAfter` 与真实预算不一致时，真实预算决定控制流。
- [ ] `estimated_progress` 与 `fits` 明确区分，前者只允许一次 overflow 重试。

### 13.3 确定性成本验收

| 指标 | 标准 |
| --- | --- |
| 单用户 prompt 自动 Soft Compaction operation 上限 | 3，跨状态机运行累计 |
| 单个有效请求快照 Default Shake 上限 | 1 |
| 单个有效请求快照 Rescue Shake 上限 | 1 |
| 单次 Soft Compaction 内部 Provider 请求 | 受现有 wall-clock retry 与 provider retry 配置共同约束，必须单独计数 |
| 单用户 prompt 摘要 Provider 请求总上限 | 不得宣称固定为 3；必须小于等于各 Soft Compaction operation 内部请求上限之和 |
| `blocked` 后新增 Provider 请求 | 0 |
| 正常完成回答维护后的自动续跑 | 0 |
| 同一失败方法被状态机重新执行 | 0 |
| 每个 committed 方法后的真实预算检查 | 1 |
| 来源失效后的状态机重启上限 | 1 |

## 14. 实施顺序

| 阶段 | 工作 | 阶段出口 |
| --- | --- | --- |
| S0 | 固化状态机纯类型、转移表和单元测试 | SM01–SM27 先失败，失败原因对应缺失实现 |
| S1 | 实现 `context-maintenance.ts` 纯推进器 | 单元测试通过，无 AgentSession 改动 |
| S2 | 将 Shake 和单次 Soft Compaction 改为结构化方法结果，拆开提交前后错误边界 | 方法级测试通过，已提交结果不会误报 failed |
| S3 | 迁移 `_handlePostAgentRun()`、`_checkCompaction()` 和 overflow 路径，接入 prompt 额度和请求指纹 single-flight | 自动入口只剩统一状态机 |
| S4 | 接入 Trace、CLI/RPC 和子代理终态 | IM/TR 组通过，不误报完成 |
| S5 | 删除旧布尔调度、旧计数分支和重复判断 | 搜索确认无第二套自动编排路径 |
| S6 | 定向回归、静态检查和全量离线验证 | 第 15 节命令通过，未运行项单独记录 |

不保留旧状态机作为降级或兼容路径。每个阶段同步更新所有调用方和测试，不能通过增加条件分支绕过新协议。

## 15. 测试命令

在 `packages/coding-agent` 目录运行定向测试：

```bash
node ../../node_modules/vitest/dist/cli.js --run test/context-maintenance-state-machine.test.ts
node ../../node_modules/vitest/dist/cli.js --run test/suite/context-maintenance-state-machine.test.ts test/suite/shake-threshold-avoids-compaction.test.ts test/suite/shake-compaction-budget-exhausted.test.ts test/suite/context-budget-integrity.test.ts test/suite/agent-session-compaction.test.ts test/suite/agent-session-trace.test.ts test/suite/agent-session-runtime.test.ts test/suite/grok-alignment/mid-prompt-compaction.test.ts test/suite/regressions/pre-prompt-compaction-no-continue.test.ts
```

代码修改完成后，在仓库根目录运行：

```bash
npm run check
bash ./test.sh
```

不得运行未经隔离的全量 Vitest。若当前 Windows 环境无法运行 `bash ./test.sh`，必须明确记录为未验证，不能把定向测试等同于全量离线回归。

## 16. 交付证据

实现交付必须包含：

- 实际修改文件清单；
- SM、IM、TR 测试 ID 到测试用例的映射；
- 每个自动入口迁移到统一状态机的代码位置；
- 一条完整的 `Default Shake → Soft Compaction → ready` Trace；
- 一条完整的 `no_progress → blocked` Trace；
- 一条完整的 `superseded → remeasure` Trace；
- 一条完整的 `committed + post-commit warning` Trace；
- Provider、摘要和工具调用次数断言；
- `npm run check`、定向测试和 `bash ./test.sh` 的实际结果；
- 未执行测试和已知限制，不得计为通过。
