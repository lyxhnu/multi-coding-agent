# memory-context-integrity 实施与验证记录

日期：2026-08-31。工作区：`E:\pi-main`。依据：[Spec](memory-context-integrity.md)。使用说明：[记忆与上下文](../memory-context.md)。

## 1. 交付结论

R01–R07 的代码链路已实现，定向回归通过。S6 的“全仓离线回归全绿”条件尚未满足，因此不能宣称整个 Spec 已完成验收。Q01–Q04 未获单独运行授权，未调用真实模型评估语义质量。

本次保留 JSONL 和 Markdown 存储，没有新增数据库、后台自动入口、bash 工具或独立界面；没有兼容双写、自动迁移/清理用户历史文件，也没有执行 commit 或 build。

## 2. 变更落点

以下路径相对仓库根目录；测试文件和实际运行命令另见第 4 节。

| 需求 | 实现文件/模块 | 关键行为 |
| --- | --- | --- |
| R01 | `packages/coding-agent/src/core/compaction/compaction.ts`、`core/agent-session.ts` | split-turn 保留旧摘要；完整非空输出、来源指纹和保留边界通过后才能提交 |
| R02 | `packages/ai/src/{types.ts,index.ts,utils/estimate.ts,api/simple-options.ts}` | 统一输入、输出预留和安全余量；验证 usage 前缀；未知元数据显式标记 |
| R02 | `packages/agent/src/{types.ts,agent.ts,agent-loop.ts,run-state.ts}` | 最终请求快照检查；结构化 `context_limit`；请求与可变正文/schema 分离 |
| R02 | `packages/coding-agent/src/core/{agent-session.ts,compaction/compaction-policy.ts}` | shake/压缩后重算；次数有界；不重复消费输入或重放工具 |
| R03–R05 | `packages/coding-agent/src/core/memory/{memory-store.ts,secret-filter.ts,memory-index.ts,consolidation.ts,extraction.ts}` | 统一安全入口、有效视图、撤销二次检查、正文提炼、快照、水位、锁、提交日志和幂等收敛 |
| R06 | `packages/coding-agent/src/core/compaction/checkpoint.ts`、`core/agent-session.ts` | 按覆盖范围复用；冻结后台来源；迟到/改写/分支变化校验；usage 去重 |
| R07 | `packages/agent/src/harness/compaction/shake.ts`、`packages/coding-agent/src/core/tools/{history-get.ts,index.ts}` | 占位符携带来源；只读分页；不执行原工具；拒绝旧 memory 结果 |
| 权限与子代理 | `packages/coding-agent/src/core/{plan/plan-state.ts,permissions/policy.ts,permissions/permission-service.ts,subagents/pi-child-runner.ts}` | 只读/Plan/allow/deny 接线；子代理超限映射为失败而非完成 |
| 持久化与诊断 | `packages/coding-agent/src/core/{session-manager.ts,trace.ts}`、`src/extensions/trace/index.ts` | 提交失败回滚内存索引；首次超限也落盘；log-only trace 导出/恢复 |
| CLI/RPC/SDK | `packages/coding-agent/src/{index.ts,modes/index.ts,modes/print-mode.ts,modes/rpc/rpc-mode.ts,modes/rpc/rpc-types.ts}` | 非零超限退出；RPC 状态/原因码；运行中工具 ID 序列化为数组；导出历史工具接口 |
| 测试设施 | `packages/coding-agent/test/suite/harness.ts` | 可使用真实临时 JSONL 文件，关闭并创建新会话实例验证恢复 |
| 文档 | `packages/coding-agent/{README.md,docs/compaction.md,docs/sdk.md,docs/rpc.md,docs/memory-context.md,docs/specs/memory-context-integrity.md}` | 新默认工具集、预算/状态/数据契约及验收状态 |
| Changelog | `packages/{ai,agent,coding-agent}/CHANGELOG.md` | 仅修改 Unreleased，记录 API/数据格式变化 |

表中 `core/...` 缩写均相对于同一行的 `packages/coding-agent/src/`。完整定向测试清单不是修改清单，其中包含未修改但受影响的既有回归。

