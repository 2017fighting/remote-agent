# prompt 必写项清单（v1）

v1 没有 skill 层：durable 没有 Skill 工具、没有 slash command，runner 不扫 skill 目录（[ADR-0004](../adr/0004-prompts-live-in-configmap.md)、[ADR-0008](../adr/0008-durable-runtime-base.md)）。所以 mattpocock 那套里 AFK 必需的语义**全部**得由我们自己钉死，而钉死不等于「塞进 prompt」——[ADR-0007](../adr/0007-run-result-contract.md) 已经证明有些规矩该由工具自述承载。

本清单是 [#16](https://github.com/2017fighting/remote-agent/issues/16) 的结论，前置是 [#8](https://github.com/2017fighting/remote-agent/issues/8)（`/implement`、`/implement-spec`、`code-review`、`pr`、`tdd` 的契约）。消费者：[#14](https://github.com/2017fighting/remote-agent/issues/14)（两份模板初稿）。

## 规矩：只有四类落点

| 落点 | 谁维护 | 能强制到什么程度 |
| --- | --- | --- |
| **角色 prompt**（随 Job 镜像发布的 `prompts/`） | 镜像（事故时可被 `PROMPTS_DIR` 覆盖） | 只靠模型自觉 |
| **工具自述**（镜像里的 durable 工具：`description` / schema） | 镜像 | schema 能拒收，描述能引导 |
| **App**（唯一 GitHub writer，[ADR-0002](../adr/0002-app-is-sole-github-writer.md)） | App 代码 | 能兜底、能补、能校验 |
| **init container / runner** | 镜像 + Job 模板 | 能注入、能不做 |

没有第五类：**不引入 wrapper、辅助命令、skill 加载器**。每条越界都是错——prompt 里写了 App 的活就是两仓漂移，工具里放了下游的决策就是改一句话要重建镜像。

配套一条判据（第 7 条的原则，适用于每一条）：**工具表先行，prompt 只为真实持有的工具写禁令**。镜像里没有 `gh` / `kubectl`、agent 手上没有 token，就不必也不该在 prompt 里禁它们；能由 schema 拒收的，就不由一句叮嘱承载。

`prompts/` 的键（随镜像发布，[ADR-0020](../adr/0020-prompts-travel-with-the-image.md)；键面自 [ADR-0004](../adr/0004-prompts-live-in-configmap.md) 不变）：

- `_common`：所有 role 都拼在最前（第 3、4、8、9、10、11、12 条）
- `implement-ticket`、`implement-spec`：两份角色差异（第 1、5、6 条）
- `review-standards`、`review-spec`：reviewer conversation 的系统提示，两轴各一份（第 2、7 条）

## 十二条

### 1. spec 来源 → `_common` + 两份角色模板

- **为什么必写**：`code-review` 的 spec 查找顺序是 commit message 的 issue 引用 → 参数路径 → `docs|specs|.scratch` 匹配文件 → **问用户**，它**没有** parent/sub-issue 遍历；`/implement` 也是拿到无歧义的 ticket 引用才开工（`implement/SKILL.md:9`）。AFK 下最后一档「问用户」等于卡死。
- **不写会怎样**：reviewer 的 Spec 轴静默跳过并报「no spec available」，整轮「Spec 轴通过」是假的；或模型凭上下文猜错对象，审了别人的活。
- **写什么**：我们是在写叙述，不是真调 skill——review 步骤直接写明「spec 来源 = `<owner/repo>#<n>`」，值由 runner 渲染时注入；并要求每条 commit 标题**沿用目标仓 `git log` 的既有形态**（试点仓 pi-web 是 Conventional Commits 在前、`(#n)` 收尾，如 `fix: … (#1308)`；prompt 不整段复述规则，只要求「照既有形态、带 `(#n>)`」）。commit 的成色是**软约束**：不阻断、不重试，代码与 review 不依赖它（形态由 [#24](https://github.com/2017fighting/remote-agent/issues/24) 拍板）。
- **落点**：prompt（正文与 spec 正文由 **App** 读好、经 Job 参数交给 runner 渲染——模型手上没有 `gh` 与凭证，见 [#14](https://github.com/2017fighting/remote-agent/issues/14)）。

### 2. review 的固定点 → `_common`，值由 runner 注入

- **为什么必写**：`code-review` 只看 `git diff <fixed-point>...HEAD`（三点，对 merge-base），无参数时**问用户**；且它要求先确认 ref 能 resolve、diff 非空，否则在扇出两个 reviewer 之前就失败。
- **不写会怎样**：模型自己猜 `HEAD~3` 或 `main`，Spec 轴审到错的范围；或 diff 为空却两手一摊报 `done`。
- **写什么**：字面值（merge-base sha，或 init container 记录的 baseSha，来源归 [#17](https://github.com/2017fighting/remote-agent/issues/17)）。**取哪个 sha 按 role 分**（[#14](https://github.com/2017fighting/remote-agent/issues/14)）：ticket role 取**本次运行的起点**（每票只审本票的 diff），spec 收尾 role 取**分支起点**；整条分支的覆盖面由 spec 收尾那一次全分支 review 提供。Spec 轴读的 spec 正文同样由 `code_review` 工具注入（A10，[#25](https://github.com/2017fighting/remote-agent/issues/25)）——固定点与 spec 正文同一条注入面。
- **prompt 里不再复述校验**：「ref 解析不开 / diff 为空就先自己处理」这句话删了——`code_review` 在起 reviewer 之前已经 `git rev-parse` 并检查 `<fixed>...HEAD` 非空，坏 ref 直接弹回，模型先做一遍是同一件事说两遍（no-op）。两份 review 模板里的同一句也删了。prompt 只留两条：逐字传、不许为收尾跳过这一轮。
- **落点**：prompt（注入）+ 工具（review 工具自己 `git rev-parse` 与非空校验，坏 ref 直接弹回，不浪费两个 reviewer）。

### 3. 小 bug 的授权 → `_common`（`implement-spec` 收尾段加一句）

- **为什么必写**：`/implement` 与 `code-review` **既不修也不问**（code-review 只报告，`implement` 也不处理它的发现）；只有 `/implement-spec` 有一步「在一个 implementer 里修完 review 发现」。默认行为两边都不符合我们要的。
- **不写会怎样**：要么把「顺手重构」当交付，要么一次运行交回一堆本来可以顺手修的尾巴，人再开一堆票。
- **写什么**：授权**但有边界**——只修落在本次 diff 涉及的代码内、不引新依赖、不改公开接口；出圈就记进 `warnings`（ticket role），spec 收尾 role 可开 `newTickets`。`implement-spec` 收尾段另补一句：review 提出的问题**必须修**，修不动的写进 `newTickets`。
- **落点**：prompt。

### 4. commit 先于 review → `_common`

- **为什么必写**：`implement/SKILL.md:15-17` 的顺序是**先 review 后 commit**，而 code-review 只看 `<fixed>...HEAD`，**排除 staged 与工作区改动**（上游两边都承认且未修）。这是必须**覆盖**的默认行为，不是可选优化。
- **不写会怎样**：reviewer 面对空 diff，两轴都报「没有发现」——假绿，而且假得很安静。
- **写什么**：先 commit（允许拆成多条），再 review 固定点之后的 diff；review 的修复**另起一条 commit**（不 `--amend`，保住「reviewer 当时看了什么」可重现）。push 不在 agent 手上（第 10 条）。
- **落点**：prompt。

### 5. e2e → **不写**

- **为什么必不写**：`/implement-spec`、`/implement`、`code-review`、`tdd`、`pr` 全文 grep `e2e|end-to-end` **零命中**——它不是 skill 能力，是上游没有的东西。`/implement-spec` 的收尾只有：全分支一次 `code-review` → 在一个 implementer 里修完 → PR ready 或关票 → 清 worktree；`/implement` 的验证是「常跑 typecheck 与单文件测试，收尾跑一次全量测试」。
- **写了会怎样**：单 ticket 循环成本翻倍，ticket 阶段的 e2e 失败又归因不到本张票上。
- **决定**：v1 收尾 role 的验证 = 全量测试 + typecheck（仓库 prompt 里点名 lint 就跑），**撤销** [#4](https://github.com/2017fighting/remote-agent/issues/4) 的「收尾 Job 跑 e2e」。代价明写：pi-web 的 `test:e2e` 这次运行没人跑，结果交到 PR 让人看。
- **命令从哪来**：目标仓各不相同，`npm test` 这类猜测会跑错或跑空。`_common` 第 2 步要求先看这个仓库自己的 `package.json` scripts / `Makefile` / CI 配置，用它的命令。
- **落点**：无（这是「不写」条目）；#4 的决策行记着这次撤销，`docs/architecture.md` §3 已按「收尾不跑 e2e」重画。

### 6. PR body 与 `Closes #<spec>` → 工具 + App

- **为什么必写**：`/pr` 只给 body 模板（Summary / Evidence / Merge Danger），**全文没有** `Closes` 约定；而 PR 由 **App** 开（ADR-0002），agent 不可能、也不许自己去开。
- **不写会怎样**：PR 打开却不关票，spec 永远停在 S3；或 agent 去调 `gh pr create`，直接破 ADR-0002。
- **写什么**：run result 增加 `prBody` 字段，只有 spec 收尾 role 的 `finish_spec` 带它，内容按 /pr 三段写；`Closes #<spec>` 由 **App** 追加进 PR body（幂等：已含就不重复加）——它知道 spec 号，模型忘了也不会断。**Evidence 段不要求整份输出**：`prBody` 是一个 JSON 字符串字段，全量日志照抄会把一次收尾变成几千 token 的复制粘贴，所以要求「命令 + 退出码 + 计数 + 失败行」，取输出的头尾，并明写不许把绿跑转述成一句话。
- **落点**：工具（`prBody` 的 schema 与必填）+ App（开 PR 时拼 `Closes`）。角色 prompt 只需说明 `prBody` 要写什么，**不写**「去开 PR」。

### 7. reviewer 的承载与扇出禁令 → 工具 + `review-*` 模板

- **为什么必写**：上游两个 brief **没有**禁止再委派，实测扇出到 50+ 个子 agent 且未修；契约里也没指定 subagent 的 role 名（它只说「parallel sub-agents」）。
- **不写会怎样**：一次运行炸成几十个 conversation，烧钱烧额度，最后没人说得清结论从哪来。
- **写什么**（三处，缺一层都不够）：
  - **工具**：runner 烧一个 `code_review` 工具，起一个**独立 conversation** 的 reviewer（foreground、`replay: "safe"`、独立模型由 runner 给），传固定点与 spec 正文，取回两轴报告。它的工具表是 `read` / `grep` / `bash`——**不给 subagent 工具，也不给 `code_review` 自己**，扇出从工具表上被结构地断掉。（[#14](https://github.com/2017fighting/remote-agent/issues/14) 就地改：reviewer 得自己跑 `git diff` / `git log`，所以它拿到 `bash`；只读靠 prompt 约束，`bash` 本身不打开扇出。）
  - **镜像里的模板**：两轴 brief 写成 `review-standards` / `review-spec` 两份模板（diff 命令与 commit 列表），随 Job 镜像发布（[ADR-0020](../adr/0020-prompts-travel-with-the-image.md)）。改 review 话术要重建镜像——事故时可走 `PROMPTS_DIR` 覆盖。smell baseline 十二条**只住在 `review-standards`**（[#25](https://github.com/2017fighting/remote-agent/issues/25)：Spec 轴用不上它，单份不漂移）；Standards 轴读的 standards 文件清单**不由模板提供**——`code_review` 被调时 runner 扫工作副本得出，候选名表是 runner 代码常量（A17a），扫出的列表作为 `{{standards_files}}` 占位符**在模板内部**替换（不是渲染完再追加：追加会让模板的末行不再是被读到的最后一句）；Spec 轴的 spec 正文由工具注入（A10）。
  - **工具（扇出第二层，[#25](https://github.com/2017fighting/remote-agent/issues/25) A15）**：`code_review` 同一 run 第二次调用直接报错（「review 已跑过：修完就收尾」）——implementer 真正的扇出向量是反复调 review，不只在 reviewer 里开子 agent。implementer 模板**不写**「不要开子 agent」：它的工具表里没有 subagent 工具（[#21](https://github.com/2017fighting/remote-agent/issues/21) 研究证实 durable 无内置），禁令只写进两份 review 模板当保险丝。原则：**工具表先行，prompt 只为真实持有的工具写禁令**。
  - **模板末行**：一句「不要开子 agent、不要改文件」，两轴模板各一遍——reviewer 才是被约束的人。它是**最后一行**，这也是 standards 清单走 `{{standards_files}}` 占位符而不是渲染后追加的原因（追加会把保险丝推到中间）。单测两边都断言。
- **落点**：工具（起 conversation + 工具表裁剪）+ 镜像里的模板（两份 brief）+ prompt（一句禁令，在 review 模板里而不是角色模板里）。

### 8. 承载形态 → 清单开头那条规矩

- **为什么必写**：[ADR-0020](../adr/0020-prompts-travel-with-the-image.md) 把 prompt 放进了镜像（自 [ADR-0004](../adr/0004-prompts-live-in-configmap.md) 的 ConfigMap 让位），但没说清什么不该进 prompt，于是每张票都会有人想往里加一段。
- **不写会怎样**：prompt 越长越像 spec，最后变成第二份真相之源，改名、改契约各改一半。
- **写什么**：四类落点的规矩 + 「没有第五类（wrapper / 辅助命令 / skill 加载器）」+ 「模板里不出现 `/implement`、`/code-review` 这类斜杠命令，步骤摊成流程叙述」（#22：模型眼里根本没有这些东西，写了它会去找不存在的工具）。
- **落点**：规矩本身（本文件开头）。

### 9. 自述 → 工具（三个）+ `_common` 一句

- **为什么必写**：durable 的 `submission.wait()` 只说得清「正常收尾还是没答」，说不清「agent 自判没做完」，而 `blocked` 是状态机的一等公民（ADR-0007）。
- **不写会怎样**：模型把「我做不完」报成 done → App 关票；或把原因塞进 outcome；或中途乱调，让 annotation 变成半成品。
- **写什么**：**三个工具，按 `AGENT_ROLE` 注入，outcome 不在字段里——由「调了哪个工具」决定**：
  - `finish_ticket`：这张 ticket 干完了 → `done`
  - `finish_spec`：整条 spec 干完了、可开 PR，带 `prBody`，可带 `newTickets` → `done`
  - `blocked`：卡住，`summary` 必填 + `commentBody` **必填**（人要知道该改什么）→ `blocked`

  ticket role 注入 `finish_ticket` + `blocked`，spec 收尾 role 注入 `finish_spec` + `blocked`；**agent 无法自述 `error`**，载荷里也没有 `reason`（细分原因归 App 的五条 error 路径）。每个 run 只调一次，工具返回 `control: { terminate: true }`；中断与崩溃不调——那不是终态，pod 会被 k8s 重启并 `resume()`。prompt 只需一句「干完调 `finish_*`、真卡住调 `blocked`，一次运行一次」。
- **`blocked` 的三个条件不重写**：它们住在 `blocked` 工具自己的 `description` 里（第 7 条的原则：工具表先行）。`_common` 原先逐字复述了一遍（~110 词），已改成一句指针 + 唯一需要反默认的那一条「**Hard is not blocked**」——难度不是阻塞，先换一条路。
- **落点**：工具（schema + description，工具名即语义）+ prompt（一句）。

### 10. 不写 + 不做 → `_common`

两栏，缺一栏都会漏：

**不写**（写了就是与别的落点重复，改一处必漂移）：checkout / push `agent/spec-<n>` 的步骤、模型与 thinking 档位、reviewer 的模型、凭证与 token 用法、Ticket PVC 路径与卷布局、durable / storage / k8s / Job / annotation 的任何细节、额度与 frontier 计算、Gate 与 label 状态机。

**不做**（agent 手上就不该有这些通道）：push、开 PR、关票或改 label、调 `gh`、调 `kubectl`。push 由 runner 做，GitHub 写入由 App 做（ADR-0002）。**这一栏不由 prompt 承载**：镜像里只有 git / ca-certificates / ripgrep，没有 `gh`、没有 `kubectl`，token 也不在 agent 手上——写成禁令只是把不该发生的行为再拉进上下文一遍（no-op，且按第 7 条的原则就是错位）。`_common` 只留一句正面表述：「你永不 push，永不碰 PR / issue / label，GitHub 写入由控制面在你报完之后做」。

**唯一的例外写在这里**（[#58](https://github.com/2017fighting/remote-agent/issues/58)）：冲突时 runner 会把**停在冲突上的 rebase** 交给 agent，那一刻工作副本归它——解冲突、`git add`、`GIT_EDITOR=true git rebase --continue`、跑全量测试与 typecheck、用同一个 Result tool 把**整份载荷**再报一次（`finish_spec` 时含必填的 `prBody`，见 `job/src/internal/runner.ts` 的 `conflictHandoffPrompt`）。规矩写死在同一段里：保住对方提交的意图、不许 `--abort` / `--skip` / `-X ours|theirs`、不重跑 `code_review`（那一轮已用掉）、**仍然不 push**。不写成新条目，是因为它只从「不做」这一栏里开一个口子，其余各栏不变。

- **落点**：init container / runner / App。

### 11. tdd 的 seam → `_common`

- **为什么必写**：tdd 规定「**没确认 seam 不许写测试**」并会问用户，而这是 `/implement` 三个提问点之一（另两个是 ticket 引用歧义、code-review 的固定点/spec 来源）。AFK 下没人在线确认。
- **不写会怎样**：模型要么停下来等人（死锁到 `DeadlineExceeded`），要么偷偷按实现细节写测试，review 时没人能对账。
- **写什么**：agent 自己列 seam（公开接口 + 一句「它抓住什么、漏掉什么」），写进首条 commit message 的 body（[#24](https://github.com/2017fighting/remote-agent/issues/24) 拍板：不再「或 summary」二选一）；ticket/spec 正文自带 `## Seams` 就照它。**不**上升成 Gate 条件（不碰 #10 已定的入场门）。
- **落点**：prompt。

### 12. review 之后的复验 → `_common` + `implement-ticket`

- **为什么必写**：review 的修复是**一条新提交**（第 4 条要求不 `--amend`），它不在第 2 步那次全量测试与 typecheck 的覆盖范围内。`implement-spec` 本来就写了「修完再跑一次，收尾证据是第二次输出」，`implement-ticket` 原先没有——同一份骨架在两个 role 上不对称，而缺口朝坏的方向开。
- **不写会怎样**：reviewer 发现的回归被修完直接提交，`commentBody` 里那句「已验证」拿的是修复之前的证据，全量测试与 typecheck 从未跑过分支的最终形态。
- **写什么**：`implement-ticket` 的收尾顺序固定为 commit → 全量测试 + typecheck（先把绿的 branch 交给 reviewer）→ `code_review` → 修 in-scope 发现并**再跑一次** → `finish_ticket`；出圈的进 `warnings`，不进 diff。`_common` 的 Review 一节同样收尾于「跑全量 suite 与 typecheck 一次」。
- **落点**：prompt。

## 两份模板的骨架

`_common`（所有 role 拼在最前）：谁是你（含 `blocked` 一句指针）、工作项与来源、环境已备好（含冲突交接）、流程顺序（先找仓库自己的命令 → commit 先于 review）、范围与小 bug、测试与 seam、收尾 review（固定点 + 调用 `code_review` + 修完复验）、自述（调哪个工具）。

差异部分只有三件事：

| | `implement-ticket` | `implement-spec` |
| --- | --- | --- |
| 手头是什么 | 一张 ticket（正文即验收标准），`Part of #<spec>` 给出 parent | 整条 spec：spec 正文 + 它的 ticket 图，**已全部关票** |
| 收尾 | 走 review → 修完复验 → `finish_ticket` | 走全分支 review → 修完 → `finish_spec`（`prBody` + 可选 `newTickets`）；**不跑 e2e** |
| 自述工具 | `finish_ticket` + `blocked` | `finish_spec` + `blocked` |

## 连带改动

- [ADR-0007](../adr/0007-run-result-contract.md) 就地改：outcome 由工具身份决定、新增 `prBody`、删 `reason`、error 不由 agent 自述。
- [ADR-0004](../adr/0004-prompts-live-in-configmap.md) 就地改：ConfigMap 的键从「同名一份模板」扩到「`_common` + 两份角色 + 两份 review」。
- [ADR-0020](../adr/0020-prompts-travel-with-the-image.md) 新增（ticket [#76](https://github.com/2017fighting/remote-agent/issues/76)，Part of [#75](https://github.com/2017fighting/remote-agent/issues/75)）：prompt 随 Job 镜像发布，runner 从镜像内 canonical 目录读，只留 `PROMPTS_DIR` 一个事故覆盖口子，逐 key 打 `prompt-source=<key>:<image|override>`；本文的载体描述改指它。
- [#4](https://github.com/2017fighting/remote-agent/issues/4) 的「收尾 Job 跑 e2e」撤销；`docs/architecture.md` §3 的 Spec 循环图已按新执行面重画（收尾不跑 e2e，`Closes` 由 App 写进 PR body 而不是 commit）。
- **2026-10-28 模板重写**（第 2、5、6、7、12 条）：`prompts/` 五份模板按本清单重新收一遍——删掉 no-op 禁令（`gh` / `kubectl` / 凭证 / 卷布局在镜像里根本不存在）、删掉与工具自述重复的段落、补上 review 后复验与「先找仓库自己的检查命令」。`{{standards_files}}` 从 runner 侧字符串追加改成模板内占位符（`renderReviewPrompt` 的必填输入），冲突交接的重报补上 `prBody`。量：`_common` 1167 → 956 词，渲染后 1434 → 1170（ticket）、1544 → 1324（spec）。

## 本清单不覆盖

runner 的内部结构（task/phase、工具集、section 拼接方式）留给 spec 阶段的 `/codebase-design`；工作副本与凭证归 [#17](https://github.com/2017fighting/remote-agent/issues/17)；模型与 provider 归 [#20](https://github.com/2017fighting/remote-agent/issues/20)；Job 与卷的预算归 [ADR-0010](../adr/0010-job-resource-budget.md)。
