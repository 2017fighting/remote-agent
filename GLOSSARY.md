# Remote Agent

一个把 GitHub issue 变成 k8s 里 AFK agent 运行的编排系统：App 读 issue、算 frontier、起 Job，Job 里的 runner 跑一个 agent role、把结果写进自己 Job 的 annotation，再由 App 回报到 GitHub。

## Language

### 工作单元

**Spec**:
一个带 sub-issue 的 GitHub issue，代表一整块要端到端实现的工作；它的所有 ticket 共用一条分支。
_Avoid_: epic, parent issue, 大 issue

**Ticket**:
一个没有 sub-issue 的 GitHub issue，是 agent 一次运行的工作单元。
_Avoid_: task, subtask, child issue

**Frontier**:
某个 spec 当前可开工的那张 ticket：它的 sub-issue 里第一条**通过 Claim-gate 的**——即 Gate（label 半边）∧ 确定性名下无未删的 Job 对象（k8s 半边，见 `Claim`；[ADR-0013](docs/adr/0013-claim-gates-on-job-absence.md)）。
_Avoid_: next task, queue head, 待办

**Gate**:
一张 issue 可以被 App 动手的全部条件：`open` ∧ 无 open blocker ∧ 有 `ready-for-agent` ∧ **已授权** ∧ 无任何 `agent:*` label。四条件缺一不动；不够条件不是错误，只是不做。

