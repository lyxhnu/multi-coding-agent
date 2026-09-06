# 基于持久记忆的上下文窗口管理方案

状态：代码实现、确定性行为验收和真实模型自动换窗验收已完成；用户排除的 provider `overloaded` 不计入功能缺陷。日期：2026-09-05。

后续修订见 [上下文换窗的状态保存与续跑可靠性](context-window-continuation-reliability.md)。该 Spec 基于真实仓储案例和当前代码，修订第 3、5.3、6.3、6.4、7、9 节的保存轮次、恢复材料与检查要求；修订代码、确定性行为和真实模型验收结果记录在该文第 11 节。

依据：用户提供的 Token Budget / new_context / History / Notes 架构分析，以及当前工作区实现。本文件描述目标设计，不将外部方案的服务端能力视为本项目已有能力。

## 1. 目标与关键决策

目标：每次模型请求的工作集有界；新窗口以最小内容启动，恢复内容只服务于接下来要做的工作；已经保存的任务信息可重新发现、读取和核对；换窗不改变任务、用户授权及待交付消息的语义。

根据用户补充要求，默认不向新窗口注入完整 Handoff、最近窗口消息、全部 Note 或完整 Todo。恢复是否可靠，与恢复正文是否预先装进 prompt，是两个独立问题。

用户进一步明确：新链路实施时同步删除被替换功能的代码及配套配置、类型、导出和测试，不保留僵尸代码。删除操作与替代实现一起交付。

本文件是自动窗口管理的现行契约。`context-rollover.md`、`context-maintenance-state-machine.md`、`task-note-projection.md` 和 `memory-context-integrity*.md` 中涉及旧自动压缩、Checkpoint、Handoff、History allowlist 和 credit 门禁的条款仅记录被替代设计，不再作为实现要求。手动摘要、Memory 有效视图、原始证据和交付语义仍适用；现行接口见 `../memory-context.md`、`../session-format.md` 和 `../rpc.md`。

将自动上下文管理改为：

```text
正常执行：最终请求预算测量 → 模型感知 → 关键变化写 Task Note
                                      ↓
模型请求换窗 / 系统达到工作预算阈值
                    ↓
当前 sampling 与完整工具批次结束，结果持久化
                    ↓
确认权威状态、TaskNoteProjection 与历史引用可恢复
                    ↓
构造最小启动描述，校验可恢复性、预算与 revisions
                    ↓
PreparedContinuation → CAS + append rollover
                    ↓
dispatch_started → 新窗口请求 → dispatch_finished
                    ↓
按下一动作读取必要 Notes / 权威状态 / History
```

换窗成为正常操作，不再以 Soft Compaction 失败为前置条件。自动链路只保留一种窗口切换策略，不新增旧策略兼容开关，也不在换窗失败后改走摘要模型。

模型负责语义整理和建议切换时机；系统负责真实请求的预算判定、工具批次结束位置、持久化和提交。Note 和按需检索仍有信息选择，方案不承诺模型无损记忆。

## 2. 当前实现中需要调整的连接点

| 当前代码 | 已有能力或限制 | 本方案处理 |
| --- | --- | --- |
| `packages/agent/src/agent-loop.ts` 的 `prepareAgentRequest()` | 转换、工具定义、append-only 组装后计算最终请求预算 | 作为唯一预算口径，增加模型可读的预算快照 |
| `packages/ai/src/utils/estimate.ts` | 适用时复用 provider usage，其余内容用启发式估算 | 明确标注估算来源，不宣称精确 tokenizer 计数 |
| `packages/coding-agent/src/core/compaction/compaction-policy.ts` | `twoPassEnabled` 默认关闭，控制 Checkpoint prefire | 任务状态保存脱离 two-pass compaction |
| `packages/coding-agent/src/core/context-rollover.ts` 的 `shouldStartContextRollover()` | 只接受容量维护 blocked 终态 | 改为统一接收模型请求和系统预算触发 |
| `packages/coding-agent/src/core/agent-session.ts` 的 `_executeContextRollover()` | 强依赖有效旧 Checkpoint、未覆盖 Active Suffix 和 Strong Progress credit | 用恢复引用快照与最小启动描述构造换窗，调整进展门禁 |
| `packages/coding-agent/src/core/tools/history-get.ts` | 只能读 Shake 或最新 Handoff 精确授权的旧条目 | 支持当前分支历史发现和读取，统一检索权限 |
| `packages/coding-agent/src/core/task-note-projection.ts` | 有证据索引、更新链、来源和 freshness | 继续作为唯一任务笔记投影，增加查询入口 |
| `packages/coding-agent/src/core/session-manager.ts` | 持久记录、分支、rollover、delivery 与 dispatch 重建 | 增加稳定窗口身份与历史查询投影 |