## 3. 已验证的跨模块证据

### 请求、压缩与恢复

- 首次超长输入在 provider 调用前停止；没有虚构 assistant 消息，用户输入只持久化一次。
- 即使没有 `request/header`，真实临时 JSONL 中也有预算 trace；分支导出、fork 和重新打开后仍可读取；逻辑分支仍只有用户消息。
- 并行工具结果、steering、follow-up 全部进入下一次预检；超限不重放已经执行的工具。
- E01/E03：写入真实临时文件 → 工具读取 → shake → 修改原文件 → 模型调用 `history_get` → 下一次模型请求看到原始保存内容 → 前缀预摘要 → 追加尾部 → 增量压缩 → 再次压缩 → 从 JSONL 创建新会话并继续。硬约束继续进入请求，原文件读取工具仍只执行一次，最终存在两个 compaction entry。
- split-turn、普通压缩和三轮摘要传递均保留旧约束；模型截断、空摘要、异常、取消及无效扩展结果不提交。
- 注入 compaction 写盘失败后，逻辑叶子、有效消息和原 JSONL 不变，也不生成笔记。
- 后台前缀期间换分支、原地改写来源、abort 和 dispose，均不会提交失效 checkpoint；重复预触发只发起一次调用。
- 两阶段均有非零 usage 时，统计包含两阶段但不重复计入第一阶段。

### 记忆与撤销

- 全局、项目、note、手动/自动 flush、autoDream 输出共用过滤；新增拒绝 metadata/trace 不含模拟敏感值或其前缀。
- 混合 ID/无 ID Markdown、CRLF、Unicode 和空文件保持有效视图语义；损坏撤销文件和越界目录 junction 明确拒绝。
- 异步 embedding 中发生撤销，返回前会去掉失效候选；相同文档重复搜索不会新增文档 embedding。
- 归档提炼接收正文与来源 ID，不获取执行工具；无效模型 JSON、未知字段和伪造来源不推进水位。
- 合法空事实推进水位但不写空条目；相同批次重试不再次提炼。
- 两个独立 MemoryStore 实例共享目录并竞争归档锁；只有一个提炼器运行。
- 故意让水位写入失败：事实和提交日志已写；新实例恢复后补齐水位，不再次生成或追加同一事实。
- 提炼期间修改正文或撤销有效视图，旧来源都不能提交；定时取消释放锁而不推进水位。
- 未处理老笔记不裁剪；已处理笔记跨老化阈值后不被再次当作新知识。

### CLI、RPC 和权限

- 文本/JSON print mode 对最终 `context_limit` 返回 `1`；RPC 发送结构化事件，并通过 `get_state` 保留结果。
- RPC `prompt` 只回复一次接受结果；接受成功与任务完成分离。
- `/memory` 命令处理器和 RPC 的 flush/undo 语义已覆盖；拒绝写入不会显示为成功写入一条记忆。
- 子代理因输入过大停止时返回失败；不会被结构化结果协议误当作完成。
- 显式 allowlist、denylist、禁用默认工具、Plan Mode 和最大子代理深度均有回归；未获准的 history 工具不会被新占位符承诺可用。

## 4. 运行结果

### 4.1 静态检查

在仓库根目录执行 `npm run check`，退出码 `0`。包括 Biome、固定依赖版本检查、TS import 检查、shrinkwrap/install-lock 校验、TypeScript 检查和 browser smoke 检查。

当前 npm 仍输出项目既有 `min-release-age` 配置无法识别的 warning；没有为消除它而删除依赖安装安全配置。未执行 commit。

### 4.2 定向回归

实际完整命令及工作目录保存在 [命令记录](../../../../.test-results/memory-context-commands.md)。使用各包现有 `node_modules/vitest/dist/cli.js --run`；未通过未经隔离的全量 Vitest 入口运行。

