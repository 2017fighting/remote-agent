# 执行面基座是 pi-durable 库 + 自写 runner，崩溃靠同卷 `resume()`

`pi -p --mode json` 是一次性的 print 运行：没有 checkpoint，进程一死就无从接续，所以任何崩溃都只能「重跑整个 ticket」（`docs/architecture.md` 第 8 节缺口 A）。v1 把执行面基座换成 `@earendil-works/pi-durable@1.3.0`——一个**库**、没有 CLI——runner 是 remote-agent 自己写的 TypeScript 程序：它打开同一块 per-ticket PVC 上的 durable storage，跑一个 agent role，在**真正终态**时把结果写进 Job annotation。崩溃与被驱逐不再是 `error` + 起新 Job 重来，而是同一块卷上 `resume()` 从每个 task 的最后一个 checkpoint 接着跑。

## 硬约束（选型的后果，不是实现细节）

- **单写者**：durable 自身没有任何跨进程锁（`README`：「One process owns a storage at a time; there is no cross-process locking」）。防线只能建在 k8s 上——Ticket PVC 用 `ReadWriteOncePod`、Job 用 `parallelism: 1`、旧进程在 `terminationGracePeriodSeconds` 内 `harness.close()` 后退出。
- **sqlite 必须落块卷**：durable 的 SQLite 后端是 WAL + `synchronous = NORMAL`，NFS 上的锁与共享内存语义退化（home-ops 已把 SQLite-on-NFS 记为接受的降级）。Ticket PVC 固定 `truenas-iscsi-retain`，不用 `truenas-nfs-retain`。
- **终态只有三种**：Job `Complete`（runner 自述 done/blocked 后写了 annotation）、`backoffLimit` 耗尽、`activeDeadlineSeconds` 到点。pod 重启与 `resume()` 全程对 GitHub 不可见——runner 被 SIGTERM 时只 `harness.close()` 然后非零退出，**不写 annotation**。
- **结果载体不变、证据换了**：Result tool + Job annotation 那一层保留（[ADR-0007](0007-run-result-contract.md)），砍掉的是「解析 pi json 流」那一层；outcome 的判定证据从 pi 的 `stopReason`/退出码换成 durable 的 `submission.wait()` 与 task outcome。

## Considered Options

- **留在 `pi -p --mode json`，在 App 侧重试**：不加新依赖，但缺口 A 无解——一次性运行没有 checkpoint，重试永远是「从零重跑整个 ticket」。
- **钉 `/root/clone/pi` 的源码 commit（`v1.3.0-61-g16f5f0af4`）**：白得 `restartLimit`/park、`sleeping`/`sleepUntil`、`wake()`、`retryTask`、双参数 `onReport`。不要：npm 1.3.0 已够 v1 用（`resume()`、`submission.wait()`、`control: { terminate: true }`、`harness.closed` 都在发布版里），而源码 HEAD 未发布、`CHANGELOG` 的 `[Unreleased]` 已列 4 条 Breaking Change。**v1 因此不依赖 park / sleeping / retryTask / 双参数 `onReport`**；crash-loop 的上界由 Job 的 `backoffLimit` 给。
- **用 `@earendil-works/pi-env` 把 harness 移出 pod**（长驻 runner 持存储与凭证、pod 只当工具执行面）：能让崩溃续跑与「人接进去」都变免费，但控制面变成有状态的（撞 [ADR-0001](0001-stateless-reconciler.md)），且需要一条进 pod 的通道（当前 App Role 没有 `pods/exec`）。留在地图的雾里。

## Consequences

- **v1 没有 Base PVC、Sync Job、Job snapshot**：工作副本由 init container 幂等播种进 Ticket PVC（同卷还有 session sqlite）。[ADR-0006](0006-base-pvc-freshness.md) 在 v1 不适用（保留为 v2 候选）；[ADR-0003](0003-one-k8s-job-per-ticket.md) 里「工作副本来自一次性快照」与「pod 的终态就是这次运行的结果」两句话作废。
- **`error` 不再自动重试**：ADR-0007 的 outcome 三值不变，但「error 享有一次自动重试」整句删掉——重试的粒度从「App 起新 Job」变成「k8s 重启 pod」。`error` 因此成为**人的**入口，不再有自动回路。
- **崩溃的代价是 phase 重跑**：durable 只在 phase 边界落 checkpoint（`spec §5.6`「There is no sleep inside a phase: a phase reruns from its top after a crash or close」），且 built-in 工具（连 `read`）全是 `replay: "unsafe"`——崩在工具调用里，模型看到的是 `interrupted` 而不是重跑。
- **「接着跑」要求卷比 Job 活得久**：人只能在 Job 不跑时独占打开 Ticket PVC 上的 storage（或读它的只读副本）。所以卷不在 Job 结束时删，回收规则另票定。
- **#6 的研究只对 pi CLI 成立**：`research/pi-afk-contract` 保留为历史，不再是 v1 的依据。
- **依赖钉版**：durable / ai / chord 三个包同钉 `1.3.0`；升级是显式窗口，不是漂移（`packages/durable` 自带 `registerStorageConformance` / `registerEnvConformance` 可当回归基线）。
