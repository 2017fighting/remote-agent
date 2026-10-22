# installation token 的并存语义：多枚能不能并存，mint 新 token 会不会作废旧 token

回应 [#31](https://github.com/2017fighting/remote-agent/issues/31)。[ADR-0009](../adr/0009-ticket-volume-seeding.md) 把凭证定成「per-Job Secret 挂文件 + App 原地续期」，[ADR-0014](../adr/0014-wake-surface-periodic-resync.md) 把它变成「每 Job 每 ~30 分钟 mint 一枚新 token，把 `expires_at` 写进 Secret annotation」。两条都隐含「同一 installation 名下可以有多枚同时有效的 installation token」，而 ADR-0014 自己留了一句：若「mint 新 token 作废旧 token」为真，续期会「续 A 弄挂 B」，per-Job 凭证载体本身要重开。本文把四个事实钉下来。

**方法说明（重要）**：**本轮没有做任何实测**。本机 `gh auth` 用的是 user PAT，PAT 的行为不能证明 installation token 的行为；自签 JWT 真 mint 两枚比对需要 App 私钥，本轮不具备（也没有可用的执行面）。所以下文每条都明确标注是【直接证据】（原文原句）、【解读】（我基于证据的推断）还是【未确认】。原始检索里 Exa 与 Tavily 的摘要在第 2 条上互相矛盾，见「矛盾与来源辨析」。

## 一句话结论

| # | 事实 | 答案 | 证据强度 |
|---|---|---|---|
| 1 | 同一 installation 下多枚 token 能否同时有效 | **能**。文档没有「单枚有效」这类约束；GitHub 自己的 Actions 就是「每个 job 各发一枚、并行 job 的 token 同时有效」 | 直接证据（Actions 文档的 per-job 发币）+ 解读；文档无正面许可句【未确认：无「官方明说不限量」的原句】 |
| 2 | mint 新 token 会不会让该 installation 之前的 token 立刻失效 | **不会**。文档从未这样写，且「吊销」在文档里只有显式动作（`DELETE /installation/token`、卸载/挂起 installation）；新格式 token 是**无状态**的，结构上不存在可被「作废」的中心登记表 | 直接证据（吊销语义原文 + 无状态格式公告）+ 解读；**文档沉默**，无正面否定句【未确认】 |
| 3 | mint 端点是否计入 installation 的 primary rate limit | **文档没有任何一句话把它算进 installation 的桶**；该端点要求用 **JWT**（App 身份）而非 installation token，按文档模型它扣不到「installation access token 的桶」 | 直接证据（端点要求 JWT + 桶定义原文）+ 解读【未确认：JWT 请求自己的桶未文档化】 |
| 4 | `expires_at` 是否恒等于签发时刻 + 60 分钟；`DELETE /installation/token` 吊销范围 | 寿命是「创建起 1 小时」（原句）；**精确到秒的 `+3600s` 未被文档保证**，`expires_at` 应作为唯一真值【未确认】。`DELETE /installation/token` **只吊销调用它的那一枚**（原句），不存在「吊销该 installation 全部 token」的端点 | 直接证据（两处原句） |

**对 ADR-0009 / ADR-0014 的结论：四条事实都不构成推翻「per-Job Secret 挂文件 + 原地续期」的理由，凭证载体不需要重开。** 但有一条**与四问无关、却真实影响实现**的外部变更：2026 年 4 月起 GitHub 把 installation token 的格式换成了无状态的 `ghs_APPID_JWT`，长度从 40 字符变成 ~520 字符（2026-10-02 公告称 rollout 已完成、默认全量）。凡是对 token 长度/形态做假设的地方都不能有（详见「对设计的影响」）。

## 逐条证据

### 1. 并存：多枚能不能同时有效

【直接证据】Actions 的 `GITHUB_TOKEN` 文档（`content/actions/concepts/security/github_token.md`）原句：

> At the start of each workflow job, GitHub automatically creates a unique `GITHUB_TOKEN` secret to use in your workflow. […]
> Before each job begins, GitHub fetches an installation access token for the job. The `GITHUB_TOKEN` expires when the job finishes or after its effective maximum lifetime.

同一 repo 上并行跑 20 个 job，就是对同一个 installation（GitHub Actions app 在該 repo 的 installation）**同时**持有 20 枚 installation token。同一段还写了：

> […] because the `GITHUB_TOKEN` is an installation access token, it can only be refreshed for up to 24 hours.

【解读】「refresh」在这里的实现就是**再 mint 一枚**；如果 mint 会作废此前的 token，那么「长跑 job 刷新自己的 token」和「同一 repo 上并行 job 各持一枚」这两件事都会互相打死——Actions 本身就不成立。这是我能拿到的最强的**行为存在性证明**，虽然它不是一句「多枚可以并存」的许可声明。

【直接证据 · 反面】`DELETE /installation/token` 的文档只吊销「你用来调这个端点的那一枚」（见第 4 条），GitHub 没有提供「列出/吊销某 installation 名下全部 token」的端点；`DELETE /app/installations/{id}` 是卸载，不是吊销 token。【解读】没有枚举面、没有批量吊销面，说明 installation token 不是「每个 installation 一枚、可被替换」的模型。

### 2. 作废：mint 新 token 会不会作废旧 token

【直接证据】创建 token 端点的完整描述（OpenAPI 生成，`POST /app/installations/{installation_id}/access_tokens`，docs.github.com/en/rest/apps/apps）原句包含：

> Creates an installation access token that enables a GitHub App to make authenticated API requests for the app's installation on an organization or individual account. Installation tokens expire one hour from the time you create them. Using an expired token produces a status code of 401 - Unauthorized, and requires creating a new installation token. By default the installation token has access to all repositories that the installation can access.

**整段没有任何一句提到旧 token 会被作废**；它给出的唯一失效原因是「过期 → 401」。

【直接证据】「Token expiration and revocation」页枚举了 token 被吊销的全部原因（到期、被推送到公开仓库、长时间未用、用户撤销授权、第三方通过 credential revocation API 上报、企业管理员批量吊销、OAuth app 的 10 枚上限），**没有任何一条是「同一主体又签发了一枚新 token」**——除了专属于 OAuth app token 的那一条：

> There is a limit of ten tokens that are issued per user/application/scope combination, and a rate limit of ten tokens created per hour. If an application creates more than ten tokens for the same user and the same scopes, GitHub revokes one of the existing tokens with the same user/application/scope combination […]（`data/reusables/apps/oauth-token-limit.md`，挂在「Token revoked due to excess of tokens for an OAuth app with the same scope」小节下）

【解读】这条是 **OAuth token** 的规则，不是 installation token 的；它恰好是检索摘要互相矛盾的根源（见下）。它的存在反过来是**负证据**：GitHub 在确实设置「同类 token 上限 + 超限吊销最旧一枚」的地方，是**明写**出来的；installation token 没有对应段落，最自然的读法是「没有这条规则」。

【直接证据 · 结构性】新 token 格式是**无状态**的（`ghs_APPID_JWT`）：

> We're now supporting a new, stateless token format for GitHub App installation tokens […] The JWT is signed using a GitHub-internal issuer and cannot nor should not be validated by a client app. It contains details about the token such as the target installation, the application, and basic validation details.（2026-04-24 公告）
> The staged rollout of the stateless GitHub App installation token format […] is complete. By default, all newly minted GitHub App installation tokens will be in the stateless `ghs_APPID_JWT` format […] Token permissions, repository scoping, the one-hour expiration, and the installation access token REST API endpoint are unchanged. Tokens minted before the change continue to work until they expire.（2026-10-02 公告）

【解读】无状态 = 签发时不再在服务端写一条「本枚 token 的记录」，验证靠自包含的 JWT。没有中心登记表，就没有「mint 新的一枚时把旧的标记为失效」这个动作可以落地。对**经典有状态**格式我没法用这条论证，但那是历史格式：现在（2026-10 之后）新 mint 的都是无状态。

【综合判断】第 2 条的答案是「不会作废」，置信度**高**；但必须诚实标注：**文档从未正面写过这句话**，这是「文档沉默 + 多条结构性反证」的结论，不是一句可引用的事实陈述【未确认（无正面原句）】。

### 3. 额度：mint 端点是否计入 installation 的 primary rate limit

【直接证据】桶的定义（`data/reusables/rest-api/primary-rate-limit-github-app-installations.md`）原句：

> GitHub Apps authenticating with an installation access token use the installation's minimum rate limit of 5,000 requests per hour. […] the rate limit for the installation will scale with the number of users and repositories. Installations that have more than 20 repositories receive another 50 requests per hour for each repository. […] The rate limit cannot increase beyond 12,500 requests per hour.

即：这个桶的名字叫「**用 installation access token 认证的请求**」。

【直接证据】mint 端点本身**不接受** installation token，原文最后一句：

> You must use a JWT to access this endpoint.

【解读】请求的凭据是 App 的 JWT，不是 installation token，因此按文档模型它**不可能**被记在「installation access token 的桶」上；它（如果计入任何桶）只能落在 App 级别的桶里。

【未确认】① 文档没有定义 JWT（App 身份）请求的 primary 桶，也没有任何一句「mint 免费/不计入」；② 检索中唯一给出「mint 走 app 级/共享节流」说法的是社区讨论 [#196652](https://github.com/orgs/community/discussions/196652)，那篇是**无 GitHub staff 背书的生成式回答**（通篇「does not appear to have documented」），不足以作为证据；③ 有邻近的**已文档化**的 token 签发保护，但性质是「复杂度」不是频率：单次最多列 500 个 repo、按权限×repo 数计算的复杂度上限，超限报 `Too many repositories for installation`（2024-02-22 公告）。

【量级判断 · 解读】即使最坏假设它计入 installation 的 5,000/h 桶：ADR-0014 的形状是每 Job 每 30 分钟一枚 ⇒ 每 Job ≤ 2 次/h，10 个并发 Job 也只有 20 次/h，占 5,000 的 0.4%。**这条事实就算答错，也不会改变设计的可用性**；真正要避免的是「每轮 reconcile 无条件重 mint」（ADR-0014 已明确否掉）那种签发风暴。

### 4. `expires_at` 的真值；`DELETE /installation/token` 的吊销范围

【直接证据】寿命：两处文档同句 —— `data/reusables/apps/generate-installation-access-token.md`「The installation access token will expire after 1 hour.」；`content/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation.md`「The installation access token will expire after 1 hour.」；REST 描述「Installation tokens expire one hour from the time you create them.」

【未确认】「`expires_at == created_at + 3600s` 精确成立」。文档只承诺「1 小时后过期」，没有承诺秒级等值，也没有承诺 `expires_at` 与 `created_at` 的固定差；网络/服务端处理带来的几十毫秒到几秒偏移没有被排除。**正确做法**（ADR-0014 已经是对的）：只读 `expires_at` 当唯一真值、判「剩余 < 30 分钟」，不要自己用 `now + 60min` 推算，也不要用 Secret 的 `creationTimestamp`。

【补充 · 解读】任何一个 *短于* 60 分钟的寿命都会让 30 分钟阈值**更早**触发续期（安全方向）；只有寿命掉到 < 30 分钟才会退化成「每轮都续」——那种情况目前没有任何证据，2026-10-02 公告还明确写了「the one-hour expiration … unchanged」。

【直接证据】吊销范围，`DELETE /installation/token`（docs.github.com/en/rest/apps/installations）原句：

> Revokes the installation token you're using to authenticate as an installation and access this endpoint. Once an installation token is revoked, the token is invalidated and cannot be used. Other endpoints that require the revoked installation token must have a new installation token to work. You can create a new token using the "Create an installation access token for an app" endpoint.

即**只吊销调用者自己那一枚**；文档里也没有「吊销某 installation 全部 token」的端点。旁证：官方 Action `actions/create-github-app-token` 的做法就是「用完显式吊销这一枚」——

> Unless the `skip-token-revoke` input is set to true, the token is revoked in the `post` step of the action, which means it cannot be passed to another job.（README）

【解读】吊销是**逐枚、显式**的动作，不是「换发即吊销」。

## 矛盾与来源辨析

- **第 2 条上 Exa 与 Tavily 的摘要互相矛盾。** Exa 只回引原文（`DELETE /installation/token` 的吊销语义、创建端点的「1 小时后过期」），**没有任何一句谈「mint 会作废旧 token」**；Tavily 则给出「GitHub allows up to 10 active tokens per user/application/scope combination, and if this limit is exceeded, the oldest token should be revoked」并据此暗示「新 token 会顶掉旧 token」。**溯源结论**：Tavily 的这句来自 OAuth app token 的 `data/reusables/apps/oauth-token-limit.md`（上限 10 枚 / 每小时 10 枚，超限吊销同 user/app/scope 组合里最旧的一枚），**与 installation access token 无关**；它引用的社区讨论 [#198354](https://github.com/orgs/community/discussions/198354) 讲的也是 OAuth 的 `max_for_app`。
- **原始文档在两处都沉默。** 创建端点的完整描述、`generating-an-installation-access-token` 与 `authenticating-as-a-github-app-installation` 两页、`rate-limits-for-the-rest-api` 与 `rate-limits-for-github-apps` 两页、`token-expiration-and-revocation` 的吊销原因清单——**没有任何一句**说「mint 新 token 会/不会作废旧 token」，也没有一句说「同一 installation 可/不可持有多枚」。这与 ticket 的既有判断一致。
- **一处质量陷阱**：社区讨论 [#196652](https://github.com/orgs/community/discussions/196652) 在检索里排得很前、结构很漂亮（表格 + 「Recommended Architecture」），但通篇是无署名的生成式回答（「does not appear to have documented」「Likely Behavior Model」），**无 staff 背书**，本文只把它当「文档沉默」的旁证，不当证据。
- **`source_check` 的自动判读不可用**：对「mint 不作废旧 token」这条，工具返回 `unclear (confidence 0.30)`，理由是「automated semantic support or contradiction assessment is unavailable」。也就是说，这条结论的强度完全来自我手工核对的原文，而不是工具的自动判定——这是本轮验证的局限，已如实记录。

## 对设计的影响

**四问的答案都不推翻 ADR-0009 的凭证载体，也不推翻 ADR-0014 的续期形状。**「续 A 弄挂 B」这条风险可以关掉：`renewed=<n>` 的每轮 patch 不会让 pod 里那枚（旧 30 分钟以内、还没过期的）token 失效，因此 **ADR-0014 里「pod 挂载晚 1–1.5 分钟、恰好读到一枚已作废的 token」这个具体失效形状不成立**；剩下的仍是普通的时间竞争（读挂载文件时那份已过期），由 30 分钟阈值 + 1–1.5 分钟同步窗口兜着。

必须**新增**记录、但不属于「重开载体」的一条外部变更：

1. **token 现在是 ~520 字符的无状态 JWT（`ghs_APPID_JWT`），2026-10-02 起默认全量。** 直接后果：① 任何 `ghs_[A-Za-z0-9]{36}` 之类的正则/长度假设都是 bug（公告推荐的兼容正则 `ghs_[A-Za-z0-9\.\-_]{36,}`）；② Secret 里存 520 字符没问题（Secret 上限 1MiB），但**任何把 token 塞进 URL 的地方要复查**——ADR-0009 已经禁止 token 进 remote URL，这条现在更硬：`https://x-access-token:<520字符>@…` 会把 URL 拉到 600+ 字符，经过代理/中间件时有被截断的风险；③ 日志脱敏规则若只匹配旧的 40 字符形态，会漏；④ `git credential.helper` 从挂载文件现读的形态不受影响（文件内容长度无关）。
2. **`expires_at` 只当读来的真值用**（ADR-0014 已经是这样）。不要引入「`created_at` + 60min」的自算，也不要用 `metadata.creationTimestamp`。
3. **不要为第 3 条加任何节流机制**：每 Job 每 30 分钟一枚的签发量在任何桶下都可忽略；要避免的是「每轮无条件重 mint」，ADR-0014 已否掉。
4. **不需要 `DELETE /installation/token`**：App 是唯一写入者、per-Job Secret 随 Job 生灭（ownerReference），多留几枚活到自然过期没有额外风险面；引入显式吊销只会多一个失败模式（吊销后 pod 恰好读文件 push）。

## 未确认 / 缺失的证据

- **没有任何一句官方「多枚可并存」或「mint 不作废旧 token」的正面陈述。** 第 1、2 条的结论建立在：Actions per-job 发币的文档、吊销语义的原文、无状态格式的公告、以及「GitHub 在确有上限处会明写」这条负证据之上。要拿到正面确认，只有两条路：(a) 用 App 私钥真 mint 两枚、比对第一枚是否仍可 `GET /installation/repositories`；(b) 向 GitHub Support 提问并留档。**本轮都没做**。
- **JWT（App 身份）请求自己的 primary 桶未文档化**，因此第 3 条只能是「不计入 installation 的桶（解读）+ 实际量级可忽略」。
- **精确 `+3600s`** 未被承诺；`expires_at` 与 `created_at` 的实测差值分布没有证据。
- **无状态格式下的吊销语义细节**：公告只说「the installation access token REST API endpoint are unchanged」，没有专门说明「无状态 token 被 `DELETE /installation/token` 吊销后如何失效」（是否会写一条吊销名单）。对本设计无影响（我们不吊销），但「吊销只针对调用者那一枚」的结论在无状态格式下是从「端点行为不变」推来的。

## 来源

**primary（文档原文，路径 + 提交）**

- `github/docs` `content/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation.md` @ `0b762b0` — 「The installation access token will expire after 1 hour.」；全文无并存/作废语句
- `github/docs` `data/reusables/apps/generate-installation-access-token.md` @ `737ac95` — 同上；mint 的步骤与 `repositories`/`permissions` 语义
- `github/docs` `data/reusables/rest-api/primary-rate-limit-github-app-installations.md` @ `fcb5246` — installation 桶的定义（5,000/h 起，最高 12,500/h），只描述「用 installation access token 认证的请求」
- `github/docs` `content/rest/using-the-rest-api/rate-limits-for-the-rest-api.md`（main）— 桶的分类；无 JWT 桶、无 mint 例外
- `github/docs` `content/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps.md`（main）— 只指向上面两页，无新信息
- `github/docs` `content/actions/concepts/security/github_token.md` @ `25d85ce` — per-job 发安装 token；「can only be refreshed for up to 24 hours」（第 1、2 条的核心旁证）
- `github/docs` `content/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation.md`（main）— 吊销原因全集；安装 token 无「换发即吊销」
- `github/docs` `data/reusables/apps/oauth-token-limit.md`（main）— 10 枚/组合上限**只针对 OAuth token**（Tavily 矛盾的根源）
- `github/docs` `content/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app.md`（main）— JWT 的 `iat`/`exp` 约束（`exp` ≤ 10 分钟）
- docs.github.com/en/rest/apps/apps — `POST /app/installations/{installation_id}/access_tokens` 完整描述（含「You must use a JWT to access this endpoint」「expire one hour from the time you create them」）
- docs.github.com/en/rest/apps/installations — `DELETE /installation/token` 完整描述（只吊销调用者那一枚）
- github.blog changelog 2026-04-24 / 2026-05-15 / 2026-10-02 — 无状态格式、`X-GitHub-Stateless-S2S-Token` 临时头（2026-11-30 弃用）、rollout 完成与「one-hour expiration unchanged」
- github.blog changelog 2024-02-22 — 签发保护只有「复杂度」上限（500 repo / 权限×repo 数），不是频率上限
- `actions/create-github-app-token` README（main）— 默认在 `post` 步显式吊销当前那一枚；`skip-token-revoke` 可关
- `octokit/auth-app` README — token 缓存到过期、`refresh: true` 强制换新（无「换新即作废旧」的说明）

**deprioritized / rejected**

- 社区讨论 [#196652](https://github.com/orgs/community/discussions/196652) — 生成式回答、无 staff 背书，只当「文档沉默」旁证
- 社区讨论 [#198354](https://github.com/orgs/community/discussions/198354) — OAuth `max_for_app`，与 installation token 无关（却被检索摘要当成答案）
- octokit/auth-app issue #117、Link-/gh-token、aembit 博客、terraform-aws-github-runner PR #5132 — 二手/无关；PR 里的「token mint 撞 rate limit」是第三方自述、未给 headers
- Tavily 对第 3 条的「由 secondary rate limit / abuse detection 治理」结论 — 无一手依据，弃

## 下一步（若要把【未确认】变【已确认】）

1. 用 App 私钥真 mint 两枚（间隔 1 秒），对第一枚调 `GET /installation/repositories`：200 ⇒ 并存成立，直接消掉第 1、2 条的解读成分。顺带记下两次响应的 `created_at`/`expires_at` 差值与 `x-ratelimit-resource`/`x-ratelimit-remaining`（同一次调用就能把第 3、4 条也钉死）。**这需要 App 私钥与出网能力，且属于「实测」，必须真跑过才能写进文档。**
2. 若要长期依据：向 GitHub Support 提一个书面问题（「does minting a new installation access token invalidate previously issued ones for the same installation, and does the mint call consume the installation's primary rate limit?」）并把回复留档。
