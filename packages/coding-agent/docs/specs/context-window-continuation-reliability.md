# 上下文换窗的状态保存与续跑可靠性

状态：代码实现、确定性行为验收和真实模型行为验收已完成；用户排除的 provider `overloaded` 不计入功能缺陷，subagent 成功提交路径由确定性回归覆盖。日期：2026-09-05。

依据：[基于持久记忆的上下文窗口管理方案](context-window-memory-proposal.md)、当前工作区实现，以及仓储预留系统的真实模型测试。本文定义修订后的实现契约，并在第 11.3 节记录当前代码与验收状态。

本文修订原 Spec 第 3、5.3、6.3、6.4、7、9 节中有关保存轮次、恢复材料和恢复检查的条款；其余目标继续适用。实现时直接替换相应逻辑，不增加策略开关、兼容分支或第二条自动换窗链路。

## 1. 结论与证据

上一轮方案方向正确，但不能原样实现。仅增加必写 Note 和工具门禁，会把部分空换窗变成保存失败或恢复死循环。必须同时处理保存请求的实际容量、引用发现、控制额度、完整结果持久化，以及恢复材料进入实际请求的顺序。

### 1.1 真实案例已经证明什么

任务是完成零依赖 Node.js 仓储预留系统，包含 JSONL 事件存储、并发预留、幂等、过期、重启重放和 CLI，共 22 项验收测试。模型为 `rrver/gpt-5.4`。24k、48k、32k 是测试使用的本地窗口配置，不表示提供商的物理窗口上限。

| 原始记录 | 已确认的观察 | 不能据此得出的结论 |
| --- | --- | --- |
| 24k Session `01a0711d-71d0-7fee-bb0a-1906e153865c` | 完整 JSONL 有 8 条 rollover、0 条 Task Note、0 条 save_state 操作；经历重复读取 | 纯阅读本身就是无效工作，或者应恢复 Strong Progress credit |
| 先 48k、后改为 32k 的 Session `01a07120-80ab-7820-bfc8-cbc2c10412a1` | rollover `cd7f9e4a-7d95-4b3b-a72b-d225af981ac0` 从 27,253 个估算输入 token 切到 6,246；0 条 Note、0 条保存操作 | 首请求变小就证明 Note 足以续跑 |
| 对部分实现的独立验证 | 18/22 项通过；CLI 两项、跨命令幂等冲突、重启后的 reserved 重建仍失败；Windows 语法检查脚本也失败 | 四个业务失败都是换窗造成的，或换窗修复后模型一定能修完 |
| 新窗口遇到提供商中断 | 自主读取恢复材料和完成后续工作的轨迹不完整 | 新窗口已经完成恢复，或已经证明其语义恢复失败 |

原始记录位于测试目录 `C:/Users/16474/AppData/Local/Temp/pi-real-warehouse-20260905/` 的 `sessions/`、`sessions-48k/` 和 `run-32k-resume*.log`。Session 是证据来源，HTML 是派生展示。先前观察到的 7 次换窗是中间统计；完整记录以 8 次为准。

用户明确排除 rrver 返回的 24 次 `overloaded`：本次不修改 provider、重试、dispatch 的 `outcome_unknown` 判定或退出码策略。服务中断的运行标注“行为验收未完成”，不能删除错误后把余下片段拼成一次通过。

### 1.2 代码问题与上一版遗漏

路径以下均相对仓库根目录。

| 问题 | 当前连接点 | 本文处理 |
| --- | --- | --- |
| 普通请求不适配就跳过保存 | `agent-session.ts::_installContextGuard()`；`context-budget.ts::contextRemaining()` | 对保存请求独立组装、测量；普通请求的 context_limit 不等于保存请求也放不下 |
| 把尝试保存当作保存完成 | 存在 `${windowId}:save_state` 的任意操作记录即跳过；只写 started | 区分 started 和有验证结果的 finished；恢复不得重置额度 |
| 查完引用就自动换窗 | `agent-loop.ts` 在 savingState 的首个工具批次后无条件退出 | 有界保存阶段允许引用查询、Note 更新和一次修正；有效结果决定完成 |
| 保存时无法发现证据 | 保存工具集没有 History，guard 禁止 Note query | 开放受控制额度约束的查询；不要求模型猜 entryId |
| 查询额度为零 | History 和 Note 共用 remainingWorkTokens；进入保存阶段正好为零 | 区分业务额度与状态保存额度，按阶段提供查询预算 |
| 大结果吃掉保存空间 | `tools/tool-result-budget.ts` 只有固定单结果字节/行上限；在消息落盘前缩小内容 | 在完整批次级别保留保存空间；先持久化可保存结果，再生成有来源的有界投影 |
| 空 Note 也能提交 | `context-rollover.ts::validateContextRecovery()` 只验证投影有效，未验证续跑动作 | 必须有已确认的续跑 Note 和可解析的必要依赖 |
| 同批 Note 与修改可能错位 | `new_context`、Note 和业务工具可同批出现 | 全部 terminal result 落盘后确定业务 cutoff；较早的 Note 不能自动覆盖较晚结果 |
| 恢复入口夹在全部目录中 | `task-note-query.ts` 在 resume 查询后按投影顺序追加全部 Note | 优先返回明确的当前动作和直接相关引用；无关目录按普通查询访问 |
| 查过目录就被当成恢复 | 新窗口只有恢复提示，没有执行检查 | 检查必读正文的完整片段是否进入前一真实请求，目录、空响应和 details 不算 |
| 限制了工具却没有恢复出口 | 上一版未定义何时解锁、材料放不下怎么办 | 明确恢复阶段和容量终态；未恢复完成不能再次自动换窗 |
| 固定强制 state/failed_attempt 不通用 | `bash` 无法仅按工具名判定写入，失败也不都值得长期记忆 | 对所有任务统一要求明确下一动作；状态、决策和失败由模型按续跑依赖记录，系统验证引用和结构 |
| 新 prompt 后旧事实难以重用 | `resolveTaskNoteScope()` 与 `sameScope()` 把投影绑定 promptGeneration | 区分当前有效 Note 与可查询的旧任务 Note；明确延续任务时引用原始要求，不能只留下“继续” |
| 现有回归肯定了错误行为 | `test/suite/context-window-memory.test.ts` 将 Note query 报错后仍换窗作为成功 | 用真实文件、真实工具执行和实际请求断言替换该用例 |

