# 人重入的 relabel 不再被旧 Job 的判决改回去：每个已消费的收尾 outcome 都写 `closeout-consumed`，且它与退出迁移是同一次 label edit

[ticket #61](https://github.com/2017fighting/remote-agent/issues/61)。spec 循环里 S3–S5 的「这块 outcome 已消费」载体**就是那次 label 迁移**（摘 `ready-for-agent`、加 `ready-for-human` + `agent:blocked`/`agent:error`）——而人重入（S6）正是抹掉这次迁移的那个动作。于是重入之后的第一次 reconcile 又读到同一个终态 Job，判出同一个 verdict（`Complete` 而无 annotation → `no-result`），把退出 label 原样写回去。人看到自己的编辑被撤销，而且**没有新评论解释**：证据评论按 marker 去重，同一条 Job 的评论早就在了。spec 就这样被挡在门外，直到那个对象被 TTL 删掉，人还得再贴一次 label。

实测（App seam，两次 `runReconcilePass` 中间插一次人重入，world 是「sub-issue 全关 + 收尾 Job 终态且无 annotation」）：pass 1 判 `no-result` 并写 `[agent:error, agent:implement, ready-for-human]` + 一条证据评论；人重入后 pass 2 把 label 改回退出集、写日志增长、**评论数仍是 1**；pass 3 一个 Slot 都不占、不建 Job。

**票这边没有这个洞，也不该有**：票的 judge 只在 `agent:in-progress` 上跑（T4–T6 会摘掉它），所以重入的票根本到不了 judge；它的旧 Job 对象由 Claim-gate 的 k8s 半边挡住，落在既有的 `waiting` 支上，零写入。spec 循环缺的正是这一支。

## 决定

- **每个判过的收尾 outcome 都写 `closeout-consumed`**（S3 / S3N / S4 / S5），不再只有 S3N。重入的 spec 于是命中既有的短路支：不改 label、不评论、不建 Job、不读 annotation，计进既有的 `closeout-consumed=<n>`，等对象被删掉后**下一轮自己起跑**——不需要人贴第二次 label。ADR-0015 当初说「S3–S5 不需要这个标记，因为 label 迁移把它们移出了门」，那句话的前提正是人不会重入；#61 把它证伪了。
- **S3–S5 的标记与退出迁移合并成一次 label edit**（`consumed()`）。两者是**同一个状态转移**——「这块 outcome 已落地，spec 出门」——所以写在一起才让标记不可能丢：没有任何崩窗能留下「退出 label 在了、标记没在」。**S3N 保持它自己的「先写标记、再建票」**（ADR-0015 的写序理由不变：崩在批次中间宁可丢一次 outcome，不可重复建票）。
- **写序：评论 → 卷的 `expires-at` → label 迁移 + 标记**（S3 是 PR → `expires-at` → label 迁移 + 标记）。评论**先于** label 迁移，因为它是人唯一的入口：反序的崩窗会留下一个「有退出 label、没有评论」的 spec，而 spec 已经出门，谁都不会再补——今天就是这个形状。`expires-at` 也提到 label 迁移之前：它写在 label 之前才不会有「spec 出门了、卷却没有回收时钟」的窗口。
- **重入提示改成一条有序步骤**（`reentryNote`）：**1. 先删 Job 对象**（或等满保留窗，~30 分钟；`kubectl delete job` 同时是立即唤醒）；**2. 只有失败长在卷上时才删卷**（`unrecoverable`）——并写明 `kubectl delete pvc` 会停在 `Terminating` 直到 Job 那个已完成的 pod 放开卷，所以第 1 步正是解开它的动作；**3. 最后才 relabel**。卷那一步（原 `volumeResetLine`）**并入同一条序列**（`volumeResetStep`），不再追加在末尾——否则渲染出来的顺序是「Job → relabel → 卷」，正好把要讲的那件事讲反。提示文本不再说「relabel 早了没用」：修好之后 relabel 是被尊重的，它只是**起不了跑**。
- **票侧一字不改**：judge 的 `agent:in-progress` 前提、Claim-gate 的 k8s 半边、`waiting` 计数全部照旧。控制用例（重入的票 + 旧 Job 对象在）钉在 App seam 上，防的是有人日后把 judge 放宽到「门内即判」。

## Considered Options

- **用 App 自己那条判决评论的 marker 当载体**（`blocked` / `error` / `evidence` 已经在 issue 上 → 跳过 label 迁移）：人删不掉它，覆盖也更全。不要：S3 不发判决评论（要另找 PR 分支当第二个信号），而且这个判断必须挪到 label 写之前才有意义，等于把「已消费」的判定从 planner 挪进写侧、多一次评论读；label 载体人可见、已经存在（ADR-0015 正是以「人可见」否掉了卷上的 annotation）。
- **两个载体都留**（label + 评论 marker 兜底）：不要。一个事实两个载体，且 label 那个在「人按文档动作重入」时已经够用——多出来的那个只会多一条要维护的路径。
- **给 App `batch/jobs` 的 `delete`，让重入立刻起跑**：不要。[ADR-0012](0012-job-deletion-ttl.md) 刚以「k8s 是唯一删除者」否过它，[ADR-0013](0013-claim-gates-on-job-absence.md) 也否过同一个想法（两个删除点、RBAC 扩张、App 在 delete 与 create 之间崩掉留下假 T6e）。人手里的 `kubectl delete job` 就是零延迟的逃生口，提示现在把它写在第一步。
- **把「Job 对象在」也做成 spec 收尾的门**（issue #61 的选项 3：对象在就不判、等 `DELETED`）：不要，**它单独不成**——第一次判决恰好发生在这个状态里（spec 在门内、对象终态），没有载体的话 outcome 永远消费不掉，PR 永远不开。要等就还得先有一个「判过了」的载体，那就回到本 ADR 的第一条。
- **四个分支统一「标记最后写」**（含 S3N）：不要。S3N 的标记必须先写：崩在批次中间重复建票是静默污染 GitHub，丢一次 outcome 只是下一轮自愈（ADR-0015）。
- **让 TTL 更短，让重入必然落空**：不要。ADR-0012 的预算账已经否掉调短（`no-result` 的兜底要靠这个窗口），而且它只降概率、不定行为。

## Consequences

- **重入的 spec 从「被扔出门外」变成「在门内等对象被删」**：等待就是既有的 `closeout-consumed=<n>`，于是 #61 里那个「静默」变成一个可数的数。
- **S3–S5 之后 spec 的 label 集多一个 `closeout-consumed`**（如 S5 之后是 `[ready-for-human, agent:implement, agent:error, closeout-consumed]`）。人重入时**不要动它**——它不在人的动作清单里（`GLOSSARY.md` 的 `Re-entry`、README 的重入说明都写明）。这正是本 ADR 明写的**残余风险**：载体是一个 label，谁要是把 spec 上的 label 全清掉再补回门内那一对，载体就没了，那一次仍会被改回去。文档动作（摘 exit label、换 triage label）不会碰到它，所以按文档做的人不会撞上。
- **一条新的可数信号，不需要新计数器**：重入后停住的 spec 与 S3N 之后停住的 spec 在 pass 日志里是同一个 `closeout-consumed=<n>`——两者都是「卡在一块已判过的对象上」。
- **`GLOSSARY.md` 三处**：新增 **Exit marker**（`agent:*` 里表示「这次运行结束了」的那两个，与 `agent:in-progress` 和 `closeout-consumed` 各自区分开）；**Re-entry** 补上「旧 Job 对象还在时，relabel 只是把下一轮准备好，起跑要等它被删」；**closeout-consumed** 改成「每个判过的收尾 outcome 都写」，并说明它为什么是人重入时唯一活下来的载体。
- **[ADR-0013](0013-claim-gates-on-job-absence.md) 就地改**：「等待的可见性」那条的提示文本由「重入后最迟 30 分钟内起跑」改成有序步骤（先删 Job、再 relabel），并点明 spec 侧的 `closeout-consumed` 要留着。
- **[ADR-0015](0015-closeout-outcome-consumed-once.md) 就地改**：删掉「实际写标记的只有 S3N」那一句的判断，改为「四个终态形状都写；S3–S5 与退出迁移合并成一次 edit，S3N 仍然单独先写」。
- **[`docs/architecture.md`](../architecture.md) 三处**：§4.2 的逃逸口、§4.5 的 S3/S4/S5/S6 行、§4.6 的重入提示。README 的重入说明与 `closeout-consumed` 段落同步。
- **代价：S3–S5 各多一次 label 的写入内容**（同一次 edit，不是多一次请求），以及 `closeout-consumed` 在 spec 上停留的时间从「S3N 一轮」变成「每轮收尾之后都到下一轮开始」——它仍然由对象兜住寿命，不需要 TTL 或清理逻辑。
