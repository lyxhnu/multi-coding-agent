# Multi-Coding Agent

一个面向复杂软件工程任务的多 Agent Coding 系统。  
它不是让一个大模型在一条回复里“扮演”多个角色，而是把规划、设计、前端、后端、运维、测试拆成真实协作的 Agent，并把全过程以白盒方式落盘和展示出来。

当前版本的核心能力包括：

- 真实多 Agent 运行时：`PC / CA / FD / BD / DE / QT`
- run 级任务板、事件流、消息流和 handoff 文件
- 当前 run 内的 `answer / resume / modify` continue 机制
- 结构化上下文管理：最近窗口原文 + 摘要 + task-board + handoff
- mem0 主导的长期记忆：`preference / episode / failure_fix`
- 前端 Run Dashboard：任务、Agent、事件流、文件与原始消息可见

---

## 1. 系统架构

后端核心组件：

- `Orchestrator`
  负责 run 生命周期、任务调度、重试、恢复和阶段推进
- `Run Manager`
  负责 run 文件目录、消息、事件、历史和共享文件落盘
- `Agent Registry`
  负责 Agent 注册、状态维护、`sessions_send / sessions_history`
- `Task Allocator`
  负责初始任务板、增量任务、retry task
- `Semantic Memory`
  负责 mem0 长期记忆检索和写入

前端核心界面：

- Run Dashboard
- Agent Panel
- Task Board
- Event Timeline
- Files / Inspector
- Raw Messages

---

## 2. 当前版本特性

### 多 Agent 协作

- `PC`：项目协调、任务分配、进度控制、结果汇总
- `CA`：架构设计、模块边界、共享契约
- `FD`：前端实现
- `BD`：后端实现
- `DE`：环境、脚本、运行方式、部署说明
- `QT`：聚焦验证、测试报告、风险收口

### Continue 机制

同一个 `run_id` 下支持三种后续交互：

- `answer`
  只读回答当前项目状态
- `resume`
  继续未完成任务，优先恢复失败/阻塞任务
- `modify`
  基于当前项目追加增量修改任务

### 上下文与记忆

- 当前 run 以内：
  - 最近对话原文
  - `conversation summary`
  - `phase summary`
  - `task-board active view`
  - `handoff`
- 跨 run 长期记忆：
  - `preference`
  - `episode`
  - `failure_fix`
- 长期记忆主检索和主记录由 mem0 承担
- 本地 `backend/memory/cards/` 保留审计镜像

---

## 3. 目录结构

```text
.
├── APP/                          # 每次 run 生成的项目产物
├── backend/
│   ├── api/                      # FastAPI 路由
│   ├── graph/                    # Orchestrator / Run Manager / Agent Registry / Task Allocator
│   ├── tools/                    # sessions / memory / terminal / write_file 等工具
│   ├── memory/                   # 长期记忆、审计镜像、MEMORY.md
│   ├── skills/                   # 技能插件
│   ├── workspace/                # Prompt 组件与 run 元数据
│   └── sessions/                 # 单 Agent 兼容会话历史
├── frontend/
│   └── src/                      # Run Dashboard 前端
└── README.md
```

运行期最重要的目录：

- `backend/workspace/runs/<run_id>/`
  - `run.json`
  - `task-board.json`
  - `messages.ndjson`
  - `events.ndjson`
  - `handoff/`
  - `reports/`
  - `summaries/`
- `APP/<generated-project>/`
  - 某次 run 生成出来的项目代码

---

## 4. 已验证环境

当前仓库在本机已验证通过的版本：

- Python: `3.11.14`
- Node.js: `24.14.0`
- npm: `11.9.0`

为了减少兼容问题，建议：

- Python 使用 `3.11.x`
- 不要混用多个 Python 解释器和用户目录 site-packages
- 使用干净虚拟环境运行后端

---

## 5. 环境变量配置

后端读取：

- `backend/.env`
- 如果 `.env` 中没有，再回退系统环境变量

模板文件在：
[backend/.env.example](/E:/download/langchain-miniopenclaw-main/langchain-miniopenclaw-main/backend/.env.example)

### 5.1 最小可运行配置

如果你只是想把系统跑起来，**至少**配置一个可用的聊天模型。

推荐直接使用智谱 `glm-5`：

```env
LLM_PROVIDER=zhipu
LLM_MODEL=glm-5
LLM_API_KEY=你的智谱 API Key
```

说明：

- 对于 `zhipu`，以下任一变量都可以提供主模型 key：
  - `LLM_API_KEY`
  - `ZHIPU_API_KEY`
  - `ZHIPUAI_API_KEY`
- 如果你已经设置了 `LLM_API_KEY`，通常不需要再重复设置 `ZHIPU_API_KEY`

### 5.2 可选：Embedding 配置

Embedding 不是启动后端的硬前置条件。  
如果不配置，系统仍然可以启动，但本地 `MEMORY.md` 的向量检索能力会关闭。

例如：

```env
EMBEDDING_PROVIDER=bailian
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_API_KEY=你的百炼 Key
```

