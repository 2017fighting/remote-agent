# mattpocock-skills 的 `/implement` 与 `/implement-spec` 契约

研究票：2017fighting/remote-agent#8
方法：只读 primary source。逐份读 `SKILL.md` 与其直接引用的文件原文，不采信 README/二手转述。
证据标注：**[直接证据]** = 原文引用 + 路径:行号；**[解读]** = 对原文的翻译/归纳；**[推断]** = 由证据外推、原文没直说；**[未确认]** = 现有 primary source 查不到。

## 0. Source inventory（本地 clone 的精确版本）

| 来源 | 路径（相对 `/root/clone/mattpocock-skills`） | 用途 |
| --- | --- | --- |
| repo HEAD | `49dd158 wizard: template fixes (#1237)` | 固定所有行号 |
| `/implement` 契约 | `skills/engineering/implement/SKILL.md` | 主证据 |
| `/implement-spec` 契约 | `skills/engineering/implement-spec/SKILL.md` | 主证据 |
| `/code-review` 契约 | `skills/engineering/code-review/SKILL.md` | 主证据 |
| `/tdd` 契约 | `skills/engineering/tdd/SKILL.md`、`tests.md`、`mocking.md` | 主证据 |
| `/pr` 契约 | `skills/engineering/pr/SKILL.md` | 主证据 |
| 一手说明文（同 repo 作者文档，非 SKILL 契约） | `docs/engineering/implement.md`、`implement-spec.md`、`code-review.md` | 补充「已知 bug / 设计意图」，单独标注 |
| tracker 约定 | `skills/engineering/setup-matt-pocock-skills/SKILL.md` + 本项目 `docs/agents/issue-tracker.md` | 关闭 ticket 的方式 |

`skills/engineering/implement/` 与 `implement-spec/` 目录下除 `SKILL.md` 外只有 `agents/openai.yaml`（展示名/隐式调用开关），无 `references/`。`code-review/` 无 references。`tdd/` 有 `tests.md`、`mocking.md`。`pr/` 有 `CREDITS.md`。这是这几份 skill 的全部文件（`find` 枚举确认）。

---

## 1. `/implement` 需要什么输入、在哪几步会问用户

### 1.1 输入

**[直接证据]** `skills/engineering/implement/SKILL.md:7`：「Implement the work described by the user in the spec or tickets.」
**[直接证据]** 同文件 `:9`：「If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.」
**[直接证据]** 同文件 `:17`：「Commit your work to the current branch.」

**[解读]** `/implement` 的输入只有两类：
1. 用户消息里描述的工作 / 一个 ticket 引用（issue 号、URL 等）；
2. 当前所在分支（它不接收、也不创建 base 分支参数）。

**[直接证据]** `docs/engineering/implement.md:27`：「`implement` commits to the branch you are on. It does not create one, and it does not ask.」

**[解读]** 所以「base 分支」**不是** `/implement` 的输入参数。skill 契约里根本没有「问 base 分支」这一步；它默认调用者已经在正确的分支上。想控制 base 分支只能靠调用前把 HEAD 切好。

### 1.2 会问用户的地方

`/implement` 自己的 SKILL.md 里只有 **1 个显式提问分支**：

**[直接证据]** `implement/SKILL.md:9`：ticket 引用**有歧义**时问。其余不问。
**[直接证据]** `docs/engineering/implement.md:5`：「It never reopens the plan. There is no interview, no clarifying round, no proposal of a different approach.」

但它**内部调用两个会问的子 skill**：

- **`tdd`（提问）** — `implement/SKILL.md:11` 调 tdd。tdd 规定：
  **[直接证据]** `tdd/SKILL.md:22`：「**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam.」
  **[直接证据]** `tdd/SKILL.md:24`：「Ask: "What's the public interface, and which seams should we test?"」
  **[直接证据]** `docs/engineering/implement.md:45`：「Nothing inside `implement` agrees the seams. `tdd` is the skill that asks, and it refuses to write a test at an unconfirmed seam.」
- **`code-review`（提问）** — `implement/SKILL.md:15` 在收尾时调 code-review，而 code-review 有两处提问：
  **[直接证据]** `code-review/SKILL.md:19`：固定点（fixed point）没给就「ask for it」。
  **[直接证据]** `code-review/SKILL.md:32`：找不到 spec 来源就「ask the user where the spec is」。

