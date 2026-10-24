# 收尾 outcome 只消费一次：S3N 在 spec 上留一个 `closeout-consumed` 标记

[ticket #49](https://github.com/2017fighting/remote-agent/issues/49)。S3N（收尾 Job 报 `newTickets` → App 建 sub-issue、不开 PR）是 spec 循环里唯一**判完还留在门内**的分支，而它「已消费」的载体原本只有它建出来的那些票：链接成 sub-issue 之后，只要有一张还 open，spec 就在 S1 而不是 S2，不会有第二轮去重判那块收尾 Job。

那个载体**会死**。新票全部关闭之后，spec 回到「无 open sub-issue」分支，而收尾 Job 对象还在自己的保留窗里（`ttlSecondsAfterFinished: 1800`，[ADR-0012](0012-job-deletion-ttl.md)）→ S1 的第二分支重新判那块**已被消费过**的 Job → 同一批 `newTickets` 被再建一遍。实测（App seam，连跑 `runReconcilePass`）：建票 #100 → #100 被 Claim → #100 done 关票 → 无 open sub-issue + 旧对象还在 → 又建一张 #101。

[#48](https://github.com/2017fighting/remote-agent/issues/48) 之前这条路上有人工检查点兜着（新票不带 `agent:implement`，人授权之前那 30 分钟保留窗早过了），所以重判很少发生；#48 让新票继承授权、自动进 Frontier 之后，**这个洞落在正常路径上**，每轮收尾都可能多建一批重复票。

## 决定

- **S3N 的 outcome 消费后，在 spec 上写 label `closeout-consumed`**。它是这块 outcome 的唯一「已消费」载体，与 Ticket PVC 的 `expires-at` 同构：**判定的那一次 reconcile 写一次，起下一块收尾 Job 的那一次 reconcile 清一次**。
- **判定顺序**：`planSpecStep` 在 k8s 半边之后读它——先确认「确定性名下有一个对象」（没有对象 ⇒ 起 Job 并清标记），再看标记，**最后**才 `judgeJob`。先读标记是为了不重读 annotation（[ADR-0007](0007-run-result-contract.md) 的「恰好读一次」）：带标记的对象不可能属于一块还没判过的运行，因为起 Job 的那一支必然清掉标记。命中标记就走新的一支 **`closeout-consumed`**：不建 Job、不改 label、不评论、不开 PR、不建票、不读 run result，等对象的 `DELETED` 事件。
- **标记对每个终态形状一视同仁地短路**，不只 `done + newTickets`。`done`（无票）、`blocked`、`error` 各有自己的幂等载体（label 迁移 + 评论 marker），标记在它们身上是冗余的——但它们同样可能被重判，而重判一次是白做一次活；统一短路掉比「只挡 `newTickets` 那一种」少一条要维护的例外。实际写标记的只有 S3N：S3–S5 判完就把 spec 移出门，走不到这里。
- **写序：先标记，后建票**（S3N 内部）。崩在两者之间 → 这一批票没建出来，spec 停在 `closeout-consumed`，等旧对象被 TTL 删掉、起一块**新的**收尾 Job，由 spec role 重新报出「还差什么」。**丢一次 outcome，绝不重复建票**——重复建票是静默污染 GitHub，丢一次 outcome 是下一轮自愈。反序（先建票后标记）会把洞原样留着：崩在中间时票已建好，等它们全关掉、旧对象还在窗里，又被重判一次。
- **两个窗口，代价不同**：「标记写完、第一张票还没建」丢整批；「某张票建好、还没链接成 sub-issue」丢这一批剩下的票，并留下一张没人链接的孤儿票（在仓库里看得见，只是不在 spec 的 sub-issue 列表里）。后者在标记出现**之前**的代价是整批重来，所以标记把代价从「重复建票」换成「少建几张」——方向对，但没有变没。要真正关掉得让 run result 带幂等键。
- **写序：先清标记，后起 Job**（S1 → S2）。这一支的前提就是「确定性名下无对象」，所以此处的标记必属上一轮、必然是陈旧的；先清再建，崩在中间的最坏结果是「无标记 + 无对象」，下一轮照常起 Job，什么都不丢。反序会让一块**尚未判定**的新运行带着旧标记，它的 outcome 会被误判成已消费，白跑一整轮。
- **可见性**：pass 日志加第七个计数器 `closeout-consumed=<n>`（数 spec），与 `deferred` / `waiting` / `idle` 平级。被标记停住的 spec 不出现在 `idle` 里：它没有 open sub-issue，也不是「门内 + Frontier 空」那一支。
- **标记的寿命由对象兜住**：标记只在「确定性名下有一个终态对象」时才被读，而对象的存在正是「这个 outcome 属于当前这轮」的判据。所以标记不需要 TTL、不需要清理逻辑；人 `kubectl delete job` 掉旧对象，下一轮自动清标记 + 起新 Job。

## Considered Options

- **每张新票 body 里埋 marker，创建改 create-if-absent**：不丢、不重，还顺手补掉「建了没链接」那个旧窗口。不要：要给 `K8sJob` 端口加 `finishedAt`（k8s 的 `completionTime`）才能区分两轮 `done`，而且 App 建的每张票 body 里都多一条隐藏注释——把一份纯给人看的正文变成幂等键，改标题/改正文的人会无意改掉键。
- **收尾卷上的 annotation（同 `expires-at` 的做法）**：GitHub 侧零改动。不要：人不可见（label 在 issue 上一眼能看到），而且卷被回收时标记一起消失，判定就退回「无载体」。
- **标题去重**：正文里已被否掉——猜错就静默吞掉一张真票，代价比重复建票更糟。
- **每轮轮次号进 Job 名**：即 ADR-0013 的「Considered Options」里那条，同样被否——`agent-…-r2` 的幂等键仍然要一个可读的计数器，而计数器在卷上。

## Consequences

- **S3N 的「已消费」载体从「新票还 open」变成「新票还 open **或** spec 带 `closeout-consumed`」**：前者是快路径（有票在跑时根本不走到收尾分支），后者是兜底（票全关了而对象还在窗里）。
- **[`docs/architecture.md` §8](../architecture.md#8-两处缺口) 的那条缺口记录作废**，改写进 [§4.5](../architecture.md#45-spec) 的 S3N 行与 [§3](../architecture.md#3-spec-循环) 的代价段。
- **一条新代价，明写：每轮之间多一个等删除的间隙。** 新票全部关闭之后，spec 不再立刻起下一块收尾 Job，而是等到那块旧对象被 k8s 按 `ttlSecondsAfterFinished` 删掉（≤ 30 分钟，[ADR-0012](0012-job-deletion-ttl.md)）才开始下一轮。S3N 之后这一轮与下一轮之间就多出这段等待，**且它每轮都可能发生**（[§3](../architecture.md#3-spec-循环) 的轮数无上限让这个间隙可以反复出现）。想立刻跳过的人可以 `kubectl delete job <名>`——`DELETED` 事件就是唤醒源，与 [ADR-0013](0013-claim-gates-on-job-absence.md) 的逃逸口同一个。**被否掉的「按标题去重」方案换来的正是「零等待」，而它猜错时会静默吞掉一张真票**：等 30 分钟比丢一张票便宜。
- **一条新代价，明写**：S3N 之后到「新票全部关闭」之间，spec 上的 label 集是 `[ready-for-agent, agent:implement, closeout-consumed]`。人读到它要知道 `closeout-consumed` **不是 exit 标记**、不进 `Loop`、不挡授权继承——它只是「上一块收尾 Job 的结论已经落地」的记号。逃生口不变：摘 `agent:implement`（整条 spec 退出门）或 `kubectl delete job`（只影响当前这一块）。
- **pass 日志多一列**：`closeout-consumed=<n>`。它是「有多少 spec 正卡在一个已经判过的对象上」的可数信号——数值长时间不降，说明 Job 的 TTL 没生效或 watch 没接上。
- **不新增控制面状态**（[ADR-0001](0001-stateless-reconciler.md)）：标记活在 issue 的 label 上，和 `agent:*`、`ready-for-*` 同一层，重启后从 GitHub 重读。
- **未核实的前提：仓库里最好存在名为 `closeout-consumed` 的 label。** 现有四个 `agent:*` label 今天能写，说明它们已经建好了。GitHub 对「给 issue 加一个仓库里不存在的 label」到底是自动创建还是 422，查证没有定论（`PATCH /issues/{n}` 带 `labels` 数组这条路没有明确文档），所以**不做依赖**：若它自动创建，一切照常；若它 422，那一次 S3N 的 `editLabels` 会抛错、pass 记一行 `pass-error`，下一轮重试——而**重试是安全的**，因为标记写失败意味着 outcome 还没被消费，会重新走一遍建票分支（这也顺带说明为什么标记必须先写：它失败时停在「什么都没发生」而不是「一半发生了」）。一次性运维动作：把 `closeout-consumed` 建进仓库，与 ADR-0011 的 SC、ADR-0010 的 quota 同级。