`context-rollover.ts` 当前公开的两个异步入口主要把工作转交给 dependencies，而大部分 orchestration 仍在 AgentSession。本次应将状态转换和校验迁入该 Module，使外部 Interface 对调用者隐藏内部顺序约束。

## 3. 感知：复用同一份请求预算

新增模型工具 `get_context_remaining()`，返回：

```ts
interface ContextRemaining {
  windowId: string;
  measuredAtEntryId: string | null;
  requestConfigRevision: string;
  inputTokens: number;
  remainingInputTokens: number | null;
  remainingWorkTokens: number | null;
  measurement: "usage_anchored_estimate" | "estimate" | "unknown";
  phase: "normal" | "save_state" | "transition_required";
}
```

`remainingInputTokens` 扣除当前请求输入、输出预留和现有安全余量；`remainingWorkTokens` 进一步应用工作阈值及保存状态的控制预算。预算字段未知时返回 null，不返回虚假的零或无限额度。

保存状态的控制预算按一次有界的 Note 更新请求、允许输出和控制结果开销确定；与正常输出预留分别记账，不能重复扣除同一项。它只用于整理状态，不用于扩大普通业务工具的执行额度。

工具查询返回最近完成边界上的预算快照并注明测量点；其自身工具结果和之后的新消息仍会占用 token。每次真正发送前继续测量最终请求，查询结果不是后续请求的容量承诺。

新窗口注入稳定身份及简短使用说明；进入 `save_state` 时提醒一次。提醒发送状态从 Session 事件重建，进程恢复不得重复发送。预算变化不改写已发送的缓存前缀，提醒作为新内容追加，其成本进入最终预算。

工作预算不足时，调度器停止开启普通业务 sampling，在完整工具批次结束位置处理换窗。若仍有硬容量，可执行一次受预算约束的状态保存轮次，工具集合仅含 Note 更新、预算查询和换窗请求。该轮次必须预先计入操作额度；达到硬限制后不得补发。

大工具输出可能直接越过提醒区间，因此“提前提醒”不是保证。已保存工具输出的回填仍需有界；记录中原本未保存的截断内容不能由 History 恢复。

## 4. 管理：统一的换窗请求与提交

新增 `new_context({ reason })`。参数只表达意图，窗口身份、操作 ID、权限和预算由运行时赋值。

工具处理器持久化换窗请求，并返回 `requested`；此时尚未切换。请求 ID 由来源窗口与 toolCallId 确定，同一请求恢复后不得重复提交。

Agent loop 在当前 assistant 的所有 tool calls 均有 terminal result、这些结果完成持久化后，返回明确的窗口切换控制结果。AgentSession 接管后 prepare/commit/dispatch。内部 loop 退出不表示用户任务完成，也不增加 promptGeneration。不能在仍运行的 loop 内递归调用 continuation。

多个并行工具中包含 `new_context` 时，整个批次按既有规则完成后才处理请求；请求本身不能取消或跳过其他已接受的工具。存在待确认交互或未终止的后台 Task 时不提交，完成后重新验证来源。

统一触发类型为：

```ts
type ContextTransitionCause =
  | "model_requested"
  | "work_budget_reached"
  | "provider_context_rejected";
```

三个入口执行相同的准备、校验和提交，不伪造 Maintenance blocked 记录。Provider 明确拒绝容量且没有可执行结果时，才按第三种原因处理；已经发生不确定执行的请求仍进入 outcome_unknown。

取消、新用户目标、Todo、队列或配置变化在提交前使 proposal 失效。重新组装最多一次，沿用现有有界 supersede 规则。任务已经完成且没有待续跑工作时，不为额度整理额外触发模型请求。

## 5. 记忆：本地权威历史与可查询笔记

### 5.1 窗口身份

为实际窗口增加稳定 `windowId`，并保存 `previousWindowId`、窗口开始位置及换出截止位置。初始窗口在第一次请求前持久化身份；换窗的目标 ID 只生成一次，写入原子 rollover 记录，resume 复用该 ID。

窗口身份描述物理上下文生命周期。现有 `promptGeneration/contextEpoch` 继续表达用户 prompt 和执行额度，二者不能代替 windowId：新用户 prompt 不一定清空模型上下文，现有 epoch 数字又会重置。

普通消息通过 Session 路径中的窗口开始/rollover 记录确定归属。新分支创建自己的窗口身份，记录祖先关系；默认可查询的记录仅为该分支可达祖先。子代理按各自 Session 隔离，不自动开放父代理或兄弟代理历史。