**[解读]** `/implement` 一轮的提问点共 3 个：① ticket 引用歧义；② tdd 的 seam 未预先约定；③ code-review 的固定点 / spec 来源缺失。AFK 场景下这 3 个都必须在 prompt 里预先回答。

**[直接证据]** `docs/engineering/implement.md:47` 明确说 seam 的约定「happens either upstream in the spec, or in the first exchange of the run」——即把 seam 写进 spec/ticket 就能掐掉这个提问。

---

## 2. 怎么找 parent issue 当 spec 来源、怎么配 reviewer subagent、两轴 review 的 seam 从哪读

### 2.1 spec 来源的查找顺序（code-review）

**[直接证据]** `code-review/SKILL.md:27-32`，按此顺序：
1. commit message 里的 issue 引用（`#123`、`Closes #45`、GitLab `!67`），经 tracker doc 的工作流去 fetch；
2. 用户作为参数传入的路径；
3. `docs/`、`specs/`、`.scratch/` 下与分支名/特性名匹配的 spec 文件；
4. 都没有 → 问用户；用户说没有 → Spec 轴跳过并报「no spec available」。

**[解读]** **skill 契约里没有「找 parent issue」这一步。** 它靠 **commit message 里的 issue 引用**回指 spec，而不是靠 GitHub 的 sub-issue / parent 关系去遍历。
**[推断]** 本项目 README 要求「spec 来源是 parent issue」，若要满足，必须在 prompt 里显式把 parent issue 号/内容喂给 code-review，或保证 commit message 带 `#<spec>`（后者正好命中查找顺序第 1 条）。**仅靠 sub-issue 关系、commit message 又不带 spec 号，skill 找不到 spec。**

### 2.2 reviewer subagent 与 pi-subagents 的 role 名

**[直接证据]** `code-review/SKILL.md:11`：「Both axes run as **parallel sub-agents**」；`:58-60`：「Issue both sub-agent calls together, in the foreground」。
**[直接证据]** 全文（`nl -ba` 逐行核对）**没有出现任何 subagent 角色名**：没有 `reviewer`、没有 `worker`、没有 Claude Code 的 `Task`/`Agent` 具体名。
**[解读]** 该 skill 是 **harness-neutral** 的：它只说「spawn sub-agents」，具体用哪个 agent 由 harness 决定。所以 **pi-subagents 的 `reviewer` role 名不是这个 skill 规定的**。
**[直接证据]** pi-subagents 内置 agent 确实存在同名 `reviewer`：`/root/.pi/agent/npm/node_modules/pi-subagents/agents/reviewer.md`（frontmatter `name: reviewer`，`tools: read, grep, find, ls, watchdog_diff, contact_supervisor`，`acceptanceRole: read-only`）。pi-subagents 文档也把 `reviewer` 列为「Review specialist」内置 agent（`.../skills/pi-subagents/references/prompting-and-roles.md`，Builtin Agents 表）。
**[推断]** 本项目要「用 subagent 的 reviewer agent」，落点应是 **pi-subagents 内置 `reviewer`**（read-only，天然适合两轴 review），而不是 mattpocock 契约里的名字——因为契约里没有名字。这条属于项目自己的配置决定。

**[直接证据]（已知 AFK 风险）** `docs/engineering/code-review.md:61`：Standards/Spec 两个 sub-agent 的 brief **没有禁止再委派**，sub-agent 可能再次触发 `/code-review` 并扇出，实测有报到 50+ agents 的案例，且**尚未修复**；社区补丁是往两个 brief 各加一句「Do not invoke `/code-review` or spawn additional agents」。**[解读]** 无人值守跑 code-review 必须自己加这条 guard。

### 2.3 「两轴 review 的 seam 从哪读」

**[解读]** 这里要拆开两个概念，因为契约里它们不在同一个 skill：
- **seam** 是 **tdd** 的词：「A **seam** is the public boundary you test at」（`tdd/SKILL.md:20`），由 tdd 在写测试前**与用户确认**（`tdd/SKILL.md:22-24`）。code-review 里**没有** seam 概念。
- **code-review 的输入边界**由三步定：固定点（用户给，`code-review/SKILL.md:19`）、spec 来源（`:27-32`）、standards 来源（`:34-41`，含 12 条 Fowler smell baseline）。