**已授权**对 ticket 有两个来源：它自己带 `agent:implement`，**或**它的父 spec 在门内（即父 spec 自己过得了 `Gate`，包括它自己带 `agent:implement`；继承；见 [`agent:implement`](#labels)）。只有授权这一条能继承——`ready-for-agent`、blocker、`open`/`closed`、exit 标记都仍是这张票自己的事实。spec 自己没有父，所以它的门只认自己的 label。
_Avoid_: 门槛, 准入, ready check

**Loop**（spec 的「在循环里」）:
Gate 里除授权之外的三条：`open` ∧ 无 open blocker ∧ 有 `ready-for-agent` ∧ 无任何 `agent:*`。spec 靠它决定「能不能推进 sub-issue」——**不看自己的 `agent:implement`**，因为那张票可能自带授权（「只单独实现这一张」的入口）。spec 自己的收尾运行（S2–S5）不是推进 sub-issue，所以还要 `Gate` 的授权那一条。
_Avoid_: 半门, 弱门

**Claim**:
App 给一张 ticket 加上 `agent:in-progress` 的那一次 label edit，表示此刻有一个 Job 占着它。门是双半边的：除了 label 门（无任何 `agent:*`），还要求该 ticket 确定性名下**无未删的旧 Job 对象**（终态与否）——名下 Job 还在就不 Claim、不读旧 annotation，等它的 `DELETED` 事件唤醒（[ADR-0013](docs/adr/0013-claim-gates-on-job-absence.md)）。去重靠这门 + 确定性 Job 名的 create-if-absent。assignee 不参与状态机。
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
一次幂等的重算：从 GitHub 与 k8s 读出全部相关状态，算出该做什么并执行。唤醒源有三种——webhook、Job watch、Resync tick（[ADR-0014](docs/adr/0014-wake-surface-periodic-resync.md)）；同一时刻只跑一轮，期间的触发合并成恰好一次后续 pass。
_Avoid_: sync loop, poll, tick, 轮询

**Resync tick**:
每 5 分钟一次（`RESYNC_INTERVAL_SECONDS`）的周期性唤醒：只当「去跑一轮 pass」的信号，自己不重算、不读 GitHub、不持有状态（[ADR-0014](docs/adr/0014-wake-surface-periodic-resync.md)）。
_Avoid_: poller, 轮询器, cron job, sync loop

**Defer**:
额度已满时本轮什么都不做——不建 Job、不改 label、不评论——等下一次唤醒自然重试；它的重试上界就是 Resync tick 的间隔。
_Avoid_: queue, 排队, 延后重试

**Idle**:
某个 spec 在门内、有 open sub-issue、但 Frontier 空，于是本轮什么都不做——不建 Job、不改 label、不评论，只把它计进 pass 日志的 `idle` 数，并为它打一行 `idle-spec` 说清原因（[ADR-0014](docs/adr/0014-wake-surface-periodic-resync.md)）。与 `Defer` 同形（都是「没动作但有原因」），区别是下一步：`Defer` 等额度，`Idle` 等人或等 label。
_Avoid_: blocked, 空转, 无事可做

**Agent role**:
一次运行要扮演的角色（`implement-ticket` / `implement-spec`），决定用哪份 prompt 模板。
_Avoid_: mode, action, agent type

### 执行面

**Job**:
一个 k8s Job，跑一个 agent role，对应一张 ticket（或某个 spec 的收尾）。Job 的终态是这次运行唯一的结论来源；pod 可以在 `resume()` 里重启，所以 pod 的终态不说明任何事。
_Avoid_: worker, pod, task

**Round**（一轮）:
一条 conversation 上一次**报过结论**的运行。票的 conversation 可以有多轮：报过结论之后，人重开这张票、或重入一张 `blocked` 票，runner 就在同一块卷上开新的一轮，带着上一轮的历史；收尾 role 的 conversation 恰好一轮，所以它的每一轮都在**新卷**上开始（[ADR-0016](docs/adr/0016-closeout-round-starts-on-a-fresh-volume.md)、[ADR-0017](docs/adr/0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md)）。
_Avoid_: run（那是「一次运行」，一个 Job 跑一轮）, attempt, 轮次

**Round header**:
runner 在 round ≥ 2 时前置到 prompt 的那一段：第几轮、上一轮报了哪个 outcome、什么时候报的，以及「正文里的评论是那之后发生的事」。它是 runner 生成的，不住在 prompt ConfigMap 里——它说的那些事实只活在卷上（[ADR-0017](docs/adr/0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md)）；round 1 没有它。
_Avoid_: 轮次前缀, round note, preamble

**Runner**:
镜像里烧的 TypeScript 程序：打开 Ticket PVC 上的 durable storage、注入 prompt 与模型、跑一个 agent role、在真正终态时把 run result 写进自己 Job 的 annotation。它是 Job 里唯一的 k8s writer。
_Avoid_: wrapper, entrypoint, pi 命令

**Submission key**:
runner 提交这次 run 时用的去重键，形如 `remote-agent:<repo>#<n>:<role>`；崩溃后新 pod 靠它找回同一条未结算的 submission 续跑（ADR-0008）。**已结算的 submission 不可续跑**——同一个键再提交只会立刻拿回那个旧终态——所以这张 conversation 已有结算过的输入 submission 时（模型报错、被 abort），新一次尝试的键会带一个递增的 `#retry-<n>` 后缀，真正开一次新 run。计数只算 `type: "input"` 的结算记录，compaction 那种 `write` 不算一次尝试（[#52](https://github.com/2017fighting/remote-agent/issues/52)）。一段 conversation 可以有**两个键族**：run 自己的 `…:<role>`，与冲突交接那一轮的 `…:<role>#conflict`——各自的 `#retry-<n>` 从自己的基键数起，否则两族会互相占用序号（[#58](https://github.com/2017fighting/remote-agent/issues/58)）。
_Avoid_: requestId（那是 durable 的字段名）, 幂等键

**Conflict hand-off**:
一次运行里唯一那轮「解冲突」的交接：push 把本次提交 rebase 到 spec 分支的 tip 上时停在冲突上，runner 不 abort，把停着的 rebase 与未合并路径清单交给同一个 conversation 里的 agent（编辑 → `git add` → `git rebase --continue`），agent 跑全量测试后重述 run result，runner 再 push。预算只记**已自述的一次**，写在卷上的 `remote-agent.conflict-handoff` 里：声明的解没解成（rebase 仍停着、或 `HEAD` 不再含本次提交）与解完再撞都是 `FatalPushError`，agent 说两边意图不能共存则自述 `blocked`（[#58](https://github.com/2017fighting/remote-agent/issues/58)）。
_Avoid_: 自动解冲突、merge 冲突、重试 push

**Ticket PVC**:
一个 ticket 一块、`ReadWriteOncePod`、`truenas-iscsi-delete`（薄置备、`reclaimPolicy: Delete`）的 PVC，比 Job 活得久，里面同时装这个 ticket 的工作副本（`repo/`）、durable 的 session storage（`state/`）与 HOME 的缓存（`home/`）；它的生死由 App 按 Ticket PVC expiry 决定（[ADR-0011](docs/adr/0011-ticket-pvc-recycling.md)）。
_Avoid_: 工作卷, workspace, job pvc

**Ticket PVC expiry**:
Ticket PVC 上的 `remote-agent/expires-at` annotation（RFC3339）：App 在判定 outcome 的那一次 reconcile 里写一次（`done` 7 天、`blocked` / `error` 30 天），Claim 时清掉；**不存在 = 这块卷不可删**。
_Avoid_: ttl, 保留期, 过期时间

**Spent volume**:
一块**已经报过结论**的卷：它 `state/` 里的 conversation 报过一次结论（[ADR-0011](docs/adr/0011-ticket-pvc-recycling.md) 的「重跑不回到干净态」只对**中断**的 run 成立）。这个事实**不等于**「这块卷不能再跑」——能不能再跑由 role 决定：收尾 role 的 conversation 是终态的，所以它的下一轮必须在新卷上开始（起收尾 Job 时 App 先回收上一轮那块，[ADR-0016](docs/adr/0016-closeout-round-starts-on-a-fresh-volume.md)）；票的卷被复用，runner 在一块的**新 Job** 上就地开新的一轮（[ADR-0017](docs/adr/0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md)）。与 Ticket PVC expiry 的区别：expiry 说的是「什么时候可以删」，spent 说的是「这块卷上的对话已经报过结论」。
_Avoid_: 用过的卷, 脏卷, 已完成的 PVC

**Job retention**:
终态 Job 在被 k8s 按其 `ttlSecondsAfterFinished` 删除之前的保留窗（1800 秒）。它不是清理习惯，而是 App 的读取预算：App 要在这段内读到 run result 并把证据落进 GitHub，超出预算的宕机由 no-job 兜底接管。
_Avoid_: ttl, 清理窗口, job 过期

**Seed**:
init container 把工作副本装进 Ticket PVC 的那一步：问 `git ls-remote` 分支在不在、全量克隆、checkout `agent/spec-<n>`、写 marker。只碰 `repo/`，从不碰 `state/`。
_Avoid_: bootstrap, sync, 初始化

**Seed marker**:
`state/seeded.json`——播种最后一步原子写下的记录：这块卷是按哪个 repo、哪个分支、哪个 commit 播的。存在且与 Job 的 env 一致就跳过播种；未提交改动与 session storage 靠它保住。
_Avoid_: done flag, lock file, 初始化标记

**Review fixed point**:
review 只审它之后的 diff 的那个提交。ticket role 取**本次运行的起点**（runner 开工前读到的 HEAD，存进 durable，`resume()` 后不变），spec 收尾 role 取**分支起点**（`git merge-base origin/main HEAD`）。值由 runner 注入 prompt 与 `code_review` 工具。
_Avoid_: base sha, diff 起点, 基准提交

**Stale credential**:
push 时被远端拒绝的那枚挂载 token——文件的状态，不是卷的状态：App 已把新 token patch 进 Secret，只是 kubelet 还没把它送到 pod。恢复有两条互补的路径：runner 进程内等文件内容变化后重跑一次整段 fetch+rebase+push；等不到就以 retryable 退出，新 pod 启动时重新解析挂载自然读到新文件。凭证类失败因此**永远不是 fatal**（[#57](https://github.com/2017fighting/remote-agent/issues/57)）。与 seed 的 `auth` 分类刻意不对称：seed 拿的是刚 mint 的 token，被拒就是 mint 错了，仍 fatal。
_Avoid_: token 过期（分不清是文件陈旧还是卷坏了）, auth 失败（同一措辞在 seed 那边是 fatal）

**Spec branch**:
`agent/spec-<n>`——**按 spec 命名，不按 ticket**，所以同一 spec 的每个 ticket 都往同一个 ref 推。push 前 runner 会 fetch 该分支并把本次的提交 rebase 到它的 tip 上，因此两个 ticket 先后落地的顺序是安全的；改到同一批行时 rebase 会冲突，runner 不 abort，而是把停在那里的 rebase 交给 agent 按语义解一次（**Conflict hand-off**），解不动由 agent 自述 `blocked`。解完再撞、或凭证/仓库读不到，才是 `FatalPushError`（runner exit 78 → `podFailurePolicy` `FailJob`），一次就停等人工，而不是把同一个 push 重放完 `backoffLimit`（[#55](https://github.com/2017fighting/remote-agent/issues/55)、[#58](https://github.com/2017fighting/remote-agent/issues/58)）。
_Avoid_: 工作分支, feature branch

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

**写在 spec 上时，它的范围是整条 spec 循环，不只是「这一轮开工」**：包括收尾 Job 自己发现的活——收尾 Job 报 `newTickets` 建出的 `ready-for-agent` 新票不用人再点火，下一轮就进 Frontier 并被 Claim（[ticket #48](https://github.com/2017fighting/remote-agent/issues/48)）。这是「逐票授权」→「整条 spec 授权到底」的语义变化，代价明写：**轮数无上限**，没人踩刹车，逃生口是人在 issue 上摘 `agent:implement`（或 `kubectl delete job`）。并发仍受 Slot 上限约束，无上限的只是轮数。

**授权沿 spec → ticket 继承**：一张 ticket 在门内 ⟺ 它自己带 `agent:implement`，或它的父 spec 带 `agent:implement`（且父 spec 自己的门是开的）。所以人给 spec 加一次，它名下所有 `ready-for-agent` 的 sub-issue 都能被 Claim，不必逐票点火；票自己带 label 的用法保留，那是「只单独实现这一张」的手动入口。**继承只影响判定，不落到 label 上**：Claim 不在票上补写 `agent:implement`，票上的 label 永远只记人写过的东西。

**agent:in-progress**:
App 加上，表示这张 ticket 此刻被一个 Job 占着（Claim → Job 终态）。只出现在 ticket 上，spec 从不带它；pod 重启期间它一字不变。

**agent:error**:
App 加上，表示这次运行没有可用结论：Job 非正常退出（backoffLimit 耗尽 / 超时）、Job 已终态却读不到 run result、或 label 与 Job 漂移（有 `in-progress` 无 Job——App 宕机超过了 Job retention）。同时摘 `ready-for-agent`、加 `ready-for-human`、发一条带证据的评论；**没有自动重试**。

**agent:blocked**:
Agent 自述没做完、需要人做决定，由 App 按 run result 加上（同时摘 `ready-for-agent`、加 `ready-for-human`、转写评论）。

**closeout-consumed**:
App 加在 **spec** 上的记号，表示「这块收尾 Job 的 outcome 已经落地」；S3N（收尾 Job 报 `newTickets`）判完那一次写一次，起下一块收尾 Job 那一次清一次（[ADR-0015](docs/adr/0015-closeout-outcome-consumed-once.md)）。**不是 exit 标记**：它不进 `Loop`，也不挡授权继承，只挡「同一块收尾 Job 被重判一次」。S3N 是唯一判完还留在门内的 spec 分支，而它建出来的新票会全部关闭——那个载体一死，没有这个 label 就会把同一批 `newTickets` 再建一遍。

带标记的 spec 这一轮什么都不做（不建 Job、不改 label、不评论），等那块 Job 对象被 `DELETED`；它在 pass 日志里计进 `closeout-consumed=<n>`，与 `Defer` / `Idle` / 等待 `DELETED` 的 Claim 同形。
_Avoid_: 已收尾, consumed flag, 幂等键