同一 windowId 用于模型提示、Session 记录、Trace 和 History 查询。本项目用本地 JSONL 保存权威记录，不依赖 Codex 后端 ingestion 协议。

### 5.2 History 查询

用统一 `history` 工具替换现有 `history_get` 工具定义，提供四种操作：

- `list_windows`：列出当前分支可达窗口，返回稳定 ID、时间及条目范围。
- `list_items`：按窗口、角色、工具名分页列出条目元数据。
- `read_item`：按 entryId、blockIndex 和偏移读取已保存正文。
- `search`：按字面文本搜索，返回有界片段及可读取引用。

四种操作使用同一个可见性判定：当前 Session、当前分支可达且已交付给本 Agent 的内容，以及系统明确公开的 Todo/Task contract 投影。恢复引用表达检索优先级，不再决定旧历史的访问权限。这样即使 Note 漏记某个关键词，模型仍有机会重新发现它。

查询不得绕过原有 Memory 可见性规则：历史 `memory_search/memory_get` 结果仍不能复播；待交付队列正文、隐藏推理、其他分支、未向模型公开的内部记录均不进入搜索语料。搜索结果和 list 元数据也必须先经过同样的过滤。

规范化记录包含角色、时间、windowId、entryId、工具关联及正文块；工具调用参数可以作为显式工具调用记录查询，隐藏推理块不投影为正文。Todo/Task contract 只开放已有模型可见字段，不能借此读取任意 custom/internal entry。非文本条目返回已保存附件引用与类型，不能声称文本查询能恢复全部多模态内容。

分页游标绑定查询条件、分支快照和可见性版本。单次扫描量和返回量都有上限，返回 continuation cursor；`exhausted=false` 时，空匹配不能解释为完整历史中不存在。读出的历史始终是带来源的数据，不能提升为系统指令或现行授权。

第一版按 Session 已加载的条目构造可重建索引，增量更新；不另建权威历史文件或远端归档系统。History 查询结果自身不进入搜索索引，避免递归索引副本。

### 5.3 Task Note 查询与维护

扩展 `context_note`，支持 `query`、现有 `upsert` 和 `retract`。query 可按 kind/key/字面文本过滤，默认返回有界目录元数据；显式选择 item 才读取正文、来源及 freshness。

query 的 resume 视图接受本窗口的恢复指针，返回目标/约束/当前 Todo 的权威引用，以及 next_action 与相关 Note 的定位信息。它从已有状态派生，不把 objective 或 Todo 写成 Note，也不默认展开全部恢复正文。

继续使用五种 Note Kind：constraint、decision、state、next_action、failed_attempt。objective、acceptanceCriteria、completedWork 的权威来源仍为用户消息、Task contract 和工具/Task 事实。

Note 作用域跨 windowId/contextEpoch 存活，`createdInContextEpoch` 只是来源信息。新用户 prompt 的作用域及旧约束是否继续有效，仍遵循当前任务规则，不能因为换窗自动扩大到其他任务。

修改同一 key 必须显式引用当前 eventId；撤销和替代必须在 Note 查询中生效，不能把旧 Checkpoint 中的同一事实再次拼回。多个不同 key 的 state 必须保留各自语义，不能用遍历顺序让最后一项覆盖其他项。

所有待展示为当前有效的事实，包括 completedWork 中的验证结论，都按证据类型检查时效。未知依赖范围或外部状态无法核对时标记 unknown，不把“过去一次工具未报错”认定为当前验收通过。

配额限制单次变更和活跃笔记集合。长期追加日志不应仅因累计事件数超过当前的 256 条就使整个有效投影不可用；运行次数和费用由运行时额度控制，旧 Note 事件保留审计。

## 6. 恢复入口：最小启动描述与按动作读取

### 6.1 Handoff、最近记录和 Note 是否需要注入

| 材料 | 默认注入新窗口 | 原因与读取方式 |
| --- | --- | --- |
| 当前适用的系统/开发者规则和工具定义 | 是 | 保持运行和指令语义；不是旧窗口恢复内容 |
| 窗口身份、恢复指针、简短恢复说明 | 是 | 让模型知道从何处继续，内容固定有界 |
| 完整 Handoff/Checkpoint 正文 | 否 | 与 Note、Todo 和历史重复；换窗提交改用引用快照 |
| 最近 N 条消息/Active Suffix | 否 | 时间接近不等于下一动作需要，相关条目显式读取 |
| 全部 Note 或完整 Note 目录 | 否 | 默认查询有界目录，再读取指定 key |
| 完整 Todo、completedWork、failedAttempts | 否 | 只读取当前动作涉及的状态，其他内容保留可查 |
| 当前应交付的用户/steering/follow-up 消息 | 按原交付规则 | 它们是新输入，不能为缩小窗口而隐藏或改写 |