## 2. 目标与可证明范围

目标链路为：正常工作积累信息，达到工作阈值后保存当前续跑动作及所需事实，在完整工具批次落盘后原子换窗；新窗口读取任务要求与必要 Note，继续尚未完成的工作。

必须同时满足：

1. 普通业务请求、保存请求、恢复请求均通过最终组装后的同一预算守卫。
2. 模型不会自觉写 Note 时，运行时也会安排保存阶段；没有合格续跑入口时不提交空换窗。
3. 已接受工具批次全部终止并持久化，才可关闭旧窗口；失败结果与成功结果同样保留。
4. 保存、换窗与恢复不增加 promptGeneration，不吞掉新消息，不恢复未知副作用。
5. 新窗口的第一次请求只含当前规则、阶段说明、窗口身份、resume_ref 和本次应交付的新消息。
6. 不把必读正文提前整包注入首请求；必须通过受预算约束的查询读取。
7. 完成恢复检查表示材料已经可供模型使用，不表示模型理解无误。Note 的语义质量用真实任务结果验收。

本次不承诺修复仓储系统本身的四项业务错误，也不通过脚本替模型修完案例。它们是后续续跑质量的验收目标。

## 3. 一条状态链

```text
normal
  → 当前完整工具批次结束并落盘
  → save_state（必要时最多 3 次 sampling）
  → saved（续跑契约验证通过且 finished 落盘）
  → prepare / revisions CAS / append rollover
  → recovering（仍属于同一用户任务）
  → 必读正文进入真实请求，恢复检查通过
  → normal（从下一动作继续）
```

模型主动 `new_context({reason})`、工作阈值、现有 provider context rejection 三个入口共用该链。`new_context` 继续只表达意图，窗口 ID、操作 ID、cutoff、权限、预算及提交时机由运行时决定。

任务已按现有完成语义结束且没有待续跑工作时，不为保存 Note 新开请求。保存阶段中的空回答、“已经保存”或口头“完成”不能使未满足的续跑契约通过，也不能被当作用户任务完成。

恢复尚未完成时不得启动下一次自动换窗。容量不足、引用失效或额度耗尽应产生具体的未完成原因；正常上限仍为每个 prompt 最多 8 次换窗。纯阅读任务可以在完成恢复、读取新的必要材料并保存新续跑动作后再次换窗，不要求写文件获取额度。

## 4. 预算与工具结果

### 4.1 使用实际请求形状判断

保留最终请求测量作为唯一口径。系统/工具定义、消息转换、图片、扩展结果、队列输入、控制提醒都进入计量。工具集合变化后，旧 usage 锚点只有在原指纹规则允许时才能复用。

预算区分三个用途：业务工作、状态保存、恢复读取。`get_context_remaining` 增加 `remainingControlTokens` 和 `recovering` 阶段；未知值仍为 null。remainingControlTokens 在保存阶段表示整个保存阶段尚可消耗的控制空间，在恢复阶段表示当前恢复请求扣除输出、安全余量及后续正常执行预留后的读取空间；normal 阶段为 null。字段必须标明快照测量点，不宣称一次查询保证后续所有请求有空间。

保存阶段初始上限：最多 3 次 sampling；模型累计新增输出预留 2,048 个估算 token，查询结果、提醒、协议与修正反馈累计预留 3,072 个估算 token。这是整个阶段的共享上限，不是每次调用各领取一份。实现前用最大允许形状核对计量；业务工具定义与保存工具定义的差额按实际请求计算。

发送普通请求前必须为其可能新增的模型输出、工具结果最小引用结构及保存阶段留下空间。保存预留应进入请求准入和工具结果投影，而不只是从 UI 数字减去一个常量。

对同一已选请求形状，约束可写为：

```text
I + O + S + R <= C
I：最终输入估算
O：本次请求实际生效的输出预留
S：现有安全余量
R：该阶段仍需保证的后续控制/结果空间，排除已计入 I 或 O 的部分
C：当前配置窗口
```

进入保存阶段后，其本次输出只计入 O；后续查询和 sampling 的未消耗预算计入 R。不能先扣普通输出预留，再重复扣保存输出；不能把 3,072 作为 2,048 输出之外任意新增工作的授权。

