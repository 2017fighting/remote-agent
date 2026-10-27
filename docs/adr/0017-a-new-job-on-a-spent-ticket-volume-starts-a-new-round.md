# 票的新一轮在同一块卷上开始：runner 遇到「新 Job 跑在一块已报过结论的票卷上」就地重置这一轮的文档，重开一张 `done` 票真的再跑一轮

[ticket #62](https://github.com/2017fighting/remote-agent/issues/62)。`done`（T4）关票时只摘 `agent:in-progress`，`ready-for-agent` 留着（[§4.3](../architecture.md#43-ticket)），所以重开一张票就把它送回 `Gate`；旧 Job 对象一过保留窗（[ADR-0012](0012-job-deletion-ttl.md)），Claim 就再占上它，而 Claim 复用的正是上一轮那块卷（[ADR-0011](0011-ticket-pvc-recycling.md)）。卷上 `state/session.sqlite` 带着 `remote-agent.run-completed`，runner 的 open 路径于是直接短路：`runner-open conversation=1 already-complete=true` → exit 0、**不写 annotation** → Job `Complete` 而无 annotation → App 判 `no-result`（T6d）→ `agent:error` + `ready-for-human`。人的新评论模型一眼没看，一轮 Job 的额度先没了。

[ADR-0016](0016-closeout-round-starts-on-a-fresh-volume.md) 只把它**变响**（runner 发现「自己 Job 上没有 run-result + 卷上已报过结论」就 exit 78 → `unrecoverable`，证据评论里现成的 `volumeResetLine` 叫人删卷），没有把它修好——而它明写为未解决。这与 [ADR-0011](0011-ticket-pvc-recycling.md) 写下的意图相反：重开一张 `done` 票**要的是**「同一条 conversation 上再跑一轮，模型带着『我刚说过做完了』的历史」。

那个墙不止挡 `done`。`markComplete()` 对**每个报过结论的 outcome** 都跑，所以一轮 `blocked` 也把卷标成 completed——人重入一张 `blocked` 票（摘 `agent:blocked`、把 `ready-for-human` 换回 `ready-for-agent`）走的正是同一条路。ADR-0010 / ADR-0011 说 `blocked` / `error` 的卷是人重入后 `resume()` 的目标，而今天它也撞在同一道墙上。所以本文修的是**「新 Job 跑在一块已报过结论的票卷上」这一整类**，不是「重开的 `done` 票」那一个实例。

## 决定

- **判据用 [ADR-0016](0016-closeout-round-starts-on-a-fresh-volume.md) 已有的那次读**：打开 storage 后若 conversation 已报过结论，读**自己 Job** 的 `remote-agent/run-result` annotation：
  - **annotation 不在** ⇒ 这是一块**新 Job** 跑在一块已报过结论的票卷上（重开的 `done` 票，或人重入的 `blocked` 票）⇒ **开新的一轮**：就地重置这一轮的文档、渲 prompt、submit。
  - **annotation 在** ⇒ 同一块 Job 的替补 pod，这次 run 的结论已经落地 ⇒ 照旧 `already-complete=true` + exit 0。
  - **GET 失败** ⇒ 照旧 exit 0，且**什么都不重置**。「判断不了」永远不能换来一轮新工作（一次已经成功的 run 不能被判死，一次没跑过的 run 也不能因为读不到 Job 就被当成重开）。
- **只对 ticket role 开这一支。** 收尾 role 照旧 exit 78（`runner-refused reason=spent-volume`）——收尾的每一轮都在**新卷**上开始（App 回收，[ADR-0016](0016-closeout-round-starts-on-a-fresh-volume.md)），所以收尾卷上出现「新 Job + 已报过结论」只可能是 App 的回收没发生，那是要响亮停下的 bug。ADR-0016 的守卫因此**收窄为收尾 role 的守卫**，它守的不变式（「一个 Job 不能在没有为这一轮报过结论的情况下 `Complete`」）由两条路各自成立：票靠真的跑一轮，收尾靠拒绝。
- **重置五个 per-run 文档，一次提交清掉**：`remote-agent.run-completed`、`remote-agent.run-result`、`remote-agent.review-fixed-point`、`remote-agent.review-round`、`remote-agent.conflict-handoff`。五个都必要，缺哪个都出问题：
  - `run-result` 不清 ⇒ open 路径会走「outcome 已定但没送出去」那一支：**跳过 agent**、把上一轮的结果再 push 一次再 annotate，票被静默地再关一次。
  - `review-round` 不清 ⇒ 新一轮的 `code_review` 被「这一轮已经审过」弹回，新一轮的工作拿不到 review。
  - `review-fixed-point` 不清 ⇒ 新一轮继承上一轮的起点，review 范围错（它是 per-run 的值）。
  - `conflict-handoff` 不清 ⇒ 新一轮没有它自己那一轮的解冲突预算。
  - `run-completed` 不清 ⇒ 就是本文要修的那道墙。
- **读序：先把这一轮要说的事实读出来，再一次 commit 清五个文档，然后才渲 prompt / submit。** 要读的：上一轮的 outcome（`run-result`）、上一轮的 `completedAt`（`run-completed`）、轮次号。**轮次号 = 该 conversation 上基键族（`…:<role>` 与它的 `#retry-<n>`）里已结算**且 `status=done`**的 `input` submission 数 + 1**——「报过结论」才是轮次（`GLOSSARY.md` 的 Round），而一条 `unanswered`（模型报错）的 submission 什么都没报，重跑它的那个 pod 仍在同一轮里（[#52](https://github.com/2017fighting/remote-agent/issues/52)），所以它不计；把它计进去，重跑就会拿到一段声称「上一轮已经报过结论」的头。冲突交接那一族（`…:<role>#conflict`）也不算，否则两族互相占序号（[#58](https://github.com/2017fighting/remote-agent/issues/58)）。submission key 本身一字不动：基键已结算时 `#retry-<n>` 自己会往前走。
- **崩在重置的两侧都干净**：崩在 commit 之前 ⇒ 什么都没变，下一个 pod 看到的还是「新 Job + 已报过结论的卷」，重来一次重置；崩在 commit 之后 ⇒ conversation 是干净的未完成态，下一个 pod 照常 `resume()` / `submit()`。
- **ticket role 的 `{{work_body}}` 从「只有正文」变成「正文 + `## Comments`」**：与 spec role 的 ticket map 同一套渲染（`**author** (createdAt):` + 正文，最旧在前），**每一轮都渲全部评论**，不按时间切——旧评论对**第一轮**同样从没到过模型（一条票上的评论此前根本进不了 prompt），而重复的部分在第二轮之后已在 conversation 历史里，代价只是几十行文本。
- **runner 在 round ≥ 2 时给渲好的 prompt 前置一段 round 头**：轮次号 + 上一轮的 outcome + 上一轮报结论的时刻 + 一句「正文里的评论是那之后发生的事：重读它们、接着做，不要直接再报一次」。**模板与占位符一字不动**（ADR-0004 的键面不变），因为这段话说的事实（上一轮怎么结束的、什么时候）只活在卷上。
- **重开而没写新评论也照跑。** 人的重开就是信号。代价明写：那一轮很可能什么都不做、再报一次 `done`。
- **T4 `done` 的 label 集不动**：只摘 `agent:in-progress`，`ready-for-agent` 留着——「重开这张票」这一个动作就是「再来一轮」，不需要人多贴一次 label。
- **新一轮的工作副本从上一轮的 tip 开始。** seed 因 marker 匹配跳过、不 fetch；远端若已前进，仍由 push 路径的 `fetch` + `rebase` 收口，撞到同一批行就走既有的 Conflict hand-off（[#58](https://github.com/2017fighting/remote-agent/issues/58)）。

## Considered Options

- **App 在 Claim 时回收票卷（与 [ADR-0016](0016-closeout-round-starts-on-a-fresh-volume.md) 的收尾回收对称）**：不要。丢掉的正是 ADR-0011 要留的那份对话——重开一张 `done` 票的价值就是模型带着「我刚说过做完了」的历史；而且它与 ADR-0011「ticket 的卷本来就该被复用」的决定正面冲突。
- **只清 `run-completed`**：不要。`run-result` 还在，open 路径跳过 agent 直接把旧结果再送一遍——把一个响亮的 no-op 换成一个静默的错轮。
- **轮次号写在卷上（第六个文档）**：不要。已结算 `input` submission 的计数已经是确定性的轮次号来源，多一个文档就多一个「重置时必须记得清」的东西。
- **轮次号进 Job 名（每轮换名字）**：ADR-0015 / ADR-0016 已否，理由相同——可读的计数器没有家（无状态 reconciler 不存它，卷上的 annotation 会随卷被回收，k8s 对象会被 TTL 删掉）。
- **让 runner 直接 `submit()` 而不重置 review 那两个文档**：不要。`code_review` 会被「这一轮已经审过」弹回，新一轮的提交拿不到 review，而 review 的粒度本该是「一轮」。
- **守卫继续对两个 role 生效，把重开票也变成 exit 78**：不要。#60 的守卫让形状从静默变响亮，但重开一张票要的是**真的再跑一轮**；把 loud 当成 done，等于把「人本来能做的事」变成「人必须做的事」（删卷 + 重贴 label），而这正是 #60 的 Considered Options 里「只让 runner 拒绝」被否掉的同一个理由。
- **把「有没有新东西」做成拒绝条件**（卷上的 `completedAt` 对比票上最新评论的时间）：不要。判断权在人手里——重开这张票可能是因为 issue 之外的东西变了（CI 修好了、main 上补了东西），那一轮照样该跑。要拒绝就得再引入一个 App 或 runner 侧的新事实，而它没有家。

## Consequences

- **票的 conversation 从此可以有多轮**：`remote-agent.run-completed` 不再等于「这块卷不能再跑」，它只等于「上一次运行报过结论」；`Spent volume` 在 `GLOSSARY.md` 里的定义因此收窄为这个事实，能不能再跑由 role 决定。新增词条 `Round`。
- **ADR-0016 的守卫收窄**：`runner-refused reason=spent-volume` 只剩收尾 role 一条活路（App 回收没发生时）。票这边它被「开一轮新的」取代。
- **review 的粒度从 run 变成 round**：一轮一次 `code_review`，固定点是这一轮的起点 HEAD；上一轮已审过的提交不重审（它属于上一轮那次 review 的范围）。
- **一条新的可数信号**：`runner-round-start round=<n> previous-outcome=<done|blocked> previous-completed-at=<ts>`。轮次号长时间往上涨，说明有人在反复重开同一张票。
- **人重入一张 `blocked` 票也走这条路**：它今天同样被那道墙挡着，只是 #60 之后挡得响亮。这次一起修好。
- **代价：重开而没写新评论的那一轮很可能白跑**（模型看到同样的正文与评论，再报一次 `done`）。接受，理由见 Considered Options。
- **代价：一轮的起点是上一轮的 tip，不是远端的最新 tip。** 与崩溃续跑同形；远端已前进时由 push 路径收口，冲突走 Conflict hand-off，最多多付一轮解冲突的 token。
- **[ADR-0011](0011-ticket-pvc-recycling.md) 就地改**：回收表与「重开一张 `done` 票」那条后果改写——卷被复用，新一轮由 runner 在同一块卷上开，App 不需要往工作项正文里写任何东西（评论由 runner 渲进 prompt）。
- **[ADR-0016](0016-closeout-round-starts-on-a-fresh-volume.md) 就地改**：守卫那一条标注为收尾 role 的守卫并指向本文；它的 Consequences 里「[#62] 明写为未解决」改为已由本文解决。
- **不在本文范围**：收尾 role 的每一轮仍在新卷上开始（ADR-0016 不变）；[#61](https://github.com/2017fighting/remote-agent/issues/61)（人重入的 label 被旧 Job 的判决改回去）；spec role **自己**的评论同样到不了模型（`workBody` 只渲正文与 ticket map，不渲 spec 自己的评论）——那是同一类缺口，另开一张票。**（2026-10-26，[#65](https://github.com/2017fighting/remote-agent/issues/65) 已修）**：`{{work_body}}` 现在对两个 role 都是「正文 + `## Comments`」，spec role 的 ticket map 接在评论之后（正文 → 评论 → ticket map）；收尾 role 不加 round 头——它每一轮都在**新卷**上开始，没有历史可校正，而 spec 上那条 App 自己发的失败评论就是上一轮的记录。