Note 可以成为主要的语义恢复材料，但不能独立替代目标、有效用户约束、Todo 和执行事实。Note 保存的是有来源的判断；系统仍需保证这些权威材料可定位、可读且版本有效。笔记完整时，新窗口可能只需要读取少量 Note 及任务要求，无须访问最近窗口正文。

这里没有必要保留一份独立的、持续维护的 prose Handoff。现有 Handoff 的提交校验职责迁到恢复引用校验；其自动正文注入职责删除。也不能把原 Handoff 改名为 Note 后整包注入。

### 6.2 最小启动内容

启动描述只包含如下结构：

```text
<context_window>
window_id: <stable id>
resume_ref: <reference to this committed rollover>
Continue the current task. Resolve the resume reference with context_note.query.
Read the effective task requirements before dependent work; load details as needed.
</context_window>
```

resume_ref 使用 prepare 之前已生成的稳定 rolloverId，提交后解析到对应 rollover entry 中的已有状态引用：当前任务来源、有效要求来源、Todo revision、Note projection revision、历史截止位置和恢复检索起点。只保存 ID、版本和定位信息，不复制事实正文，不增加第二套权威账本。不得在 append 后才生成或改写指针，否则 PreparedContinuation 与真实请求不再相同。

512 个估算 token 是固定启动描述的体积回归目标，不是完整任务状态或全部恢复内容的容量，也不作为运行时裁剪必要内容的阈值。启动描述只允许固定模板和有长度约束的 ID，不能加入任意 Note 正文、任务摘要、路径列表或整个目录；其大小不随历史和任务规模增长。

本轮用项目现有 `estimateTextTokens()` 和两个 36 字符 UUID 测量了描述正文：

| 启动模板 | UTF-16 code units | UTF-8 bytes | 项目估算 token |
| --- | ---: | ---: | ---: |
| 本节英文模板，包含真实长度的 ID | 305 | 305 | 77 |
| 等义中文简短说明 | 206 | 296 | 52 |
| 英文说明加明确的 query 参数示例 | 475 | 475 | 119 |

当前函数使用 `ceil(text.length / 4)`，其中 length 是 JavaScript UTF-16 长度；这不是 provider tokenizer，也不能据此推断中文实际 token 更少。以上没有计入系统提示、工具定义、消息协议开销或新用户输入。结果说明 512 对当前固定入口有余量，不能证明任意任务可以在 512 token 内恢复。

实际运行以完成全部组装后的请求预算为准。模板体积异常增长应通过回归检查发现并修正生成逻辑，不允许 slice/truncate 启动描述来通过检查。首次查询返回必要的引用和分页游标，不能展开完整目录来绕过启动目标。

第一次新窗口请求是：

```text
当前系统/开发者上下文与工具定义
+ 最小启动描述
+ 按既有规则本次必须交付的新消息
```

不自动附加 Handoff、普通历史、Todo 全文或 Task Note catalog。需要同时修改 SessionManager 的上下文重建和 AgentSession 的 transform/projection 注入点，否则即使 rollover bundle 很小，后续转换仍会把正文加回来。

### 6.3 换窗前验证“能恢复”，换窗后读取“现在需要”

换窗前从权威状态和 Note 构造恢复引用快照，检查：

1. 当前用户目标、生效约束和验收要求有可解析的权威来源。
2. 当前 Todo/Task revision 与 Note projection 有效，目标未被新用户输入替换。
3. 下一动作或明确的恢复读取动作可定位，所依赖的结果没有被错误标记为已知成功。
4. 已保存历史覆盖完整工具批次截止位置，相关原始证据确实能按权限读取。
5. 来源与配置 revisions 在提交点仍匹配。

这个快照替换换窗所需的 summary Checkpoint，独立于 compactionPrefix。正常 Note 更新承担语义整理；换窗时不新增一次整段历史摘要模型调用。

换窗后先定位任务要求和当前动作，再按依赖读取指定 Note、Todo 或原始证据。已知必须适用的任务约束必须在依赖它的业务操作前读取；不能仅因 Note 没列出就当作不存在。系统只可验证引用和结构，不能靠 ID 校验宣称模型已经理解全部约束。

