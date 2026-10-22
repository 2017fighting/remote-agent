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
├── resourcequota.yaml               # 只算数量的护栏，见 §7
└── prompts-configmap.yaml           # remote-agent-prompts，见 §8
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

> **未完成的动作项**：`README.md` 里那枚 webhook secret 已进 git 历史，按**已泄漏**处理——在 GitHub App 后台重设、新值进 sops、README 那行删掉（本仓库当前只在那一行旁标了「已泄漏，待轮换」）。App private key 与它同一个 secret。

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

Job 名是动态生成的，RBAC 收窄不到 `resourceNames`，所以这是 namespace 级权限：一个 Job pod 理论上能改同 namespace 里另一个 Job 的注解。**App 侧的应对**：只信带自己 label 的 Job，并校验注解里的 Job 名与对象一致（注解不是无签名真相）。

## 6. Job 模板与镜像

- **pod 模板由 App 代码构造**（TypeScript + `@kubernetes/client-node`）：镜像、env、卷、`activeDeadlineSeconds`、SA、label 都在代码里，与 run result 契约、env 名、确定性命名同源，能进假客户端单测。home-ops 不存 Job YAML。
- **镜像**：App 是 `ghcr.io/2017fighting/remote-agent`，Job 是 `ghcr.io/2017fighting/remote-agent-job`；两者同仓、同一个 Actions 工作流发布到 GHCR（[#5](https://github.com/2017fighting/remote-agent/issues/5)）。**Job 镜像的 tag 在构建时烧进 App 镜像**（Dockerfile `ARG` → 编译常量），home-ops 只在 `apps/remote-agent/helmrelease.yaml` 的 `image.tag` 一处写 tag。
- **Kyverno `registry-proxy-cache`** 会把 `ghcr.io/...` 无条件改写成 Harbor 代理 → 新 namespace 自动吃到，不需要白名单或 pull secret。
- **网络**：集群里没有任何 NetworkPolicy（默认全通）；`profile: proxy` 就是出网。Job 要能到 GitHub、GHCR 与集群内的 OmniRoute（§9）。
- **Job env 的键面**：`AGENT_ROLE`、`AGENT_THINKING_LEVEL`、`OMNIROUTE_BASE_URL` / `OMNIROUTE_MODEL` / `OMNIROUTE_REVIEW_MODEL`（§9）、`OMNIROUTE_API_KEY`（`secretKeyRef`）。App 自己的 env（默认值在代码里）：`JOB_PVC_SIZE`、`JOB_ACTIVE_DEADLINE_SECONDS`、`JOB_BACKOFF_LIMIT`（[ADR-0010](adr/0010-job-resource-budget.md)）、`JOB_TTL_SECONDS_AFTER_FINISHED`（[ADR-0012](adr/0012-job-deletion-ttl.md)）、`RESYNC_INTERVAL_SECONDS`（[ADR-0014](adr/0014-wake-surface-periodic-resync.md)）。

## 7. 护栏 quota

`ResourceQuota` 只算对象数量：`count/jobs.batch: "10"`、`pods: "20"`，**不含 `requests.*` / `limits.*` 任何一个键**（只要出现这类键，k8s 就要求 namespace 里每个 Pod 都声明它，会把资源声明变成硬前置）。它只防「App 逻辑写错时无限起 Job」，**不承载并发语义**——并发是 App 自己算的 Slot（[#13](https://github.com/2017fighting/remote-agent/issues/13)，图见 [architecture.md §5](architecture.md#5-并发slot-与-defer)）。

## 8. prompt 的载体

ConfigMap `remote-agent-prompts`（放 `apps/remote-agent/`，与 App 同生命周期），作为只读卷挂进 Job。**键面以 [ADR-0004](adr/0004-prompts-live-in-configmap.md) 为准**：`_common`（所有 role 拼在最前）+ `implement-ticket` / `implement-spec` + `review-standards` / `review-spec`。（#12 当初的「一角色一个 key、`/prompts/${AGENT_ROLE}.md`」形态已被 `_common` 与两轴 review 取代；挂载路径与渲染顺序的最终形态归 spec 阶段。）

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

## 10. 本文件不覆盖

App 与 runner 的**内部结构**（模块划分、durable 的 task/phase、工具集、prompt section 拼接）、观测性、探针与 Service 细节，归 spec 阶段的 `/codebase-design`。Ticket PVC 的容量与回收见 [ADR-0010](adr/0010-job-resource-budget.md) / [ADR-0011](adr/0011-ticket-pvc-recycling.md)；状态机见 [architecture.md §4](architecture.md#4-状态机)。
