# 控制面是无状态 reconciler

App 不保存任何控制面状态：GitHub 的 issue 状态与 k8s 的 Job 列表就是唯一真相，每次 reconcile 都从这两处全量重算该做什么。选它是因为 webhook 会漏投、pod 会重启、并发事件会互相踩，而一个「只读外部状态、再幂等执行」的循环不需要数据库，也没有「内存里的并发计数器丢了」这类故障模式。代价是每次 reconcile 都要花 GitHub 与 k8s 的 API 调用，且每个动作都必须幂等。唤醒源有三种——webhook、Job watch、resync tick 每 5 分钟一次（[ADR-0014](0014-wake-surface-periodic-resync.md)）：周期触发只是「再来一轮」的信号，不引入状态，也不把这个循环变成 poller。