最近一批工具结果即使尚未写入 Note，只要已经持久化，仍可通过截止位置和工具关联读取；它们不会作为整段 suffix 注入。未完成工具批次不允许换窗。没有可用恢复入口时返回具体缺失项，不能以“历史总归还在”作为提交依据。

查询时按当前分支最新权威状态重新判断生效性和 freshness；resume_ref 中的版本是提交证明，不得让模型持续读取旧 Todo 或已被撤销的 Note。

### 6.4 防止“空窗口启动，第一轮又全部加载”

Note/History 读取与启动描述使用独立预算，不沿用 512。初始页预算建议为 2048 个估算 token，包含返回正文、元数据和游标，并按当前最终请求剩余工作预算缩小。读取首先选择所需 Note 条目或证据范围，能完整容纳的条目完整返回，长内容分页并返回精确引用及后续游标；搜索优先返回定位结果，不默认返回完整命中正文。工具参数中的预算只决定返回大小，不改变已经保存的内容。更短结果自然按实际大小返回，不填满额度。

同一恢复阶段不重复返回已读取的条目片段，除非来源版本变化或模型显式要求核对。实现用已有窗口消息中 entryId/版本/offset 识别重复，不新增一套持久“已读记忆”账本。

分页不是免除必要上下文的办法。如果下一动作确实依赖大量要求或证据，就需要相应工作集；不得为了数字漂亮而截断有效约束或提前执行。低延迟和最小预填存在取舍：本方案接受额外的有界检索轮次。

容量验收分别计量固定系统/工具开销、启动描述、待交付新输入、以及首次有效业务动作之前累计读取的恢复内容。取消“首请求小于半窗就说明恢复足够小”的质量判据；完整请求仍必须通过现有硬容量守卫，并为恢复与后续执行保留工作预算。

性能基准的起始目标：固定自动恢复描述不超过 512 个估算 token，初始读取页不超过 2048；常规恢复用例在首个有效业务动作前的恢复正文累计不超过 4096 个估算 token。512 和 4096 用于回归评估，不授权截断必要内容；单页完整性由显式分页和游标保证，真实发送容量由最终请求预算守卫保证。这些数值在行为基准中评估，不能只凭单个模板长度认定恢复质量已达标。

新增 `validateContextRecovery()` 校验恢复引用、权威状态版本和最终启动请求，删除旧 `validateFinalHandoff()`；不要求某些正文一定出现在首请求，也不保留旧名称的转发包装。引用可恢复性不能证明自然语言语义绝无遗漏，因此验收包含“只读必要内容仍正确完成下一动作”的跨窗行为测试。

## 7. 提交、恢复和循环约束

保留现有原子提交与发送协议：

```text
request recorded
  → safe execution position reached
  → recovery references + history readable through cutoff
  → exact PreparedContinuation created
  → revisions CAS + append rollover（唯一窗口切换提交点）
  → dispatch_started（含 reservedDeliveryIds）
  → provider continuation
  → dispatch_finished
```

Session/Todo/Queue/Progress/RequestConfig 以及 Note projection 的版本进入同一提交校验。新 windowId、最小启动描述、恢复引用、历史截止位置和预留 delivery 必须属于同一个 proposal。提交前必须确认必读引用在当前权限下能实际读取。

关键日志写入失败不得继续清除 active history 或发送请求。若声明支持断电恢复，需要让关键 authority/dispatch 日志完成相应持久化同步，并验证半行写入与恢复行为；当前同步 append 本身不能证明断电持久性。

| Crash 所在位置 | 恢复行为 |
| --- | --- |
| 请求已记录，未提交 rollover | 继续使用原窗口；等待完整工具结果后重新检查请求，不能重放未知工具 |
| rollover 已提交，未 started | 按固定 windowId 和 reservedDeliveryIds 重建相同请求，匹配后发送 |
| started，未 finished | outcome_unknown，禁止自动重放 |
| finished | 从目标窗口的权威消息恢复 |

next-prompt 消息仍仅在下一次用户 prompt 投影；换窗不消费它。commit 后新增消息留在队列，不能使已预留请求意外重建或重复交付。

删除 Strong Progress 换窗硬门禁，以及专门为该门禁服务的 credit 计算、消费记录和字段。纯阅读、检索和设计任务也需要多次换窗，不能要求这些任务制造写操作来获取 credit。已有 ContextProgress 事实仍被 Note 证据校验实际使用，因此保留；不为保住旧 credit 算法而另造一个观测消费者。

运行约束继续包括：每个来源窗口最多一次 commit、同一请求幂等、每个用户 prompt 最多 8 次换窗、有界状态保存轮次、重复或不缩小的目标请求被拒绝。该上限提供资源边界，不把 Note 自述当作已经完成业务进展的证明。