### 5.3 可选：mem0 配置

当前长期记忆以 mem0 为主。  
如果不配置 mem0，后端仍然可以启动，但跨 run 长期记忆的主记录/主检索能力会受限。

如果使用 mem0 Platform：

```env
MEM0_PROVIDER=platform
MEM0_API_KEY=你的 mem0 Key
MEM0_APP_ID=multi-coding-agent
MEM0_USER_ID=local-user
```

如果暂时不接 mem0，可以保留默认值或留空；系统仍可运行，但长期记忆能力会下降。

### 5.4 推荐的 `backend/.env` 最小示例

```env
LLM_PROVIDER=zhipu
LLM_MODEL=glm-5
LLM_API_KEY=your_zhipu_key

MEM0_PROVIDER=platform
MEM0_API_KEY=your_mem0_key
MEM0_APP_ID=multi-coding-agent
MEM0_USER_ID=local-user
```

---

## 6. 后端启动

### 6.1 Windows PowerShell

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
python -m uvicorn app:app --host 127.0.0.1 --port 8002 --reload
```

### 6.2 macOS / Linux

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn app:app --host 127.0.0.1 --port 8002 --reload
```

### 6.3 启动成功后验证

打开：

- [http://127.0.0.1:8002/health](http://127.0.0.1:8002/health)

预期返回：

```json
{"status":"ok"}
```

---

## 7. 前端启动

### 7.1 默认启动

```powershell
cd frontend
npm install
npm run dev
```

打开：

- [http://127.0.0.1:3000](http://127.0.0.1:3000)

### 7.2 如果后端不跑在 8002

前端默认请求：

- `http://127.0.0.1:8002/api`

如果你把后端改成别的端口，比如 `8005`，启动前端前先设置：

Windows PowerShell:

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8005"
npm run dev
```

macOS / Linux:

```bash
export NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8005"
npm run dev
```

---

<<<<<<< Updated upstream

=======
## 8. 首次运行检查清单

建议在新机器上按下面顺序检查：

1. 后端虚拟环境已创建，且只使用这一套 Python
2. `pip install -r requirements.txt` 成功
3. `backend/.env` 已填写至少一组可用模型 key
4. [http://127.0.0.1:8002/health](http://127.0.0.1:8002/health) 返回 `{"status":"ok"}`
5. 前端 `npm install` 成功
6. [http://127.0.0.1:3000](http://127.0.0.1:3000) 能打开
7. 在首页发起一个新 run，能看到：
   - run 创建
   - agent 列表
   - task-board
   - event timeline

---

## 9. 基本使用方式

1. 在前端发起一个新 run
2. 观察任务板、Agent 状态、事件流和 Raw Messages
3. 在右侧 Inspector 中查看：
   - `project-plan.md`
   - `architecture.md`
   - `shared-memory.md`
   - `handoff/*`
   - `reports/*`
4. 项目代码产物会写入：
   - `APP/<run-name>/`
5. 同一个 run 内支持继续追问：
   - `answer`
   - `resume`
   - `modify`

---

## 10. 常见问题

### 10.1 前端报 `Failed to fetch`

通常是以下原因之一：

- 后端没启动
- 后端不是跑在 `8002`
- 前端没有设置正确的 `NEXT_PUBLIC_API_BASE_URL`

先检查：

- [http://127.0.0.1:8002/health](http://127.0.0.1:8002/health)

### 10.2 `pydantic_core` / `fastapi` 导入异常

这通常是 Python 环境污染导致的。  
不要混用：

- base conda
- 用户目录 `site-packages`
- 项目虚拟环境

建议做法：

- 只使用一个干净的 Python 3.11 虚拟环境
- 重新安装 `requirements.txt`

### 10.3 mem0 没生效

如果 mem0 没配置好：

- 后端通常仍能启动
- 但长期记忆召回和沉淀会受限

优先检查：

- `MEM0_PROVIDER`
- `MEM0_API_KEY`
- 对应账号/项目权限是否正常

### 10.4 Embedding 没配置

如果不配置 embedding：

- 后端仍能启动
- 本地 `MEMORY.md` 的向量检索会不可用

---

## 11. 开发与验证建议

后端：

```powershell
cd backend
python -m compileall .
```

前端：

```powershell
cd frontend
npm run lint
npm run build
```

---

## 12. 上传到 GitHub / 发布 v2 注意事项

仓库建议只提交源码、配置模板和文档，不提交运行期产物。

通常不应提交：

- `backend/workspace/runs/`
- `APP/` 下的生成项目
- 虚拟环境目录
- 本地日志和缓存

建议在发版前确认：

- `README.md` 为当前版本
- `backend/.env.example` 与真实读取逻辑一致
- 前后端能在新机器上按本文档步骤启动

---

## 13. 当前版本一句话说明

当前版本已经是一个**真实多 Agent、run 级调度、白盒可观测、支持 continue 的 Coding 系统**，并且长期记忆已收敛到 mem0 主导的 `preference / episode / failure_fix` 三类模型。
>>>>>>> Stashed changes
