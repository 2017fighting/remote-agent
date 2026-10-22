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
某个 spec 当前可开工的那张 ticket：它的 sub-issue 里第一条通过 Gate 的。
_Avoid_: next task, queue head, 待办

**Gate**:
一张 issue 可以被 App 动手的全部条件：`open` ∧ 无 open blocker ∧ 有 `ready-for-agent` ∧ 有 `agent:implement` ∧ 无任何 `agent:*` label。四条件缺一不动；不够条件不是错误，只是不做。
_Avoid_: 门槛, 准入, ready check

**Claim**:
App 给一张 ticket 加上 `agent:in-progress` 的那一次 label edit，表示此刻有一个 Job 占着它；去重靠它加确定性 Job 名（create-if-absent）。assignee 不参与状态机。
_Avoid_: lock, lease, 认领标记

**Re-entry**:
人把一张 `blocked` / `error` 的票送回 Frontier 的唯一动作：摘 `agent:blocked` / `agent:error`，把 `ready-for-human` 换回 `ready-for-agent`；`agent:implement` 不动。
_Avoid_: retry, 重新触发, 恢复

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

**Defer**:
额度已满时本轮什么都不做——不建 Job、不改 label、不评论——等下一次 reconcile 自然重试。
_Avoid_: queue, 排队, 延后重试

**Agent role**:
一次运行要扮演的角色（`implement-ticket` / `implement-spec`），决定用哪份 prompt 模板。
_Avoid_: mode, action, agent type

### 执行面

**Job**:
一个 k8s Job，跑一个 agent role，对应一张 ticket（或某个 spec 的收尾）。Job 的终态是这次运行唯一的结论来源；pod 可以在 `resume()` 里重启，所以 pod 的终态不说明任何事。
_Avoid_: worker, pod, task

**Runner**:
镜像里烧的 TypeScript 程序：打开 Ticket PVC 上的 durable storage、注入 prompt 与模型、跑一个 agent role、在真正终态时把 run result 写进自己 Job 的 annotation。它是 Job 里唯一的 k8s writer。
_Avoid_: wrapper, entrypoint, pi 命令

**Ticket PVC**:
一个 ticket 一块、`ReadWriteOncePod`、`truenas-iscsi-delete`（薄置备、`reclaimPolicy: Delete`）的 PVC，比 Job 活得久，里面同时装这个 ticket 的工作副本（`repo/`）、durable 的 session storage（`state/`）与 HOME 的缓存（`home/`）；它的生死由 App 按 Ticket PVC expiry 决定（[ADR-0011](docs/adr/0011-ticket-pvc-recycling.md)）。
_Avoid_: 工作卷, workspace, job pvc

**Ticket PVC expiry**:
Ticket PVC 上的 `remote-agent/expires-at` annotation（RFC3339）：App 在判定 outcome 的那一次 reconcile 里写一次（`done` 7 天、`blocked` / `error` 30 天），Claim 时清掉；**不存在 = 这块卷不可删**。
_Avoid_: ttl, 保留期, 过期时间

**Seed**:
init container 把工作副本装进 Ticket PVC 的那一步：问 `git ls-remote` 分支在不在、全量克隆、checkout `agent/spec-<n>`、写 marker。只碰 `repo/`，从不碰 `state/`。
_Avoid_: bootstrap, sync, 初始化

**Seed marker**:
`state/seeded.json`——播种最后一步原子写下的记录：这块卷是按哪个 repo、哪个分支、哪个 commit 播的。存在且与 Job 的 env 一致就跳过播种；未提交改动与 session storage 靠它保住。
_Avoid_: done flag, lock file, 初始化标记

**Review fixed point**:
review 只审它之后的 diff 的那个提交。ticket role 取**本次运行的起点**（runner 开工前读到的 HEAD，存进 durable，`resume()` 后不变），spec 收尾 role 取**分支起点**（`git merge-base origin/main HEAD`）。值由 runner 注入 prompt 与 `code_review` 工具。
_Avoid_: base sha, diff 起点, 基准提交

**Slot**:
一个 Job 占用的一个并发名额；全局与每个 target repo 各有一条上限。Job 只要名下还有未到终态的 pod 就占着它的 Slot，无论该 pod 是否正在终止。
_Avoid_: 并发数, 令牌, quota