## 8. Module 与实施顺序

按 codebase-design 的深 Module 原则，内部 seam 设在 Agent loop 的完整工具批次结束处，AgentSession 与窗口 Module 通过小 Interface 协作。

| Module | 目标职责 |
| --- | --- |
| `packages/agent/src/agent-loop.ts` | 最终请求预算、完整工具批次完成后退出控制、PreparedContinuation |
| `packages/coding-agent/src/core/context-rollover.ts` | 接收 intent，推进状态保存、组装、校验、提交与恢复；从 AgentSession 迁入现有实现 |
| `packages/coding-agent/src/core/session-manager.ts` | authority 持久化、稳定窗口身份、分支重建、历史 cutoff |
| 新的包内 History Module | 统一可见性、规范化、分页与搜索；工具是其调用者 |
| `packages/coding-agent/src/core/task-note-projection.ts` | 可查询的派生索引、替代/撤销、证据时效 |
| `packages/coding-agent/src/core/tools/*` | 严格参数校验，调用上述 Interface，不拥有换窗状态机 |

实施依赖顺序：

1. 建立窗口身份、History 可见性与可恢复查询；补齐 Note 查询。
2. 用恢复引用快照替换 summary Checkpoint/Handoff 的换窗依赖，移除 suffix/Todo/Note catalog 的自动恢复注入，验证最小启动请求。
3. 在请求准备和 loop 完整工具批次结束处接入预算快照、提醒及 new_context。
4. 统一自动换窗入口，迁移现有提交与恢复逻辑，删除 Strong Progress 门禁与专用 credit 状态。
5. 切换自动主链并更新工具注册、CLI/RPC/Trace、Session 格式及 Spec 验收矩阵。

以上是同一目标设计的交付顺序，不是长期并行运行的多套策略。

旧自动路径中被替换的部分：Soft Compaction 多次重试、Rescue 后才能 rollover 的条件、two-pass 为换窗生成前缀摘要的耦合、换窗后自动回填 Handoff/普通 Active Suffix/完整 Todo/Note catalog 的规则。

确定性 Shake 继续承担工具输出工作集缩减。用户显式 `/compact` 的摘要需求与自动换窗是不同操作，保持独立；本方案只替换自动容量管理主链。手动 compaction 也必须生成明确的窗口生命周期记录，使实际请求身份和历史查询一致。

### 8.1 与替代实现同步完成的删除清单

| 删除对象 | 当前定位及连带清理 |
| --- | --- |
| 整段 Handoff 的构造和注入 | `context-rollover.ts` 的旧 Note/Bundle schema、prompt、parser、assembler、merge 和 validator；`messages.ts` 的 Handoff formatter；`session-manager.ts` 对旧正文的重建路径 |
| 前缀摘要 Checkpoint 通路 | `_maybeStartTwoPassPrefire()`、`_validPrefixCheckpoint()`、`_validContextRolloverCheckpoint()`、专用 in-flight Promise/controller、Checkpoint envelope/parser、two-pass 增量摘要分支；专用 `compaction/checkpoint.ts` 在所需通用校验迁移后删除 |
| 只服务于旧 Checkpoint 的 Note 批量候选入口 | 旧 checkpoint candidate source、batch envelope 解析和提交耦合；正常 context_note 更新及其证据校验继续保留 |
| Active Suffix 自动恢复 | `activeEntryIds` 的持久化、扫描、20% 门禁和回填；完整工具批次的公共校验保留用于新提交位置检查 |
| Todo/Note catalog 自动恢复注入 | Session 重建中的 Todo 全文注入；`TASK_NOTE_REFERENCE_CATALOG_*`、目录构造、transform 自动追加以及专用 usage projection 过滤；调用者提供的通用转换能力保留 |
| 旧自动缩减状态机 | Soft Compaction 重试、Rescue 后 rollover 的触发关系、失效状态/额度/失败原因，以及只有旧路径使用的 Module/export |
| 旧 History 授权及工具名称 | `historyAllowlist`、旧 `history_get` 实现和注册/导出/权限名单/说明；由统一 history Interface 与可见性规则接替，不保留别名 |
| Strong Progress credits | `collectStrongProgressCreditIds()`、`no_strong_progress` 原因、已消费 credits 集合、`strongProgressCreditIds` 持久字段和专用 Trace 字段；原始事实证据不删除 |
| 专用配置与统计字段 | `twoPassEnabled`、`TWO_PASS_PREFIRE_MARGIN_PERCENT`、`shouldPrefireTwoPass()`、`prefixUsage` 专用通路及其无消费者的配置/UI/RPC/统计字段；仍被显式 compaction 使用的设置按实际引用保留 |
| 失效测试与文档约束 | 专测被删除行为的测试、fixture、mock 和 Spec 条款一起删除或改写；跨窗恢复、队列、证据、预算的有效行为断言迁入新 Interface 测试 |