普通请求为 `context_limit` 时，构造保存工具集和保存输出上限后重新测量，不直接换窗。保存请求本身不适配时禁止发送。27,253 + 2,048 + 当前 4,096 安全余量已超过 32,000，因此不能仅凭“换成小输出”断言上轮一定能保存；必须测量工具定义差额，并在此前控制工具结果增长。

### 4.2 完整批次的结果投影

大结果处理属于正常工具执行链：

1. 工具和现有 result hook 结束后，先在 Session 权威记录中保存可持久化的结果及 terminal 状态，取得稳定 entryId。
2. 为发送给模型的整个批次分配一个共享空间，保证全部 toolCallId 都有 terminal result，并为保存阶段保留空间。多个结果不得各自使用一整份剩余额度。
3. 无法完整内联的文本结果返回有来源的片段、原始 entryId、正文范围及分页提示。结果正文不被声称完整；模型未见部分不能被概括成已知事实。
4. 新增的容量投影沿用现有 Session/Shake 重建机制，落盘后再影响请求。重新打开 Session 时，原文仍可查，模型视图仍有界。不能重新把完整大结果载入模型消息。
5. 原始工具自身已经丢弃的内容仍不可恢复；附件需要已有可读载体，不能仅凭 MIME 元数据算作已阅读。

权限与可见性继续按已有规则执行，内部 details、隐藏内容和历史 Memory 结果不因“完整保存”而进入 History。投影在外部 hook 后统一执行；不能让 hook 在预算检查后重新放入大正文。

已发送的原始用户要求和必要约束不裁剪。若当前不可缩小的请求、图片或外部新输入使保存请求仍不适配，保留旧窗口与历史，返回 `save_state_budget_exhausted`。若此前已有覆盖当前事实的合格续跑契约，可按同一校验提交；没有则停止。不得伪造 Note 或切到另一种摘要链路。

### 4.3 保存查询的额度

保存阶段开放 `history`、`context_note`、`get_context_remaining` 和 `new_context`，业务工具保持不可执行。History/Note 的返回上限取单页上限、阶段剩余额度和当前请求实际容量三者的最小值。

查询不再使用值为零的 remainingWorkTokens。并行查询先预留同一个阶段额度，结束后按实际占用结算；失败、修正反馈和模型输出同样收费。额度和 sampling 次数从 Session 恢复，重启不返还已消耗额度。

## 5. 可执行的状态保存

### 5.1 发现原始引用

保存阶段首条提醒包含固定说明、业务 cutoff 和查询方法，不自动附加完整历史或 Note 目录。

History 的 `list_items` 增加 `toolCallId` 精确过滤，能把模型已见的工具关联解析为原始消息引用。结果同时提供该调用可用的证据定位信息；只公开现有 Note 证据消费者所需的字段，不开放任意 custom/internal entry。Note 元数据查询继续返回当前 eventId，用于显式 supersession。

在最多 3 次 sampling 内，模型可以依次查询来源、写入 Note、依据工具错误修正一次；来源已知时直接写入。每个完整控制批次结束后验证契约，满足后立即结束，不强制用满轮数，也不额外要求一次 `new_context` 才承认保存成功。

### 5.2 续跑 Note 与直接依赖

沿用五种 Note Kind。约定 `kind=next_action, key=current` 是当前自动续跑入口；同 key 更新必须引用当前 eventId。其他 next_action 可以作为备选笔记存在，但不会随机被选作启动动作。

该入口使用现有 text、sourceRefs、evidenceRefs；增加仅适用于此类续跑入口的结构化 `resume` 字段：

```ts
interface NextActionResume {
  relatedNotes: Array<{ kind: TaskNoteKind; key: string }>;
  requiredHistoryRefs: TaskNoteReference[];
  requirementSourceRefs: TaskNoteReference[];
  todoIds: string[];
}
```

每个数组最多 8 项；需要更多业务材料时，将下一动作写成逐步定位或核查，不把全部材料打包进该字段。此上限只限制模型显式选择的直接依赖，不限制运行时必须保留的有效用户要求集合。relatedNotes 是直接依赖，不递归遍历整个 Note 图；禁止指向自身。key 引用在提交时解析为当时的有效 eventId，避免要求模型猜同一批次尚未返回的新 eventId。todoIds 指向现有 Todo 权威项，不另建任务清单。

resume 是 next_action/current 的必填字段，其余 Note 不携带该字段。没有对应依赖的数组允许为空，当前任务来源及其已交付要求由运行时强制纳入，不能通过空数组取消。四个数组去重；字段与现有 Note 校验、事件 hash、投影、supersession 和序列化同步更新。

`text` 描述下一项具体动作、对象和完成该动作的判断依据。例如：核对某文件某段实现，修复一个明确失败，再执行指定测试。不得只写“继续任务”“阅读所有历史”。后两种文本是行为质量不合格的例子，不用字符串黑名单冒充语义校验器。

relatedNotes 由模型选择当前动作所需的 state、decision、constraint 或 failed_attempt；requiredHistoryRefs 只列当前动作确实必须回读的原始材料，不能把所有证据自动展开。尚未阅读的大结果应明确记录为“待读取的结果”，下一动作先读取对应原文。

