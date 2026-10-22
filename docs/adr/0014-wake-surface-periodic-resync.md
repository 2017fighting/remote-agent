# 唤醒面：webhook / Job watch / resync tick 三个唤醒源，5 分钟一轮、单飞、失败不自排

[ADR-0009](0009-ticket-volume-seeding.md) 把 token 续期放进 reconcile pass（「剩余寿命 < 30 分钟就原地 patch Secret」），可 pass 没有周期性唤醒源：webhook 与 Job watch 都是事件驱动的，而一个正在跑的 Job 一小时里可能什么事件都不产生，续期这条路径在安静时段根本不执行。[#23](https://github.com/2017fighting/remote-agent/issues/23) 把「Job 终态读取」从动机清单里摘掉（watch 秒级读 + 重启 list 补读 + T6e 兜底已闭环），[#27](https://github.com/2017fighting/remote-agent/issues/27) 又加回一条「漏接 `DELETED` 的静默等待」。同时主分支上挂着两句相反的话（`docs/architecture.md` §1 与 §8：「没有一个 poller 角色」）。这张 ADR 定唤醒面的形态：**tick 只是同一份 `reconcile()` 的第三个唤醒源，5 分钟一轮，同一时刻只跑一轮，失败的轮不自我重排。**

## 决定

- **唤醒源三种，落点只有一个**：webhook（`issues` / `issue_comment` / `sub_issues` / `issue_dependencies` / `installation_repositories`）、Job watch（含 `DELETED`）、resync tick；进程启动时另外做一次 list + 一轮 pass（`trigger=startup`）。三者都只是「去跑一轮」的信号，落点永远是同一个 `reconcile()`——不在 pass 里分叉出「只续期」的快路径，也不为 tick 写第二份重算逻辑。
- **间隔 5 分钟**，落点与 [ADR-0010](0010-job-resource-budget.md) / [ADR-0012](0012-job-deletion-ttl.md) 同构：App 代码常量 + `RESYNC_INTERVAL_SECONDS` env（ADR-0012 之后 env 键面 5 个）。推导只有一个硬约束：间隔必须小于 ADR-0009 的 30 分钟续期阈值，5 分钟给出 23.5 分钟余量（扣掉 kubelet 挂载同步的 1–1.5 分钟）；顺带把「漏事件后静默等多久」也压到 5 分钟以内。
- **不做「只在有活 Job 时 tick」的门**：漏接 `DELETED` 的形状恰恰是「票在门内等、而名下已无活 Job」，一个以活 Job 为前提的 tick 会把这一轮掐掉，等于只修了动机的一半。
- **不做「按 token 到期时刻 arm 一个定时器」**：那是最省调用的形态，但它只覆盖续期，漏事件那半仍要另配周期兜底——两个机制做一件事，且「arm 到最近一个到期点」需要在内存里维护一份到期表并处理它的失效。
- **单飞 + 深度 1 队列**：同一时刻只有一轮 pass 在跑；期间到达的任何触发合并成**恰好一次**后续 pass。它是 coalesce，不是缓冲区：队列深度恒为 1、不保存触发内容、重启即空（重启后的 list 天然补读）。理由不是洁癖——幂等吸不住并发：「两张票同时过门、各建一张 Job」不是同一动作的重复，而是超配额；label 的两处写也不是同一次 edit 的重放。
- **失败的轮不自排**：pass 抛错只记一行日志，被合并出来的那个后续 pass 照跑一次，失败本身不再 re-enqueue 自己；恢复到下一个真实触发（最迟 5 分钟后的 tick）。这样热循环在结构上不存在，不需要在 App 里再养一个退避器。崩溃安全不由它负责：Claim 的写序（先建 Job 后写 label，[ADR-0013](0013-claim-gates-on-job-absence.md)）已经把半途挂掉收掉了。
- **续期判定读 Secret 上的 `remote-agent/token-expires-at`**（RFC3339，写 GitHub 返回的 `expires_at`，与 Ticket PVC 的 `remote-agent/expires-at` 同形）：App 每次 mint 都刷新它，pass 只读它判「剩余 < 30 分钟」。**不读 Secret 的 `metadata.creationTimestamp`**：patch `data` 不更新它，续一次之后年龄永远是旧的，判定退化成「每轮重 mint」，而每轮重 mint 正好撞上那条未核实的事实（新 token 会不会作废旧 token）——pod 的挂载晚 1–1.5 分钟，恰好赶上 push 前读到一枚已作废的 token。每枚 token 因此至少用满 30 分钟才换，一次 3h 运行最多换 6 枚。
- **每轮一行结构化日志**：`pass trigger=webhook|job-watch|tick|startup slots=<used>/<max> deferred=<n> renewed=<n> waiting=<n>`。`trigger` 是 tick 引入的新维度（出问题第一个要问的就是「这轮是谁叫醒的」）；`deferred` 数把「多少票正因为额度在等」变成可数；`waiting` 数把 ADR-0013 里那条「只有一行日志、不可数」的等待也变成可数。
- **tick 不引入控制面状态**：ADR-0001 的「无状态」一字不改，多出来的是「唤醒源有三种」这一句。App 里任何为这轮 pass 临时聚合的内存（本轮的 Job 列表、到期时刻）都是 list 的可重建产物，重启即丢，不是跨 reconcile 的索引。

## Considered Options

- **只在有活 Job 时 tick**：省 GitHub 调用，但把「票在门内等、无活 Job」这一半动机排除在外（见上）。tick 的价值一半在「有活 Job 时叫醒续期」，另一半正在「没有活 Job 时叫醒等待」。
- **按 token 到期时刻 arm 定时器**：零多余调用、零日志噪声，但只覆盖续期；且 arm 表要在内存里维护并被 pass 与 watch 事件反复修正，复杂度不比一个固定间隔低。
- **换凭证方案：App 开一条 in-cluster mint 端点**，runner 现取现用，寿命问题连根拔掉（ADR-0009 已把它记作后续选项）。不要：给 App 加一个 HTTP 面与一份鉴权，直接撞 [ADR-0002](0002-app-is-sole-github-writer.md)「只暴露 `/webhook`」，还要重开 ADR-0009 的凭证载体。
- **每轮无条件重 mint**：不需要任何到期判断，代码最少；代价是每票每天 288 次 Secret 写，并把那条未核实事实变成设计依赖。
- **失败的轮自排重试 + 指数退避**：恢复更快、不必让 tick 兼当兜底。不要：GitHub 一挂就是热循环，而 secondary rate limit（并发 100 / 写入 80 每分钟）正是最容易撞的那条；补退避器等于在 App 里养一个带状态的调度器。
- **条件请求（ETag / `If-None-Match`）省额度**：`304` 不计入 primary rate limit，理论上能把 tick 的读成本压掉大半。v1 不要：这是给一个尚不存在的成本问题（每 5 分钟几十次读）新增一份跨 reconcile 的缓存——ADR-0001 明确要求任何跨 reconcile 的索引重新论证。

## Consequences

- **[ADR-0001](0001-stateless-reconciler.md) 就地补一行**：唤醒源有三种，周期 tick 只是其中一种信号，不引入状态。
- **两份文档里相反的话就地改**：`docs/architecture.md` §1 的三条边界与 §8 的差异表（「没有 poller 角色」），以及 §1 的图补一个 tick 节点。
- **GLOSSARY**：`Reconcile pass` 锐化出唤醒源列表，新增 `Resync tick` 一条（它是触发，不是第二个循环），`Defer` 补一句「重试上界 = resync 间隔」。
- **可用性预算多一条（与 ADR-0012 同类记账）**：App 单次宕机 < 60 分钟不伤在跑的 Job（最后一次 pass 续的 token 还没到期，pod 的 git 是现读挂载文件）；超过就得靠 k8s 重启 pod + `backoffLimit` 4 兜，耗尽才是 `error(no-result)`，而卷上 commit 还在、人重入即 `resume()`。不加新机制。
- **RBAC 不动**：`secrets get/patch` 已由 ADR-0009 加过，续期按确定性名 `get` 那一枚、不 list；tick 只多花 GitHub 与 k8s 的读，不新增写面。
- **rate limit 余量**：一次 pass 典型 3–5 次 GitHub 读、最坏 20 次；5 分钟间隔 ≈ 60 次/h，最坏 240 次/h，占 installation 下限 5,000/h 的 1.2%–4.8%。多 repo 下的余量仍留在图的「Not yet specified」里。
- **一条未核实的事实不因本 ADR 消失**：GitHub 文档既没写「mint 新 installation token 会让旧 token 失效」，也没写相反。本 ADR 的选择在两种答案下都可用（每 Job 各自续期、每 30 分钟才 mint 一次），但若为真，「续 A 弄挂 B」会让 per-Job 凭证载体本身失守——那要重开 ADR-0009/#17 的前提。判据交给研究票 [#31](https://github.com/2017fighting/remote-agent/issues/31)。
