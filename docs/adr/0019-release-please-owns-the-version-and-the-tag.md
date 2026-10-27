# 版本号、tag 与 GitHub Release 由 release-please 拥有：发版是「点一次按钮」，不是手打 tag

[ticket #67](https://github.com/2017fighting/remote-agent/issues/67)。

到 `v0.7.0` 为止 tag 是手工打的（`git tag v0.7.0 && git push --tags`）。这条路上的三个洞在第一次认真「发一个版本」时会同时露出来：**版本号靠人记**——root `package.json` 停在 `0.1.0`，与最新 tag 差六个版本；**没有 CHANGELOG**——七个 tag 里只有一个发过 GitHub Release，其余六个连 release 都没有；**tag 与镜像的语义靠人维持**——`ci.yml` 的 `push-images` 认 `tags: ["v*"]`，而 tag 什么时候打、打几号，全凭记忆。可这些 commit 本来就是 conventional commits（46 条里 43 条合规），版本推进规则完全可以算出来，不该由人记。

## 决定

- **release-please 拥有版本号、tag 与 GitHub Release**（`googleapis/release-please-action@v5` + `release-please-config.json` + `.release-please-manifest.json`）。**手打 tag 作废**：手工 `v0.8.0` 会绕过版本推进规则、不产生 CHANGELOG，也让 release-please 的下一次计算找不到基线。版本号也不再手改——manifest 与 root `package.json` 的 `version` 都是它的输入。
- **一仓一版本，`node` 策略，版本号落在 root `package.json`**。与 `ci.yml` 里那条既有决定同源（「One tag decision for both images」）：App 镜像与 Job 镜像从来是同一个版本，多包各自发版会让 tag 变成 `app-v0.8.0` 之类，直接绕过触发条件。
- **`include-component-in-tag: false`**：manifest 模式下 tag 默认是 `<component>-v<version>`（即 `remote-agent-v0.8.0`），只有关掉它才是 `v0.8.0`。这不是审美，是 `ci.yml` 的 `tags: ["v*"]` 与七个历史 tag 的形状共同钉死的。
- **tag 由 PAT 创建（`secrets.RELEASE_PLEASE_TOKEN`），不是 `GITHUB_TOKEN`**：用 `GITHUB_TOKEN` 创建的 tag/release **不触发** `on: push: tags` 的工作流，于是 release 出来了、GHCR 上一个新镜像都没有——整条链路静默断在最关键的一步。
- **触发模型：`push main` 维护 release PR，`workflow_dispatch` 合并它**。平时每次合并 PR，release-please 在 main 上更新/创建那条 release PR，所以「下一个版本是几」随时可见；合并几个 PR 之后手动派发一次，那一次 run 把 release PR squash 合并掉（`--squash --delete-branch`）。**打 tag 发生在合并之后的那次 run 里**（合并产生的 push main 触发它）——这不是绕路，而是 release-please 的固有形状：`release-pr` 只开 PR，`release` 才打 tag。**那条 PR 是按 `autorelease: pending` label 找的，不读 action 的 `pr` 输出**：PR 内容未变时 release-please 不报任何 PR（`maybeUpdateExistingPullRequest` 直接返回 `undefined`），而派发时通常正是这个状态（PR 就是同一批 commit 生成的）——读那个输出会让“发版”静默变成“什么都不做”。
- **0.x 期间的版本推进只开 `bump-minor-pre-major`**：fix → patch、feat → minor、BREAKING → minor（不会意外跳 `1.0.0`）。**不开 `bump-patch-for-minor-pre-major`**：那会让一批新功能也只涨一个 patch，版本号就再也说不清「这一版多了什么」。
- **release PR 跳过 `build-images` 与 `kind-e2e`**（`ci.yml` 按 `autorelease: pending` label 判断，分支前缀 `release-please--` 作为兜底）。它只改 `package.json` / `package-lock.json` / `CHANGELOG.md` / manifest，而且是被立即合并的；真正的门禁在合并之后的 **main push** 与 **tag push** 上，两者都跑完整链路（含 45 分钟的 kind e2e），所以镜像的准入一字未松。
- **落地时把 root `package.json` 与 `package-lock.json` 的 version 手动对齐到 `0.7.0`**，与 manifest 一致，让第一次 release PR 的 diff 是干净的 `0.7.0 → 0.7.1`。

## Considered Options

- **继续手打 tag，只加一个 CHANGELOG 生成器**：不要。洞不在 CHANGELOG，在「版本号与 tag 由谁拥有」——只要还能手打，规则就还是人记。
- **用 `GITHUB_TOKEN`，把 `ci.yml` 改成可复用 workflow 由 release run 显式调用**：零长期凭据，但 `ci.yml` 要同时支持两条触发路径并长期保持一致，而「合并 release PR / 建 tag / 发镜像」三件事被拆到两处描述。一个新凭据的代价比这个低。
- **fork `release-please-action` 到自己账号再引用**：只有要改 action 行为时才值得。本地那份 clone 是干净的上游 checkout（`v5.0.0` + 两个未发布提交），没有本地改动，所以直接 `@v5`。
- **只在 `workflow_dispatch` 上跑 release-please**：平时没有 release PR 与分支噪音，但打 tag 需要「合并之后的再一次运行」，于是同一个 job 里要跑两遍 action（开 PR → 合并 → 打 tag）。为省一条常驻 PR 而把固有形状拆成两段，不值。
- **两个 pre-major 开关都开**：feat 也只涨 patch。1.0 之前版本号涨得慢，但「多了功能」这件事在版本号上消失。
- **release PR 用 `gh pr merge --auto` 等检查**：仓库没有任何 required checks、也没有分支保护，`--auto` 实际上也是立即合并，多这一层只是多一个必须去 Settings 打开的开关。
- **补发 `v0.2.0`–`v0.7.0` 那六个缺失的 GitHub Release**：不要。那些 tag 从没发布过，补出来是伪造的历史记录（没有当时的 changelog，也没有对应的发布语义）。release-please 只看 tag、不看 Release，下一次发版之后 Releases 页的 Latest 自然变成正确的那个。

## Consequences

- **一次发版要等两轮完整 CI**：合并 release PR 的 main push 跑一遍（~50 分钟，含 kind e2e），tag push 再跑一遍才把 semver 镜像推上 GHCR。tag 上那次是「重复」的（同一个 commit 刚在 main 上过门），换来的是「镜像只在完整链路上线」这条不变式。
- **tag 不是点按钮那一刻出现的**：顺序是 dispatch run（合并）→ push run（tag + Release）→ `ci.yml` tag run（镜像）。日志要按这个顺序读。
- **多了一个长期凭据**：`secrets.RELEASE_PLEASE_TOKEN`（fine-grained PAT：Contents 读写、Pull requests 读写、Issues 读写）。它过期时症状是「PR 合并了，但没有 tag」——release-please workflow 会直接红。
- **`autorelease: pending` / `autorelease: tagged` 两个 label 是这套机制的零件**：`ci.yml` 用它识别 release PR（分支前缀是兜底），`workflow_dispatch` 用它找到要合并的那条 PR。`pending` 不存在时 release-please 打标是否 422 未经验证——落地时已预先创建，所以这个不确定性被消掉了。
- **`docs/deployment.md` §10 是发版链路的操作面**（哪一步产生什么、要等多久），本 ADR 只记为什么这么定。
