# multi-coding agent

一个面向软件工程场景的全透明多 Agent Coding 系统。

它不是用一个大模型“扮演”多个角色，而是把需求分析、架构设计、前后端开发、测试验证、交付汇总拆成真实的多 Agent 协作流程，并把整个过程以白盒方式展示出来。

## 项目特点

- 真实多 Agent Runtime：内置 `PC / CA / FD / BD / DE / QT` 六类角色，具备独立身份、独立会话、独立状态和任务分配能力。
- 白盒可观测：前端实时展示 Agent 创建、任务分发、文件读写、工具调用、测试结果、失败重试与恢复过程。
- 文件优先记忆：会话历史、长期记忆、共享计划、交接文档、日志和事件流全部落盘，可回放、可审计、可恢复。
- 记忆与上下文工程：支持会话压缩、长期记忆检索、RAG 模式、角色作用域上下文和技能插件 Prompt 组装。
- 隔离式生成工作区：每次 coding run 的产物都会写入独立的 `APP/<run>` 目录，避免污染宿主工程。
- 本地优先开发体验：前后端分离，支持直接编辑记忆、技能、工作区文件和运行期产物。

## 系统架构

系统采用三层结构：

1. `Orchestrator`
   负责 run 生命周期、任务依赖图、并行调度、失败重试、恢复与收尾。
2. `Run Manager + Agent Registry`
   负责 run、agent、task、message、event、history、snapshot 的持久化与管理。
3. `Run Dashboard`
   基于 FastAPI SSE + Next.js 展示多 Agent 协作过程、任务板、事件时间线、Raw Messages 和运行文件。

## 多 Agent 如何协作

- `PC`：拆解需求、生成任务板、贯穿项目始终并做最终交付总结。
- `CA`：负责架构设计、共享约束、接口边界和实现顺序。
- `FD`：负责前端界面、交互和可视化链路。
- `BD`：负责后端 API、Agent runtime、存储与工具链。
- `DE`：负责环境、脚本、运行命令和部署说明。
- `QT`：负责测试验证、回归检查和质量门禁。

Agent 之间通过会话消息、共享记忆和共享文件协同；所有关键动作都会写入事件流并同步到前端。

## 记忆与上下文

项目保留并增强了原有的记忆体系：

- 会话记忆：保存聊天与工具调用历史，支持压缩摘要和续接上下文。
- 长期记忆：以本地 Markdown 作为事实源，向量索引只作为可重建缓存。
- 共享记忆：run 级共享计划、架构文档、handoff、日志与测试结论。
- 角色作用域上下文：不同 Agent 默认只读取与自己职责相关的信息，降低无效上下文和 Token 成本。
- 技能插件：能力通过文件化 `SKILL.md` 组织，并参与 Prompt 实时组装。

## 运行产物

- 生成项目目录：`APP/<run>`
- run 元数据目录：`backend/workspace/runs/<run_id>`
- 长期记忆：`backend/memory/MEMORY.md`
- 单 Agent 会话兼容历史：`backend/sessions/`

## 快速开始

### 1. 启动后端

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app:app --host 127.0.0.1 --port 8002
```

至少配置以下环境变量：

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=your_key
LLM_MODEL=deepseek-chat
```

### 2. 启动前端

```powershell
cd frontend
npm install
npm.cmd run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

## 使用方式

1. 在首页发起一个新的 coding run。
2. 观察任务板、Agent 状态、事件时间线和 Raw Messages。
3. 在右侧查看共享文档、handoff、日志与生成文件。
4. 最终交付的项目代码会写入 `APP/` 下的独立目录。

## 项目结构

```text
.
├── APP/                     # 多 Agent 生成的独立项目目录
├── backend/
│   ├── api/                 # FastAPI 路由
│   ├── graph/               # Orchestrator / Run Manager / Agent Registry / Task Allocator
│   ├── tools/               # sessions, memory, terminal, write_file 等工具
│   ├── memory/              # 长期记忆
│   ├── skills/              # 技能插件
│   ├── workspace/           # Prompt 组件与 run 元数据
│   └── sessions/            # 单 Agent 兼容会话历史
├── frontend/
│   └── src/                 # Run Dashboard 前端
└── README.md
```

## 当前状态

当前版本已经支持：

- 真实多 Agent run 创建与调度
- 任务依赖图与并行批次执行
- 会话消息、共享记忆与共享文件协同
- 白盒事件流展示与历史回放
- run 恢复、超时重试与 orphan task 回收
- 独立工作区生成与端到端实测

## GitHub 上传说明

仓库默认忽略以下运行期产物：

- `backend/workspace/runs/`
- `APP/` 下的生成项目目录
- 本地环境、缓存和日志文件

这样可以保证推送到 GitHub 的内容以源码、文档和配置为主，不会把测试 run 和生成项目一并上传。
