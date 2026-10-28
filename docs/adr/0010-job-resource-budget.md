# Job 与 Ticket 卷的资源与时间预算：固定 8Gi 薄卷、500m/2Gi + 6Gi 内存上限、3h 截止、`backoffLimit` 4

[ADR-0008](0008-durable-runtime-base.md) 定了执行面的形态、[ADR-0009](0009-ticket-volume-seeding.md) 定了卷的播种与凭证，但每个数值都还空着（v1 没有 base PVC、没有快照，没有任何东西能替我们给数）。这张 ADR 把 v1 的数一次给全，并写下它们逼出来的三条语义：**不依赖自动扩容**（改由每次 pod 启动的 `df` 预检挡）、**内存上限就是崩溃路径**（`OOMKilled` = 新 pod + 同卷 `resume()`）、**截止时间可恢复**（卷还在，人重入后接着跑）。数值是 App 代码里的常量，其中三个（PVC 容量 / 截止 / `backoffLimit`）留 App env 覆盖。

## 数（v1）

| 对象 | 值 | 理由一句话 |
| --- | --- | --- |
| Ticket PVC | 固定 **8Gi**，`truenas-iscsi-delete`（薄置备） | 一次给够 `node_modules` + `.next` + sqlite + npm 缓存，留一倍余量 |
| agent 容器 | requests `cpu 500m / mem 2Gi`，limits **只给** `mem 6Gi` | request 决定调度（3 并发共 6Gi 塞得进现有空闲），内存上限把 runaway 变成一次 pod 重启，CPU 不设限以免 CFS 限流拖长构建 |
| init 容器（seed） | requests `cpu 100m / mem 128Mi`，无 limits | 播种只是 git（[ADR-0009](0009-ticket-volume-seeding.md)），30MB 级；调度取 `max(init, app 之和)`，它永远不会顶掉 pod |
| `activeDeadlineSeconds` | **10800**（3h），两个 role 同值 | 覆盖实测活跃时长的 p99（183min），再加依赖安装与两个 reviewer conversation |
| `backoffLimit` | **4**（共 5 次尝试） | 纯退避只有 150s；够接住偶发 pod 死亡（`resume()` 从 checkpoint 接着跑），系统性崩溃又不至于磨到 deadline |
| `terminationGracePeriodSeconds` | **120** | 给 `harness.close()`（含在飞的模型请求）留时间；最多多占 2 分钟 Slot |
| HOME | `/mnt/agent/home`（Ticket PVC 上） | 崩溃换 pod 后 npm 不重下 853 个包，也不写节点共享的可写层 |

App 侧四个 env 覆盖（默认值就是上表）：`JOB_PVC_SIZE` / `JOB_ACTIVE_DEADLINE_SECONDS` / `JOB_BACKOFF_LIMIT` / `JOB_TTL_SECONDS_AFTER_FINISHED`（第四个来自 [ADR-0012](0012-job-deletion-ttl.md)）。判据是「事故里会不会被人当场改」：CPU / 内存跟着镜像里的工具链走，要改它们本来就该重估镜像，所以留在代码里。

## 硬约束（选型的后果，不是实现细节）