| 包 | 测试文件 | 通过 | 失败 | 跳过 | JSON 证据 |
| --- | ---: | ---: | ---: | ---: | --- |
| ai | 1 | 15 | 0 | 0 | [报告](../../../../.test-results/memory-context-ai.json) |
| agent | 6 | 111 | 0 | 0 | [报告](../../../../.test-results/memory-context-agent.json) |
| coding-agent | 47 | 370 | 0 | 12 | [报告](../../../../.test-results/memory-context-coding.json) |
| 合计 | 54 | 496 | 0 | 12 | 跳过不计作通过 |

上述最终批量回归已包含 E01/E03 的实际模型工具回读断言，以及损坏记忆 metadata/归档 JSON 不泄漏原始值的检查。最终代码修改后已重新执行静态检查。

12 个跳过项沿用既有条件，本次没有新增 skip：

- `compaction.test.ts` 的 2 个真实模型集成测试：未配置该用例要求的授权。
- `compaction-extensions.test.ts` 的 8 个真实模型测试：同上；本次新增的无效扩展提交检查使用 faux，已实际执行。
- `suite/grok-alignment/subagent-sandbox-binding.test.ts` 的 2 个操作系统 sandbox 用例：当前环境不满足隔离条件。只读工具/权限检查通过不等于这两个 OS 隔离用例通过。

### 4.3 全仓离线回归：未通过