不固定要求每次都写 state 和 failed_attempt：阅读/设计任务可以使用已有结论、决策和下一读取位置；已经修复的临时错误不必列为未解决问题。编码任务中影响后续操作的已完成修改、当前测试失败和验证限制应写成相关 Note，由行为验收检查是否遗漏。

state/failed_attempt 继续按既有证据类型校验。内置 bash 的非零退出已经走错误路径，保留该行为；验证结论必须引用真实终态或已保存的确定结果，不能从工具名称、模型文字或“工具成功返回”推断当前验收通过。没有可核对的结果时，在 next_action 中写明待核查及验证动作，不编造 state 或“18/22 已通过”。

### 5.3 完成标记与截止位置

`save_state.started` 保存 operationId、windowId、promptGeneration、businessCutoffEntryId、起始 Note revision 和阶段额度。businessCutoff 是进入保存前最后一个完整业务批次或已交付输入的截止位置；Note/query/control 事件本身不使它不断向后移动。

同一 `(windowId, promptGeneration)` 只有一个保存操作；重复 intent 和进程恢复复用该操作，不能刷新额度。新用户 prompt 按原规则取消旧候选后可以建立本代操作；旧 prompt 的 started/finished 与内存工具限制不能泄漏到新一代。操作 ID 由运行时生成并持久化，不由模型传入。

有效入口必须在该业务 cutoff 之后写入或明确更新；若已有入口之后没有新的业务结果/输入，且其依赖仍有效，可以直接验证并复用。不能仅比较 Note 总数或存在某个旧 next_action。

`save_state.finished` 只在以下条件成立后追加：

- 续跑入口、直接相关 Note、要求来源和必读原文均在当前分支实际可访问。
- 更新链、撤销、任务作用域和来源检查通过，所有已接受控制工具调用均有持久化 terminal result。
- 保存期间没有新的业务事实、输入或 Todo 变化使候选失效；需要重新确认时沿用同一阶段剩余额度。
- 记录 operationId、businessCutoffEntryId、最终 Note revision、nextActionEventId、relatedNoteEventIds 和当前控制预算消耗。

该记录证明结构与引用校验完成，不证明模型语义上概括了所有结果。Note 正文仍只存于 Task Note 事件；finished 不另存一份 prose Handoff。

finished 按 operationId、业务 cutoff 和投影 revision 幂等。提交前出现新的已交付事实时，旧 finished 失效；只能在该操作剩余额度内重新确认并追加新版本校验结果，不能把旧 finished 改写，也不能新建操作刷新额度。

3 次 sampling 或累计额度用尽仍不满足契约时，返回 `continuation_state_missing` 或具体引用错误，保留已成功写入的 Note 和原窗口。不追加 finished 或 rollover。一次失败 Note 更新不能让整批其他已成功更新消失，也不能让旧 next_action 自动被当成本轮成功。

## 6. 提交与恢复的精确引用

rollover.recovery 增加 `saveStateOperationId`、`nextActionEventId`、`relatedNoteEventIds`、`requiredHistoryRefs`、`requirementSourceRefs` 和 `todoIds`。这些都是已有权威条目的引用；任务正文、Todo 和 Note 正文不复制进 rollover。

`validateContextRecovery` 检查 finished 与当前事实 cutoff 一致，Note projection 和要求来源有效，所有待展示引用能够按真实工具权限读取。`historyStartEntryId` 只能是检索辅助，不能代替续跑入口或只指向全任务最后一个 toolResult 就宣称恢复完整。

保存/恢复所需工具被用户禁用或其确切查询被权限拒绝时，在进入相应阶段前报告 `recovery_unavailable` 及缺失操作，不擅自激活工具、放宽权限或发起必然无法完成的保存调用。权限检查必须使用实际引用和查询参数，不能只测一个缺少 entryId 的通用 read_item。

准备目标请求之前选定 recovering 阶段工具集；prepare、commit 后的上下文重建和 dispatch 使用同一工具配置与指纹。禁止先按全工具集 prepare，再在 dispatch 时临时改成恢复工具集。

原有 revisions CAS、最多一次重新组装、每个来源窗口一次 commit、reservedDeliveryIds 和 dispatch 恢复协议保持。候选因 Todo、任务目标、权限或要求变化失效时，必须重新验证保存契约；只刷新 request fingerprint 不足以恢复候选有效性。

resume 查询的第一优先级是任务要求引用、唯一续跑入口及其直接依赖。无关 Note 不排在这些内容前面；普通目录查询仍可用于其他笔记。入口引用也要分页，不为返回完整目录突破预算。

History 的 `read_item` 对 Todo 条目支持 `todoId` 选择：仅在对应的已公开 todo-state 投影中读取该项，返回源 entryId、Todo revision 和字段完整的正文；一般消息不能使用该参数。恢复查询根据 todoIds 返回这些精确调用参数，现有 Todo revision 校验适用。没有 Todo 的任务不要求模型凭空创建 Todo。

提交后 Note 被替代或撤销时，保留原 eventId 作为审计版本，查询按 kind/key 明确报告当前有效版本及变化。必读集合随有效版本更新，旧正文不抵消新版本的读取要求；入口被撤销且没有新的有效入口时，报告 `recovery_reference_invalid`，不得静默跳过。

## 7. 新窗口恢复检查

### 7.1 检查哪些内容