**[解读]** 因此「两轴 review 的 seam」若指 review 的比较基准，那就是 **固定点**：`git diff <fixed-point>...HEAD`（`code-review/SKILL.md:21`）。若指「测试 seam」，那来自 **tdd / spec**，与 review 无关。本票问题把两者混用；落 prompt 时建议分别处理：review 的固定点写死，测试 seam 写进 spec/ticket。

---

## 3. `/implement-spec` 的 task graph 与 frontier 怎么算、是否自带「不提问」路径

### 3.1 task graph 与 frontier

**[直接证据]** `implement-spec/SKILL.md:13`：「The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.」
**[直接证据]** `:21` step 1「Read the spec and tickets to understand the task graph.」
**[直接证据]** `:34` step 6：「If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets.」

**[解读]** SKILL.md **没有给出 frontier 的计算算法**。它把 frontier 定义为「blocking 关系已满足、可被抓取的 ticket 集合」，由 tracker 的 blocking 边（`to-tickets` 写、GitHub 用 native dependency）决定。
**[直接证据]** `to-tickets/SKILL.md`（步骤 3）规定每个 ticket 声明 **blocking edges**，无 blocker 即可立即开始。
**[直接证据]（已知 bug）** `docs/engineering/implement-spec.md:58-60`：GitHub 上 **blocked-by 计数只在 blocker *close* 时才下降**，而 ticket 通常在 PR merge 时才 close（run 末尾）；于是「blocker 已 merge 但 ticket 永不启动」。建议：让 orchestrator **自己记录哪些 ticket 已 merge 进 integration branch，并据此算 frontier**。

**[推断]** 本项目「每 spec 串行单写者 + 由 App 重算 frontier」的设计，恰好绕开这个已知 bug：frontier 由 App 在 GitHub 上算（README「如何找 spec 当前 frontier ticket」：list then open children，drop 有 open blocker / assignee / `agent:*` label 的，first wins），而不是靠 `/implement-spec` 内部并发算。

### 3.2 是否自带「不提问」路径

**[直接证据]** `implement-spec/SKILL.md` 全文（`:1-40` 逐行核对）**没有任何 `ask` / `question` / `confirm` 步骤**。唯一与用户相关的句子是 `:9`「tracker 没配就告诉用户去跑 `/setup-matt-pocock-skills`」和 `:25`「tracker 通过 PR 关闭工作、或用户要求时，开 draft PR」。
**[直接证据]** `docs/engineering/implement-spec.md:40`：启动方式是「clear the context and type `/implement-spec` with a pointer to the spec (an issue number or a file path)」。
**[解读]** 结构上它**没有提问分支**，可以理解成「自带不提问路径」；但它**不是被设计成 AFK 的**：
**[直接证据]** `docs/engineering/implement-spec.md:64`：「For work that is truly AFK, a deterministic loop (Sandcastle, a shell script, a CI job) is faster, cheaper, and more reliable, because no agent makes the orchestration decisions.」
**[解读]** 作者明确推荐真 AFK 用确定性循环，而不是 `/implement-spec`。本项目把 `/implement-spec` 塞进 AFK Job，是在用「结构上不提问」这一点，而非官方 AFK 路径。

**[直接证据]** 输入 = **spec 指针（issue 号或文件路径）**（`:7`、`docs/engineering/implement-spec.md:40`）。integration branch 由它 step 3 自己创建（`:25`）。base 分支同样不是输入参数。

---

## 4. AFK 下必须预先掐掉的四点，分别落在契约的哪个位置

> 前提：prompt 模板（issue #14）尚未写。本节回答「每个提问/行为在契约里的源头在哪」，即 prompt 必须瞄准的位置。

### ① issue 号

- **源头**：`implement/SKILL.md:9` —— ticket 引用有歧义就问。
- **掐法**：调用时传**无歧义**的引用（`/implement #<n>`，最好 `owner/repo#<n>` 或完整 URL）。**[直接证据]** `docs/engineering/implement.md:75`：「passing the issue URL or `owner/repo#2` removes the ambiguity entirely.」并会「state its title before starting」可当校验点。
- **[推断]** 只传裸 `#<n>` 在长上下文里可能被解析到别的编号列表（`docs/engineering/implement.md:73` 记录了「worked on something completely unrelated」的真实事故），所以 prompt 里应带 repo 前缀或 URL。

