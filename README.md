# Remote Agent

术语以 [`GLOSSARY.md`](GLOSSARY.md) 为准；状态机与执行面图见 [`docs/architecture.md`](docs/architecture.md)，部署面与 env 键面见 [`docs/deployment.md`](docs/deployment.md)，取舍过程住在 [`docs/adr/`](docs/adr/)。本文件只讲「系统长什么样、一次运行怎么走」。

## 运行环境

k8s @/root/clone/home-ops(git@github.com:2017fighting/home-ops.git)

## Github Appas

Name: Raenzo-Remote-Agent
App ID: 5390512
Client ID: Iv23lipjSurEcAJNUaNW
Homepage URL: https://remote-agent.raenzo.com/
Webhook URL: https://remote-agent.raenzo.com/webhook

## mattpocock-skills 生成的issue label

> @/root/clone/mattpocock-skills(git@github.com:mattpocock/skills.git)

- `needs-triage`: maintainer needs to evaluate
- `needs-info`: waiting on reporter for more information
- `ready-for-agent`: fully specified, ready for an AFK agent
- `ready-for-human`: needs human implementation
- `wontfix`: will not be actioned

## 我们需要用到的issue label

- `agent:implement`: 标记这个 issue(spec or ticket) 需要由 remote agent 进行实现；**人写，App 永不删**（它记的是「人授权过」，不是「此刻在跑」）。**一张 ticket 的授权可以继承自它的父 spec**：给 spec 加一次，它名下所有 `ready-for-agent` 的 sub-issue 都能被 Claim，不必逐票点火；票自己带 label 的用法保留，那是「只单独实现这一张」的手动入口。继承只影响判定、**不落到 label 上**——Claim 不在票上补写它，票上的 label 永远只记人写过的东西。**写在 spec 上时它授权的是整条 spec 循环**，包括收尾 Job 自己发现的新活（`newTickets` 建出的 `ready-for-agent` 票下一轮自己就跑），代价是轮数无上限，见 [`Spec implement循环`](#spec-implement循环)
- `agent:in-progress`: App 已 Claim 这个 ticket（此刻有 Job 占着它）；**只出现在 ticket 上，spec 从不带它**
- `agent:error`: Job 非正常退出 / 读不到 run result / label 与 Job 漂移，由 App 设置；**没有自动重试**，人改 label 是唯一重入方式
- `agent:blocked`: agent 自述没做完、需要人做决定，由 App 按 run result 设置
- `closeout-consumed`: **只在 spec 上**，App 加/摘。表示「这块收尾 Job 的 outcome 已经落地」，挡住同一批 `newTickets` 被再建一遍；不是 exit 标记，不进 `Loop`（[ADR-0015](docs/adr/0015-closeout-outcome-consumed-once.md)）

## implement整体流程

1. `人`：给 `ready-for-agent` 的 issue 加 `agent:implement` 的 label——**给 spec 加一次就够**，它的 sub-issue 继承这个授权（不必逐票点火），**包括收尾 Job 自己建的新票**；只想单独跑某张票时，也可以把 label 加在那张票上
2. `App`：收到 webhook（`issues` / `issue_comment` / `sub_issues` / `issue_dependencies` / `installation_repositories`），**只把它当「去跑一轮 pass」的信号**，不解析业务。唤醒源设计上共三个（webhook、Job watch、每 5 分钟的 resync tick），落点都是同一个 `reconcile()`（[ADR-0014](docs/adr/0014-wake-surface-periodic-resync.md)）；**目前 Job watch 尚未 arm，在跑的是 webhook + tick**（见 [architecture.md §1](docs/architecture.md#1-系统全景) 的实现状态注）
3. `App`：一轮 pass 从 GitHub 与 k8s 读出全部相关状态。有 sub-issue 的 issue 是 spec（算它的 Frontier，只实现 Frontier 那一张 ticket），没有 sub-issue 的是 ticket（实现它自己）
4. `App`：Claim 这张 ticket——按写序建 Ticket PVC（若缺）、mint 只覆盖目标 repo 的 installation token 写进 `agent-<repo-slug>-<issue#>-token`、create-if-absent 建 Job，**最后**才写 `agent:in-progress`（反过来会在两写之间留下假的 no-job 形状，[ADR-0013](docs/adr/0013-claim-gates-on-job-absence.md)）
5. `implement job`：init container `seed` 先把工作副本播进这块 ticket 自己的 Ticket PVC（`git ls-remote` 判分支、克隆、checkout `agent/spec-<n>`、原子写 marker），主容器 `runner` 再打开同一块卷上的 durable storage 跑一个 agent role——执行面基座是 **`@earendil-works/pi-durable` 这个库 + 自写的 TypeScript runner**，不是 `pi -p`（[ADR-0008](docs/adr/0008-durable-runtime-base.md)）。agent 不碰 GitHub：push 由 runner 在收尾时做，凭证是挂成文件的 token
6. `App`：读 Job 的 `remote-agent/run-result` annotation 判 Outcome，写 label / 评论 / 关票 / 开 PR。**没有「检查 pi 最终结果」这层包装**：结果由 agent 调的 Result tool 自述、runner 落在 annotation 上（[ADR-0007](docs/adr/0007-run-result-contract.md)），四条非 agent 自述的失败由 App 从 Job 终态推出来并判 `error`（[architecture.md §4.6](docs/architecture.md#46-每个-error--blocked-终态都留一条评论)）

## 如何区分issue是`spec`还是`ticket`

**有 sub-issue 的 issue 就是 spec，没有的是 ticket**——不靠 label 区分，也不给 ticket 建 sub-issue（[architecture.md §4.5](docs/architecture.md#45-spec)）。spec 与它的 ticket 是一对多；spec 只驱动 Frontier 那一张，自己从不带 `agent:in-progress`。

## 如何找spec当前frontier ticket

list then open children，keep only those passing the Gate（`open` ∧ no open blocker ∧ `ready-for-agent` ∧ **已授权** ∧ no `agent:*` label），first wins。**已授权**对一张 ticket 有两个来源：它自己带 `agent:implement`，或它的父 spec 带 `agent:implement`（且父 spec 自己的门是开的）——所以给人给 spec 加一次 label，整串票就自己跑下去。只有授权这一条能继承，其余四条仍是票自己的事实。**门还有 k8s 半边**：该 ticket 确定性名下的 Job 对象还在（终态与否）就不 Claim、不建、不读旧 annotation，等它被删掉之后的下一轮唤醒（[ADR-0013](docs/adr/0013-claim-gates-on-job-absence.md)）。

## job并发

由 `App` 自己算，不用 k8s 的并发机制：**全局 `MAX_JOBS_GLOBAL`（默认 3）、每个 target repo `MAX_JOBS_PER_REPO`（默认 2）**，两个都是 App env 键（[deployment.md §6](docs/deployment.md#6-job-模板与镜像)）。

- **Slot**：一个 Job 占一个并发名额。Job 只要名下还有未到终态的 pod 就占着它，**`Terminating` 也算**；终态 pod 与「根本没有 pod」都不占（保留窗里的旧 Job 因此不占名额）。计数按 Job 聚合（pods 按 `ownerReferences` 归到 Job），所以 pod 重启不会双计（[architecture.md §5](docs/architecture.md#5-并发slot-与-defer)）。
- **Defer**：名额不够时本轮什么都不做——**不建 Job、不改 label、不评论**，只把 `deferred` 计数打进那行 pass 日志。重试不是排队，而是等下一次唤醒自然重算，上界就是 resync tick 的间隔（[ADR-0014](docs/adr/0014-wake-surface-periodic-resync.md)）。
- **Guardrail quota 不是并发**：namespace 里那个只算对象数量的 ResourceQuota 防的是「App 逻辑写错时无限起 Job」；撞到它（403）是正常分支，同样不建、不改、不报 `agent:error`。

## branch

每个spec一个branch`agent/spec-<spec-issue-number>`，这个spec下的sub issue，都在这个branch下工作，每次工作前都从最新commit开始（新卷靠播种拿到分支的最新提交；同一张票重入时卷上还留着上一轮的工作副本与历史，播种 marker 匹配就跳过，见下面 `## k8s job的pvc哪来`）。**v1 每 spec 串行、单写者**（#4 / #13）曾是「远端已前进（非 FF）即按异常处理、runner 不自动 rebase」的依据（[ADR-0009](docs/adr/0009-ticket-volume-seeding.md)）。**2026-10-25 修正**：分支是按 **spec** 命名的，所以同一 spec 的两张票确实会先后写同一个 ref，「串行」并不等于「只有一个写者」——`pi-web#3` 与 `#4` 就撞上了，后者被非快进拒绝后把同一个 push 重放到 `backoffLimit` 耗尽（[#55](https://github.com/2017fighting/remote-agent/issues/55)）。现在 push 前会 fetch 该分支并把本次提交 rebase 到它的 tip 上。**2026-10-26 修正（[#58](https://github.com/2017fighting/remote-agent/issues/58)）**：rebase 停在冲突上不再等人工——runner 不 abort，把停在冲突上的 rebase 与未合并路径清单交给 agent（同一个 conversation 里再一轮输入），agent 按语义解开、`git add`、`git rebase --continue`、跑全量测试与 typecheck 后自述一次，runner 再 push 并用新的 run result 写 annotation（被冲突重开的那次允许覆盖上一次，预算只记一次，且写在卷上）。解不动由 agent 自述 `blocked`；**解完再撞**（或仓库根本不是 git 仓库）才是 `FatalPushError` → runner exit 78 → `podFailurePolicy` `FailJob`，**一次就停等人工**，不再重放。**凭证被拒不属于这类**——那是挂载的 token 文件陈旧而非卷坏了，runner 会等文件变化重试一次，等不到就交给新 pod（[#57](https://github.com/2017fighting/remote-agent/issues/57)）。代价：每撞一次多付一整轮 agent 的 token，且解冲突产生的新提交没有 review 覆盖（覆盖它的是那一轮之后的全量测试）。

## Spec implement循环

每轮 pass 重算当前 spec 的 Frontier，只实现那一张 ticket。一张票怎么结束由它的 run result 说（agent 自述 done/blocked，App 转写）：

- **done**：App 关票、摘 `agent:in-progress`；下一轮唤醒重算 Frontier，接着实现下一张
- **blocked**：App 加 `agent:blocked` + `ready-for-human`、按 run result 的 `commentBody` 转写一条评论说明做了什么，**不关票**，然后停下（agent 不碰 GitHub，[ADR-0002](docs/adr/0002-app-is-sole-github-writer.md)）

直到所有 `ready-for-agent` 的 sub-issue 都做完。**spec 下再无 open sub-issue 时**，App 起一个收尾 Job（`implement-spec`）做最后的工作：干完就开 PR 到 main（`Closes` 由 App 写进 PR body）；判断还有活没干完就在 spec 下新建 sub-issue、**不开 PR**——新票只带 `ready-for-agent`（或 `ready-for-human`），但授权是沿 spec 继承来的，所以 **`ready-for-agent` 的新票下一轮就进 Frontier、就被 Claim**，不需要人在票上补 `agent:implement`；`ready-for-human` 的留在门外等人。票上的 label 走的是普通票那条链：`ready-for-agent`（App 建票时写）→ 继承授权 → `agent:in-progress`，`agent:implement` 全程不出现。

S3N 的 outcome **只消费一次**：这块分支判完还留在门内，而它唯一的「已消费」载体原本是它建出来的票——票全部关闭之后载体就没了，旧收尾 Job 却还在 30 分钟保留窗里，同一批 `newTickets` 会被再建一遍。所以 S3N 在 spec 上加一个 `closeout-consumed` label（判定那一次写、起下一块收尾 Job 那一次清）：新票全关之后 spec 停在这儿等旧 Job 的 `DELETED`，然后起一块**新的**收尾 Job 重新判断还剩什么（[ADR-0015](docs/adr/0015-closeout-outcome-consumed-once.md)）。

**收尾的每一轮都在一块新卷上开始**（[ADR-0016](docs/adr/0016-closeout-round-starts-on-a-fresh-volume.md)，[#60](https://github.com/2017fighting/remote-agent/issues/60)）：收尾 role 的 conversation 报过一次就是终态的，同一块卷上的第二轮只会 `seed-skip` + `already-complete` + 不写 annotation，App 只能判 `no-result`——所以起收尾 Job 时先删掉上一轮那块卷与它的同名 Secret，再建新的。代价明写：上一轮的对话全文在下一轮开始时消失，App 在 GitHub 上的那条评论成为唯一记录（`blocked` / `error` 的 30 天保留期只在**没有下一轮**时有效，想读全文要在重入前读）。runner 侧另有一道守卫：打开卷发现 conversation 已完成、而自己 Job 上没有 `run-result` annotation（新 Job 跑在一块 Spent volume 上）就 exit 78 → `unrecoverable`，评论里现成的指引直接叫人删卷。

这条修法明写两个代价：**每轮之间多一个 ≤30 分钟的等删除间隙**（等不及就 `kubectl delete job <名>`，删除事件即唤醒）；以及**两个崩溃窗口仍然没有载体**——「标记写完、票还没建」丢整批，「票建好、还没链接」丢剩下的票外加一张孤儿票，都靠 TTL 后的新收尾 Job 补回。反过来的写序（先建票后标记）会把重复建票的洞留着。

**代价：轮数无上限。** 收尾 Job 每轮都可能再报 `newTickets`，没人踩刹车；一张 spec 到底要跑多少轮才收尾，不再有人类检查点兜着。并发仍然有界（每轮受 [`MAX_JOBS_GLOBAL` / `MAX_JOBS_PER_REPO`](#job并发) 约束，不会同时起一堆），无上限的只是轮数。逃生口两个，都在人手上：在 issue 上摘 `agent:implement`（整条 spec 立刻退出门），或 `kubectl delete job <名>`（只影响当前这一块）。

spec 上**从不写 `agent:in-progress`**：它的「在跑」就是「在门内 + Frontier 空/非空」，收尾后把 `ready-for-agent` 换成 `ready-for-human` 就是退出门。完整状态表见 [architecture.md §4.5](docs/architecture.md#45-spec)。

## k8s job的pvc哪来

**每个 ticket 一块自己的 Ticket PVC，没有 Base PVC、没有 Sync Job、也没有快照**——这三样在 v1 都已退出（[ADR-0008](docs/adr/0008-durable-runtime-base.md)，[GLOSSARY](GLOSSARY.md) 里保留为 v2 候选）。

1. Claim 时 App 先 create-if-absent 建这块卷（名字就是 Job 名 `agent-<repo-slug>-<issue#>`，`ReadWriteOncePod`，SC `truenas-iscsi-delete` 薄置备，默认 8Gi = 文件系统上限而不是池占用），然后才建 Job、最后写 `agent:in-progress`
2. Job 的 init container `seed` 把工作副本播进这块卷：`git ls-remote --exit-code` 判 `agent/spec-<n>` 分支在不在 → 全量克隆（分支在就直接 `--branch` 克隆，不在就从 `main` 克隆再 `checkout -b`）→ `fetch origin main:refs/remotes/origin/main`（spec 收尾 role 的 `merge-base origin/main HEAD` 靠它）→ 最后原子写 `state/seeded.json` marker。播种前先做一次 `df` 预检（< 3Gi 直接判 `disk` 失败），因为卷满会让同一个 phase 反复撞 ENOSPC。**工作副本只落在 `repo/`**：`state/` 只放 marker 与 session storage（`state/` 永远在 git 视野之外，`git clean -xfd` 删不掉唯一一份可续跑的历史），`home/` 只当 `HOME`（[ADR-0009](docs/adr/0009-ticket-volume-seeding.md)）
3. 主容器 `runner` 用的是同一块卷：工作副本在 `repo/`，durable 的 session storage（`session.sqlite`，WAL）在 `state/`，`HOME` 在 `home/`（npm 不重下）。**没有「每次都从零拉取」的问题，也没有需要同步的 base**：同一张票重入时 marker 匹配就跳过播种，未提交改动与历史全在；只有 marker 缺失、且 `state/` 里也没有 session 时才清 `repo/` 重播。
4. 卷比 Job 活得久，因为 `resume()` 与「人回来把对话全文读出来」（[architecture.md §8 缺口 B](docs/architecture.md#8-三处缺口)）都要它。生死由 App 按 `remote-agent/expires-at` 判：判 Outcome 那一次 reconcile 写一次（`done` 7 天，`blocked` / `error` 30 天，set-if-absent），Claim 时清掉；**不存在 = 不可删**。兜底只看 k8s：无 `expires-at` ∧ 无未终态 Job ∧ 年龄 > 30 天 → 删（[ADR-0011](docs/adr/0011-ticket-pvc-recycling.md)）
5. 回收的对象是两个：Ticket PVC + 同名的 per-Job Secret（凭证跟卷一起死）；Job 本身归 k8s 的 `ttlSecondsAfterFinished`，App 既无 Job 的 `delete` 也无 `patch` 权（[ADR-0012](docs/adr/0012-job-deletion-ttl.md)）

spec 的收尾 Job（`implement-spec`）也是同一套：确定性名、同一块自己的 Ticket PVC、同一条回收规则——它同样会拿到 `expires-at`。**唯一的例外是删除点**：起下一块收尾 Job 时先删掉上一轮那块（[ADR-0016](docs/adr/0016-closeout-round-starts-on-a-fresh-volume.md)），因为收尾 role 的 conversation 报过一次就不再跑。

## implement ticket prompt

镜像里**没有 skill 层**：durable 没有 Skill 工具、没有 slash command，runner 也不扫目录（[ADR-0004](docs/adr/0004-prompts-live-in-configmap.md)）。prompt 是 ConfigMap `remote-agent-prompts` 里的纯文本，`_common` 拼在最前，再拼 role 模板（`implement-ticket` / `implement-spec`），由 runner 渲染占位符后交给模型。所以 mattpocock 那套里 AFK 必需的语义全部由我们自己钉死，落点只有四类：角色 prompt、工具自述、App、init container/runner——**不引入 wrapper、辅助命令、skill 加载器**（[prompt 必写项清单](docs/agents/prompt-checklist.md)）。

`implement-ticket` 掐掉了上游「问用户」的分支：

1. issue 号与正文：App 读好、经 `AGENT_WORK_ITEM` 交给 runner（agent 手上没有 `gh`，也不该有凭证）
2. base 分支是 `agent/spec-<spec-issue-number>`
3. 两轴 code review 前先本地 commit（review 只看 `<fixed>...HEAD`，排除工作区与 staged），fixed point 是**本次运行的起点**，由 runner 存进 durable、`resume()` 后不变；Spec 轴读的 spec 正文也由 `code_review` 工具注入
4. 小 bug 直接修，真有阻塞就调 `blocked` 工具自述（不碰 GitHub）

## implement Spec prompt

`implement-spec` 是收尾 role，跑在分支 `agent/spec-<n>` 上：

- **不跑 e2e**：v1 撤销了「收尾 Job 跑 e2e」（[#4](https://github.com/2017fighting/remote-agent/issues/4) 的决策行）；收尾验证 = 全量测试 + typecheck（仓库 prompt 里点名 lint 就跑），代价是目标仓自己的 `test:e2e` 这次没人跑，结果交到 PR 让人看
- 全分支一次 `code_review`（fixed point = `git merge-base origin/main HEAD`，分支起点）→ 修完发现 → 再跑一遍测试与 typecheck
- 调 `finish_spec` 交 `prBody`；**PR 由 App 开**，`Closes #<spec>` 由 App 追加进 PR body（幂等，已含就不重复加）——agent 不开 PR、不调 `gh`、也不把 `Closes` 写进 commit message（[ADR-0002](docs/adr/0002-app-is-sole-github-writer.md)）
- 修不动的、超范围的写进 `newTickets`：那一次**不开 PR**，App 只建 sub-issue

## implement job的结果

结果由 **Result tool + Job annotation** 承载（[ADR-0007](docs/adr/0007-run-result-contract.md)）：agent 调一个 Result tool 自述，runner 在 outcome 已定之后才把它 PATCH 到**自己 Job** 的 `remote-agent/run-result` annotation 上，App 读那里。**没有「解析 `pi -p` 输出 / 读 session 文件」那层**，agent 也不碰 GitHub。

三个 Result tool，按 Agent role 注入其中两个：

- `finish_ticket`（`implement-ticket`）：`{summary, commentBody?, warnings?}` → `done`
- `finish_spec`（`implement-spec`）：`{summary, prBody, commentBody?, newTickets?, warnings?}` → `done`
- `blocked`（两个 role 都有）：`{summary, commentBody}` → `blocked`

它们返回 `control: { terminate: true }` 让本次 run 就此收尾；同一轮调多个时**第一次调用生效**，所以一次 run 最多只写一条 annotation。**`error` 不是 agent 能自述的**：它只由 runner / App 判（Job 非正常终态、读不到 annotation、label 与 Job 漂移），且**没有自动重试**。

一条硬顺序：**push 严格先于 annotation**。push 失败就不写结果、非零退出，k8s 起新 pod 同卷 `resume()` 到同一点再 push——所以卷上那部分工作不会因为没有结果而丢。

App 看到的东西（四种）：

| Job 终态 · annotation | App 做什么 |
| --- | --- |
| `Complete` · `done` | ticket：关票、摘 `agent:in-progress`、`commentBody` 有就转成评论；spec：开 PR + `ready-for-human`（或 `newTickets` 时只建 sub-issue） |
| `Complete` · `blocked` | 摘 `ready-for-agent`、加 `ready-for-human` + `agent:blocked`，把 `commentBody` 转成评论；不关票 |
| `Failed`（backoff 耗尽 / 超时）· **无 annotation** | 加 `agent:error` + 一条 App 自己的证据评论（reason、Job/pod 名、pod 终态、Ticket PVC 名与它的 `remote-agent/expires-at`、`kubectl logs` 指引） |
| `Complete` 但 annotation 缺失/不可解析，或 label 说在跑却没有 Job | 同上（`no-result` / `no-job`） |

## issue状态机

完整表格与状态机图见 [docs/architecture.md 第 4 节](docs/architecture.md#4-状态机)；这里只留三条前提、入口门和一张 label 清单。

**三条前提**

1. **Job 的终态只有三种**：`Complete`（runner 自述 done/blocked 后已写 annotation）、`Failed(reason=BackoffLimitExceeded)`、`Failed(reason=DeadlineExceeded)`。**只有 Job 终态会移动 label**；pod 层的 OOMKilled / 驱逐 / SIGTERM / CrashLoopBackOff 与重启后的 `resume()` 全程对 GitHub **不可见**（[ADR-0008](docs/adr/0008-durable-runtime-base.md)）。「Job 在跑但 pod 在重启」是一个对 GitHub 不可见的自环：label 停在 `agent:in-progress`、不评论、Slot 继续占着——票看起来一动不动，那是正常的。
2. **写者各一个**：label、评论、关 issue、开 PR 全是 **App**（[ADR-0002](docs/adr/0002-app-is-sole-github-writer.md)）；annotation 只有 **Runner**（[ADR-0007](docs/adr/0007-run-result-contract.md)）。Job 从不碰 issue。
3. **label 是三个维度**：triage（`ready-for-agent` / `ready-for-human`，人写，表示谁该干）、授权（`agent:implement`，人写）、运行事实（`agent:in-progress` / `agent:error` / `agent:blocked`，只有 App 写）。**assignee 不参与状态机**，App 不读也不写。

**入场门（Gate）**

```
Gate(issue)        ⟺ open ∧ 无 open blocker ∧ 有 ready-for-agent ∧ 已授权 ∧ 无任何 agent:*
Claim-gate(issue)  ⟺ Gate ∧ 确定性 Job 名下无未删的 Job 对象（k8s 半边，ADR-0013）

已授权(ticket)     ⟺ 票自己带 agent:implement ∨ Gate(父 spec)
```

`Gate` 的 label 条件缺一不动；Claim-gate 的 k8s 半边不满足时同样不动，只是等 `DELETED` 事件唤醒，见 [ADR-0013](docs/adr/0013-claim-gates-on-job-absence.md)。`ready-for-agent` 是门的一部分而不是装饰：spec 收尾后把它换成 `ready-for-human`，就是靠这一条退出门。额度满时 **Defer**（本轮不建 Job、不改 label、不评论，只写一条日志，见 #13）。

**授权是唯一能沿 spec → ticket 继承的一条**（[architecture.md §4.2](docs/architecture.md#42-frontier-与-gate)）：父 spec **在门内**（它自己过得了 `Gate`），它的 `ready-for-agent` 子票就不用自己带 `agent:implement`；但 `ready-for-agent`、blocker、`open`/`closed` 与 exit 标记永远是票自己的事实。父 spec 自己出不了门时继承不生效。

| 场景（Job 终态 · annotation） | ticket 的 label | spec 的 label |
|---|---|---|
| —（Claim：Job 非终态，含 pod 重启自环） | `open` · `[ready-for-agent, agent:implement, agent:in-progress]` | `[ready-for-agent, agent:implement]`（不变，spec 不写 `agent:in-progress`） |
| `Complete` · `done` | `closed` · `[ready-for-agent, agent:implement]` | `[ready-for-human, agent:implement]` + 已开 PR |
| `Complete` · `done` + `newTickets` | 同 `done`（但 ticket 的 `finish_ticket` 没有 `newTickets` 参数，所以这个形状只有 spec 收尾能产出） | `[ready-for-agent, agent:implement, closeout-consumed]`（**不开 PR**，新 sub-issue 已建；新票只带 `ready-for-agent`，但授权继承自 spec，所以下一轮就进 Frontier。第三个 label 是「这块 outcome 已消费」的记号，见 [ADR-0015](docs/adr/0015-closeout-outcome-consumed-once.md)） |
| `Complete` · `blocked` | `open` · `[ready-for-human, agent:implement, agent:blocked]` + 评论 | 同左 |
| 任何 `error`（自述 / backoffLimit / DeadlineExceeded / no-result / no-job） | `open` · `[ready-for-human, agent:implement, agent:error]` + 评论 | 同左 |
| 人重入 | 摘 `agent:blocked`/`agent:error`、`ready-for-human` → `ready-for-agent` | 同左 |
| 额度满 · Defer | 一字不变 | 一字不变 |

表里 ticket 侧的 `agent:implement` 一律读作「**仅当人把它写在票上**」：靠继承进门的票没有这个 label，其余一字不差——App 从不写、也不删它。

每个 `error` / `blocked` 终态 App 都会发一条评论（reason + Job/pod 名 + pod 终态证据 + 那块 Ticket PVC 的名字与它的 `remote-agent/expires-at` + `kubectl logs` 指引）——因为那几条路上根本没有 annotation。