清理针对源代码及失效契约，不删除用户 Session JSONL、工作文件或历史证据。目标 Session 格式和 SDK 类型一次性更新，不为旧实现增加双路径、deprecated 包装或配置兼容分支。

### 8.2 删除验收

- 每项被替换能力都在同一交付中完成旧调用点、实现、类型、字段、导出、配置、测试和文档清理；不能仅把开关默认改为 false。
- 保留的辅助函数必须有实际生产消费者。空转发、返回固定值的旧入口、只为旧接口存在的 adapter 和无消费者的日志计算不保留。
- 全库引用搜索检查旧符号、旧工具名和失效配置；剩余命中必须有明确有效用途，不能以“以后可能用到”为理由保留。
- 对共享文件按功能切分，避免删除仍服务于手动 compaction、分支摘要、Note 证据、队列与 dispatch 的有效实现。
- 替换旧实现测试；不得用 skip/注释把旧断言留成不再运行的测试代码。新的验收通过生产 Interface 检查实际请求与恢复结果。
- 新链路定向测试和 `npm run check` 通过后才算完成；没有新入口接管之前，不单独删除仍承担运行职责的旧实现。

## 9. 验收矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| 未配置任何 two-pass 选项 | 正常保存状态与换窗；代码和配置 schema 已删除失效的 twoPassEnabled |
| 模型低预算查询 | 返回带测量点的预算估算，真实请求再次通过同一预算守卫 |
| 提醒后恢复进程 | 不重复发送同一窗口提醒，不重置已消耗额度 |
| 保存状态轮次 | 预算和工具集合受限，不执行普通业务副作用工具 |
| new_context 与其他工具同批 | 全部 terminal results 保存后才换窗，旧窗口无悬空 toolCall |
| 硬容量被一次大输出越过 | 使用已具备的恢复材料处理；不足则明确停止，不发超预算保存请求 |
| 模型请求/系统触发 | 经过同一提交和发送路径，未改变 promptGeneration |
| Note 未列出的旧细节 | 可通过 search → read 找回真实来源 |
| 新窗口首次请求 | 没有完整 Handoff、旧消息、完整 Todo 或 Note catalog；恢复启动描述不超过 512 个估算 token |
| 启动模板长度回归 | 固定模板和有界 ID 的体积有实测依据，不通过截断描述满足指标 |
| 启动预算与读取预算 | 512 不限制 Note 正文或完整任务状态，必要内容按条目和分页读取 |
| Note 足以说明当前状态 | 读取任务要求和必要 Note 即可继续，不默认读取最近窗口 |
| 首次读取恢复入口 | 返回有界引用，不借工具结果注入整包 Handoff |
| 增加大量旧历史/无关 Note/Todo | 自动注入量不随之增长，常规下一动作的恢复读取量保持有界 |
| 最新工具结果未写成 Note | 按恢复截止位置找到精确条目，无须加载整个 suffix |
| 必要约束正文超过单页 | 分页核对后才执行依赖动作，不为满足指标遗漏约束 |
| 分支、子代理和 Memory 视图 | list/search/read 一致隔离，旧 Memory 内容不能经搜索泄漏 |
| 搜索扫描预算耗尽 | 返回 continuation cursor，不把部分未命中当作全量不存在 |
| Note 被替代或撤销 | 新窗口不再出现旧有效结论；多条 state 不互相覆盖 |
| 验证通过后源码改变 | Note/证据查询明确 stale/unknown，不宣称当前验证仍通过 |
| Todo 或 steering 在 prepare 时变化 | 旧 proposal 不能提交，新消息不丢失、不重复 |
| 纯阅读任务连续换窗 | 不要求写入副作用来获取 Strong Progress credit |
| 不断请求空换窗 | 被相同/未缩小请求检查及累计次数上限约束 |
| commit/start/finish 各位置 crash | 恢复行为与上表一致，未知结果不重放 |
| authority 日志写失败 | 不切换 active context，不 dispatch |
| 新用户 prompt 与 Session fork | task/epoch/window 身份不混淆，历史范围正确 |
| CLI/RPC/Trace | 内部换窗不伪装成任务完成，能观察触发原因与恢复状态 |
| 替代链路交付 | 旧实现、无用字段、开关、导出、测试和文档契约同步清理，无僵尸入口 |