recovering 阶段允许 `history`、`context_note` 的 query 和 `get_context_remaining`；业务工具不可执行。`new_context` 不能绕过恢复检查。Note 更新在正常工作恢复后继续执行，避免一边读一边无约束修改必读集合。

必须完成：

1. 解析当前 resume_ref，得到有界必读引用。
2. 读取当前任务的有效用户要求、随后已经交付的约束，以及续跑入口明确关联的原始要求来源。当前系统/开发者规则已经在请求中，不通过旧 Note 重新赋予其效力。
3. 读取 next_action/current 的完整正文及相关 Note 的完整正文；Todo 存在时读取当前动作相关的权威项，而不是强制读取整个 Todo。
4. 读取 requiredHistoryRefs 指定的材料。其他证据保留按需读取；stale/unknown 应作为核查条件，不能被当成当前成功结论。

对以当前事实为前提的依赖操作，模型仍需先核对文件或外部状态。恢复检查不通过文本里的“已通过”替代实际验证，也不声称能够自动判断所有外部事实的新鲜度。

### 7.2 什么才算已读取

检查依据是有来源的正文片段，按 entryId/eventId、版本、blockIndex、offset/end 组合计算覆盖。目录元数据、工具调用参数、sourceRefs、search 短片段和仅存在于 details 的内容均不算完整读取。

非连续分页必须补齐所需范围。`exhausted=false` 的第一页不算读完；0 字符的去重响应只有在实际请求保留了前次完整正文时才能复用覆盖。

复用现有窗口消息和 History/Note fragment 机制派生覆盖，不新建持久“已读记忆”账本。但 `contextReadFragments()` 当前只检查 Session 重建消息，还不够：验证点必须位于 transform、Shake、append-only 和最终请求组装之后。查询执行成功、原文落盘或前端显示出来，都不能替代这个检查。

在包含最后所需正文的请求发送前，工具仍保持 recovering 集合。该请求正常结束后，下一次请求才可开放业务工具。因此同一 assistant 批次内先调用 query、再调用 edit，edit 仍被阻止；即使串行执行工具，也不能假设模型已经看到该批次自己的查询结果。

最后的恢复请求若只输出文字，运行时也继续推进到正常业务请求；不能因没有 toolCall 就把整个任务判为完成。当前 `prepareAgentRequest()` 拒绝以 assistant 为最后一条消息的请求，因此切换到 normal 时追加一次固定、有界、可重建的 `context-recovery-complete` 控制消息，再准备后续请求。其成本进入预算，不伪造用户输入或增加 promptGeneration；重启不重复追加。解锁前再次验证来源/队列 revision 和最终请求中的材料覆盖；取消或新目标按原规则生效。

### 7.3 恢复也需要可执行空间

准备时估算必读正文、分页/工具结果开销及恢复结束后的完整业务工具定义，确认它们能与至少一次正常请求的输出预留、安全余量和保存空间共同容纳。仅验证最小首请求能发出去不够。

恢复每次读取继续通过实际容量检查。首请求恢复说明 512、单页 2,048、常规首次有效业务动作前恢复正文累计 4,096 个估算 token 沿用原 Spec，分别是模板/单页约束及行为回归目标；4,096 不能用来裁剪必要要求。

必读材料实际无法容纳时返回 `recovery_workset_too_large`，附缺失引用和预算分解；不得在 recovering 中循环换窗、清空已经读取的页再从头开始，也不得提前解锁业务工具。连续 3 次 sampling 没有恢复进度时返回 `recovery_no_progress`。进度包括发现新的必读定位信息、在同一查询快照中推进分页游标或增加所需正文覆盖；重复相同目录、预算查询及无关内容不算进度。目录推进允许继续检索，但不等于已读正文或可以解锁。版本变化不能重置已消耗的 token 额度。该检查用于恢复阶段，不恢复要求业务副作用的 credit 门禁。

## 8. 多轮用户交互、并发与重启

### 8.1 “继续”不能替代原始任务要求

promptGeneration 是一次用户输入的执行额度，不能仅凭它证明旧目标、约束和 Note 不再相关。当前实现会在新 prompt 后切换 Note scope；本次不通过自动合并所有旧 Note 扩大当前任务授权。

给 `context_note.query` 增加显式的 `taskSourceEntryId` 选择器，允许只读查询当前分支可达、已交付任务来源对应的旧 Note 投影，并标明其历史作用域；该参数与 resumeRef 互斥。History 用户消息目录提供可选的任务来源定位信息，用于发现这些旧 scope。未知、未交付或其他分支来源拒绝访问。

模型在明确延续任务时，可查询旧 Note，依据原始 source/evidence 在当前作用域重新确认相关事实，并把原始任务要求纳入 next_action 的 requirementSourceRefs。旧 Note 的文字不能被直接当作新的用户授权；也不能只把本轮“继续”作为唯一需求来源。

新目标替代旧任务时，按当前任务规则使用新的作用域和要求；旧 Note 仍是历史材料。验证“继续已有任务”和“开始另一任务”两个方向，不能以一个模糊的自动任务分类器决定授权继承。

### 8.2 交付与并发

新用户目标、steering、Todo、工具配置变化在保存/prepare 时使相关候选失效，重新确认使用剩余额度；不重复发送提醒，也不新建无限保存事务。后台 Task 和交互未结束时继续遵循现有提交阻止条件。