### ② base 分支

- **源头**：`/implement` **没有** base 分支提问（`docs/engineering/implement.md:27`「It does not create one, and it does not ask.」）。真正需要 base 分支的是 **code-review 的固定点**（`code-review/SKILL.md:19`）。
- **掐法**：Job 在调用 `/implement` 前把 worktree 切到 `agent/spec-<n>`；调用 code-review 时**显式传固定点**（base 分支 / branch point），否则它会问（`:19`）。
- **[推断]** 本项目 README 写的「base 分支是 `agent/spec-<spec-issue-number>`」对应的是 **Job 的 cwd/HEAD 准备** + **code-review 固定点**，不是 `/implement` 的参数。

### ③ 先 commit 再 review

- **源头（这是契约的缺陷点）**：`implement/SKILL.md:15-17` 的顺序是 **先 code-review、后 commit**；而 code-review 只看 `git diff <fixed-point>...HEAD`（`code-review/SKILL.md:21`），**排除 staged 与 working-tree 改动**。
- **[直接证据]** `docs/engineering/implement.md:65`：「`implement` runs it before committing, so unless an interim commit already exists there is nothing in that diff to review... Commit first, then review against the point you branched from.」
- **[直接证据]** `docs/engineering/code-review.md:81`：同义，且「Multiple people have reported this and it is unfixed on both sides.」
- **掐法**：prompt 必须**覆盖 skill 的默认顺序**：先本地 commit，再让 reviewer subagent 做两轴 review（或让 review 在 commit 后单独一轮跑）。

### ④ 小 bug 直接修，不用问

- **源头**：`/implement` 与 code-review **都没有「发现小 bug 要不要问」这一步**。
  - code-review 只**报告**，不修：`code-review/SKILL.md:76-80`（aggregate + 输出两轴报告），无 fix 步骤。
  - `implement` 收尾**不处理** review 的发现：`docs/engineering/implement.md:53`「It also does not act on the findings `code-review` produced」。
  - 只有 `/implement-spec` 有「修 review 发现」步骤：`implement-spec/SKILL.md:36`「Fix all issues raised by the code review in a single **implementer subagent**.」
- **掐法**：prompt 必须显式授权「小 bug 直接修，不提问」，因为契约默认既不修也不问。真正阻塞时改走 `agent:blocked`（这是本项目语义，非 skill 语义）。
- **[直接证据]（相关）** `implement` 没有完成动作：`docs/engineering/implement.md:53`「`implement` has no completion step. It ends at the commit and never touches the work item.」——所以「close issue」也必须在 prompt/Job 里另外安排。

---

## 5. e2e 验证在 `/implement-spec` 里是强制的还是可选的

**[直接证据]** 在 `implement-spec/SKILL.md`、`implement/SKILL.md`、`code-review/SKILL.md`、`tdd/*.md`、`pr/SKILL.md` 以及三份 `docs/engineering/*.md` 中，`grep -rni "e2e|end-to-end|end to end"` **零命中**（exit 1）。

**[解读]** `/implement-spec` **没有 e2e 步骤**，既非强制也非可选——它是**缺席的**。skill 里与验证相关的只有：
- 每个 implementer subagent 跑 **`tdd`**（`implement-spec/SKILL.md:29`）；
- 全 spec 完成后跑一次 **`code-review`**（`:36`）。

**[直接证据]** `tdd` 的测试是 seam 上的 **integration-style** 测试（`tdd/tests.md`「Good Tests: Integration-style: Test through real interfaces」），但这不等于独立的 e2e 阶段。

**[推断]** 本项目 README「implement Spec prompt → e2e 验证」是**项目自己新增**的收尾要求，不是 `/implement-spec` 提供的。若要让 AFK Job 跑 e2e，必须在 prompt/Job 里显式加，不能指望 skill。

---

## 6. 对本票 5 个编号子问题的直接回答（浓缩）