- **薄置备：8Gi 是文件系统上限，不是池占用**：`truenas-iscsi-delete` 带 `sparse: "true"`（驱动只在显式 sparse 时才薄置备，`truenas-csi` `pkg/driver/controller.go:707`），所以池里只占实际写入量（单卷 1–2GB 量级），而不是请求的 8Gi。代价是 `df` 预检只看得见文件系统、看不见池（池满时写失败发生在预检之后，走普通 `error(no-result)` 路径）——预检不再是池满的防线。SC 换名与回收规则见 [ADR-0011](0011-ticket-pvc-recycling.md)。
- **不能用 GitHub API 的 `size` 定容**（[ADR-0009](0009-ticket-volume-seeding.md) 已证：它只含仓库本身，大头是 `node_modules` 与 `.next`），也不该把 playwright 的浏览器缓存算进来：`playwright@1.62.1` 与 `playwright-core@1.62.1` 的 package.json 都没有 install script，`npm ci` 不下载那 1.2GB；[#16](https://github.com/2017fighting/remote-agent/issues/16) 也已撤销 e2e。
- **不依赖 `allowVolumeExpansion`**：App 读不到卷用量（没有 `pods/exec`、没有卷 metrics），自动扩容要多一条「runner 上报用量 → App patch PVC」的跨仓契约与一份 PVC 写权限，且块卷在线扩容常要重启 pod 才能 grow fs。v1 用**每次 pod 启动都跑的 `df` 预检**替代：空闲 < 3Gi 就按 ADR-0009 的 `disk` 类退 78，`podFailurePolicy` 直接 `FailJob`，几秒内终态交人。预检放在 marker 检查**之前**，所以 `resume()` 的 pod 也过这一关——否则一块被写满的卷会把同一个 phase 重跑到同一个 ENOSPC，直到 `backoffLimit` 或 deadline。
- **运行中撞顶走普通 error 路径**：ENOSPC 发生在预检之后时，git / npm / sqlite 写失败 → 工具调用报错或 runner 崩溃，最终 `error(no-result)`（[#10](https://github.com/2017fighting/remote-agent/issues/10) 的路径），App 发一条带证据的评论。恢复手段是 ADR-0009 已写的「删掉这块 PVC、让 App 重播」；谁删、留多久见 [ADR-0011](0011-ticket-pvc-recycling.md)。
- **内存上限是有意的**：`mem 6Gi` 不是「够用就好」的估计，而是把 runaway（失控的构建、泄漏的工具）变成 `OOMKilled` → 新 pod → 同卷 `resume()`，而不是让它吃掉节点、驱逐同节点的别的 app。代价明写：cp-2 只有 7.1Gi allocatable，6Gi 的 limit 落在它上面时会挤压邻居。
- **截止时间可恢复，所以取宽不取紧**：`DeadlineExceeded` 是终态 `error`（[ADR-0008](0008-durable-runtime-base.md) / [#10](https://github.com/2017fighting/remote-agent/issues/10)），不自动重试；但 Ticket PVC 还在，人重入（摘 `agent:error`、把 `ready-for-human` 换回 `ready-for-agent`）后同一个 Job 模板在同一块卷上 `resume()`。误杀的代价是一次人工介入，不是丢掉的工作——这个数真正的职责是别让卡死的 job 长期占着 3 个 Slot 之一（[#13](https://github.com/2017fighting/remote-agent/issues/13)）。
- **`backoffLimit` 的墙由 deadline 兜**：`restartPolicy: Never` + `podFailurePolicy`（ADR-0009）下每次崩溃都是新 pod，崩掉的那个 phase 从头重跑，所以 5 次尝试理论上能烧掉几小时——`activeDeadlineSeconds` 才是真正的墙，`backoffLimit` 只回答「多少次算系统性坏掉」。
- **时长画像**（选 3h 的依据）：本机 1074 个 pi session 的活跃时长（间隔 >2min 记空闲）p50 7min / p75 29min / p90 66min / p95 94min / p99 183min，最长 481min。工作画像是 `npm ci` + `tsc --noEmit` + `npm test`（[#16](https://github.com/2017fighting/remote-agent/issues/16) 的收尾验证，不跑 `next build`、不跑 e2e）；pi-web 的 CI `checks` job 在 7GB / 2core 的 runner 上 15 分钟内跑完同一套，所以 6Gi 的上限够，而 2Gi 的 request 在 3 节点（allocatable mem 14.3 / 14.3 / 7.1Gi，空闲 request ≈ 13.5Gi）上排得下。

## Considered Options

- **固定 10–12Gi 买保险**：薄置备下多请求几 Gi 几乎不占池，但 fs 变大后 `df` 预检的门槛与「卷满」的判断都跟着变，而 8Gi 已覆盖实测画像加一倍余量。**不买。**
- **按 GitHub `size` 乘系数 + 下限**：ADR-0009 已证系统性低估，且多一条 App→GitHub 调用与一段 App 侧逻辑。
- **App 自动扩容**（runner 报用量 → App patch PVC）：把容量变成需要跨仓契约维护的状态，还要求 App 能写 PVC（[#12](https://github.com/2017fighting/remote-agent/issues/12) 的最小 RBAC 里没有）；块卷在线扩容常要重启 pod 才 grow fs，等于把「卷满」变成「卷满 + 一次重启」。留作以后。
- **不给内存 limit**：最不容易误杀（不会 `OOMKilled` 打断一次 40 分钟的活），但 runaway 会吃到 kubelet 驱逐阈值，把同节点的别的 pod 一起带走。**不换。**
- **给 cpu limit**（如 3）：防单个 job 抢满 4 核节点，但 CFS 限流会把构建拖长，而 CPU 是可压缩资源、不产生崩溃路径。**不设。**
- **`backoffLimit` 取 k8s 默认 6**：纯退避 630s、容忍度更高，但同一 phase 反复崩时可能把 3h 塔满才交人。**取 4。**
- **HOME 留在容器可写层**：每次崩溃换 pod 都要重下 853 个包的 tarball（几分钟），且那几百 MB 写在全节点共享的 45GB 可写层上。**不放。**
- **分 role 的超时**（ticket 2h / spec 收尾 4h）：更贴画像，但两个数、两条规则，而单一 3h 已覆盖两者的 p99 区间。**先不分。**
- **数值放 home-ops ConfigMap**：与当时的 [ADR-0004](0004-prompts-live-in-configmap.md) 的 prompt 载体一致（该载体已由 [ADR-0020](0020-prompts-travel-with-the-image.md) 取代），但 pod spec 的旋钮跨到了另一个仓库，且 App 要读 ConfigMap（#12 的最小 RBAC 里没有）。**放 App 代码 + env。**

## Consequences

- **App 的 env 面多三个键**（默认值在代码里；加上 [ADR-0012](0012-job-deletion-ttl.md) 的 `JOB_TTL_SECONDS_AFTER_FINISHED` 是四个，[ADR-0014](0014-wake-surface-periodic-resync.md) 的 `RESYNC_INTERVAL_SECONDS` 之后是五个），home-ops 的 HelmRelease 可以不带它们就跑。
- **Ticket PVC 上多一层 `home/`**：`repo/`（工作副本）、`state/`（durable sqlite + marker）之外还有 HOME 的缓存。播种仍然只碰 `repo/`，从不碰 `state/` 与 `home/`。
- **`disk` 这个失败类终于有了触发点**：ADR-0009 的五个分类里原本只列了名字。
- **以后要跑 e2e 或 `next build` 时这些数要重估**：6Gi 的上限容不下一次 `next build` 加 chromium。那是新的一次决策，不是把 6Gi 调大就行。
- **3h 与 Job 的删除保留窗是两个不同的时钟**（[ADR-0012](0012-job-deletion-ttl.md)）：deadline 管「一次运行能跑多久」，保留窗管「App 有多久把 annotation 与证据读走」。
