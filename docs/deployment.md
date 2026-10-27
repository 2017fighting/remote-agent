# 部署面与接线：已定的事实

本文件不是 ADR：它记的是**已经定下来的事实**（落在哪、叫什么、哪些键、哪些权限），取舍过程住在 `docs/adr/` 与各自的票里。写它的原因：落地面（[#12](https://github.com/2017fighting/remote-agent/issues/12)）与 OmniRoute 接线（[#20](https://github.com/2017fighting/remote-agent/issues/20)）的结论原先只住在关掉的票里，而它们是 spec 与实现的直接输入（收口见 [#32](https://github.com/2017fighting/remote-agent/issues/32)）。

改这里之前先问：这是**事实变了**（改本文 + 改 home-ops / App 代码），还是**决策变了**（先开票 / 开 ADR，再回来改本文）。本文件不承载取舍理由，也不重复 ADR 里已有的论证。

## 1. 落点与命名

- **一个 namespace**：`remote-agent`，App、agent Job、per-Job Secret、Ticket PVC 全住这里。不建 per-repo namespace，不引入任何 ClusterRole（[#12](https://github.com/2017fighting/remote-agent/issues/12)）。
- home-ops 侧新增一行 registry 行：path `apps/remote-agent`、profile `proxy`、deps `traefik`。目录名 = namespace = release name = Service 名。
- **App 是单副本 Deployment**（无数据库、无状态 reconciler，[ADR-0001](adr/0001-stateless-reconciler.md)），只暴露一个 `/webhook`。

## 2. home-ops 侧的文件清单

```
apps/remote-agent/
├── helmrelease.yaml                 # app-template：Deployment + Service；image.tag 是唯一的 tag 真相
├── httproute.yaml                   # host remote-agent.raenzo.com，一条 PathPrefix /webhook
├── configmap.yaml                   # remote-agent-env：GITHUB_APP_ID / GITHUB_APP_CLIENT_ID / 非密配置
├── remote-agent-secret.sops.yaml    # 三键，见 §3
├── rbac.yaml                        # SA remote-agent + Role + RoleBinding，见 §4
├── agent-job-rbac.yaml              # SA agent-job + Role（jobs get,patch）+ RoleBinding，见 §5
└── resourcequota.yaml               # 只算数量的护栏，见 §7
```

（`clusters/home/app-registry.yaml` 加一行；目录里**不放** `namespace.yaml`、不写 `kustomization.yaml`——namespace 由 registry 渲染，目录是 plain build root。lint 强制 `HelmRelease` + `chartRef: OCIRepository app-template` + `valuesFrom: <app>-workload-profile`，禁止手写 HTTPRoute `parentRefs`、禁止内联 `nodeSelector/affinity/tolerations`。）

**不在 home-ops 里的东西**：Job 的 pod 模板（在 App 代码里，见 §6）、Ticket PVC（App 运行时按需建，[ADR-0011](adr/0011-ticket-pvc-recycling.md)）、VolumeSnapshot 与 base PVC（v1 已退出，[ADR-0008](adr/0008-durable-runtime-base.md)）。

## 3. secret 与 env

sops 一份 `remote-agent-secret`，三键：

| key | 用途 | 谁读 |
| --- | --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | App 签 installation token | 只 App |
| `GITHUB_WEBHOOK_SECRET` | 校验 webhook 签名（HMAC） | 只 App |
| `OMNIROUTE_API_KEY` | 网关 key（§9） | Job 用 `secretKeyRef` **精确取这一个**（不用 `envFrom`） |

非密配置进 `remote-agent-env` ConfigMap：App ID `5390512`、Client ID、installation 归属。

> **2026-10-23 已完成轮换**：`README.md` 里那枚 webhook secret 明文进过 git 历史，已按**已泄漏**处理——GitHub App 后台重设完毕，现役值只住在 `home-ops` 的 `apps/remote-agent/remote-agent-secret.sops.yaml`（`GITHUB_WEBHOOK_SECRET`，56 位 hex），本仓库的 `README.md` 不再出现任何 secret 值（[#45](https://github.com/2017fighting/remote-agent/issues/45)）。三者同一个 Secret：`GITHUB_APP_PRIVATE_KEY` 与 `GITHUB_WEBHOOK_SECRET` 只 App 读，`OMNIROUTE_API_KEY` 只 Job 读（见上表）；轮换只动了 webhook secret 一个键。历史不重写——值已作废，重写买不到东西。

per-Job 凭证是另一回事：`contents: write`、只覆盖目标 repo 的 installation token 写进 `agent-<repo-slug>-<issue#>-token` Secret，挂成文件、由 App 按 `remote-agent/token-expires-at` 续期（[ADR-0009](adr/0009-ticket-volume-seeding.md)）。

## 4. App 的 RBAC（现状，含各 ADR 的增量）

namespaced Role，SA `remote-agent`，`automountServiceAccountToken: true`：

| API | 动词 | 出处 |
| --- | --- | --- |
| `batch/jobs` | `create, get, list, watch` | [#12](https://github.com/2017fighting/remote-agent/issues/12) |
| `pods` | `get, list` | #12（`OOMKilled` / `exitCode` 这类证据） |
| `pods/log` | `get` | #12（证据评论里的日志末尾） |
| `secrets` | `create, get, patch, delete` | [ADR-0009](adr/0009-ticket-volume-seeding.md)（per-Job 凭证 + 续期） |
| `persistentvolumeclaims` | `create, get, list, patch, delete` | [ADR-0011](adr/0011-ticket-pvc-recycling.md)（建卷、写 `expires-at`、按到期删） |

**不给**：`batch/jobs` 的 `delete` 与 `patch`（k8s 是唯一的 Job 删除者，[ADR-0012](adr/0012-job-deletion-ttl.md)；App 不在 Job 上存进度）、`pods/exec`（[ADR-0008](adr/0008-durable-runtime-base.md) 的沙箱分离会撞它）、events、VolumeSnapshot、任何 ClusterRole。

App 必须把「创建被拒（403 quota exceeded）」当正常分支：本轮不起 Job、下轮重算，不报错、不标 `agent:error`。

## 5. Job 的 ServiceAccount

共享一个 `agent-job` SA（agent Job 用它），Role 只给 `batch/jobs` 的 `get, patch`（run result 写在 Job 自己的 annotation 上，[ADR-0007](adr/0007-run-result-contract.md)），`automountServiceAccountToken: true`。

Job 名是动态生成的，RBAC 收窄不到 `resourceNames`，所以这是 namespace 级权限：一个 Job pod 理论上能改同 namespace 里另一个 Job 的注解。**App 侧的应对只有两条，都很薄**：outcome 判定只读**确定性名字**下的那一个 Job（载荷里没有 Job 名，所以没有「名字与对象对不上」这种校验）；Slot 计数、token 续期与回收只算带 `app.kubernetes.io/managed-by: remote-agent` 标签的对象。注解里没有签名，也没有第二个标识——一个恶意 Job 如果知道另一个票的确定性名字，就能写它的 annotation。这是 v1 接受的代价（共享 SA + namespace 级权限），不是已解决的问题。

## 6. Job 模板与镜像

- **pod 模板由 App 代码构造**（TypeScript + `@kubernetes/client-node`）：镜像、env、卷、`activeDeadlineSeconds`、SA、label 都在代码里（`app/src/renders/job-template.ts`），与 run result 契约、env 名、确定性命名同源，能进假客户端单测。home-ops 不存 Job YAML。
- **镜像**：App 是 `ghcr.io/2017fighting/remote-agent`，Job 是 `ghcr.io/2017fighting/remote-agent-job`；两者同仓、同一个 Actions 工作流发布到 GHCR（[#5](https://github.com/2017fighting/remote-agent/issues/5)）。**Job 镜像的 tag 在构建时烧进 App 镜像**（Dockerfile `ARG` → 编译常量），home-ops 只在 `apps/remote-agent/helmrelease.yaml` 的 `image.tag` 一处写 tag。**tag 从哪来、什么时候有**见 §10。
- **Kyverno `registry-proxy-cache`** 会把 `ghcr.io/...` 无条件改写成 Harbor 代理 → 新 namespace 自动吃到，不需要白名单或 pull secret。
- **网络**：集群里没有任何 NetworkPolicy（默认全通）；`profile: proxy` 就是出网。Job 要能到 GitHub、GHCR 与集群内的 OmniRoute（§9）。

### App 的 env 键面

| key | 默认值 | 用途 |
| --- | --- | --- |
| `MAX_JOBS_GLOBAL` | `3` | 全局 Slot 上限 |
| `MAX_JOBS_PER_REPO` | `2` | 每个 target repo 的 Slot 上限 |
| `RESYNC_INTERVAL_SECONDS` | `300` | Resync tick 间隔；必须 < 1800（token 续期阈值），否则启动报错（[ADR-0014](adr/0014-wake-surface-periodic-resync.md)） |
| `JOB_PVC_SIZE` | `8Gi` | Ticket PVC 的 `requests.storage`（薄置备下是文件系统上限，[ADR-0010](adr/0010-job-resource-budget.md)） |
| `JOB_ACTIVE_DEADLINE_SECONDS` | `10800` | Job 的 `activeDeadlineSeconds` |
| `JOB_BACKOFF_LIMIT` | `4` | Job 的 `backoffLimit` |
| `JOB_TTL_SECONDS_AFTER_FINISHED` | `1800` | 终态 Job 的保留窗 = App 的读取预算（[ADR-0012](adr/0012-job-deletion-ttl.md)） |
| `NAMESPACE` | `remote-agent` | Jobs / Secrets / Ticket PVCs 建在哪里 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | octokit 的 base URL（e2e 指向 stub） |
| `GIT_BASE_URL` | `https://github.com` | 拼给 Job 的 `GIT_REMOTE_URL` 用它（e2e 指向 stub 的 git http-backend） |
| `GITHUB_APP_ID` | 空 | octokit 鉴权；同时传给 Job 作为 agent commit 的 bot 身份（空是合法值：不带 app id 前缀） |
| `OMNIROUTE_BASE_URL` | 集群内 FQDN（§9） | 注入每个 Job |
| `PORT` | `8080`（镜像里写死） | webhook 监听端口；App 绑 `0.0.0.0:$PORT` |
| `GITHUB_APP_PRIVATE_KEY` | — | octokit 鉴权；空值会在适配器构造时直接报错（`GITHUB_APP_PRIVATE_KEY is required`），来自 `remote-agent-secret`（§3） |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC 校验；来自 `remote-agent-secret`（代码不校验它非空，空值相当于用空 key 验签） |

`GITHUB_APP_CLIENT_ID` 只在 `shared/src/env-keys.ts` 的键索引里声明（写进 `remote-agent-env` ConfigMap），v1 没有任何读者——不要在它上面做假设。

### Job 的 env 键面（模板实际发射的）

agent 容器（`runner`）：

| key | 来源 | 用途 |
| --- | --- | --- |
| `AGENT_ROLE` | `implement-ticket` / `implement-spec` | 决定拼哪份 prompt、注入哪两个 Result tool |
| `AGENT_THINKING_LEVEL` | 代码常量 `high` | 两个 role 都是 `high`（§9） |
| `AGENT_WORK_ITEM` | App 渲染的 `WorkItemV1` JSON（≤ 512KB） | 正文逐字、评论旧→新（超预算时从最旧的开始换成一行占位） |
| `TARGET_REPO` | `owner/name` | 目标仓 |
| `SPEC_NUMBER` | spec 号 | 分支 `agent/spec-<n>` 与 `Closes #<n>` 的来源 |
| `GIT_BASE_URL` | App 的 `GIT_BASE_URL` | **模板发射但 Job 镜像不读**（镜像读的是下面那条 `GIT_REMOTE_URL`）；留在这里是因为它是 App 侧拼 URL 的源，也是 e2e 的第三个 env 差异点 |
| `GIT_REMOTE_URL` | App 拼好：`GIT_BASE_URL/<owner>/<name>.git` | 播种与 push 都用它，**不带 token** |
| `GITHUB_APP_ID` | App 的 `GITHUB_APP_ID` | commit 身份 `<app-id>+remote-agent[bot]@users.noreply.github.com` |
| `OMNIROUTE_BASE_URL` / `OMNIROUTE_MODEL` / `OMNIROUTE_REVIEW_MODEL` | App 常量（§9） | 两个 conversation 的模型 |
| `OMNIROUTE_API_KEY` | `secretKeyRef` → `remote-agent-secret` 的**同一个 key** | 网关 key（从不用 `envFrom`） |
| `JOB_NAME` | **字面值**，就是 Job 名 | runner 往自己 Job 上 PATCH annotation 时的目标 |
| `JOB_NAMESPACE` | `fieldRef: metadata.namespace` | 同上 |
| `PROMPTS_DIR` | 代码常量 `/mnt/prompts-override` | 事故覆盖目录（[ADR-0020](adr/0020-prompts-travel-with-the-image.md)）：某 key 在此有文件则用它，否则回落镜像 |

init 容器（`seed`）只要三个：`TARGET_REPO`、`SPEC_NUMBER`、`GIT_REMOTE_URL`——它只做 git，拿不到 work item 与模型配置（[ADR-0009](adr/0009-ticket-volume-seeding.md)）。

### 三个卷，不多不少

| 卷 | 类型 | 挂载 | 谁挂 |
| --- | --- | --- | --- |
| `ticket` | PVC，名字 = Job 名 | `/mnt/agent`（`repo/` · `state/` · `home/`） | seed + runner |
| `token` | Secret，`agent-<repo-slug>-<issue#>-token`（整个 Secret） | `/mnt/credentials`（只读；`token` 键落在 `/mnt/credentials/token`） | seed + runner |
| `prompts-override` | ConfigMap `remote-agent-prompts-override`（`optional: true`） | `/mnt/prompts-override`（只读） | 只 runner（见 §8） |

这三块就是镜像会读的全部输入面：`ticket` 与 `token` 少一个，Job 会在第一个模型调用之前就死（seed 拿不到 token 或 runner 读不到凭证）；`prompts-override` 是**可选**的，对象不存在时挂一个空目录，runner 逐 key 回落镜像里的模板，默认路径不受影响。**任何一边加路径而不加另一边的断言，都会静默变成「Job 永远起不来」**——这正是 kind e2e 存在的理由（[e2e/README.md](../e2e/README.md)）。

`token` 那条挂的是**整个 Secret 目录**，不是用 `subPath` 挑出 `token` 键——两者最终路径一样，行为却不同。kubelet 传播 Secret 更新靠原子切换卷的符号链接，`subPath` 在容器启动时就把链接解析掉了，之后永远读启动那一刻的文件。App 的续期是原地 patch Secret（`token-renewal.ts`），所以 `subPath` 会把 token 冻在 pod 出生那一刻：任何跑过 60 分钟（installation token 寿命）的 run 都会拿一枚死凭证去 push（[#53](https://github.com/2017fighting/remote-agent/issues/53)）。挂目录则让 ADR-0009 / ADR-0014 那句「挂载晚 1–1.5 分钟生效」重新成立，30 分钟续期阈值也才有意义。

一个已知的重复拼写：token 的挂载路径在 `app/src/renders/job-template.ts` 里是 `TOKEN_MOUNT_PATH`，在 `shared/src/paths.ts` 里是 `JOB_MOUNT_PATHS.token`（Job 镜像读后者）。`app/test/job-template.test.ts` 用 `mountPath === dirname(JOB_MOUNT_PATHS.token)` 把两者钉在一起，但那只盖住「目录 + 键名 = 路径」这层关系；改任一处仍要两处一起看。

### 三个「不要改回去」的细节

1. **`JOB_NAME` 必须是字面值，不能写成 `fieldRef: metadata.name`。** 容器里的 downward API 把 `metadata.name` 解成 **pod 名**，而 Job 的 pod 是 `<job-name>-<random5>`；runner 的 `deriveJobName()` 优先读 `JOB_NAME`，于是每次 run-result PATCH 都会打向一个不存在的 Job（404），App 随即判 `error(no-result)`——**每一个结果都丢**。`JOB_NAMESPACE` 用 `fieldRef` 是安全的。
2. **init 容器必须显式写 `command`。** 两个容器共用一个镜像，镜像的 `CMD` 是 runner；不写 `command` 时 seed 会去跑 runner，在 runner-only 的 env 上启动失败，pod 一路 loop 到 `BackoffLimitExceeded`。
3. **token 卷必须整目录挂，不能加回 `subPath`。** `subPath` 挂载收不到 Secret 更新，而 token 是 App 原地 patch 续期的：加回 `subPath` 等于把 token 冻在 pod 出生那一刻，所有超过 60 分钟的 run 都会在 push 时认证失败（[#53](https://github.com/2017fighting/remote-agent/issues/53)）。失败形态是 `git push` 报 `Invalid username or token`，看起来像凭证问题而不像挂载问题。

### 其余代码常量（不走 env）

`parallelism: 1`、`restartPolicy: Never`、`terminationGracePeriodSeconds: 120`、`fsGroup: 1000`、SA `agent-job`、PVC `ReadWriteOncePod` + SC `truenas-iscsi-delete`、agent 容器 requests `500m/2Gi` + memory limit `6Gi`、seed 容器 requests `100m/128Mi` 无 limit、`podFailurePolicy`：seed 容器 exit 78 → `FailJob`，**以及 runner 容器 exit 78 → `FailJob`**（[ADR-0009](adr/0009-ticket-volume-seeding.md) / [ADR-0010](adr/0010-job-resource-budget.md)）。

runner 那条规则管的是「重试不可能改变结果」的那一类失败：仓库根本不是 git 仓库，以及**已经交给 agent 解过一次、再撞上来的** rebase 冲突（[#58](https://github.com/2017fighting/remote-agent/issues/58)）。分支按 **spec** 命名，同一 spec 的两个 ticket 会写同一个 ref，改到同一批行时 runner 选不出赢家——所以冲突时它不 abort，把停在冲突上的 rebase 交给 agent 去按语义解（同一 conversation 的一轮新输入 + 一次可覆盖的 run result），agent 解不动就 `blocked`，解得动就再自述一次，runner 随后 push。**一次就停**针对的是「解完了还撞」：那时再重放同一个 push 只会一直撞（`pi-web#4` 就是这样丢了一轮：五个 pod、五次同样的拒绝）。凭证被拒也不在这类里——那是挂载文件陈旧而非卷坏了，runner 会等文件变化重试一次，等不到就交给新 pod（[#57](https://github.com/2017fighting/remote-agent/issues/57)）。其余 runner 失败仍旧 exit 1，走正常 backoff。

### 6.1 Job 上的身份：标签只放合法值，机器可读的身份进注解

spec §4 把 `remote-agent/ticket=<repo>#<n>` 与 `remote-agent/repo=<repo>` 写成**标签**，但这两个值含 `/` 与 `#`，API server 会直接 422（kind e2e 抓到的真 bug：照那个拼法一张 Job 都建不出来）。实际形态：

| 载体 | 键 | 值 |
| --- | --- | --- |
| label | `app.kubernetes.io/managed-by` | `remote-agent` |
| label | `remote-agent/spec` | `<n>` |
| label | `remote-agent/role` | `implement-ticket` / `implement-spec` |
| annotation | `remote-agent/ticket` | `<repo>#<n>` |
| annotation | `remote-agent/repo` | `<repo>` |

读 `owner/name` 的地方（token 续期、每 repo 的 Slot 计数）读**注解**，不读标签。改这里之前先读 [ADR-0011](adr/0011-ticket-pvc-recycling.md) 的那条 provenance 决定。

## 7. 护栏 quota

`ResourceQuota` 只算对象数量：`count/jobs.batch: "10"`、`pods: "20"`，**不含 `requests.*` / `limits.*` 任何一个键**（只要出现这类键，k8s 就要求 namespace 里每个 Pod 都声明它，会把资源声明变成硬前置）。它只防「App 逻辑写错时无限起 Job」，**不承载并发语义**——并发是 App 自己算的 Slot（[#13](https://github.com/2017fighting/remote-agent/issues/13)，图见 [architecture.md §5](architecture.md#5-并发slot-与-defer)）。

## 8. prompt 的载体

prompt 模板**随 Job 镜像发布**（[ADR-0020](adr/0020-prompts-travel-with-the-image.md)）：`job/Dockerfile` 把 repo 的 `prompts/` COPY 到 `IMAGE_PROMPTS_DIR` = `/opt/remote-agent/prompts`（与 `seed.mjs` / `runner.mjs` 同级），runner 默认从那里读，**不依赖任何挂载的 ConfigMap**。键面仍是五个（[ADR-0004](adr/0004-prompts-live-in-configmap.md) 的结论，载体由 0020 取代）：`_common`（所有 role 拼在最前）+ `implement-ticket` / `implement-spec` + `review-standards` / `review-spec`（reviewer conversation 两轴各一份）。repo 里的 `prompts/` 就是这份 key 面的逐字源，单测断言它恰好是这五个键、且每个 Agent role 与 review axis 映射出的 key 都在里面。

事故覆盖口子是 `PROMPTS_DIR`（[ADR-0020](adr/0020-prompts-travel-with-the-image.md)）：某 key 在该目录里有文件就用它，否则回落镜像目录；role 模板与 review axis 模板走同一条回落路径。每个 key 解析时打一行 `prompt-source=<key>:image` 或 `prompt-source=<key>:override`，一次运行解析整个 key 面，所以单次运行的日志点名每个 key 的来源；两处都没有该 key 时直接报错，文案同时点名两个目录。

覆盖口子已经接上（ticket [#77](https://github.com/2017fighting/remote-agent/issues/77)）：Job 模板常驻一个 `optional: true` 的 ConfigMap 卷 `prompts-override` → `remote-agent-prompts-override`，挂在 `/mnt/prompts-override`（`JOB_MOUNT_PATHS.promptsOverride`），`PROMPTS_DIR` 指向同一路径。对象不存在时 k8s 挂一个空目录，默认路径不受影响；旧的 `remote-agent-prompts` 卷与 `PROMPTS_CONFIGMAP_NAME` 常量已退场，home-ops 的 `prompts-configmap.yaml` 随之删除。App 不需要新 RBAC（卷由 kubelet 挂），seed 容器挂载不变。

### 事故热改

覆盖卷常驻、但默认不存在：Job 模板挂一个 `optional: true` 的 ConfigMap `remote-agent-prompts-override` 到 `/mnt/prompts-override`，`PROMPTS_DIR` 指向它。**这是事故工具，不是常规发布路径**：prompt 的正常变更走 `prompts/` + 一次 release（§10），只有事故里要临时改一句、又等不起一次发版时才用它，而且用完必须删掉。事故里只改一个 key（键面就是上面那五个：`_common` / `implement-ticket` / `implement-spec` / `review-standards` / `review-spec`；只放要改的那一个）：

1. `kubectl create configmap remote-agent-prompts-override -n remote-agent --from-file=<key>=<path>`（`--from-file` 的文件名就是 prompt key）。
2. 等下一轮 Job 起来，看它的日志：那个 key 是 `prompt-source=<key>:override`，其余仍是 `:image`。
3. **用完删掉**：`kubectl delete configmap remote-agent-prompts-override -n remote-agent`。忘记删就会一直生效，而这是唯一的线索来源。

（runner 在**每一轮开始时**一次性解析整个 key 面，不是在每次读模板时惰性读；所以删覆盖 ConfigMap 只影响之后才起跑的那些轮——它们读回镜像里的模板，在跑的 Job 已经读过，不受影响。最初设想里「删之前先确认 `kubectl get jobs -n remote-agent` 为空」那条前置因此不再需要，理由见 [ADR-0020](adr/0020-prompts-travel-with-the-image.md) 与 [#76](https://github.com/2017fighting/remote-agent/issues/76)。）

渲染顺序已定：runner 先读 `_common`、再读 role 模板，拼起来后一次把 `{{...}}` 全部替掉（未知占位符直接报错，不把字面值交给模型）。

每条 prompt 义务的落点与内容见 [prompt 必写项清单](agents/prompt-checklist.md)。

## 9. OmniRoute 接线（runner 侧）

provider 名 `omniroute`，baseUrl 走**集群内 Service 的 FQDN**：

```
http://omniroute.omniroute.svc.cluster.local:20128/v1
```

不吃 edge、不绕一圈。OmniRoute 侧 `REQUIRE_API_KEY=true`，所以**必须**带 key：`envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"])`。

| conversation | model id | contextWindow | maxTokens | thinking |
| --- | --- | --- | --- | --- |
| 主 runner | `default` | 1,000,000 | 131,072 | `high` |
| reviewer（`code_review` 起的独立 conversation） | `review` | 1,000,000 | 65,536 | `high` |

两者都是 OmniRoute 里真实存在的 **combo**（`default` = `glm-5.3-high` → 兜底 `deepseek-flash`；`review` = `gemini-3.8-flash-tiered` → 兜底 `default`），`reasoning: true`、`tool_calling: true`、`input: ["text"]`（combo 的 `multimodal: false`）、`cost` 全 0。元数据以活体 `/v1/models` 为准——`~/.pi/agent/models.json` 里那组 `1048576/1048576` 是错的，不要抄。

形态（`createProvider` 不补默认值，每条 model 都要写全）：

```ts
models.setProvider(createProvider({
  id: "omniroute",
  name: "OmniRoute",
  baseUrl,                                  // required("OMNIROUTE_BASE_URL")
  auth: { apiKey: envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"]) },
  api: openAICompletionsApi(),              // @earendil-works/pi-ai/api/openai-completions.lazy
  models: [ /* 两条，见上表 */ ],
}));
```

四条约束：

- **值走「App 常量 → Job env → runner 只读 env」**，与 §6 的镜像与 Job 模板同构：单一真相在 App 代码里，env 只是传输与覆盖点，**runner 不设内置默认**——不出现「env 没设时静默用别的地址」这种只能靠人看出来的失败模式。
- **启动即校验**：`OMNIROUTE_*` 缺任何一个都在 runner 启动时失败退出，不拖到第一次模型请求才抛 `Provider is not configured`。
- **不写 `compat`**：未知 provider/baseUrl 的自动 compat（`thinkingFormat: "openai"` + `supportsReasoningEffort` + `maxTokensField: "max_completion_tokens"`）实测被 OmniRoute 接受。`thinking` 用 `high`，**不写 `thinkingLevelMap`**（`xhigh` / `max` 才需要显式 map，v1 不用）。
- **接线里没有 `sleepUntil` / `sleeping` / `wake()` / `retryTask` 这类形状**：一次 run 从开工走到某个 Result tool（[ADR-0008](adr/0008-durable-runtime-base.md) 已定不依赖未发布的能力）。

combo 的兜底会静默换上游模型，但**不需要新机制**：durable 的 session entry 里有 `AssistantMessage`，其 `responseModel` 就是 provider 上报的实际模型，从 Ticket PVC 上的 storage 可复原。

## 10. 发版（release-please）

版本号、tag 与 GitHub Release 由 release-please 拥有（[ADR-0019](adr/0019-release-please-owns-the-version-and-the-tag.md)）。人只做两件事：合并功能 PR，以及「攒够了之后手动派发一次 `release-please` workflow」。

| 步 | 触发 | 产物 |
| --- | --- | --- |
| 1 | 合并任意 PR 到 `main` | release-please 在 main 上更新/创建那条 release PR（`chore(main): release <next>`，label `autorelease: pending`），下一个版本随时可见 |
| 2 | 手动 `workflow_dispatch` 跑 `release-please` | 那一次 run squash 合并 release PR（`--squash --delete-branch`） |
| 3 | 合并产生的 push `main` | release-please 的**下一次** run 创建 tag `v<version>` + GitHub Release（CHANGELOG 已随 release PR 合入） |
| 4 | tag `v*` 的 push | `ci.yml` 完整链路（typecheck/unit → 两个镜像 → kind e2e → 推 GHCR），镜像 tag 就是这个版本号 |

要点：

- **tag 必须由 PAT（`secrets.RELEASE_PLEASE_TOKEN`）创建**：`GITHUB_TOKEN` 创建的 tag 不触发 `on: push: tags`，镜像就不会发。这个 secret 是发版的前置，缺了它第 3 步会红。
- **不要手打 tag，也不要手改版本号**：`.release-please-manifest.json` 与 root `package.json` 的 `version` 是 release-please 的输入。
- **0.x 规则**：fix → patch、feat → minor、BREAKING → minor（[ADR-0019](adr/0019-release-please-owns-the-version-and-the-tag.md)）。
- **release PR 只跑 typecheck + unit**（`ci.yml` 按 `autorelease: pending` label 跳过镜像构建与 kind e2e，分支前缀 `release-please--` 是兜底）；镜像的门禁是第 3、4 步那两次完整运行。
- home-ops 侧的 `image.tag` 仍由人写（§2、§6）：发版只负责让那个 tag 在 GHCR 上存在。

## 11. 本文件不覆盖

App 与 runner 的**内部结构**（模块划分、durable 的 task/phase、工具集、prompt section 拼接）、观测性、探针与 Service 细节不在这里：读 `app/src/`、`job/src/` 的模块注释，入口是 `app/src/main.ts` 与 `job/src/runner.ts`。Ticket PVC 的容量与回收见 [ADR-0010](adr/0010-job-resource-budget.md) / [ADR-0011](adr/0011-ticket-pvc-recycling.md)；状态机见 [architecture.md §4](architecture.md#4-状态机)。