同批 `new_context` 与业务工具照常完成整个批次后才进入保存；业务结果晚于 Note 时要重新确认入口。commit 后到达的新消息按原队列规则交付，不能为使准备请求相同而丢弃。

恢复阶段收到新约束后扩展必读集合；旧版本的已读状态不能使新约束被跳过。next_prompt 消息仍只在下一用户 prompt 交付，不能借换窗提前读取。

### 8.3 重启位置

| 中断位置 | 必须行为 |
| --- | --- |
| started，尚无控制请求发送 | 重建同一保存操作与剩余额度；提醒不重复 |
| 查询已经完成，Note 尚未写入 | 从已保存查询结果及额度继续；不把 started 当成功 |
| 部分 Note 已落盘，控制批次尚不完整 | 只按已持久化 assistant 调用及终态处理可确定的本地 Note 操作；按 eventId 幂等，不重放业务工具；存在未知结果时不提交 |
| 全部控制结果已落盘，finished 尚未写入 | 重新执行结构/来源校验，成功后补写一次 finished，不额外消耗一次模型调用 |
| finished 已写入，rollover 尚未提交 | 重新验证 revisions 和事实 cutoff，通过后按原提交路径执行 |
| rollover 已提交 | 沿用原 prepared / started / finished 恢复规则；不修改 outcome_unknown 协议 |
| recovering 查询中断 | 从当前窗口权威消息重建覆盖和剩余额度；只有真正进入请求的正文才算已读 |

跨进程只重建确定的本地控制状态；没有完整结果的模型请求不被解释为成功，也不因本 Spec 自动重放。恢复后无法证明某页进入过实际请求时，该页仍属未满足的读取要求，可以从当前保留内容重新送入受限请求；不能凭一个内存布尔值解锁。持久化失败时不清除上下文、不解锁工具。这里验证进程中断恢复，不新增断电持久性承诺。

## 9. 仓储案例的 Note 与展示要求

以下仅说明内容要求，不是旧 Session 中实际存在的 Note；旧 Session 的 Note 数为 0。复测时所有正文必须由被测模型实际写入，不能由测试驱动器代写。

| Note | 合格内容示例 |
| --- | --- |
| state/implementation | 哪些模块已经实现，采用何种事件重放/串行化方式，引用最近文件事实；不把文件写入成功当作验收通过 |
| failed_attempt/acceptance | 最近测试的真实退出状态、18/22 的观察、四项失败及对应测试；标明尚未重新验证 |
| failed_attempt/syntax-check | Windows 不展开 `node --check src/*.js` 的实际检查失败，相关命令与输出引用 |
| next_action/current | 先核对重放时 reserved 的更新和跨命令冲突顺序，再实现 CLI、修正检查命令，执行验收；相关文件位置、测试命令及依赖 Note 的 key |

HTML 按 Session 的真实时间线呈现：用户请求、模型可见回答、工具调用/结果、进入保存阶段、实际 Note 更新、换窗、新窗口查询和后续业务动作。不得以汇总仪表盘替代对话过程。

每个换窗点默认展开本次续跑 Note 和直接相关 Note 的原文，标明 eventId、来源窗口、保存时 freshness 及 supersession。并列显示新窗口实际读取了哪一版、哪几页；不能用当前最新版冒充换窗时版本。

展示触发原因、配置窗口、最终请求估算、保存阶段预算、旧/新 windowId、恢复前后读取量，以及首个业务动作。必要规则仅作紧凑说明，正文和工具日志可定位。超过预览长度的正文可展开完整内容，不伪称摘要为原文。

没有 Note 时显示“本次没有保存 Note”；中断时显示最后确认位置。各 Session、改窗口配置和人工“继续”输入均保留，不伪装成无人干预的单次运行。导出时不包含认证值或隐藏推理。

## 10. Module 与实施顺序

| Module | 责任 |
| --- | --- |
| `packages/agent/src/agent-loop.ts`、`types.ts` | 最终请求测量、阶段控制结果、完整工具批次、安全退出与恢复后继续 sampling；不认识仓储业务或 Note 语义 |
| `packages/coding-agent/src/core/context-rollover.ts` | 保存与恢复状态转换、契约校验、prepare/commit/dispatch 顺序；不再让 AgentSession 和工具分别判断“已经保存” |
| `core/context-budget.ts`、`core/tools/tool-result-budget.ts` | 分阶段额度、批次共享结果预算及容量投影 |
| `core/agent-session.ts` | 连接请求/结果持久化、权限与最终请求覆盖检查；向窗口 Module 提供现有依赖 |
| `core/session-manager.ts` | 保存操作和引用记录、结果原文与有界投影的恢复、窗口和分支权威记录 |
| `core/task-note-projection.ts`、`task-note-query.ts`、`history.ts` | resume 结构、证据、精确查询、相关 Note 优先级、历史 scope 查询和分页覆盖 |
| `core/tools/*` | 参数校验和上述 Interface 的 Adapter；不持有独立阶段状态机 |
| `core/trace.ts` 与 Session HTML 导出 | 可观察的保存、读取、阻止原因及 Note 原文定位 |

seam 保持在最终请求准备与完整工具批次结束处。扩展现有窗口 Module 的 Interface 来接收测量/批次完成信息和返回阶段控制结果，不另造调度框架或新的模型工具协议。