1. **`/implement` 输入 & 提问点**：输入 = 用户描述的工作或一个 ticket 引用 + 当前分支；**base 分支不是输入参数，也不问**（`implement/SKILL.md:7,17`；`docs/engineering/implement.md:27`）。提问点 3 个：ticket 引用歧义（`implement/SKILL.md:9`）、tdd 的 seam 未约定（`tdd/SKILL.md:22-24`）、code-review 的固定点/spec 来源缺失（`code-review/SKILL.md:19,32`）。
2. **spec 来源 / reviewer / 两轴 seam**：spec 来源按 commit message 的 issue 引用 → 参数路径 → `docs|specs|.scratch` 匹配文件 → 问用户（`code-review/SKILL.md:27-32`）；**没有遍历 parent/sub-issue 的逻辑**。reviewer subagent **契约里不指定 role 名**（只说 parallel sub-agents，`:11,58`）；pi-subagents 有内置 `reviewer`，但那是 harness/项目侧的选择。「seam」是 tdd 词，review 侧对应的是**固定点**（`:21`）。
3. **task graph / frontier / 不提问**：tickets 是带 blocking 边的 task graph，frontier = blockers 全满足的可抓取集（`implement-spec/SKILL.md:13,34`），**无计算算法**，靠 tracker；GitHub 上因「close 才降计数」而 stale（`docs/engineering/implement-spec.md:58-60`）。skill **没有提问步骤**，可当「不提问路径」，但作者建议真 AFK 用确定性循环（`docs/engineering/implement-spec.md:64`）。
4. **四点掐法位置**：① issue 号 → `implement/SKILL.md:9`，传无歧义引用；② base 分支 → 不是 `/implement` 输入，落在 **code-review 固定点**（`code-review/SKILL.md:19`）+ Job 的 HEAD 准备；③ 先 commit 再 review → 必须**覆盖** `implement/SKILL.md:15-17` 的顺序（`docs/engineering/implement.md:65`）；④ 小 bug 直接修 → 契约**默认不修**（`docs/engineering/implement.md:53`），需 prompt 显式授权；另注意 `implement` **无 close 动作**。
5. **e2e**：`/implement-spec` **没有 e2e 步骤**（全库 grep 零命中），必须由项目 prompt 自行加。

---

## 7. 缺口 / 未确认（绝不猜测）

- **[未确认]** 这些 SKILL.md 是 **harness-neutral** 文本，未说明在 **pi** 上 `Skill tool` / sub-agent 如何映射；pi 是否能像 Claude Code 那样「Skill tool with tdd」、是否支持 worktree 并行 subagent，**本地 primary source 未确认**。pi-subagents 的 `worker`/`reviewer` 与 mattpocock 的「implementer subagent / parallel sub-agents」如何对接，也**未确认**（契约没说名字）。
- **[未确认]** `/implement-spec` 在**单写者、无并发 subagent** 的 harness 上是否仍可用（`docs/engineering/implement-spec.md:44` 说「on a harness that runs subagents one at a time, it is only a slower `implement`」；但未确认 pi Job 的并发形态）。
- **[未确认]** 「e2e 验证」在本项目里的具体命令/判定标准：skill 无，README 也未定义。
- **[未确认]** `Closes #<spec>` 的自动关闭：`pr/SKILL.md` 只给 PR **body 模板**（Summary / Evidence / Merge Danger），**完全没有** `Closes` 约定；`Closes` 是 GitHub 平台行为 + 本项目 README 的自定要求，不是 skill 契约。
- **[未确认]** 上游是否另有 pi 适配分支或 `pi/` 变体：本地 clone 未见（`find` 枚举 `skills/` 全部文件），未查远端历史。

## 8. 对本项目设计的影响（解读/推断，非事实）

- **[推断]** `/implement` 的默认 review 顺序（先 review 后 commit）与本项目「先本地 commit 再 reviewer」直接冲突，**prompt 必须显式改写顺序**，否则 code-review 会看到空 diff 或漏掉未提交改动。
- **[推断]** 若把 spec 的 parent issue 当 review 的 Spec 来源，必须让 code-review 能命中它的查找顺序——最稳的是 commit message 带 `#<spec>`，或在 prompt 里直接把 parent issue 内容作为参数喂入。
- **[推断]** `/implement` 无 close 动作、`/implement-spec` 的 frontier 依赖 tracker，这两点决定了 **close issue / 重算 frontier 必须由 App 或 Job 包装层做**，与 README 的「App 是唯一 writer」一致。
- **[推断]** 无人值守跑 code-review 需自加「禁止 sub-agent 再委派」的 guard（上游未修）。
