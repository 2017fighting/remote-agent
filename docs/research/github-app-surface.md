# GitHub App 的事件面与权限面

issue #7（wayfinder:research）的研究笔记。结论以 issue 评论形式回帖，本文件是留档版本，只存在于
`research/github-app-surface` 分支，不 merge、不开 PR。

证据标记：

- **【直接证据】** — 从 primary source 原文引用，或用 `gh api` 实测复现。
- **【解读】** — 我对直接证据的归纳（多个来源组合出的结论）。
- **【推断】** — 我基于证据做的推理，没有直接出处。
- **【未确认】** — 找不到 primary source，也没有实测，按未确认处理。

## 方法与来源

所有网络来源都 pin 到 commit，避免上游改动导致引用漂移。

| 来源 | revision | 用途 |
| --- | --- | --- |
| [github/docs](https://github.com/github/docs) `src/webhooks/data/fpt/*.json` | `666463860bec200da6c8db9cb9334e7335d9b753` (2026-10-19) | 文档站 "Webhook events and payloads" 的**生成源**：事件名、action 列表、订阅所需权限、payload 字段 |
| [github/docs](https://github.com/github/docs) `src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json` | 同上 | "Permissions required for GitHub Apps" 的**生成源**：端点 → 所需 App 权限 |
| [github/docs](https://github.com/github/docs) `content/**/*.md` | 同上 | 权威叙述（去重、投递语义、rate limit） |
| [github/rest-api-description](https://github.com/github/rest-api-description) `descriptions/api.github.com/api.github.com.json` | `755ee33b4a81d51f6f07a902cce26cbec3b822f2` (2026-10-18) | OpenAPI：路径存在性、`x-github` 元数据、`x-webhooks` payload schema |
| docs.github.com 渲染页 | 2026-10-20 抓取 | 少数信息只存在于渲染页（生成源是私有数据）时使用，已标注 |
| `gh api` 实测 | 2026-10-20 | 端点形状与可访问性，见文末「实测记录」 |

注意：文档站上的 `content/rest/issues/sub-issues.md` 之类的页面正文是自动生成的空壳（
`<!-- Content after this section is automatically generated -->`），所以真正的一手材料是上面两个 JSON
数据文件，而不是那些 Markdown。

复现命令：

```bash
curl -sL https://raw.githubusercontent.com/github/docs/main/src/webhooks/data/fpt/sub_issues.json
curl -sL https://raw.githubusercontent.com/github/docs/main/src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json
curl -sL https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
```

## 1. 订阅哪些事件

### 1.1 事件全集

github/docs 的 `src/webhooks/data/fpt/` 下共 **76 个事件**（去掉 `*.child-params.json` 后计数），
例如 `issues` / `issue_comment` / `sub_issues` / `issue_dependencies` / `issue_relates_to` /
`installation` / `installation_repositories` / `check_suite` / `pull_request` / `repository` 等。
【直接证据】<https://github.com/github/docs/tree/666463860bec200da6c8db9cb9334e7335d9b753/src/webhooks/data/fpt>

每个事件文件里的 `availability` 字段给出该事件对哪些 webhook 类型可用（`app` = GitHub App 可以订阅）。
下面列出的候选事件 `availability` 全部包含 `app`。【直接证据】

### 1.2 候选事件逐条

| 事件 | actions | 订阅所需权限 | 来源 |
| --- | --- | --- | --- |
| `issues` | `assigned`, `closed`, `deleted`, `demilestoned`, `edited`, `field_added`, `field_removed`, `labeled`, `locked`, `milestoned`, `opened`, `pinned`, `reopened`, `transferred`, `typed`, `unassigned`, `unlabeled`, `unlocked`, `unpinned`, `untyped` | "Issues" read | `src/webhooks/data/fpt/issues.json` |
| `issue_comment` | `created`, `deleted`, `edited`, `pinned`, `unpinned` | "Issues" read | `src/webhooks/data/fpt/issue_comment.json` |
| `sub_issues` | `parent_issue_added`, `parent_issue_removed`, `sub_issue_added`, `sub_issue_removed` | "Issues" read | `src/webhooks/data/fpt/sub_issues.json` |
| `issue_dependencies` | `blocked_by_added`, `blocked_by_removed`, `blocking_added`, `blocking_removed` | "Issues" read | `src/webhooks/data/fpt/issue_dependencies.json` |
| `issue_relates_to` | `relates_to_added`, `relates_to_removed` | "Issues" read | `src/webhooks/data/fpt/issue_relates_to.json` |
| `pull_request` | `assigned`, `auto_merge_disabled`, `auto_merge_enabled`, `closed`, `converted_to_draft`, `demilestoned`, `dequeued`, `edited`, `enqueued`, `labeled`, `locked`, `milestoned`, `opened`, `ready_for_review`, `reopened`, `review_request_removed`, `review_requested`, `stacked`, `synchronize`, `unassigned`, `unlabeled`, `unlocked` | "Pull requests" read | `src/webhooks/data/fpt/pull_request.json` |
| `check_suite` | `completed`, `requested`, `rerequested` | "Checks" read（`requested`/`rerequested` 需 write） | `src/webhooks/data/fpt/check_suite.json` |
| `check_run` | `completed`, `created`, `requested_action`, `rerequested` | "Checks" read（`rerequested`/`requested_action` 需 write） | `src/webhooks/data/fpt/check_run.json` |
| `installation` | `created`, `deleted`, `new_permissions_accepted`, `suspend`, `unsuspend` | 无（**所有 App 默认收到，不能手动订阅**） | `src/webhooks/data/fpt/installation.json` |
| `installation_repositories` | `added`, `removed` | 无（**默认收到，不能手动订阅**） | `src/webhooks/data/fpt/installation_repositories.json` |
| `installation_target` | `renamed` | 无（app-only） | `src/webhooks/data/fpt/installation_target.json` |
| `repository` | `archived`, `created`, `deleted`, `edited`, `privatized`, `publicized`, `renamed`, `transferred`, `unarchived` | "Metadata" read | `src/webhooks/data/fpt/repository.json` |
| `push` | —（无 action） | "Contents" read | `src/webhooks/data/fpt/push.json` |
| `workflow_run` | `completed`, `in_progress`, `requested` | "Actions" read | `src/webhooks/data/fpt/workflow_run.json` |

URL 前缀统一为
`https://github.com/github/docs/blob/666463860bec200da6c8db9cb9334e7335d9b753/src/webhooks/data/fpt/`。

### 1.3 直接回答票里的四个点名问题

- **`issues`（label / assignee / close 是否都在里面）**：都在。`labeled` / `unlabeled`、
  `assigned` / `unassigned`、`closed` / `reopened` 都是 `issues` 的 action。【直接证据】（上表）
- **sub-issue 增删有没有事件**：有，是**独立的 `sub_issues` 事件**，四个 action
  `sub_issue_added` / `sub_issue_removed` / `parent_issue_added` / `parent_issue_removed`。
  文档明确说「sub-issue 相关活动用 `sub_issues` 事件；更一般的 issue 活动用 `issues` 事件」。
  【直接证据】`src/webhooks/data/fpt/sub_issues.json`
  另外 issue dependencies（blocking / blocked-by）也是独立事件 `issue_dependencies`，四个 action。
  【直接证据】`src/webhooks/data/fpt/issue_dependencies.json`
- **`issue_comment`**：存在，5 个 action（见上表）。【直接证据】
- **`pull_request`**：存在，22 个 action（见上表）。【直接证据】
- **`check_suite`**：存在，3 个 action；订阅需 "Checks" read。另有一个值得注意的行为：
  **拥有 "Checks" write 的 App 会被自动订阅 `check_suite` / `check_run`**。
  【直接证据】`src/webhooks/data/fpt/check_suite.json`、`check_run.json` 的 `summaryHtml`

### 1.4 payload 里能拿到什么

`sub_issues` 事件 payload 的字段（OpenAPI `x-webhooks` → `webhook-sub-issues-sub-issue-added`）：
`action`, `sub_issue_id`, `sub_issue`, `sub_issue_repo`, `parent_issue_id`, `parent_issue`,
`installation`, `organization`, `repository`, `sender`；required = `action`, `parent_issue_id`,
`parent_issue`, `repository`, `sender`。【直接证据】
`descriptions/api.github.com/api.github.com.json` `components.schemas.webhook-sub-issues-sub-issue-added`

`issue_dependencies` 事件 payload：`action`, `blocked_issue_id`, `blocked_issue`, `blocking_issue_id`,
`blocking_issue`, `blocking_issue_repo`, `installation`, `organization`, `repository`, `sender`。【直接证据】
同上，`webhook-issue-dependencies-blocked-by-added`

`issues` 事件里的 `issue` 对象**包含** `sub_issues_summary`
（`{total, completed, percent_completed}`）和 `issue_dependencies_summary`
（`{blocked_by, blocking, total_blocked_by, total_blocking}`），但**不包含** `parent_issue_url`，
也不包含有序的 sub-issue 列表。【直接证据】
`components.schemas.webhook-issues-labeled.properties.issue.properties` 与
`components.schemas.sub-issues-summary`、`components.schemas.issue-dependencies-summary`

### 1.5 未确认

- **`issues` 事件是否也会在 sub-issue 关系增删时触发** —— 【未确认】。文档只给出「sub-issue 活动用
  `sub_issues` 事件」这句指引，没有明确说 `issues` 是否同时投递。要确认只能真机订阅两个事件做实验。
- `issues` 事件的 `edited` action 是否涵盖「issue 的 sub-issue 汇总变化」—— 【未确认】。

## 2. 最小权限集合

权限 → 端点的权威映射来自 github/docs 的 `server-to-server-permissions.json`（即文档站
"Permissions required for GitHub Apps" 页面的生成源）。
URL 前缀：`https://github.com/github/docs/blob/666463860bec200da6c8db9cb9334e7335d9b753/src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json`

### 2.1 App 需要做的每个写动作 → 权限

| 动作 | 端点 | 权限 | 备注 |
| --- | --- | --- | --- |
| 读 ticket / spec | `GET /repos/{owner}/{repo}/issues/{issue_number}`、`GET /repos/{owner}/{repo}/issues` | `issues: read` | |
| 关闭 / 重开 / 编辑 issue | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | `issues: write` | 标记 `additional-permissions`（见 2.3） |
| 加 / 删 label | `POST`/`DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels` | `issues: write` | |
| 设 / 撤 assignee（Claim） | `POST`/`DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees` | `issues: write` | 同上 |
| 发评论（回帖 / Run result） | `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | `issues: write` | |
| 读 sub-issue（算 Frontier 的「有没有 sub-issue」「顺序」） | `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` | `issues: read` | |
| 加 / 删 sub-issue | `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`、`DELETE .../sub_issue` | `issues: write` | 无 `additional-permissions`，Issues write 单独够 |
| 读 parent | `GET /repos/{owner}/{repo}/issues/{issue_number}/parent` | `issues: read` | |
| 读 blocked_by / blocking | `GET .../dependencies/blocked_by`、`GET .../dependencies/blocking` | `issues: read` | |
| 加 / 删 blocker | `POST .../dependencies/blocked_by`、`DELETE .../dependencies/blocked_by/{issue_id}` | `issues: write` | |
| 建分支 / 写文件 / 提交 / merge | `POST /repos/{owner}/{repo}/git/refs`、`POST /git/commits`、`POST /git/blobs`、`POST /git/trees`、`PUT|DELETE /repos/{owner}/{repo}/contents/{path}`、`POST /repos/{owner}/{repo}/merges` | `contents: write` | |
| 读 repo 元数据 / 分支 / commit | `GET /repos/{owner}/{repo}`、`GET /repos/{owner}/{repo}/branches/{branch}`、`GET /repos/{owner}/{repo}/commits/{ref}` | `metadata: read`（repo 本体） / `contents: read`（分支、commit、文件） | |
| 开 PR | `POST /repos/{owner}/{repo}/pulls` | `pull_requests: write` | |
| 读 PR | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | `pull_requests: read` | |
| 订阅 `check_suite` / `check_run` | —（订阅门槛，不是 REST 端点） | `checks: read` | |
| 订阅 `workflow_run` | — | `actions: read` | |
| 改 `.github/workflows/**` | `PUT /repos/{owner}/{repo}/contents/{path}` | `workflows: write` | 仅当 agent 会改 workflow 文件时才要 |
| 列出 installation 能访问的 repo | `GET /installation/repositories` | **不需要任何权限** | 见 2.4 |

### 2.2 直接回答票里的问题

- **`contents` 要 write 吗**：只有当你用 App 的 token 去建分支/提交/写文件/merge 时才要 write。
  `git/refs`、`git/commits`、`git/blobs`、`git/trees`、`contents/{path}` PUT/DELETE、`merges` 全在
  Contents 权限下。【直接证据】（2.1 表）
  只读文件/commit/branch 的话 `contents: read` 就够。【直接证据】
- **`issues` 要 write 吗**：要。App 作为唯一 GitHub 写者（`GLOSSARY.md:36`）要加 label、设 assignee、
  关 issue、发评论，这些全部落在 `issues: write`。【直接证据】（2.1 表）
- **`pull_requests` 要 write 吗**：只有 App 亲自开 PR / 改 PR / 评论 PR 才要。若 PR 由 Job 里的
  pi/`gh` 用另一个 token 开，App 侧只要 `pull_requests: read`（甚至只要够订阅 `pull_request` 事件）。
  【解读】
- **sub-issues 需要什么权限**：读写都在 **Issues** 权限下，没有单独的 sub-issue 权限。
  `GET .../sub_issues` = Issues read；`POST .../sub_issues`、`DELETE .../sub_issue`、
  `PATCH .../sub_issues/priority` = Issues write。【直接证据】
- **issue dependencies 需要什么权限**：同上，全在 **Issues** 权限下。
  `GET .../dependencies/blocked_by`、`GET .../dependencies/blocking` = Issues read；
  `POST .../dependencies/blocked_by`、`DELETE .../dependencies/blocked_by/{issue_id}` = Issues write。
  【直接证据】

### 2.3 `additional-permissions` 是什么意思

`server-to-server-permissions.json` 里部分行带 `"additional-permissions": true`。文档站渲染出来的
说法是「必须至少拥有以下权限集合之一」。例如 `POST /repos/{owner}/{repo}/issues/{issue_number}/labels`
渲染为：

> The fine-grained token must have at least one of the following permission sets:
> "Issues" repository permissions (write) | "Pull requests" repository permissions (write)

【直接证据】<https://docs.github.com/en/rest/issues/labels>（渲染页；生成源是私有数据，故引 URL）

也就是说 `additional-permissions: true` **不是**「还要再加一个权限」，而是「还有另一条等价路径」。
对只做 issue 编排的 App，`issues: write` 单独就够。【解读】

### 2.4 两个容易踩的点

- `GET /installation/repositories`（列出 installation 可访问的 repo）**不需要任何权限**。
  【直接证据】<https://docs.github.com/en/rest/apps/installations> 渲染页 "List repositories accessible
  to the app installation" → "The fine-grained token does not require any permissions."
- 我**没有**在 github/docs 里找到「Metadata 是所有 App 必选权限」这句话的出处，
  所以不把它写成事实。【未确认】能确认的只是：`GET /repos/{owner}/{repo}` 等 repo 元数据端点
  需要 `metadata: read`，而订阅 `repository` / `label` 事件也需要 `metadata: read`。
  【直接证据】`server-to-server-permissions.json` 的 `metadata` 条目；`label.json` 的 `summaryHtml`

## 3. 怎么判断「这是我们关心的变化」+ 去重

### 3.1 每个投递都带的头

`X-GitHub-Hook-ID`、`X-GitHub-Event`、`X-GitHub-Delivery`、`X-GitHub-Hook-Installation-Target-Type`、
`X-GitHub-Hook-Installation-Target-ID`、`X-Hub-Signature-256`（配了 secret 时）、
`User-Agent: GitHub-Hookshot/*`。【直接证据】
<https://github.com/github/docs/blob/666463860bec200da6c8db9cb9334e7335d9b753/content/webhooks/webhook-events-and-payloads.md>

### 3.2 payload 判据

- 事件类型用 `X-GitHub-Event` 头，不要从 body 猜；action 用顶层 `action` 字段。
  【直接证据】`content/webhooks/using-webhooks/best-practices-for-using-webhooks.md`
  （"Check the event type and action before processing the event"）
- 归属判断可用：`installation.id`、`repository.full_name`、`issue.number`、`sender.login`。
  【直接证据】OpenAPI `x-webhooks` 各 payload 的 required 字段（如 `webhook-sub-issues-sub-issue-added`）
- **payload 不足以算出 Frontier**：`issues` 事件的 `issue` 对象只有 `sub_issues_summary`（计数）与
  `issue_dependencies_summary`（计数），没有有序 sub-issue 列表，也没有 `parent_issue_url`。
  【直接证据】`components.schemas.webhook-issues-labeled.properties.issue.properties`
  所以「这张 ticket 有没有 sub-issue」「spec 的 sub-issue 顺序」必须回读
  `GET /issues/{n}/sub_issues`。【解读】
  另外 25 MB 以上的 payload 会被直接丢弃不投递。【直接证据】
  `data/reusables/webhooks/payload_cap.md`

### 3.3 去重

- `X-GitHub-Delivery` 是「identify the event」的 GUID，可用来防重放。
  【直接证据】`content/webhooks/webhook-events-and-payloads.md`（Delivery headers 一节）
- **但红投递会复用同一个 GUID**：
  > If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery.
  【直接证据】`content/webhooks/using-webhooks/best-practices-for-using-webhooks.md`
  所以「见过这个 delivery id 就丢」的朴素实现会把红投递也丢掉 —— 而红投递通常正是你上次没处理成功的那条。
  【解读】
- 更根本的：GitHub **不会**自动重投失败投递；服务器必须 10 秒内返回 2xx，否则记为失败；
  红投递窗口是最近 3 天（fpt/ghec）；投递可能乱序到达；突发时会被限速投递。
  【直接证据】`content/webhooks/using-webhooks/handling-failed-webhook-deliveries.md`、
  `content/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks.md`、
  `data/variables/webhooks.yml`（retention: 3 / 7）、
  `content/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks.md`（"Webhooks deliveries
  are out of order"、"Webhooks deliveries may be throttled"）
- 【解读】结论：去重只能是**优化**，不能是正确性来源。这与本仓的
  `docs/adr/0001-stateless-reconciler.md:3`（「webhook 会漏投……所以 reconcile 全量重算」）一致。
  实用做法是「去重 + 合并成一次 reconcile」：webhook 只当作「该重算了」的信号，收到就触发一次幂等
  reconcile pass；delivery id 只用来 coalesce 同一事件的重复投递，并且要允许红投递穿透。

## 4. rate limit

### 4.1 installation token 的额度

原文（`data/reusables/rest-api/primary-rate-limit-github-app-installations.md`，
<https://github.com/github/docs/blob/666463860bec200da6c8db9cb9334e7335d9b753/data/reusables/rest-api/primary-rate-limit-github-app-installations.md>）：

> GitHub Apps authenticating with an installation access token use the installation's minimum rate limit
> of 5,000 requests per hour. If the installation is on a GHE Cloud organization or enterprise, the
> installation has a rate limit of 15,000 requests per hour.
> For installations that are not on a GHE Cloud organization or enterprise, the rate limit for the
> installation will scale with the number of users and repositories. Installations that have more than
> 20 repositories receive another 50 requests per hour for each repository. Installations that are on an
> organization that have more than 20 users receive another 50 requests per hour for each user. The rate
> limit cannot increase beyond 12,500 requests per hour.

【直接证据】

要点：

- 下限 5,000/h，GHE Cloud 账号 15,000/h，自建扩展上限 12,500/h。
- 额度是**按 installation 算**的，不是按 token 算；同一 installation 下所有 token（App 服务端、每个
  Job）共用同一个额度。【解读】原文只说 "the installation's minimum rate limit"，没有明说共享；
  「per installation」这一措辞 + 额度表按 installation 列出，是我这样读的理由。若这条对架构重要，
  值得实测确认。【未确认】
- installation token **1 小时后过期**。【直接证据】
  `data/reusables/apps/generate-installation-access-token.md`、
  `content/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation.md`
- 用 `POST /app/installations/{installation_id}/access_tokens` 的 `permissions` 参数可以给单个 token
  收窄权限（不能超出 App 已获得的权限）；`repositories` / `repository_ids` 可以收窄到最多 500 个 repo。
  【直接证据】同上 `generate-installation-access-token.md`

### 4.2 次要限流（secondary rate limits）

【直接证据】`data/reusables/rest-api/secondary-rate-limit-rest-graphql.md`
<https://github.com/github/docs/blob/666463860bec200da6c8db9cb9334e7335d9b753/data/reusables/rest-api/secondary-rate-limit-rest-graphql.md>

- 并发请求不超过 100（REST + GraphQL 共享）。
- 单端点不超过 900 points/min（GraphQL 2000 points/min）。
- 60 秒真实时间内 CPU 不超过 90 秒。
- 内容创建类：一般不超过 80 次/分钟、500 次/小时（含网页操作）。
- points 计价：REST 的 GET/HEAD/OPTIONS = 1 point，POST/PATCH/PUT/DELETE = 5 points；
  GraphQL 查询 1 point，mutation 5 points。

### 4.3 省额度的两个官方手段

- 条件请求：带 `Authorization` 的 `GET` 拿到 `304 Not Modified` **不计入** primary rate limit。
  【直接证据】`content/rest/using-the-rest-api/best-practices-for-using-the-rest-api.md`
- `GET /rate_limit` 本身不计入 primary rate limit（但可能计入 secondary）。
  【直接证据】`content/rest/using-the-rest-api/rate-limits-for-the-rest-api.md`
- 注意：`x-ratelimit-*` 响应头才是权威值；不同 region 处理的请求会让 `GET /rate_limit` 与响应头不一致。
  【直接证据】同上

### 4.4 直接回答「list sub-issues / 列 Job 这类高频调用会不会撞墙」

- **列 Job 不花 GitHub 额度**：Job 列表来自 k8s API（`GLOSSARY.md:49-51` 的 Job 定义、
  `docs/adr/0003-one-k8s-job-per-ticket.md`），不占 installation 额度。
- **列 sub-issue 的调用量很小**：`GET /issues/{n}/sub_issues` 支持 `per_page` 最大 100
  【直接证据】OpenAPI `components.parameters.per-page`，所以一个 spec（本例 #1 有 13 个 sub-issue）
  只需 1 次请求。实测确认该端点可用（见文末）。
- **量级估算**【推断】：一次 reconcile pass 的成本 ≈ O(每个 spec 1 次 list sub-issues + 每张
  frontier ticket 1~3 次读 + 少量写)。即使按每 repo 每次 reconcile 花 20 次请求、每分钟一次全量兜底
  来算，也就是 1,200 次/小时/repo；只要不做「每个 webhook 都全量重扫所有 repo」，5,000/h 有大量余量。
  真正容易撞的是 secondary 里的**并发 100** 和**写操作 80 次/分钟**，所以写操作要串行 + 幂等。
- 真正的风险不是 primary 额度，而是【解读】：
  1. reconcile 被 webhook 风暴触发（例如一次 label 批量操作产生几十条 `issues` 事件）→ 必须 coalesce；
  2. 多副本/多 Job 同时用同一 installation token → 额度共享且并发容易超 100。

## 5. 新 repo 加入 installation 有没有事件

**有，而且是默认订阅、不能取消的 `installation_repositories` 事件。**【直接证据】

`src/webhooks/data/fpt/installation_repositories.json`：

> This event occurs when there is activity relating to which repositories a GitHub App installation can
> access. **All GitHub Apps receive this event by default. You cannot manually subscribe to this event.**

- actions：`added` / `removed`。【直接证据】
- payload 字段：`action`, `enterprise`, `installation`, `organization`, `repositories_added`,
  `repositories_removed`, `repository`, `repository_selection`, `requester`, `sender`；
  required = `action`, `installation`, `repository_selection`, `repositories_added`,
  `repositories_removed`, `requester`, `sender`。【直接证据】
  `components.schemas.webhook-installation-repositories-added`

相关的还有：

- `installation` 事件（actions `created` / `deleted` / `new_permissions_accepted` / `suspend` /
  `unsuspend`），同样**默认收到、不能手动订阅**，payload 带 `repositories` 列表。
  【直接证据】`src/webhooks/data/fpt/installation.json`
- `repository` 事件（actions `created` / `transferred` / …）可以手动订阅，但需要 "Metadata" read，
  而且它说的是「仓库活动」，不是「installation 的范围变了」。【直接证据】`repository.json`
- 兜底轮询：`GET /installation/repositories`（列出 installation 能访问的 repo）**不需要任何权限**。
  【直接证据】<https://docs.github.com/en/rest/apps/installations>

【解读】所以「懒初始化」有两个触发点：`installation` `created`（首次安装）和
`installation_repositories` `added`（新 repo 加入），两者都是默认送达、不依赖订阅配置 —— 这对
"部署时忘了配 webhook 订阅" 这类失败模式是安全的；再用 reconcile 里对 installation repo 列表的
兜底轮询补漏（符合 `docs/adr/0001-stateless-reconciler.md:3`）。

## 6. 建议的最小配置

【解读】（这是我基于上面证据给出的归纳，不是文档原文）

订阅事件（按需要增删）：

```
issues, issue_comment, sub_issues, issue_dependencies,
installation, installation_repositories
+ 可选: pull_request, check_suite, repository
```

`installation*` 三个是默认送达的，不用也不能订阅；`sub_issues` / `issue_dependencies` 必须显式订阅，
否则 sub-issue 与 blocker 变化没有信号。

权限：

| 权限 | 级别 | 理由 |
| --- | --- | --- |
| Issues | read & write | label / assignee / close / comment / sub-issues / dependencies 全在这里 |
| Contents | read & write | 建分支、提交、merge（若 Job 用同一 App 的 token 推代码） |
| Metadata | read | 读 repo 元数据、订阅 `repository` 事件 |
| Pull requests | read & write | 只有 App 自己开/改 PR 时才要 write |
| Checks | read | 只有订阅 `check_suite` / `check_run` 时才要 |

不需要：`administration`、`workflows`（除非 agent 会改 `.github/workflows/**`）、`actions`
（除非订阅 `workflow_run`）、`organization_*` 系列。

## 7. 未确认清单

1. `issues` 事件是否在 sub-issue 关系增删时也投递。【未确认】只能靠真机订阅实验确认。
2. `issues` 的 `edited` action 是否涵盖 sub-issue 汇总变化。【未确认】
3. installation 的 primary rate limit 是否在同一 installation 的多个 token 间共享。
  【未确认】原文只说 "the installation's minimum rate limit"，共享是我的解读。
4. 「Metadata 是所有 App 的必选权限」这句话的出处。【未确认】github/docs 里搜不到。
5. `X-GitHub-Delivery` 在自动/手动红投递之外的重试路径下是否可能变化。【未确认】只确认了
   红投递复用同一 GUID。

## 实测记录

命令在 `2017fighting/remote-agent` 上执行，用的是登录用户的 PAT（**不是** installation token），
所以这些结果只证明端点形状与可访问性，**不能**用来证明 installation token 的额度或权限行为。

| 命令 | 结果 |
| --- | --- |
| `gh api /repos/2017fighting/remote-agent/issues/7/sub_issues` | `[]` |
| `gh api /repos/2017fighting/remote-agent/issues/7/parent` | 返回 issue #1 的完整对象 |
| `gh api /repos/2017fighting/remote-agent/issues/7/dependencies/blocked_by` | `[]` |
| `gh api /repos/2017fighting/remote-agent/issues/7/dependencies/blocking` | `[{ "number": 10, ... }]` |
| `gh api /repos/2017fighting/remote-agent/issues/1/sub_issues` | 13 条（#2–#14，含已关闭的 #2–#5） |
| `gh api /repos/2017fighting/remote-agent/issues/7` | `parent_issue_url` 指向 #1；`sub_issues_summary` = `{completed:0, percent_completed:0, total:0}` |
| `gh api /repos/2017fighting/remote-agent/issues/1` | `sub_issues_summary` = `{completed:4, percent_completed:30, total:13}` |
| `gh api -i /rate_limit` | `X-RateLimit-Limit: 5000`（这是 PAT 的额度，不是 installation 的） |

结论：`sub_issues` / `dependencies` / `parent` 三个端点在本仓真实可用，返回结构包含
`sub_issues_summary` / `issue_dependencies_summary`，与 OpenAPI 的 `issue` schema 一致。
【直接证据】
