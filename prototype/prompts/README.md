# prototype · v1 prompt 模板定稿（[#14](https://github.com/2017fighting/remote-agent/issues/14) → [#24](https://github.com/2017fighting/remote-agent/issues/24)）

**这是一份 prototype：throwaway，永不 merge。** 它回答一个问题——「v1 的五份 prompt 写出来长什么样」。定下来的东西以文字结论回到 ticket 的 resolution 与 `docs/agents/prompt-checklist.md`，不会以这个目录的形式进入 main。

- 分支：`prototype/prompts`（不进 main，对照 `research/*` 的处理）
- 初稿日期 / clone 基线：`main@8363367`；定稿回写：`main@8ef77ec`（[#24](https://github.com/2017fighting/remote-agent/issues/24)）
- 五份模板 = [ADR-0004](../../docs/adr/0004-prompts-live-in-configmap.md) 里 ConfigMap `remote-agent-prompts` 的五个键，逐条对着 [#16 清单](../../docs/agents/prompt-checklist.md) 的十一条写
- **语言（A1，#24 已定）：五份模板英文；agent 产出（commentBody / prBody / warnings）同英文。** 定稿五份均为英文。

| 文件 | ConfigMap 键 | 拼装方式 |
| --- | --- | --- |
| [`_common.md`](_common.md) | `_common` | 所有 role 都拼在最前 |
| [`implement-ticket.md`](implement-ticket.md) | `implement-ticket` | `_common` + 本文件 |
| [`implement-spec.md`](implement-spec.md) | `implement-spec` | `_common` + 本文件 |
| [`review-standards.md`](review-standards.md) | `review-standards` | reviewer conversation 的系统提示，Standards 轴 |
| [`review-spec.md`](review-spec.md) | `review-spec` | reviewer conversation 的系统提示，Spec 轴 |

## 怎么批注

正文里的行内标记：

- `[P1]`–`[P4]`：**替 agent 预先回答了它本来会问用户的分支**（见「预答图例」），清单第 1、2、11 条要求的位置。
- `[A…]`：批注点编号。#24 之前的行内标记已随定稿清除（正文即定稿）；#25 范围内的标记（A10 / A15 / A17）在两份 review 模板里保留。

## 已定（resolution 汇总）

#14 拍下四条，#24 拍下十条：

| 批注点 | 决定 | 出处 |
| --- | --- | --- |
| A16 reviewer 怎么拿到 diff | reviewer 也拿 `bash`：工具表 = `read` / `grep` / `bash`，只读靠模板约束；无 subagent 工具、无 `code_review` 的结构性拦断不变 | #14 |
| A7 固定点 | ticket role = **本次运行起点**；spec 收尾 role = **分支起点**；整条分支的覆盖面由收尾那次全分支 review 提供 → #17 要记「本次运行起点 sha」 | #14 |
| A2 工作项正文 | **App 取好，经 Job env/参数交给 runner 渲染**（含 `Part of #<spec>` 的 parent 解析） | #14 |
| A9 修完 review | **不再 review**：修完另起 commit → 全量测试 + typecheck → `finish_*`；修订交给 PR 上的人看 | #14 |
| A1 语言 | **英文模板；agent 产出（commentBody / prBody / warnings）同英文**。试点仓 pi-web 是英文公开仓，模板与产出同一语言、与目标仓一致，不维护两套语言约定 | #24 |
| A3 blocked 判据 | **三条正例**（工作项自相矛盾 / 缺只有人能给的决定 / 环境坏到绕不开）＋一句反例「**难 ≠ 卡**：先换路、交付能做的、把处境写进 summary 再继续；难度永不终止运行」 | #24 |
| A4 commit 标题形态 | **Conventional Commits 在前、`(#n)` 收尾**（`fix: … (#1308)`，pi-web 既有习惯）。prompt 只写「按仓库 git log 的既有形态、以 `(#n>)` 收尾」，不整段复述规则 | #24 |
| A5 seam 记录点 | **首条 commit message 的 body**（不再「或 summary」二选一）；正文自带 `## Seams` 就照它 | #24 |
| A6 newTickets 边界 | **维持可开票**（App 代写，ADR-0002 不破）；不收窄成「只开小票」——「小票」是个模型判不准的模糊档位，成色由「正文按能直接开工的 ticket 写」+ PR 上的人兜住 | #24 |
| A8 环境栏 | **维持极简**：现有两段（正面陈述 + 五个不做）已够；不加「不要创建分支」等新禁令——每多一句禁令稀释一分其余义务 | #24 |
| A11 与别的 ticket 界线 | **维持现状**（「别的 ticket 不归你、不回退、不顺手做」）；不加优先级句子——「小 bug = 本次 diff 涉及的代码内」已隐含界线 | #24 |
| A12 spec role 的 ticket 图 | **App 全文渲染**：每张 sub-issue 的标题 + 正文 + **评论按时间序**（评论里有每轮 run 报告与人的修订，正是验收面）。一 spec 一次、token 花得起；不给 agent `gh`——installation token 自带 issues:write 降不了权，只读要新建最小权限凭证，且连破 #14-A2 / 清单第 10 条 / ADR-0002 三处已定 | #24 |
| A13 e2e 不做 | **不写**：整段「没有 e2e 这一步」从 implement-spec 删除。pi-web 的 `test` 只含单测不链 e2e，点名 `test:e2e` 反而指路；「撤销 e2e」的决定已落在 #16 清单第 5 条，不需要 prompt 复述 | #24 |
| A14 prBody 三段 | **详细写法留 implement-spec 模板**；`finish_spec` 工具 schema 只留 `prBody: string` + 一句「按角色模板三段写」。形状归 prompt（改文案不重建镜像），存在性与必填归工具 | #24 |

## 预答图例（P）

| 标记 | 位置 | 替谁回答了什么 | 上游出处 |
| --- | --- | --- | --- |
| `[P1]` | `_common` 手头的工作项 | ticket 引用歧义。正文与 `<owner/repo>#<n>` 都渲染进 prompt，模型没有「猜哪个 issue」的余地 | `implement/SKILL.md:9` |
| `[P2]` | `_common` 测试与 seam | tdd 的「写测试前先与用户确认 seam」。改成「自己列、写进首条 commit body」 | `tdd/SKILL.md:22-24` |
| `[P3]` | `_common` 收尾 review | code-review 的固定点。字面值由 runner/工具注入，模型不许自己挑 ref | `code-review/SKILL.md:19` |
| `[P4]` | `_common` 收尾 review ＋ `review-spec` 输入 | code-review 的 spec 来源。显式给 `owner/repo#n`，因为上游**不遍历** parent/sub-issue | `code-review/SKILL.md:27-32` |

## 渲染与注入契约

模板是静态文本；`{{…}}` 是渲染时被替换的字面值。**渲染结果自包含**：`_common` + 角色模板拼起来，读的人不需要再去看另一份文件。

| 值 | 谁提供 | 进哪份模板 |
| --- | --- | --- |
| `{{work_ref}}` / `{{work_title}}` / `{{work_body}}` | 控制面读 issue 得到（App 是唯一 GitHub writer，读也由它做） | `_common` |
| ticket 图（spec role）：每票标题 + 正文 + 评论全文，时间序 | App 读 sub-issues 与评论后渲染（A12，#24） | `implement-spec`（经 `_common` 的 `{{work_body}}` 之外另注入） |
| `{{fixed_point}}` | merge-base 字面值（ticket role = 本次运行起点；spec role = 分支起点；取值与来源归 #17） | `_common`、两份 `review-*` |
| `{{ticket_number}}` / `{{spec_number}}` | 就是 `{{work_ref}}` 的编号部分 | 角色模板 |
| `{{spec_ref}}` + spec 正文 / standards 清单 | `code_review` 工具起 reviewer conversation 时给（diff 与 commit 列表 reviewer 自己用 `bash` 取，A16） | 两份 `review-*` |
| 模型、thinking 档位、reviewer 模型、凭证、卷布局、分支名 | **不进 prompt**（清单第 10 条），归 #17 / #20 | — |

## 仍开着（[#25](https://github.com/2017fighting/remote-agent/issues/25)）

- **A10** reviewer 的 spec 正文从哪来（工具注入 vs 落文件让 reviewer `read`）
- **A15** implementer 要不要也写「不要开子 agent」（取决于 runner 给 implementer 的工具表）
- **A17** standards 清单谁扫（运行期 vs 静态）＋ smell baseline 十二条的载体（两份重复 vs 第 6 个 ConfigMap 键 vs 镜像）

## 这份 prototype 不覆盖

- runner 的内部结构（task/phase、工具集、section 拼接）——留给 spec 阶段的 `/codebase-design`
- 模型与 thinking 档位、reviewer 的模型（#20）；工作副本播种、凭证、固定点取值（#17）；Job 与卷的预算（#18）；PVC 回收（#19）；Job 何时可删（#23）