行为测试使用 coding-agent 的 suite harness 与 faux provider；断言实际新窗口请求、工具调用次数、检索结果及磁盘恢复结果。实现后运行被修改的定向测试和 `npm run check`。

质量验收还需比较同一长任务换窗前后：目标与约束保持、重复工具执行次数、找回关键细节成功率、启动注入量、首次有效业务动作前的恢复读取量和延迟。旧历史与无关 Note 增长时，首请求必须保持稳定小；仅把大 Handoff 从首请求移到首次工具读取，不算完成本方案。

## 10. 实现与回归入口

| 覆盖范围 | 定向测试 |
| --- | --- |
| 初始窗口落盘、完整批次、固定启动内容、要求恢复、保存状态工具和预算、三类触发、八次上限 | `test/suite/context-window-memory.test.ts` |
| 并发来源变化的一次重组、steering 保留、后台任务等待、提交失败、prepared 重启、unknown 不重放、JSONL 尾部 | 同上 |
| History 可见性、Unicode 分页、空命中续扫、按查询位置计算游标进度、读取去重与 shake、长 Todo 分页、Note 长期更新、Todo 分支恢复 | 同上 |
| recovering 失败后输入新目标 | 旧 rollover 不进入新 promptGeneration/window 的工具门禁，新任务可正常执行；同上 |
| Note 更新/撤销/多 state 与证据时效 | `test/suite/task-note-projection.test.ts` |
| 硬预算、扩展转换、队列交付、Trace | `test/suite/context-budget-integrity.test.ts`、`agent-session-queue.test.ts`、`agent-session-trace.test.ts` |
| 手动摘要、Memory 档案、Session 重建与 shake 重放 | `test/suite/agent-session-compaction.test.ts`、`memory-*.test.ts`、`test/session-manager/*.test.ts` |
| CLI/RPC 未完成状态 | `test/print-mode.test.ts`、`test/rpc-prompt-response-semantics.test.ts` |
| Agent PreparedContinuation、请求与工具批次控制 | `packages/agent/test/prepared-continuation.test.ts`、`agent-loop.test.ts`、`run-state.test.ts` |
| 仓储真实文件与生产工具续跑 | `test/suite/warehouse-continuation.test.ts`，覆盖 18/22→22/22、语法检查和跨窗首个业务动作 |

这些测试使用 faux provider 或本地模拟流，不调用真实模型。它们验证结构、恢复顺序、工具执行和容量界限；不将脚本化恢复结果表述为真实模型的长期语义质量或延迟基准。进程中断恢复不包含断电持久性承诺。

2026-09-05 初始本地验证为 coding-agent 23 个定向测试文件 228 项通过、2 项跳过，agent 4 个定向测试文件 80 项通过；仓储确定性验收使用生产 read/bash/edit/write 工具完成 18/22→22/22，并通过语法检查。真实验收随后发现并修复两项宿主/控制提示问题：print 模式在后台 Task 阻塞换窗时过早 dispose，导致 Task 被取消；同一任务后续保存没有明确要求用当前 eventId 执行 Note supersession，且 next_action 容易把所有剩余工作重新打包为一次全量读取。print 模式现在等待活动 Task 终态及延后换窗收敛；保存提示要求显式 supersedesEventId、一个窗口内可完成的单一即时动作、已完成 Task/Memory 读取和精确失败事实。

真实 `rrver/gpt-5.4` 隔离 Session `01a07274-5660-7c92-b1d8-6f21f170bc31` 保留了全部用户消息和配置变化。36k/65% 阶段如实记录了工作集不足、重复读取和两次 subagent `overloaded` 终态；按用户要求不修改 provider 重试、`outcome_unknown` 或 overloaded 处理。改进后同一 Session 使用 48k/80%，在一个用户回合内自动保存三版具体 Note、完成三次 rollover/recovery，并依次修正 `warehouse.js`、实现 CLI、执行验证；Todo 最终全部 completed，Memory 约定经 `memory_get` 读取并落实。独立复跑得到 22/22；后续真实回合新增取消审计/重启测试，发现并修复 reasonCode 重建缺陷，最终独立得到 23/23 和 `npm run check` 成功。最终仓库回归为 coding-agent 14 个文件 152 项通过、2 项跳过，agent 3 个文件 40 项通过；根目录 `npm run check` 和 `git diff --check` 通过。真实对话、Note 版本、换窗和恢复页导出到 `rrver-warehouse-mechanisms-session.html`，未包含认证值。
