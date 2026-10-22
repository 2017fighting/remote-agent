# Job 的删除：k8s 仍是唯一删除者，`ttlSecondsAfterFinished` 定 1800，保留期就是 App 的读取预算

[ADR-0007](0007-run-result-contract.md) 要求「Job 在 App 成功读到 annotation 之前不得被删」，而 App Role 没有 `batch/jobs` 的 `delete`——k8s 的 `ttlSecondsAfterFinished` 是唯一的删除机制。时钟事实（k8s 官方文档核实）：TTL 从 Job 进终态（`Complete` 或 `Failed`）那一刻起跳，到点**级联删除 Job 与它的 pod**（不碰独立的 Ticket PVC Claim），且**不看任何人有没有读过**。所以「不得在读取前删除」无法由机制保证，只能由预算保证：**TTL 的长度 = App 可以不可用多久而不丢一次结果**。

## 决定

- `ttlSecondsAfterFinished: 1800`（30 分钟），单值——字段本来就只有一个，时钟在任一终态起跳，`Complete` 与 `Failed` 同钟，不按 outcome 分岔。
- 落点与 [ADR-0010](0010-job-resource-budget.md) 同构：App 代码常量 + env 覆盖，键 `JOB_TTL_SECONDS_AFTER_FINISHED`（ADR-0010 的三个 env 键就此变四个）。
- **k8s 仍是唯一删除者**：App 不拿 `delete`（#12 的最小 RBAC 一字不动），人也不需要手动清。
- **显式前提（可用性预算）**：App 的可用性义务包含「Job 终态 → annotation 与证据落进 GitHub」这一段，TTL 值就是这段的预算。健康时 Job watch 在终态转换的秒级把对象（含 annotation，runner 在 pod 结束前已写好）推给 App；发布与崩溃重启（分钟级）落在预算内，重启后的初次 informer list 补读。**超出预算的宕机**：Job 连同 annotation 消失而 label 还挂着 `agent:in-progress` → T6e（no-job）兜底判 `error` 并发证据评论——对话全文仍在 Ticket PVC 的 durable storage 里（保留期见 [ADR-0011](0011-ticket-pvc-recycling.md)）。
- **证据面**：durable storage + GitHub 落痕是设计内的证据；pod 日志是 30 分钟窗口内顺带可看的临时调试面，从不承载证据——T6b/T6c 的 pod 终态证据在 App 读 Job 那一眼里取走、写进证据评论，不依赖 Job 事后还在。

1800 的两头账：

- **下限**：假 T6e 的概率 = App 不可用时长 × 撞上完成时刻。App 是单副本 Deployment，现实不可用（滚动发布、崩溃重启、节点维护）是分钟级，30 分钟是它的十倍量。
- **上限**：终态未删的 Job 占 `count/jobs.batch: 10` 的坑（对象计数配额对存在于 etcd 的对象计数，不看状态）。3 个 Slot 在跑 + 每 spec 串行下每小时量级的完成速率，30 分钟残留在个位数以内，余量够。

## Considered Options

- **`ttlSecondsAfterFinished: 0`**：与一切解耦、零积压，[#27](https://github.com/2017fighting/remote-agent/issues/27) 的重跑撞旧 Job 几乎消失（旧 Job 秒删、人重入必扑空）。不要：任何一次发布/重启撞上完成时刻就是一次真丢失（annotation 连 Job 一起没了，只剩假 T6e），且实现被迫只用 informer 事件对象读 annotation（按名 re-GET 会 404）——把例行发布变成丢结果的抽签。
- **`3600`**：宕机容忍翻倍，pod 日志留一小时给人 `kubectl logs`。不要：quota 余量减半、#27 的等待窗口翻倍；30 分钟已盖住一切现实重启时长，多出的只买到冗余观测面（证据已在 durable storage）。
- **App 读完自己 `delete`**（要给 App `batch/jobs` 的 `delete`，[#12](https://github.com/2017fighting/remote-agent/issues/12) 明确没给）：观测性最好。不要：App 长时间不醒时 Job 永远挂着撞 quota，还得再配一条 TTL 兜底——两处删除逻辑，窗口一个也没省掉，白扩 RBAC。
- **按 outcome 分岔的不等长 TTL**：k8s 没有这个字段；要区分只能上 admission webhook，等于引入第二个控制器和新的故障面。

## Consequences

- **T6e（no-job）收窄为可用性兜底**：成因从「被 ttl 清掉 / 人手动删 / App 重启时已没了」改为「App 宕机超过保留窗 / 人手动删 / 灾难恢复」；正常自清发生在 App 读取**之后**，不落进 T6e。`docs/architecture.md` §4 的 T6e 行已同步改。**T6d 与 T6e 的分界线从此就是保留窗本身**：Job 在、读不到 annotation = T6d；Job 已不在 = T6e。
- **保留窗多一个身份：重跑的起跑延迟上界**（[ADR-0013](0013-claim-gates-on-job-absence.md)）：重入 / 重开后旧 Job 还在窗里时，Claim 的门在 k8s 半边关着，新一轮最迟等它被删（保留窗剩余部分）才起跑；典型重入落在窗外，接近零等待。
- **[#12](https://github.com/2017fighting/remote-agent/issues/12) 的「Job 靠 `ttlSecondsAfterFinished` 自清」拿到数值**；App 的最小 RBAC 不动。
- **#27（重跑撞旧 Job）拿到输入**：人重入时旧 Job 大概率还在自己的 30 分钟窗里——Claim 的 create-if-absent 会撞上「已终态、annotation 已被消费的旧 Job」。机制归 #27（等 Job 删除事件唤醒下一次 reconcile 再 Claim 是自然候选）；App 不删 Job、不 `patch` Job（[ADR-0001](0001-stateless-reconciler.md)）维持不变。
- **#26 的 resync 动机清单里没有这一条**：Job 终态读取由 watch + 重启 list + T6e 兜底闭环，周期性 resync 只剩 token 续期一个动机。
- 以后上调吞吐（多 spec 并行）或下调 App 可用性时，`count/jobs.batch: 10` 与 1800 要一起重估。