按以下依赖顺序交付，每步保留当前工作目录已有改动：

1. 先建立证据查询、Note resume 结构和保存操作重建，写出失败回归。
2. 接入分阶段预算、完整结果持久化及批次投影，消除保存查询的零额度死结。
3. 用有界保存阶段替换“一次 sampling 后直接换窗”，完成 cutoff 与 finished 校验。
4. 将精确恢复引用、受限工具集和实际正文覆盖检查接入同一 prepare/commit 链。
5. 补齐多轮交互、并发、重启、Trace 与 HTML 展示，更新当前使用文档和替换失效断言。

同步删除被替换的旧判断和测试，不保留 started 即 saved、空 Note 自动通过、保存 query 必须失败等入口；保持旧 Session、用户文件和原始测试证据。

## 11. 验收矩阵

仓库内测试使用 `test/suite/harness.ts` 和 faux provider，调用生产 Interface，不放真实 key 或真实模型调用。业务行为使用临时目录中的实际文件和工具；faux 只决定模型响应，不能直接追加 finished/rollover 绕过保存链。

| ID | 用例 | 必须断言 |
| --- | --- | --- |
| B1 | 普通请求超限，保存形状可容纳 | 真实保存请求经过最终测量并发送；不按普通请求 decision 直接跳过 |
| B2 | 保存形状仍不适配 | 不发送超预算请求、不提交空 rollover，明确容量原因 |
| B3 | 普通输出预留与保存预留切换 | 当前输出不重复扣除；工具定义与安全余量完整计量 |
| B4 | 单个/同批多个大结果、result hook 放大 | 全部 terminal result 与可保存原文落盘；实际请求有界，查询可读未内联部分 |
| B5 | 保存时工作额度为零、并行查询 | 查询可用控制额度；共享预留，无透支和重启额度重置 |
| S1 | 模型平时从未写 Note | 阈值触发查询→更新→验证→finished→rollover；至少存在合格 next_action |
| S2 | 第一轮只查引用，第二轮写 Note | 第一轮不换窗；eventId 来自工具结果而非测试偷看 Session |
| S3 | Note 被拒绝、空回答、耗尽 3 轮 | 能在额度内修正；最终失败保留原窗口和成功 Note，不把 attempted 当 saved |
| S4 | 纯阅读/设计任务 | 没有写文件也可保存并续读新材料；不强制 state/failed_attempt 或 Strong Progress |
| S5 | 测试失败、修复后旧证据失效 | Note 引用真实失败终态；过期测试结果不被记为当前通过 |
| S6 | new_context、Note、业务修改同批 | 全批次终态落盘后固定 cutoff；较早入口需要重新确认 |
| C1 | Note、Todo、队列、权限在 prepare 变化 | 不提交过期契约；有界重组，不重复交付或消耗 next_prompt |
| C2 | 无关 Note 大量增长、入口 supersession/retract | 必要引用优先；读当前有效版本，撤销入口不会静默消失 |
| C3 | 长 Todo、当前动作只依赖一项、完全无 Todo | 按 todoId 读取完整权威项并校验 revision；不自动展开全文或要求创建 Todo |
| R1 | 请求 query 和业务工具同批 | 业务工具无副作用，正文进入请求后才可解锁 |
| R2 | 长正文多页、目录、search 命中、空去重结果 | 只认所需范围的完整正文覆盖；第一项元数据不等于全部恢复 |
| R3 | Shake/transform 移除已查内容 | 被移除正文不算当前请求已读，后续可重新读取 |
| R4 | 最后恢复请求只回答文字 | 继续下一业务请求；内部恢复结束不冒充用户任务完成 |
| R5 | 恢复材料或解锁后的全工具请求过大 | 明确 recovery_workset_too_large，不连续换窗再全量回读 |
| R6 | 连续无新增覆盖、越过分页预算 | 有界停止；合法逐页读取有进度且不会被误判 |
| R7 | 新约束到达恢复阶段 | 增加当前版本必读项；读取前不执行依赖业务 |
| M1 | 同任务补充“继续”，随后再次换窗 | 可查旧 scope，关联原任务要求；必要事实在当前 scope 明确确认 |
| M2 | 新目标/分支/子代理/隐藏来源 | 不自动继承旧授权、不越权查询；范围与既有隔离一致 |
| P1 | 保存各落盘点及 recovering 中断 | 按第 8.3 节重建，Note 幂等、提醒不重复、额度不返还 |
| P2 | 已有 prepared/started/finished dispatch | 既有协议回归不变，unknown 不重放 |
| H1 | 多窗口 HTML | 对话顺序和 Note 版本对照 JSONL；无 Note/中断如实显示，无认证值 |

### 11.1 两层真实工作验收

确定性层：构造仓储案例的部分实现和失败测试，以真实工具完成保存、恢复和修复轨迹。验证 18/22→22/22 以及语法检查成功，同时核对第一项跨窗操作使用了 Note 中的失败位置/约束。faux 的脚本不能被当作模型理解能力证明。

真实模型层：在新的隔离目录，使用 `rrver/gpt-5.4` 从项目需求和验收测试开始实际工作。测试驱动器只扮演用户与记录者，不给被测模型追加专门的“现在写 Note”“现在换窗”提示，不伪造 usage、不灌重复占位文本、不代写实现。使用显式记录的较小本地窗口配置，通过真实读取、修改和测试输出触发换窗。

