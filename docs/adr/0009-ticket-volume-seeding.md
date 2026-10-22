# Ticket 卷的播种与凭证：全量克隆、`repo/` 与 `state/` 分家、Secret 挂文件续期

v1 没有 Base PVC 与快照，工作副本由 init container 幂等播种进 Ticket PVC，同卷还装着 durable 的 session storage（[ADR-0008](0008-durable-runtime-base.md)）。播种要同时满足三件互相拉扯的事：**push 得出去**（要有目标 ref 的历史）、**review 算得出来**（要有 `merge-base` 与 commit 列表）、**凭证撑得过一小时**（installation token 只有 60 分钟，而崩溃续跑靠的是新 pod）。这张 ADR 记下这三条的具体形态，以及被否掉的、看起来更省的那几条路。

## 硬约束（选型的后果，不是实现细节）

- **全量克隆，不 shallow 不 partial**：`git clone --single-branch --branch agent/spec-<n>` + `git fetch origin main`；分支不存在时从 `origin/main` 起 `-b`。实测 pi-web：全量 `.git` 14MB、`--depth 1` 6.2MB、`--filter=blob:none` 6.9MB——**浅克隆只省约 8MB**，却把 `git merge-base` 变成 `fatal: no merge base`，于是三点 diff 与「本票 commit 列表」都算不出来，而 spec 收尾那一次全分支 review 正需要这两样。`--filter=blob:none` 则让每一次 `git diff` / `log -p` 都按需拉 blob，把 agent 的日常 git 命令变成需要网络与凭证的操作。
- **分支存不存在由 init container 问 git**：`git ls-remote --exit-code --heads origin refs/heads/agent/spec-<n>`。远端是唯一真相；`--exit-code` 的 2（不存在）与 auth/网络失败在退出码上天然分开，直接喂给下面的失败分类。App 不用为它算任何东西，也不用传 merge-base。
- **卷上分家**：`/mnt/agent/repo` 是工作副本，`/mnt/agent/state` 放 durable 的 `session.sqlite`（含 `-wal`/`-shm`）与 `seeded.json`。**`state/` 永远在 git 视野之外**——`git add -A` 提交不进去，`git clean -xfd` 删不掉唯一一份可续跑的历史。runner、主 agent、reviewer conversation 的 cwd 统一 `/mnt/agent/repo`。pod 级 `fsGroup=1000`、两个容器同 uid，git 不会因 root 写过的文件报 dubious ownership。
- **凭证是每 Job 一个 Secret，挂成文件，由 App 续期**：`contents: write`、只覆盖目标 repo 的 installation token 写进 `agent-<repo-slug>-<issue#>-token`，两个容器都当文件挂（**不给 env**，env 不可变且 `kubectl get job -o yaml` 就能看到）。App 在 reconcile 时发现剩余寿命 < 30 分钟就原地更新（剩余寿命读 Secret 上的 `remote-agent/token-expires-at`，[ADR-0014](0014-wake-surface-periodic-resync.md)；Secret 挂载约 1–1.5 分钟生效），runner 在 push 时**现读文件**，不吃 pod 启动时那份。**同一 installation 下多枚 token 可并存、mint 新的不作废旧的**（GitHub 文档对此沉默，但吊销只有显式逐枚动作 `DELETE /installation/token`，且新格式 token 是无状态的，见下一条），所以续 A 不会弄挂 B——这件事的证据在研究票 [#31](https://github.com/2017fighting/remote-agent/issues/31) 与 `research/installation-token-coexistence` 分支。
- **token 形态不参与任何假设**：2026-10-02 起新 mint 的 installation token 是 ~520 字符的无状态 `ghs_APPID_JWT`（不再是 40 字符），权限、repo 收窄、1 小时寿命、签发端点都不变。于是：不写 `ghs_[A-Za-z0-9]{36}` 这类正则或长度检查；日志脸敏不能只匹配 40 字符形态；**token 更不能进 URL**——600+ 字符的 URL 过代理有被截断的风险（挂文件 + `credential.helper` 现读的形态天然满足这一条）。
- **git 的 URL 与身份**：远端用干净的 `https://github.com/<owner>/<repo>.git`，token 不进 `.git/config`、不进 remote URL；每次 git 操作靠 `-c credential.helper=...` 从挂载文件现读。commit 身份是 App 的 bot 身份（`<app-id>+remote-agent[bot]@users.noreply.github.com`），只影响 commit 归属显示。
- **幂等标记 `state/seeded.json`，最后一步原子写**：`{v, repo, branch, seedSha, seededAt}`；存在且与 Job env 一致就**什么都不做**（不 fetch、不碰工作树），未提交改动与 session storage 自然保住。marker 缺失且 `state/` 里没有 session → 判定「半播种」，清 `repo/` 重播；已有 session 或 marker 与 env 不符 → **终态失败交人**，绝不静默重播。
- **失败的五个分类 + 两个退出码 + `podFailurePolicy`**：`auth` / `repo_unreachable` / `ref_missing` / `disk` / `unknown`；可重试的（网络、5xx、429）退 75 吃 `backoffLimit`，不可重试的退 78 并写 `state/seed-error.json`、同时把 `seed-failed kind=... detail=...` 打进容器日志；Job 的 `podFailurePolicy` 对 `containerName: seed, values: [78]` 直接 `FailJob`，于是「仓名写错 / token 失效」几秒内就是终态，而不是被指数退避磨到额度用完。这条要求 `restartPolicy: Never`——也就是说**崩溃 = 新 pod = init container 重跑**，幂等标记因此是硬需求。
- **两个 review 固定点都由 runner 读一次、存进 durable**：ticket role 在渲 prompt 与发第一个模型请求**之前** `git rev-parse HEAD`；spec 收尾 role 存 `git merge-base origin/main HEAD`。值以 durable 文档提交（`defineDoc` + checkpoint），`resume()` 后读到的就是那个已提交的值。崩溃若发生在「读到 HEAD」与「提交文档」之间，因为 agent 尚未开工，重算也不会错。
- **push 先于 annotation**：runner 在结局时 `git push origin HEAD:refs/heads/agent/spec-<n>`，**成功才写 Job annotation**；push 失败就非零退出、不写 annotation，让 k8s 拉起新 pod、`resume()` 到结尾再 push（pod 重试即免费重试），退避耗尽才是 `error(no-result)`。远端已前进（非 FF）不自动 rebase/pull——v1 每 spec 串行，出现即异常。
- **播种只做 git**：不 `npm install`。依赖由 agent 按目标仓库的 AGENTS.md 自己装（收尾的全量测试会自己讨饭吃）。好处是 seed 始终秒级、镜像不绑生态、失败分类不混入「包管理器失败」。
- **PVC 固定 8Gi、不依赖扩容**：实测量级是 `.git` 14MB + 工作树 16MB + `node_modules`（pi-web 的 `package-lock.json` 有 853 个包，含 playwright）0.5–1.5GB + `.next` 几百 MB + durable sqlite 几十 MB。**不能**用 GitHub API 的 `size` 乘系数定容——它只含仓库本身，会系统性低估大头。具体数字与「写满怎么办」归 [ADR-0010](0010-job-resource-budget.md)。

## Considered Options

- **`--depth 1` 播种**：省 8MB，push FF 可行（浅克隆不是 push 的障碍，实测通过），但 `merge-base` 与 commit 列表断掉。补救路是「App 用 compare API 算好 merge-base 再让 init 按 sha 抓」（`git fetch --depth 1 origin <sha>` 在真 GitHub 上可用）+ diff 从三点改两点——多一条 App→GitHub 的调用、多一个必须被注入的值，只为省 8MB。**不划算。**
- **`--filter=blob:none`**：全 commit 图、`merge-base` 可用、`.git` 6.9MB；但 diff 与 `log -p` 变成按需拉 blob，凭证必须留在工作副本里，日常 git 命令从此依赖网络。**拿可靠性换 7MB，不换。**
- **token 进 pod env**：最省事，但 env 不可变 ⇒ 一小时后起来的 pod 永远 push 不出去，与 ADR-0008 的「崩溃 → 新 pod 接着跑」直接冲突；且读 Job 就能拿到一枚可写 token。
- **App 开一条 in-cluster mint 端点**（runner 拿一次性 bearer 现取现用）：寿命问题彻底消失，但要给 App 加一个 HTTP 面与一份鉴权，撞 [ADR-0002](0002-app-is-sole-github-writer.md) 的「只暴露 `/webhook`」。留作以后。
- **原地 reseed（`SEED_MODE` env 或 PVC annotation）**：能让烂卷自救，但 v1 多一个触发源与一条与 [#19](https://github.com/2017fighting/remote-agent/issues/19) 重叠的规则。v1 的恢复手段是「删掉这块 PVC，让 App 重播」。
- **播种时 `npm ci`**：首跑省几分钟、依赖问题早暴露在 seed 分类里；代价是 init container 从「秒级 git」变成「几分钟 + 高峰内存」（要在 #18 里单独给预算），且把镜像锁进 Node 生态。

## Consequences

- **App 的 RBAC 多一类对象**：`secrets create/patch/get/delete`（[#12](https://github.com/2017fighting/remote-agent/issues/12) 的 Role 里没有），因为 per-Job Secret 随 Job 一起生灭。
- **App 需要一个 tick**：续期不是事件驱动的（活跃 Job 不产生事件），所以 [ADR-0001](0001-stateless-reconciler.md) 的 reconcile 除了被 webhook / Job watch 唤醒，还要有一个周期性重排。#2 的「何时被唤醒」要补这一条。→ 已由 [ADR-0014](0014-wake-surface-periodic-resync.md) 收口：三条唤醒源、5 分钟一轮、单飞 + 深度 1、失败的轮不自排。
- **`backoffLimit` 的语义变清晰**：`podFailurePolicy` 强制 `restartPolicy: Never`，所以 pod 层没有「原地重启」，每次崩溃都是一个新 pod、init container 都要重跑一次（靠 marker 跳过）。crash-loop 的上界仍是 `backoffLimit`（v1 取 4，见 [ADR-0010](0010-job-resource-budget.md)）。
- **App 的证据评论靠 pod 状态与日志**：App 没有 `pods/exec`，读不到卷上的 `state/seed-error.json`；它读 `initContainerStatuses[].state.terminated.exitCode` 与容器日志（`pods/log get` 已有）。文件是留给「人挂上卷看现场」的。
- **prompt 一行都不用写这些**：checkout / push / 凭证 / 卷路径 / review 固定点的来源，全在 init container、runner 与工具里（[prompt 清单](../agents/prompt-checklist.md) 第 10 条已把这类写成「不写」）。清单第 2 条的 `git diff <fixed>...HEAD` 三点写法**不需要改**——全量克隆下两个 role 的固定点都是本地真实祖先。
- **每张票的卷都要重新装一遍依赖**：只占时间不占错（装载失败归 agent 的 `error`）。共享依赖缓存是以后的事。
