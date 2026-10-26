# 收尾的每一轮都在新卷上开始：起收尾 Job 时先回收上一轮那块，runner 遇到已完成的 run 不再静默 no-op

[ticket #60](https://github.com/2017fighting/remote-agent/issues/60)。收尾 role（`implement-spec`）的 conversation 是**终态**的：报过一次结论就不再跑（[ADR-0011](0011-ticket-pvc-recycling.md) 的「重跑不回到干净态」只对**中断**的 run 成立，干净终止之后重新打开同一份 storage 什么都不跑）。而收尾 Job 的名字是确定性的（`agent-<repo-slug>-<spec#>`），所以 S3N 之后起的**下一块**收尾 Job 会挂上**上一轮那块卷**：seed 的 marker 还匹配（`repo` + `branch`）→ `seed-skip`、`state/` 一字不动；runner 打开卷看见 `remote-agent.run-completed` → `runner-open conversation=1 already-complete=true` → exit 0、**不写 annotation**；Job `Complete` 而 annotation 缺失 → App 判 `no-result`（T6d）→ S5 `ready-for-human` + `agent:error`。一整轮什么都没做，人读到的却是「这次运行没产出结果」。

`README.md` §Spec implement循环 说的「等旧 Job 的 DELETED，然后起一块**新的**收尾 Job 重新判断还剩什么」在 Job 这一层成立，在**卷**这一层不成立——而「重新判断」正是那块已完成的 conversation 挡掉的事。[ADR-0015](0015-closeout-outcome-consumed-once.md) 的 `closeout-consumed` 只回答「这块 outcome 判过没有」，它不回答「这块卷还能不能再跑一轮」。

## 决定

- **S1 → S2 那一步先回收上一轮的卷**：`start-closeout` 的那一次 reconcile 在清 `closeout-consumed` 之后、建 Job 之前，删掉上一轮的 Ticket PVC 与它的同名 Secret，再按原样 create-if-absent 建新的。收尾的每一轮因此都从一块空卷播种（marker 缺失、`state/` 里也没有 session → 正常播种），「重新判断还剩什么」真的发生。
- **回收落在「起 Job」那一个函数里，用一个显式入参打开**：`startAgentJob` 已经拥有写序（PVC → Secret → Job）与复用路径（清 `expires-at`），所以收尾的回收是它的一个分支——复用路径从「清 `expires-at`」换成「删 PVC + 删同名 Secret」，由 `startCloseoutJob` 传入的开关打开。**ticket 的 Claim 一字不改**：一张票的卷本来就该被复用（`resume()`、`resume` 之外的「接着之前跑」、人回来读全文都靠它）。
- **无条件删**。`start-closeout` 的前提就是「确定性名下无对象」，所以那块卷只可能是两种：上一轮**判过**的，或上一轮 App 在保留窗内**没读到结果**的（[ADR-0012](0012-job-deletion-ttl.md) 的超预算宕机路径）。两种情况下新的一轮都会从 ticket map 与分支重新算出「还剩什么」，丢的只是证据——这条代价明写，见下。
- **runner 侧加一道守卫，把「Complete 而无 annotation」这个形状变成不可能**：打开 durable storage 后若 conversation 已完成（`RunCompletedDoc` 有值），读**自己 Job** 的 `remote-agent/run-result` annotation（`agent-job` SA 已有 `batch/jobs get,patch`，[ADR-0007](0007-run-result-contract.md)）：
  - annotation **不在** ⇒ 这是**一块新 Job 跑在一块 spent 卷上**（同一块 Job 的替补 pod 会读到它自己写下的 annotation）⇒ 记一行日志并以 `RUNNER_EXIT.fatal`（78）退出。Job 的 `podFailurePolicy` 直接 `FailJob`，App 判 `unrecoverable`，而 `unrecoverable` 的证据评论里已经有 `volumeResetLine`——「先删掉这块卷和它的 Secret」这句现成的指引。**（2026-10-26，[ADR-0017](0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md) 收窄）**：这一支现在只归**收尾 role**——票这边同样形状的那一次（重开的 `done` 票、人重入的 `blocked` 票）改为**就地开新的一轮**，而不是拒绝。
  - annotation **在** ⇒ 同一块 Job 的替补 pod，这次 run 的结论已经落地 ⇒ 照旧 `already-complete=true` + exit 0。
  - GET 失败按「判断不了」处理，保持今天的 exit 0：**不能因为 API 读不到，就把一次已经成功的 run 判死。**
- **守卫只对收尾 role 生效**（[ADR-0017](0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md)）：它守的是「收尾的每一轮都在新卷上开始」这条不变式——收尾卷上出现「新 Job + 已报过结论」只可能是 App 的回收没发生。ticket role 的同类形状是正常路径（人的重开 / 重入），由「就地开一轮新的」处理，而不是拒绝；两个 role 各自都还满足「一个 Job 不能在没有为这一轮报过结论的情况下 `Complete`」。

## Considered Options

- **每轮给卷换个名字（issue #60 的选项 1）**：保留上一轮那块卷到它的保留期，正是 `expires-at` 存在的理由。不要：名字里的轮次号需要一个**可读的轮次计数器**，而计数器没有家——`closeout-consumed` 是布尔 label（写/清），卷上的 annotation 会随卷被回收，k8s 对象又会被 TTL 删掉（[ADR-0001](0001-stateless-reconciler.md)：无状态 reconciler 不存它）。[ADR-0015](0015-closeout-outcome-consumed-once.md) 的 Considered Options 已经否掉同族的「轮次号进 Job 名」，理由是同一条。
- **只在 spec 带 `closeout-consumed` 时删卷**：能修 S3N 那条自动轮换的路，但 S4 / S5 之后的人重入没有这个标记（Re-entry 抹掉的正是那次 label 迁移），spent 卷仍会被复用 → 同一个 no-op 留在最需要它的那条路上。
- **只让 runner 拒绝（issue #60 的选项 3）**：最小改动，但这一轮仍然什么都没做，人还是要手工删卷 + 重贴 label；它把「卷是 spent 的」从静默变成响亮，却没有让下一轮自己跑起来。守卫因此是**这一条的加强版**，不是替代品。
- **让 runner 在已完成的 conversation 上直接 `submit()` 新 run（同卷、带历史）**：省掉删卷，还保留上一轮的上下文。不要（对收尾 role）：spec 收尾的 review 固定点是**提交在 durable 文档里**的（[ADR-0009](0009-ticket-volume-seeding.md)），`resume()` 与重跑都读到那个已提交的值，而新的一轮要的是「当前分支 tip 与 `origin/main` 的 merge-base」——把一个 per-run 的值复用给下一轮，review 范围就错了。ticket role 的那条路（[#62](https://github.com/2017fighting/remote-agent/issues/62)）要单独解决这件事，收尾不该被它拖住。
- **让 runner 写一条 `outcome=error` 的 run result 而不是 exit 78**：没有 `FailJob` 的掩盖风险（见下一条），但 [ADR-0007](0007-run-result-contract.md) 的「`error` 不是 agent 能自述的」要为此开一个例外，而且评论里现成的 `volumeResetLine` 用不上——指引文本改住在 runner 里。
- **粗暴守卫（`isComplete() && role === "implement-spec"` → exit 78）**：少一次 GET。不要：`markComplete()` 提交 `RunCompletedDoc` 之后、`process.exit(0)` 之前收到 SIGTERM（节点 drain，不是 Job 的 deadline）时，k8s 会在**同一块 Job** 里起替补 pod，它会撞上这道守卫 → `FailJob` → App 把一次**成功**的 run 判成 `unrecoverable`，还叫人删一块好卷。精确守卫用一次 `jobs get` 买掉这个风险。

## Consequences

- **上一轮的对话全文在下一轮开始时消失。** App 在 GitHub 上留下的那条评论（`done` 的 PR / 新票，`blocked` / `error` 的证据评论）成为唯一记录。ADR-0011 给 `blocked` / `error` 的 30 天保留期因此**只在没有下一轮时有效**：想读全文的人要在重入之前读，`expires-at` 那句「这块卷保留到 <date>」在下一轮开始后不再成立。
- **一条新的可数信号**：守卫触发时的那行日志（`runner-refused …`）会随 pod 日志末尾进到 App 的证据评论里，人不必 `kubectl` 就知道发生了什么。
- **`expires-at` 在收尾卷上的角色缩小**：从「决定这块卷什么时候死」变成「App 没读到结果时的兜底」。正常路径上收尾卷的寿命由**下一轮的起点**决定，而不是由它自己的保留期决定。
- **S3N 与 `closeout-consumed` 不受影响**：标记回答的是「这块 outcome 判过没有」（对象的身份），回收回答的是「这块卷还能不能再跑一轮」（卷的身份）。两者都还需要——标记挡的是「票全关了而旧 Job 对象还在保留窗里」的重判，回收挡的是「新 Job 挂在 spent 卷上」的 no-op。
- **ADR-0011 就地改**：回收表加一行「起下一块收尾 Job 时删」，并说明收尾卷的寿命短一格。
- **ADR-0015 就地改**：S1 → S2 的写序从「清标记、建 Job」变成「清标记、删旧卷、建新卷与新 Job」，崩在任意两步之间都停在可重放的状态。
- **[#62](https://github.com/2017fighting/remote-agent/issues/62) 已由 [ADR-0017](0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md) 解决**：ticket role 的同类形状（新 Job 跑在一块已报过结论的票卷上）不再拒绝，而是**就地开新的一轮**——重置五个 per-run 文档、渲 prompt（评论进正文 + round 头）、submit。本文的守卫因此收窄为收尾 role 的守卫。
- **一次删除动作多出来，且它在写序最前面**：删卷失败（API 报错）会让这次 `startAgentJob` 判 `failed`，pass 记一行错误、不建 Job，下一轮重算重试；删成功而建 Job 前崩掉，则下一轮看到「无标记 + 无对象」照常起 Job。两个窗口都不留半状态。
