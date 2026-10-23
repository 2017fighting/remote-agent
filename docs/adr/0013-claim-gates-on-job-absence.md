# 重跑的唯一性：Claim 的门再加 k8s 半边——名下 Job 还在就不 Claim，等它的 DELETED 事件

重入 / 重开把票送回门内，而旧 Job 大概率还在自己的保留窗里（[ADR-0012](0012-job-deletion-ttl.md)）：Claim 的 create-if-absent 会撞上「已终态、annotation 已被消费」或「非终态、pod 在自环」的旧对象。两个病灶：create-if-absent 什么都不建，新一轮根本没跑；App 下一轮 reconcile 读到上一轮的 annotation，把同一个 outcome 消费第二次。ADR-0008 的单写者防线（`ReadWriteOncePod` + `parallelism: 1`）只挡「同一时刻一个进程挂同一块卷」，挡不住「两个 Job 认得同一张票」。这张 ADR 定重跑的唯一性靠什么：**Claim 的门除了 GitHub 半边（label），再加 k8s 半边——该 ticket 确定性名下的 Job 对象还存在（终态与否），本轮就不 Claim、不建新 Job、不读那条 annotation，等 k8s 删除它时的 `DELETED` 事件唤醒下一次 reconcile。**

正确性依赖一条不变的时序：**annotation 恰好消费一次**。App 只在把票迁出 `agent:in-progress` 的那一次 reconcile 里读它（T4 / T5 / T6a / T6d 的 label 迁移都发生在读之后），离开 T3 的前提就是 outcome 已消费；票回到门内只可能是重入 / 重开。所以「票在门内 ∧ 名下 Job 还在」⇒ 那条 annotation（若有）必属已消费的上一轮，正确行为就是不读、等待。

## 决定

- **门 = GitHub 半边 + k8s 半边**：`open` ∧ 无 open blocker ∧ `ready-for-agent` ∧ **已授权** ∧ 无任何 `agent:*` ∧ **确定性名下无 Job 对象**（终态与否）。k8s 半边不满足 → 本轮等待：不改 label、不建 Job、不评论，与 Defer 同形。「已授权」在本 ADR 写下时只有「票自己带 `agent:implement`」一个来源；后来加了第二个——**父 spec 带 `agent:implement` 时子票继承**（[ticket #46](https://github.com/2017fighting/remote-agent/issues/46)，见 [`docs/architecture.md` §4.2](../architecture.md#42-frontier-与-gate)）。它只影响这扇门的判定，不改本 ADR 的 k8s 半边：继承来的授权同样要过「名下无 Job 对象」。
- **唤醒**：Job watch 的 `DELETED` 事件（TTL 自清、人 `kubectl delete` 都走它）。等待不吃 Slot——终态 Job 名下没有未到终态的 pod（[#13](https://github.com/2017fighting/remote-agent/issues/13) 的口径）；非终态旧 Job 占着自己的 Slot 属于正确记账。
- **Claim 的写序：先 create-if-absent Job，后写 `agent:in-progress`**。App 在两写之间崩掉留下「Job 在跑 + 票在门内」，被 k8s 半边天然收掉：Job 终态 → TTL → `DELETED` → 重新 Claim，同卷按 [ADR-0011](0011-ticket-pvc-recycling.md) 接续，不产生假 `error`。GitHub 持久失败时的代价是白跑一轮（工作在卷上不丢），比假 error 安静且诚实。反序的崩窗是「`in-progress` + 无 Job」→ 假 T6e，会把 T6e 的成因混进高频崩窗、信号变脏。
- **非终态旧 Job 同规则**：人在 Job 跑动中手滑摘了 `agent:*`，或上一次 Claim 的崩窗残留，都走等待——它最迟 `activeDeadlineSeconds`（3h）进终态，再 30 分钟被删，上界 ~3.5h、罕见、自动恢复，不新增状态机路径。annotation 无人消费是正确行为：工作已在 Ticket PVC 上，新一轮同卷接续。
- **spec 收尾 Job 同规则**：`implement-spec` 的确定性名下对象还在就不起收尾 Job，同扇门不区分 role。
- **等待的可见性**：error / blocked 的证据评论模板加一行「重入后最迟到旧 Job 保留窗结束（30 分钟内）起跑；等不及可手动 `kubectl delete job <名>`，删除事件立即唤醒 Claim」，App 在等待时打一行日志。**逃逸口**（手动删 Job）写进 `docs/architecture.md` §4.2——人手里的 kubectl 本来就是 v1 的运维面。
- T3 的进入条件由此完整：`T2 ∧ Slot 够 ∧ 名下无未删旧 Job`；首次创建与重跑走同一扇门，k8s 半边对两者不加区分。

## Considered Options

- **轮次入 Job 名**（Ticket PVC annotation 计数器 → `agent-…-r2`，create-if-absent 按轮次幂等）：重入即时起跑、零等待。不要：T6e 的按名 GET、证据评论里的 Job 名、名形推导全要改成「先读计数器再拼名」——计数器在卷上，卷已被回收时（超保留期重入）连名形都推不出，还要给「读计数 + 写计数」补幂等与崩窗语义；旧轮次 Job 仍占对象配额到 TTL，对象数也没省。换来的只是「即时起跑」，而典型重入（人读证据评论、动手修、再回来）落在 30 分钟窗外。**留作升级路径**：将来真嫌等待贵，在 Job 名上加一个后缀即可，本 ADR 的门不动。
- **给 App `batch/jobs` 的 `delete`，Claim 改 delete-then-create**：零等待、对象不积。不要：[ADR-0012](0012-job-deletion-ttl.md) 刚以「k8s 是唯一删除者」否过它——两处删除逻辑、RBAC 扩张、App 长时间不醒时 Job 挂死撞配额；App 在 delete 与 create 之间崩掉还留下「`in-progress` + 无 Job」的假 T6e。
- **TTL 调短到「重入时必然已不在」**：ADR-0012 的预算账明确否掉 0 与 3600（0 把例行发布变成丢结果的抽签）；且调短只降概率，窗口内的行为仍未定义——本 ADR 定的恰恰是窗口内的行为。

## Consequences

- **重跑唯一性分三层**：label 半边（无 `agent:*`）+ k8s 半边（名下无 Job）挡「两个 Job 认得同一张票」；`ReadWriteOncePod` + `parallelism: 1`（[ADR-0008](0008-durable-runtime-base.md)）挡「两个进程挂同一块卷」。各挡一类，缺一不可。
- **[ADR-0007](0007-run-result-contract.md) 就地改**：annotation 的消费恰好一次，写明「只在迁出 `agent:in-progress` 的那次 reconcile 读」。
- **[ADR-0012](0012-job-deletion-ttl.md) 的保留窗多一个身份**：除了 App 的读取预算，它还是重入后新一轮的起跑延迟上界（典型情形接近零——旧 Job 大概率已过窗）。
- **`DELETED` 漏接的残余**：既无 App 重启（重启的 informer list 天然把「名下无 Job」补读进来）、又无任何 webhook 的静默期里，等待会无限延长。这是 [#26](https://github.com/2017fighting/remote-agent/issues/26)（唤醒面）的一票新输入：周期性 resync 的动机清单由此多一条。
- **T6e（no-job）维持单向**：它只该在 `agent:in-progress` 挂着而 Job 不在时触发；门内的等待从不触碰它。
- GLOSSARY 的 **Claim** 锐化（门里的 k8s 半边）。
