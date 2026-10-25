# Ticket 卷的回收：换成 Delete 策略的薄置备 SC，App 按卷上的 `expires-at` 删

v1 每 ticket 一块 PVC、不随 Job 删（[ADR-0008](0008-durable-runtime-base.md) / [#22](https://github.com/2017fighting/remote-agent/issues/22)），因为缺口 B（人接进去看历史）与 `resume()` 都要求同一块卷活着。于是空间只随「Ticket PVC 没删」累积。这张 ADR 定「谁删、何时删、留下的怎么不涨」，并记下查证时才发现的一层：**`reclaimPolicy` 决定「删 PVC」到底有没有把池空间还回去**。

## 硬约束（选型的后果，不是实现细节）

- **Ticket PVC 换 StorageClass**：`truenas-iscsi-retain` → `truenas-iscsi-delete`（同驱动、同参数、`pool: nova`、`ReadWriteOncePod`、`allowVolumeExpansion`），参数里加 `sparse: "true"`。原因：`Retain` 下 external-provisioner **从不调用 `DeleteVolume`**——删 PVC 只让 PV 变 `Released`，TrueNAS 上的 zvol 留在池里；删 PV 也一样（`sig-storage-lib-external-provisioner#56`、KEP-2644；home-ops 的 ADR-0013 记了实测：「Retain on both the PV and the VolumeSnapshotClass means nothing ever calls `DeleteVolume`」，那两块 20Gi 最后是手工调 TrueNAS API 删的）。所以「谁删 PVC」不等于「空间回来」，这条只有换策略能解，不是 App 侧能绕的。保住的是 ADR-0008 真正要的东西：iSCSI 块卷 + WAL。
- **薄置备**：`sparse: "true"`（驱动只在显式 sparse 时才薄置备，`truenas-csi` `pkg/driver/controller.go:707`；驱动 README 的参数表写明 `sparse` 适用于 iSCSI/NVMe-oF、默认 `false`）。于是 8Gi 是**文件系统上限**而不是池占用，单卷实际占用是 1–2GB 量级。**这推翻了 [ADR-0010](0010-job-resource-budget.md) 的一句前提**（「请求 8Gi = 立刻在 `nova` 池里占 8Gi」），容量账改按写入量算。
- **删除者只有 App**：[ADR-0001](0001-stateless-reconciler.md) 的 App 是唯一 reconciler，[ADR-0002](0002-app-is-sole-github-writer.md) 的 Job 只写自己的 Job 对象。runner 拿不到、也不该拿 PVC 的删除权（共享的 `agent-job` SA 会变成「任一 Job pod 能删掉别的票正在用的卷」），而且 `backoffLimit` 耗尽与 `DeadlineExceeded` 两条终态路上根本没有 runner 在跑。k8s 也没有可用的原生机制：Job 上只有 `ttlSecondsAfterFinished`，`StatefulSet` 的 `persistentVolumeClaimRetentionPolicy` 不适用于 Job，CronJob sweeper 等于引入第二个控制器。
- **时钟写在卷上**：`remote-agent/expires-at`（RFC3339），App 在**判定 outcome 的那一次 reconcile**里 set-if-absent 写一次，Claim 时清掉。没有它 App 只能从 k8s 时间戳现算，而 Job 的 `completionTime` 会被 Job 的删除保留窗抹掉（[ADR-0012](0012-job-deletion-ttl.md)）——两条时钟会被强行绑在一起；用 PVC 的 `creationTimestamp` 则会让「跑了三天的票」留得比「跑了十分钟的票」短，年龄不是保留期该用的量。
- **保留期**：`done` **7 天**；`blocked` / `error` **30 天**。理由不对称：`done` 卷剩下的价值是「被重开时能接着跑」+「事后看全文」，而重开通常发生在 merge 后 CI 挂掉的一两天内；`blocked` / `error` 卷是**唯一**一份对话全文、是 ADR-0010 说的人重入后 `resume()` 的目标，而且 **push 未必发生过**（`backoffLimit` / `DeadlineExceeded` / `no-result` 三条路上 runner 可能还没 push），卷上可能有未 push 的 commit——30 天是「人回来捞」的窗口。
- **卷没了不破坏重开**：分支已经在 GitHub 上，App 重新建卷 + init container 重新播种即可，丢的只是历史与 `resume()`。所以保留期是政策选择，不是正确性下限。
- **重跑不回到干净态**：同一块卷、同一个 conversation、追加一次新 run。查证（`/root/clone/pi` 的 `packages/durable`）：干净终止（`control: { terminate: true }`，即 `done` / `blocked` 两条路）之后重新打开同一份 storage **什么都不跑**——`Harness.open` 只把还活着的 task 翻回 `pending`（scheduler 注释：「Dispatches nothing」），`harness.root()` 返回同一个 conversation（`ROOT_CONVERSATION_ID = 1`）；要跑新东西只能 `conversation.submit()`。于是 runner 的 open 路径是统一的：`resume()` 接中断的，`submit()` 起新的，不需要 App 传「这是重跑还是重开」。durable 也**没有任何删除 session / 对话的 API**（`createConversation()` / `fork()` / `reset(handoff)` 只能新开一条并保留旧历史）。
  - **补充（2026-10-25，#52）**：「追加一次新 run」的**去重键**不能永远用同一个。`submit()` 的 `requestId` 一旦已结算（`done` / `unanswered`），再提交只会拿回那条旧记录——所以一次 `unanswered` 的模型错误会让这块卷**永远**跑不起来（新 pod 1–2 ms 就 `run-failed`），而「重跑不回到干净态」本来依赖的就是能真的再跑一次。于是 runner 在已有结算过的 `input` submission 时，用带递增后缀的 Submission key（`#retry-<n>`）；崩溃续跑仍然用基础键（那条还没结算，正是 `resume()` 要接的）。卷本身仍然不需要重置，这正是本条决定的价值。
- **增长只靠 TTL + 孤儿兜底**：不加池水位、不加 PVC 数量硬上限。护栏的职责是「App 逻辑写错时不会无限涨」，但撞到它时新票是**静默卡住**（[#13](https://github.com/2017fighting/remote-agent/issues/13) 的 Defer 刻意不留痕），等于把静默泄漏换成静默停摆；薄置备后泄漏的绝对量级也不值得用停摆来换。代价明写：**泄漏信号只能由 App 自己提供**——Delete 策略下 `pv-audit` 看不见 Released PV，打了 provenance 标签后 `pvc-audit` 也不再报它，所以每次 reconcile 打一行「活着的卷数 / 最旧到期时间 / 本 spec 占用」。
- **孤儿兜底只看 k8s**：卷没有 `expires-at` ∧ 没有任何未到终态的 Job 引用它 ∧ `creationTimestamp` 超 30 天 → 删。覆盖两类永远走不到 outcome 的卷：issue 被删 / 转走，或 App 在保留窗内没能读到结果而 Job 已被 k8s 自清（[ADR-0012](0012-job-deletion-ttl.md) 的超预算宕机路径）。年龄下限同时是「Claim 与 Job 创建之间那个窗口」的安全垫。

## 回收表

| 状态 | 卷上的状态 | 谁 / 何时删 |
| --- | --- | --- |
| **T4** `done` | `expires-at = 判定时刻 + 7d` | App：到点删 |
| **T5** `blocked` / **T6a–e** `error` | `expires-at = 判定时刻 + 30d` | App：到点删 |
| **S3** 收尾 `done`（已开 PR） | `expires-at = 判定时刻 + 7d` | App：到点删 |
| **S4** 收尾 `blocked` / **S5** 收尾 `error` | `expires-at = 判定时刻 + 30d` | App：到点删 |
| **T3** 被占 / **T3L** 自环 | 无 `expires-at`（Claim 时清） | 不删 |
| **S2** 收尾在跑 | 无 `expires-at` | 不删 |
| 无 outcome 的孤儿 | 无 `expires-at` | App：无活 Job ∧ 年龄 > 30d |

`implement-spec` 的收尾 Job 也有自己的一块 Ticket PVC（同一个确定性命名规则作用在 spec 号上），回收规则与 ticket 完全一致：**判它 outcome 的那一次 reconcile 写 `expires-at`**（`done` 7d、`blocked` / `error` 30d，set-if-absent）。不把它归给孤儿兜底：孤儿是给「从未走到 outcome」的卷的，一块已经判过的卷按年龄被删，是删对了但理由和时钟都不对。

一个 pass 内的顺序：**先**处理 Claim / 终态（改 label、清或打 `expires-at`），**再**跑回收（删已过期的）。`expires-at` 不存在 = 不可删。

## Considered Options

- **保持 `truenas-iscsi-retain`，App 只删 PVC**：不动 home-ops 的存储面，误删可救（Released PV 能重绑），但 zvol 永远留在池里，靠 home-ops 的 `pv-audit` 报出来、人删 PV + 手工删 dataset——「留下的怎么不涨」等于没有答案。
- **保持 Retain，App 连 PV 一起删**：要 ClusterRole（撞 [#12](https://github.com/2017fighting/remote-agent/issues/12)「不引入 ClusterRole」），而且按事实**仍然不释放空间**，只是把 `Released` 变成「PV 没了、zvol 还在」，反而丢掉 `volumeHandle` 这条线索。
- **runner 自己删卷**：省一个 App 的循环，但共享 SA 的 namespace 级删除权是破坏性的，且两条「没有 runner 在跑」的终态路上没人执行，最终还得 App 兜底。
- **App 侧水位 / ResourceQuota 数量护栏**：见上面「增长只靠 TTL」那条。
- **重跑时开新 conversation（`createConversation()`）**：上下文干净、旧对话留作证据，但要 App 多传一个「这是重跑还是重开」的信号（多一条契约面），而重开一张 `done` 票时模型带着旧历史本来就更值钱。
- **重入即删卷、重新播种**：上下文最干净，但丢掉 HOME 缓存（pi-web 853 个包重下）与全部历史，而且那正是 ADR-0010 留给「盘满」的例外手段，拿来当常规重跑等于把例外变成常态。

## Consequences

- **[ADR-0008](0008-durable-runtime-base.md) / [ADR-0010](0010-job-resource-budget.md) 就地改**：SC 名与「厚置备」那句；ADR-0010 里「谁删、留多久归 #19」的指向改成本文。
- **home-ops 多一个 manifest**：`infrastructure/storage/storageclass-truenas-iscsi-delete.yaml`。名字按既有惯例（`-<policy>` 后缀，与 `truenas-iscsi-retain` / `truenas-nfs-retain` 同形），改名只是改字符串。
- **App Role 多两类权限**：`persistentvolumeclaims: create,get,list,delete`（+ `patch`，写 `expires-at`）。#12 当初明确「不给 PVC」的理由是 v1 没有卷路径，现在路径来了，那条要就地改。建卷也是 App（create-if-absent、确定性名字，与 Job 名同源）。
- **卷的 provenance 由 App 打标签 + 注解**（**本条取代 spec #33 §4 的标签拼法**：§4 写的是 `remote-agent/ticket=<repo>#<n>` 与 `remote-agent/repo=<repo>` 作为**标签**，而这两个值含 `/` 与 `#`，k8s 一律 422——spec 那行在真集群上不成立，以本条为准）：标签只能是 k8s 合法的值，注解可以是任意文本，所以身份拆成两半——标签 `app.kubernetes.io/managed-by: remote-agent` + `remote-agent/spec=<n>`（Job 上还有 `remote-agent/role=<role>`）；注解 `remote-agent/ticket=<repo>#<n>` + `remote-agent/repo=<repo>`。**`owner/name` 与 `owner/name#<n>` 不能做标签值**（含 `/` 与 `#`，API server 直接 422；这是 kind e2e 抓到的真 bug：App 原本把两者都写成标签，于是在真集群里一张 Job 都建不出来），而把 repo 换成 slug 会让 token 续期拿不回 `owner/name`，所以机器可读的身份进注解、标签只留合法值。home-ops 的 `pvc-audit`（#85）只认 Flux inventory 标签 / `ownerReferences` / StatefulSet 的 `volumeClaimTemplates` / KEEP 名单，App 用 k8s API 动态建的卷一个都不符合 → 它会常驻 exit 1；规则因此定为「**带 `app.kubernetes.io/managed-by: remote-agent` 标签即视为有声明来源**」（这个标签本来就存在，也是 App 自己认领对象的那一个），`remote-agent/ticket` 注解只给人看细节。**不用 `ownerReferences`**：指向 App 的 Deployment/ReplicaSet 意味着部署换代（新 ReplicaSet）时 GC 连卷一起删——正是 home-ops ADR-0016 那条「ownership 而不是 deletion policy 决定东西活不活得下来」的教训；指向 Job 则卷随 Job 死，直接废掉整个设计。
- **`expires-at` 同时是运维界面**：`error` / `blocked` 那条评论里带上「这块卷保留到 <date>」（[#10](https://github.com/2017fighting/remote-agent/issues/10) §4.6 的模板），人不用去 `kubectl get pvc` 就知道还有多久。
- **薄置备把「盘满」的形态改了**：`df` 预检（ADR-0010，每次 pod 启动、marker 之前）只能看见文件系统，看不见池；池满时写失败发生在预检之后，走普通 `error(no-result)` 路径。恢复手段不变（删卷重播），但**预检不再是池满的防线**。
- **回收的对象是两个**：Ticket PVC + 它的 per-Job Secret（`agent-<repo-slug>-<issue#>-token`，[ADR-0009](0009-ticket-volume-seeding.md)）一起删（App 本来就有 `secrets` 的 `delete`）——凭证跟卷一起死。Job 本身**不在这里删**：`ttlSecondsAfterFinished` 是唯一的 Job 删除者，App 的 Role 里没有 `jobs delete/patch`（[ADR-0012](0012-job-deletion-ttl.md)）。
- **重开一张 `done` 票时，模型带着「我刚说过做完了」的历史**：需要 App 把「人重开了这张票 + 新评论」写进工作项正文（归 [#14](https://github.com/2017fighting/remote-agent/issues/14) / [#24](https://github.com/2017fighting/remote-agent/issues/24) 的 prompt 票），否则 agent 可能直接再报一次 `done`。
- **重跑撞旧 Job**：Claim 是 create-if-absent 的确定性 Job 名，而重入 / 重开时旧 Job 可能还在自己的保留窗里（[ADR-0012](0012-job-deletion-ttl.md)）→ 新一轮可能起不来，或 App 把上一轮的 annotation 当成新结果。派生 [#27](https://github.com/2017fighting/remote-agent/issues/27)（blocked by #23）。