从根目录执行：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' ./test.sh
```

退出码 `1`，完整输出保存在 [离线日志](../../../../.test-results/memory-context-offline-final.log)。该入口隔离 HOME、临时目录、认证环境和 npm 配置。记录的是该次运行结果；之后补充的定向断言和前缀不可变快照校验已另行复跑，不把这份全仓日志冒充最终全绿证明。

| 包 | 文件失败/通过/跳过 | 测试失败/通过/跳过 |
| --- | --- | --- |
| agent | 6 / 17 / 0 | 15 / 285 / 0 |
| ai | 2 / 87 / 25 | 3 / 666 / 789 |
| coding-agent | 28 / 199 / 7 | 127 / 1915 / 51 |

TUI 使用 dot reporter；此处不从圆点输出推算通过数。上表不含无法加载套件的潜在未执行断言。

已观察到的失败类别：

- 缺少 `@earendil-works/pi-ai`、`pi-tui` 等包的 `dist` 入口，导致部分 CLI/扩展/存储套件不能加载。
- Windows 文件/目录符号链接权限、POSIX 路径/权限假设及工具环境差异；另有 fd 不可用、rg 参数错误。
- 本地模型目录与断言不一致：Qwen preview 模型缺失、DeepSeek reasoning level 差异。没有直接改生成模型文件或放宽断言。
- 还存在 headers 扩展、包命令、交互组件、sandbox 默认值、超时等失败，尚未逐项完成根因定位；不能全部归为环境问题。

本目录没有 `.git` 元数据，不能通过干净基线对照证明所有失败都早于本次修改。因此交付结论是“本次定向回归通过、全仓仍有失败”，不是“全仓剩余问题均与本次无关”。

## 5. Spec 测试 ID → 实际断言

下表路径均相对 `packages/coding-agent/test/`，除显式标注 ai/agent 的行。带 ID 的新用例可直接按测试名定位；复用既有用例时列出断言主题。映射不等同于真实模型语义效果或 OS 隔离证明。

| ID | 实际文件/用例或断言 |
| --- | --- |
| C01 | `suite/compaction-summary-integrity.test.ts`：仅新 turn prefix 时保留 previousSummary、文件记录，无替代性 No prior history |
| C02 | 上述 split-turn case 与 `suite/memory-context-integration.test.ts` 普通摘要继承 case |
| C03 | `suite/memory-context-integration.test.ts`：三次普通摘要的下一轮输入持续包含原约束；E01 覆盖重复会话压缩 |
| C04 | 同文件：手动无新增内容不提交/调用；`suite/compaction-checkpoint.test.ts`：无新尾部不调用模型 |
| C05 | `suite/compaction-summary-integrity.test.ts`：4 种无效输出；integration：落盘失败；`suite/agent-session-compaction.test.ts`：取消 |
| C06 | `compaction.test.ts`：custom cut-point、model/thinking metadata、保留区重建；summary-integrity 文件记录；integration 多工具批次/两次压缩 |
| C07 | `suite/memory-context-integration.test.ts`：empty/boundary/changed 三个扩展提交拒绝 case |
| B01 | `suite/context-budget-integrity.test.ts`：大工具结果后无第二个 provider 请求，工具仅执行一次 |
| B02 | `suite/memory-context-integration.test.ts`：两个并行结果共同超限；ai `context-estimate.test.ts`：增量总数 |
| B03 | context-budget 首次超长输入与 integration 的 steer/followUp 两个 case：唯一持久化/消费 |
| B04 | ai `context-estimate.test.ts`：零/无适用 usage 重算及过期前缀 |
| B05 | 同文件 model/system/tools/prefix 四个 case；integration transform；agent `agent-loop.test.ts`：认证等待时源对象改写不改变请求快照 |
| B06 | `suite/shake-threshold-avoids-compaction.test.ts`、`session-manager/shake-replay.test.ts`、`agent-session-auto-compaction-queue.test.ts`：重建/失效锚点 |
| B07 | ai `context-estimate.test.ts`：-1/0/+1 容量边界，同时断言 provider 输出上限 |
| B08 | 同文件：中文/英文/代码、图片估算及 unknownFields |
| B09 | context-budget 无多余请求；`suite/shake-compaction-budget-exhausted.test.ts` 有界救援；子代理超限失败；print/RPC 非完成 |
| B10 | integration 在最终 transform 取消；checkpoint abort/dispose；既有 compaction 取消与队列回归 |
| B11 | ai `context-estimate.test.ts`：输出目标与模型最大能力区分、单份安全余量、边界裁剪 |
| M01 | `suite/memory-lifecycle.test.ts`：所有直接/note/flush 入口；archive-integrity：拒绝敏感提炼结果 |
| M02 | memory-lifecycle：磁盘不安全块不出现在读取/搜索/实际 embedding 输入；有效视图参与 note 提炼 |
| M03 | memory-lifecycle 拒绝值/前缀检查、损坏 metadata/归档 JSON 的固定错误；RPC/interactive flush 拒绝结果；只检查新增诊断而非清理原始历史 |
| M04 | memory-lifecycle：普通路径和 API_KEY 变量名不新增误拒绝 |
| M05 | memory-lifecycle：原文未改写，撤销后的同实例、新实例 get/search 均不返回 |
| M06 | memory-lifecycle：有缓存时仅排除撤销块，其余块仍有效 |
| M07 | memory-lifecycle：embedding 等待期间撤销，最终返回重新校验 |
| M08 | memory-lifecycle：混合 Markdown、CRLF、Unicode、空文件 |
| M09 | memory-lifecycle：损坏 tombstone、越界路径和目录 junction；既有 memory 工具范围测试 |
| D01 | `suite/memory-archive-integrity.test.ts`：正文进入提炼，写入事实带 source-notes |
| D02 | 同文件：同日同 session 不同 compaction 不覆盖、同来源改名不重复；integration 只为已提交压缩写笔记 |
| D03 | 同文件：distinct session 数与时间门槛分别阻止调用 |
| D04 | 同文件：已处理空事实不再提炼；`suite/grok-alignment/memory-autodream.test.ts` 重复归档 |
| D05 | 同文件：空事实成功、schema 参数化拒绝、伪造来源、无效模型 JSON；无执行工具 |
| D06 | 同文件：不安全输出、取消、假时钟超时、锁释放、水位不变 |
| D07 | 同文件：两个独立 store 实例共根目录竞争，只有一个提炼；独立 OS 进程压力测试未执行 |
| D08 | 同文件：事实已写而水位失败，新实例读取 journal 收敛，不重复写事实 |
| D09 | 同文件：正文修改、有效视图撤销两条路径都拒绝旧来源提交 |
| D10 | 同文件：只选完整单条输入；无整条可容纳时不运行 |
| D11 | 同文件与 `memory-degrade.test.ts`：未处理老笔记不损失；已处理按既有层级老化 |
| D12 | archive-integrity：老化后不重提炼同一来源 |
| D13 | integration：归档失败 trace 独立于成功 compaction_end 和有效新上下文 |
| T01 | `compaction-policy.test.ts`：预触发区间；`suite/compaction-checkpoint.test.ts`：重复触发单调用 |
| T02 | checkpoint：追加尾部、导出恢复后复用；integration：第二阶段请求无已覆盖原文 |
| T03 | checkpoint：source shake、基础 compaction、原地改写均失效 |
| T04 | checkpoint：实际后台调用延迟返回至兄弟分支，不提交 |
| T05 | checkpoint：abort/dispose 无残留在途标志；JSONL 恢复完成 checkpoint 后重新验证 |
| T06 | `suite/grok-alignment/compaction-policy.test.ts` 默认 single-pass；integration 多轮普通与 split-turn 摘要 |
| T07 | checkpoint：前缀立即计费、无新尾部复用不重复计费、两阶段均非零时总量正确 |
| H01 | `suite/history-get.test.ts`：整段、多块/歧义定位；agent shake region/redaction 测试覆盖代码块来源 |
| H02 | history-get：Unicode 页边界、offset/limit/blockIndex 拒绝、EOF metadata |
| H03 | integration E01/E03：文件改变后仍回读旧内容，实际模型后续请求可见，原工具不再执行 |
| H04 | history-get：兄弟分支、未知 ID、路径、trace ID 不可读 |
| H05 | history-get：compaction 保留边界外的合法历史 entry 仍可读 |
| H06 | history-get 与 `suite/shake-survives-resume.test.ts`：真实 JSONL 导出/恢复及持久 shake |
| H07 | history-get：旧 memory 工具快照与 denylist 拒绝；Plan/depth/allowlist 回归；OS sandbox 未验证 |
| H08 | history-get：仅保存内容 EOF、不支持图片、无工具/未获准时无回读承诺 |
| E01 | `suite/memory-context-integration.test.ts` 的 E01/E03/K03/K04 case，见第 3 节 |
| E02 | archive-integrity：三会话归档→新 store 读取→撤销→再次新 store，其他有效事实保留 |
| E03 | integration 的实际工具回读与后续请求，结合 context-budget 对新工具结果的预算检查 |
| E04 | integration 写盘/扩展/归档失败；archive-integrity 水位故障；checkpoint 后台迟到/取消 |
| E05 | `interactive-mode-memory-command.test.ts`、`rpc-prompt-response-semantics.test.ts`；前者为命令处理器测试，不是完整终端录制 |
| E06 | context-budget 首次拒绝后的实际 JSONL/fork/export/reopen；session-manager trace 与 trace-extension 投影 |
| E07 | grok memory/plan/subagent/depth、SDK default/allowlist、3592/5109、history deny 回归；OS sandbox 两项跳过 |
| K01 | archive-integrity 已处理批次再次运行的提炼器不得调用 |
| K02 | memory-lifecycle 文档 embedding 计数与 query embedding 分开，未变文档无新增 embedding |
| K03 | checkpoint 与 integration 实际第二阶段请求不含已覆盖原始前缀 |
| K04 | history-get/integration 原始工具执行次数不增加 |
| K05 | shake-budget-exhausted、mid-prompt-compaction 的有限调用计数与无进展停止 |

## 6. 未通过/未验证边界

1. 全仓离线回归未通过。缺少构建产物的真实 CLI 启动、部分扩展加载、平台相关失败需要另行处理；本次未擅自执行 build、改变 Windows 权限或放宽无关测试。
2. 独立 OS 进程的长时间锁竞争/进程强杀、断电耐久性没有验证。当前证据为共享目录双实例并发、实际文件失败恢复及有界取消。
3. `/trace` 的数据投影、JSONL 保留和导出已测；本次没有完整 TUI 终端人工交互录制。
4. 真实模型 Q01–Q04、真实 embedding 服务、多 provider token 估算误差没有测。不能宣称硬约束保留率 100% 或长期事实召回率已达 90%。
5. 已有旧格式自动归档水位不兼容且不会被自动迁移/删除。旧无来源笔记仍可安全读取，但不自动当作新快照归档。

交付状态：机制实现和定向回归有证据；完整 S6 验收与真实语义评估仍未完成。