**Guardrail quota**:
namespace 里只算对象数量的 ResourceQuota（不含 requests/limits 键），用来防止 App 逻辑写错时无限起 Job；它不承载并发语义。
_Avoid_: quota, 上限, 配额

**Run result**:
写在 Job 自己对象 annotation 上的结果载荷 `{v, outcome, summary, commentBody?, prBody?, newTickets?[], warnings?[]}`；agent 用 Result tool 自述，runner 在 outcome 已定之后才落盘——被中断的运行不写它（[ADR-0007](docs/adr/0007-run-result-contract.md)）。outcome 的值不在载荷里选，而由「调了哪个 Result tool」决定。
_Avoid_: report, output, artifact

**Result tool**:
runner 里烧的三个 durable 工具，按 Agent role 注入其中两个——`finish_ticket`（这张 ticket 干完）/ `finish_spec`（整条 spec 干完、可开 PR）/ `blocked`（自判卡住）；它返回 `control: { terminate: true }` 让本次 run 就此收尾，且只把自述交给 runner，不碰 GitHub、不碰 k8s。
_Avoid_: result command, agent-result helper

**Outcome**:
run result 的三种结论之一——`done` / `blocked` / `error`；它描述**这次运行是怎么结束的**，不描述为什么没做成（后者是 App 证据评论里的事，不进载荷）。agent 只能产生 `done`（调 `finish_ticket` / `finish_spec`）与 `blocked`（调 `blocked`）；`error` 只由 runner/App 判（Job 非正常终态、读不到 annotation、label 与 Job 漂移），包揽一切非 agent 自述的失败且**不自动重试**（重试的粒度是 k8s 重启 pod + 同卷 `resume()`）。
_Avoid_: status, state, 返回值

**Seed failure**:
播种失败的五个分类（`auth` / `repo_unreachable` / `ref_missing` / `disk` / `unknown`）与两个退出码（可重试 75、不可重试 78）。不可重试的那一类由 Job 的 `podFailurePolicy` 直接判终态，不等 `backoffLimit` 磨完；`disk` 的触发点是播种前的 `df` 预检（卷空闲空间不足）。
_Avoid_: seed error, clone 失败, 初始化错误

**Base PVC**:
每个 target repo 一个、长期保留的 PVC，里面是该仓库 main 的一份同步克隆。**v1 不用**——工作副本由 init container 直接播种进 Ticket PVC（[ADR-0008](docs/adr/0008-durable-runtime-base.md)），留作 v2 候选。
_Avoid_: cache, mirror, workspace

**Sync Job**:
App 起的一次性 Job，把某个 target repo 的 base PVC 同步到最新 main；它是 base PVC 唯一的写者。**v1 不用**（没有 base PVC）。
_Avoid_: git-sync, mirror job, fetcher

**Job snapshot**:
从 base PVC 打出的 CSI 快照，用来给一次 Job 播种工作副本。**v1 不用**：工作副本直接在 Ticket PVC 上生长，不再从快照播种。
_Avoid_: clone, copy, overlay

### 外部边界

**OmniRoute**:
集群内 OpenAI 兼容的模型网关，向上游 provider 转发；Job 持有它的地址与一把网关 key，从不持有任何上游 provider 的 key。
_Avoid_: proxy, gateway, router, LLM API

### Labels

**ready-for-agent**:
人（或 interactive agent）声明这张 issue 已经 spec 完整、可以交给 AFK agent。

**agent:implement**:
人手动加上，表示「开始按这个 spec/ticket 干活」。记的是「人授权过」，不是「此刻在跑」，所以 App 永不删它。

**agent:in-progress**:
App 加上，表示这张 ticket 此刻被一个 Job 占着（Claim → Job 终态）。只出现在 ticket 上，spec 从不带它；pod 重启期间它一字不变。

**agent:error**:
App 加上，表示这次运行没有可用结论：Job 非正常退出（backoffLimit 耗尽 / 超时）、Job 已终态却读不到 run result、或 label 与 Job 漂移（有 `in-progress` 无 Job）。同时摘 `ready-for-agent`、加 `ready-for-human`、发一条带证据的评论；**没有自动重试**。

**agent:blocked**:
Agent 自述没做完、需要人做决定，由 App 按 run result 加上（同时摘 `ready-for-agent`、加 `ready-for-human`、转写评论）。