验收至少包含一次无人代写 Note 的自动换窗和换窗后的有效任务推进，最终独立运行 22 项验收和平台可用的语法检查。另用独立小窗口场景验证不会重复空恢复；若工作集确实放不下，应报告容量限制，不能将此场景计为成功续跑。

比较换窗前后的要求保持、已完成工作重复执行、关键失败找回、首次有效动作及恢复 token。合理的版本核对不计为无效重读；没有新信息却完整重读相同材料并耗尽窗口属于质量失败。业务编码错误归于任务结果，不因门禁通过而豁免。

提供商中断时保留完整轨迹并标记未完成；按用户要求不开展 overloaded 修复。只有完成上述轨迹并独立验收通过，才可把本文件状态改成“已实现、行为验收通过”。

### 11.2 检查命令与交付

修改测试后，从对应 package 运行明确文件的定向测试，至少覆盖新增续跑用例、`context-window-memory.test.ts`、`task-note-projection.test.ts`、`context-budget-integrity.test.ts`，以及实际受影响的队列、Session 重建、PreparedContinuation/agent-loop 用例。

代码交付运行仓库根目录的 `npm run check`（保留完整输出）和 `git diff --check`。不运行整个 vitest suite，不提交。本文生成阶段仅修改文档，不将上轮 332 项通过或类型检查通过记作本次尚未实现行为的验收结果。

### 11.3 实现与验收记录

2026-09-05 已完成本矩阵的代码实现和确定性行为回归。`context-window-memory.test.ts` 覆盖最终请求预算、三轮保存、并发失效、当前 Note/Todo 版本、精确正文覆盖、分页进度、transform 后重读、受限工具、重启和多窗口 HTML 证据；`task-note-projection.test.ts`、预算、队列、Session 重建、PreparedContinuation 和 agent-loop 定向测试覆盖相邻接口。History 不公开工具内部 details，Todo 目录不展开完整 Todo；长 Todo 正文通过 offset/cursor 分页并按 revision 验证完整覆盖。恢复进度规范化为同一查询的实际分页位置，忽略会随日志追加变化的 leafId，因此重复首屏不增加进度，空 search 的连续游标页仍可推进。recovering 失败后的新用户目标按当前 promptGeneration 和 windowId 隔离旧 rollover，不再继承旧恢复工具门禁。HTML 的恢复页来自最终 provider request 的 Trace，不再把 Session 中未进入请求的查询结果标作已读。

确定性仓储验收位于 `test/suite/warehouse-continuation.test.ts`。测试把部分实现复制到隔离目录，由 faux provider 驱动生产 read/bash/edit/write、History 和 Note 接口，实际执行得到 18/22，跨窗读取失败 Note 和来源，首个业务动作读取 `src/warehouse.js`，完成修复后实际得到 22/22，并通过平台语法检查。faux 只提供模型响应，未直接写 finished 或 rollover。

真实验收继续使用 `rrver/gpt-5.4` 和隔离仓储项目，权威 Session 为 `01a07274-5660-7c92-b1d8-6f21f170bc31`。36k/65% 阶段暴露出两个先前回归未覆盖的问题：print 模式会在后台 Task 使 rollover 返回 `operation_in_flight` 后立即 dispose 并取消 Task；保存提示没有说明已有 next_action 必须携带当前 eventId 作为 `supersedesEventId`，也没有要求把下一动作限制为一个窗口内可完成的单项工作。由此出现有效 Note 被 `invalid_supersession` 拒绝，以及“恢复→全量重读→再换窗”的质量失败。实现现已等待 Task 终态和延后 transition，且状态保存的初始/修正/重启提示统一要求显式 supersession、单一即时动作、精确失败与已完成 Task/Memory 读取。相应 print 和状态保存回归已加入。

改进后的同一真实 Session 明确记录配置改为 48k/80%，没有隐藏或拼接中断片段。一个真实用户回合内由模型自行生成和 supersede 三版 next_action/current，三次自动 rollover 均完成 requirements、Note、Todo 正文恢复，随后执行 edit/write/bash，修复跨命令幂等、重启 reserved 投影并实现 CLI；Memory 正文通过 `memory_get` 取得，Todo 四项全部完成。独立复跑为 22/22。后续真实回合新增取消 reasonCode 的审计、不可变 JSONL 和重启验收，测试先暴露重建遗漏，模型修复后独立复跑为 23/23，语法检查通过。两次 explore subagent 均正确进入 TaskManager 的 running→failed 终态，失败原因为用户明确排除的 provider `overloaded`；父任务继续执行，provider 策略未改。

本次最终仓库验证为 coding-agent 14 个定向文件 152 项通过、2 项跳过，agent 3 个定向文件 40 项通过；根目录 `npm run check` 和 `git diff --check` 通过。真实 HTML 导出逐条保留用户对话、工具调用/结果、每版 Note、窗口边界和恢复页，文件名为 `rrver-warehouse-mechanisms-session.html`。按用户对 overloaded 的范围约束，Todo、Memory、窗口切换和 Task 生命周期的计划行为已验收；subagent 成功提交路径仍由 faux provider 的确定性回归覆盖，不把两次 provider 失败伪记为成功提交。
