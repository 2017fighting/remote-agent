# base PVC 由一个 App 起的一次性 sync Job 保鲜

每个 target repo 的 base PVC，由 App 在每次起 agent Job 之前新建一个一次性 sync Job（`git fetch origin main` + `reset --hard` + `clean -fdx`）来刷新，App 等它 Succeeded 之后才创建 VolumeSnapshot 与 agent Job；同步失败直接把这次运行标 `error`，不降级用旧 base。选它是因为「快照必须打在静止的 base 上」这条顺序约束只有创建者能保证，而常驻 syncer 会让 base 悄悄落后、App 自己挂卷又会把单副本长跑服务拖进磁盘 I/O。代价是每次运行多一个 Job 的生命周期与一段启动延迟，且瞬时网络抖动会废掉一次运行（由 `error` 自动重试一次兜底）。

## Considered Options

- **常驻 / 定时 syncer（CronJob）**：App 完全无状态、运行启动无额外延迟，但 base 最多落后一个周期，刚 push 的 main 可能还没进 base，agent 会从过期的 main 起分支。
- **agent Job 的 init container**：pod 起来时快照已经打完，init container 改的是恢复卷而不是 base，base 永远不更新。
- **App 自己挂 base PVC 跑 git**：省一个 Job，但让 reconcile 循环被磁盘 I/O 与 git 进程阻塞，单副本服务还得自己管凭证与重试。
- **只在 base 落后 main 时同步**：省掉无谓 fetch，但要求 App 记住 last-synced SHA，与 ADR-0001 的无状态相悖。

## Consequences

- base PVC **永不删除**：按 truenas-csi 的语义，源卷被删时 `deletionPolicy: Retain` 也保不住旧快照（见 #9）。写坏时走 sync Job 的幂等自愈，强制重建的信号是 base PVC 上的 `remote-agent/reseed` annotation，而不是删 PVC。
- sync Job 是 base PVC 唯一的写者；agent Job 只见快照，因此同步不需要排空正在跑的 Job。
- base 里只放 main 的工作克隆，不放 `agent/spec-*` 分支、不放依赖缓存：分支由 agent Job 自己 fetch（它本来就要 push），base 的语义保持最单纯。
- App 不需要任何 last-synced 状态；每次同步的结果（baseSha）只作为观测写在 sync Job 自己的 annotation 上。
