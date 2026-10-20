# Remote Agent

一个把 GitHub issue 变成 k8s 里 AFK agent 运行的编排系统：App 读 issue、算 frontier、起 Job，Job 里的 pi 干活并把结果回报给 App。

## Language

### 工作单元

**Spec**:
一个带 sub-issue 的 GitHub issue，代表一整块要端到端实现的工作；它的所有 ticket 共用一条分支。
_Avoid_: epic, parent issue, 大 issue

**Ticket**:
一个没有 sub-issue 的 GitHub issue，是 agent 一次运行的工作单元。
_Avoid_: task, subtask, child issue

**Frontier**:
某个 spec 当前可开工的那张 ticket——open、无 open blocker、无 assignee、无 `agent:*` label，按 sub-issue 顺序取第一张。
_Avoid_: next task, queue head, 待办

**Claim**:
用 assignee 表示某张 ticket 已被一次运行占用。
_Avoid_: lock, lease, 认领标记

**Target repo**:
某个 spec/ticket 所属的仓库，也就是 agent 真正提交代码的地方。
_Avoid_: source repo, project

**Pilot repo**:
第一个真实目标仓库（pi-web）；kind 上的 e2e 不算。
_Avoid_: test repo

### 控制面

**App**:
单副本的 TypeScript 服务，收 webhook、做 reconcile，并且是唯一往 GitHub 写状态的角色。
_Avoid_: bot, orchestrator, controller, github app 服务端

**Reconcile pass**:
一次幂等的重算：从 GitHub 与 k8s 读出全部相关状态，算出该做什么并执行。
_Avoid_: sync loop, poll, tick, 轮询

**Agent role**:
一次运行要扮演的角色（`implement-ticket` / `implement-spec`），决定挂载哪份 prompt。
_Avoid_: mode, action, agent type

### 执行面

**Job**:
一个 k8s Job，跑一个 agent role，对应一张 ticket（或某个 spec 的收尾）。
_Avoid_: worker, pod, task

**Run result**:
Job 结束前写在自己 Job 对象 annotation 上的结果载荷 `{outcome, summary, commentBody?, newTickets?[]}`。
_Avoid_: report, output, artifact

**Outcome**:
run result 的三种结论之一——`done` / `blocked` / `error`。
_Avoid_: status, state, 返回值

**Base PVC**:
每个 target repo 一个、长期保留的 PVC，里面是该仓库 main 的一份同步克隆。
_Avoid_: cache, mirror, workspace

**Sync Job**:
App 起的一次性 Job，把某个 target repo 的 base PVC 同步到最新 main；它是 base PVC 唯一的写者。
_Avoid_: git-sync, mirror job, fetcher

**Job snapshot**:
从 base PVC 打出的 CSI 快照，用来给一次 Job 播种工作副本。
_Avoid_: clone, copy, overlay

### 外部边界

**OmniRoute**:
集群内 OpenAI 兼容的模型网关，向上游 provider 转发；Job 从不持有上游 key。
_Avoid_: proxy, gateway, router, LLM API

### Labels

**ready-for-agent**:
人（或 interactive agent）声明这张 issue 已经 spec 完整、可以交给 AFK agent。

**agent:implement**:
人手动加上，表示「开始按这个 spec/ticket 干活」。

**agent:in-progress**:
App 加上，表示已有 Job 在跑。

**agent:error**:
Job 非正常退出（含超时），由 App 加上。

**agent:blocked**:
Job 正常退出但没做完、或遇到真阻塞，由 App 加上。
