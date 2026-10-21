# prototype · v1 prompt 模板初稿（[#14](https://github.com/2017fighting/remote-agent/issues/14)）

**这是一份 prototype：throwaway，永不 merge。** 它只回答一个问题——「v1 的五份 prompt 写出来长什么样、还缺哪些决定」。定下来的东西会以文字结论回到 #14 的 resolution 与 `docs/agents/prompt-checklist.md`，不会以这个目录的形式进入 main。

- 分支：`prototype/prompts`（不进 main，对照 `research/*` 的处理）
- 初稿日期 / clone 基线：`main@8363367`
- 五份模板 = [ADR-0004](../../docs/adr/0004-prompts-live-in-configmap.md) 里 ConfigMap `remote-agent-prompts` 的五个键，逐条对着 [#16 清单](../../docs/agents/prompt-checklist.md) 的十一条写

| 文件 | ConfigMap 键 | 拼装方式 |
| --- | --- | --- |
| [`_common.md`](_common.md) | `_common` | 所有 role 都拼在最前 |
| [`implement-ticket.md`](implement-ticket.md) | `implement-ticket` | `_common` + 本文件 |
| [`implement-spec.md`](implement-spec.md) | `implement-spec` | `_common` + 本文件 |
| [`review-standards.md`](review-standards.md) | `review-standards` | reviewer conversation 的系统提示，Standards 轴 |
| [`review-spec.md`](review-spec.md) | `review-spec` | reviewer conversation 的系统提示，Spec 轴 |

## 怎么批注

正文里有两类行内标记，直接对着那一行回话就行（在本票评论里贴行号 + 一句话，或者把整段改好贴回来）：

- `[P1]`–`[P4]`：**替 agent 预先回答了它本来会问用户的分支**（见下「预答图例」）。这些不是问题，是清单第 1、2、11 条要求的位置，扫一眼确认落对了地方。
- `[A…]`：**这张票还没定的分叉**（A1 是整份文件级的——语言——不落行内标记），每条在下面「批注点」里给了问题、草稿的选择、备选。

## 预答图例（P）

| 标记 | 位置 | 替谁回答了什么 | 上游出处 |
| --- | --- | --- | --- |
| `[P1]` | `_common` 手头的工作项 | ticket 引用歧义。正文与 `<owner/repo>#<n>` 都渲染进 prompt，模型没有「猜哪个 issue」的余地 | `implement/SKILL.md:9` |
| `[P2]` | `_common` 测试与 seam | tdd 的「写测试前先与用户确认 seam」。改成「自己列、写进首条 commit body」 | `tdd/SKILL.md:22-24` |
| `[P3]` | `_common` 收尾 review | code-review 的固定点。字面值由 runner/工具注入，模型不许自己挑 ref | `code-review/SKILL.md:19` |
| `[P4]` | `_common` 收尾 review ＋ `review-spec` 输入 | code-review 的 spec 来源。显式给 `owner/repo#n`，因为上游**不遍历 parent/sub-issue** | `code-review/SKILL.md:27-32` |

## 渲染与注入契约（草稿的假设，见 A2）

模板是静态文本；`{{…}}` 是渲染时被替换的字面值。**渲染结果自包含**：`_common` + 角色模板拼起来，读的人不需要再去看另一份文件。

| 值 | 谁提供 | 进哪份模板 |
| --- | --- | --- |
| `{{work_ref}}` / `{{work_title}}` / `{{work_body}}` | 控制面读 issue 得到（App 是唯一 GitHub writer，读也由它做） | `_common` |
| `{{fixed_point}}` | 分支起点的 merge-base 字面值（取值与来源归 [#17](https://github.com/2017fighting/remote-agent/issues/17)） | `_common`、两份 `review-*` |
| `{{ticket_number}}` / `{{spec_number}}` | 就是 `{{work_ref}}` 的编号部分 | 角色模板 |
| `{{spec_ref}}` + spec 正文 / standards 清单 / diff 与 commit 列表 | `code_review` 工具在起 reviewer conversation 时给 | 两份 `review-*` |
| 模型、thinking 档位、reviewer 模型、凭证、卷布局、分支名 | **不进 prompt**（清单第 10 条），归 [#17](https://github.com/2017fighting/remote-agent/issues/17) / [#20](https://github.com/2017fighting/remote-agent/issues/20) | — |

## 批注点（A）

**A1 · 语言。** 草稿是中文。备选：英文（目标 repo 的代码、commit、工具输出都是英文），或「模板英文、`commentBody` 中文」。模型对英文指令的遵从度通常更稳，但批注与改 prompt 的人要读英文。

**A2 · 注入边界：谁把工作项正文交给模型。** AGENT_ROLE 的角色 prompt 里，模型既没有 `gh` 也没有 GitHub 凭证（清单第 10 条），所以正文只能由外面推进去。草稿假设「App 读 issue → 交给 runner 渲染」。备选：(a) App 把正文塞进 Job env / Job 参数；(b) init container 顺手取正文落到 PVC，runner 读文件；(c) 给 runner 一个只读 installation token 自己去读。这条同时决定 #17 的 init container 要不要知道 issue 正文，以及 ConfigMap 里到底哪些是静态文本。（顺带：这也意味着 App 必须把 `Part of #<spec>` 的 parent 一并解析出来，否则 `[P4]` 的 spec 指针渲染不出来。）

**A3 · 「绝不提问」的强度与 `blocked` 判据。** 草稿写了「绝不提问」＋「真做不下去调 `blocked`」，但没给「什么叫真做不下去」的例子。要不要补三条判据（工作项自相矛盾 / 缺只有人能给的决定 / 环境坏到做不了），还是留白靠模型判断？留白会让 `blocked` 时多时少；写死会让模型把「难」误报成「卡」。

**A4 · commit message。** 草稿要求「标题以 `#<n>` 开头」，因为 code-review 的第一查找顺序是 commit message 的 issue 引用。备选：`fix: … #123`（Conventional Commits 在前）或 `#123 fix: …`。软约束、不阻断、不重试——但**选哪个形态**会决定 `[P4]` 以外的兜底能不能命中。

**A5 · seam 记在哪。** 草稿选了「首条 commit message 的 body，或者 `summary`」。备选：写进 ticket 正文的 `## Seams`（人先给，模型照做）。前者零人工成本但事后才看得见；后者更好审，但要求每张票都先被写一遍 seam。清单第 11 条只要求「不上升成 Gate 条件」。

**A6 · 小 bug 的边界。** 草稿的范围是「本次改动涉及的代码 + 不引新依赖 + 不改公开接口」，出圈进 `warnings`（ticket）或 `newTickets`（spec）。问题：**spec 收尾 role 看到的问题该开新票还是记 warnings**——草稿允许它开 `newTickets`，这意味着 AFK 运行能反过来给 GitHub 造票（由 App 代写，ADR-0002 不破）。要不要收窄成「只允许开 P2 以下的票」？

**A7 · 固定点在 ticket role 是什么。** 草稿假设「这条 spec 分支的起点」（`_common` 里的 `{{fixed_point}}`）。对**同一 spec 的第 2、3 张票**，那意味着 review 会把前面几张票的改动一起重审一遍（重复发现、上下文变长）。备选：本次运行开始时分支的位置（每票只审本票的 diff），代价是 review 看不见前序改动的交互。这条同时喂回 #17 的 `.seeded` 标记要记什么。

**A8 · 「环境已备好」这一栏的边界。** 清单第 10 条的「不写」栏在 prompt 里只能变成正面表述。草稿写了一句「工作副本已就位、分支已切好、模型与凭证由环境给」，够不够让模型不去自己 `git checkout`／找 token？要不要点名「不要创建分支」？

**A9 · review 的发现必须修吗、修完要不要再 review。** 草稿：ticket role 修范围内的、范围外进 `warnings`；spec role 必须修、修不动进 `newTickets`；**都不再 review 第二次**。风险：修出来的东西没人看过（一次修改可能引入新问题）。备选「修完再跑一次 review，代价是一次运行里两轮 review」——成本翻倍，且 convergence 没有保证。

**A10 · reviewer 的 spec 全文从哪来。** 草稿假设 `code_review` 工具把 spec 正文喂进 reviewer conversation。备选：落到工作副本里一个文件让 reviewer `read`（工具表只有 `read`/`grep`，这条可行），代价是工作副本里多出非代码文件（要不要加进 `.gitignore`？谁清？）。见 A16。

**A11 · ticket role 与同 spec 其他 ticket 的界线。** 草稿写了「别的 ticket 有它自己的运行，不要回退也不要顺手做」。这条与「小 bug 可以直接修」的边界容易打架（同一文件里别人写坏的算 bug 还是算别人的活）。要不要补一句优先级（「本票要求优先于任何顺手修」）？

**A12 · spec role 的 ticket 图从哪来。** 草稿写「ticket 图是验收面的来源」，但没说图怎么拿到（App 读 sub-issues 后渲染？reviewer 不读 GitHub）。而且「已全部关票」之后 ticket 正文还在，这一轮要不要把它们全渲染进 prompt（可能很长，但 spec 收尾只有这一次）？

**A13 · e2e 的「不做」要不要明写。** 草稿写了「没有 e2e 这一步，不要去找命令、不要自己发明」。另一种看法：写了反而提醒模型去找。清单第 5 条要求「决定」是撤销 e2e，但没说 prompt 里要不要显式写这一句。

**A14 · `prBody` 三段在 prompt 里的份量。** 草稿把 /pr 的三段结构完整搬进 `implement-spec`。备选：只指向「Summary / Evidence / Merge Danger」三段名，让模型自己发挥；或把结构搬进 `finish_spec` 工具的 schema/description（落点从 prompt 换成工具）。草稿选 prompt 是因为改文案不该重建镜像。

**A15 · 「不要开子 agent」的措辞与位置。** 草稿在**两份 review 模板**的正文与末行各写了一遍（清单第 7 条要求末行统一写）。问题：**implementer 要不要也有这句**？取决于 runner 的 implementer 工具表里到底有没有 subagent 工具——有的话，一次 implement 也能扇出；没有的话这句话是噪音。这是 runner 工具集的决定（#14 的「本清单不覆盖」），但 prompt 与它必须一致。

**A16 · 〔结构性坑〕reviewer 只有 `read`/`grep`，跑不了 `git diff`。** 清单第 7 条把 reviewer 的工具表裁到 `read`/`grep`（断扇出），第 2 条又要求 brief 里带「diff 命令与 commit 列表」。两者冲突：**没有 `bash` 就执行不了那条命令**。三条路：(a) `code_review` 工具自己算好 diff 与 commit 列表，作为 reviewer 的用户消息喂进去（草稿现在写的是「工具会把 diff 的范围给你」，默认这条）；(b) 工具把 diff 落成一个文件，reviewer `read` 它；(c) reviewer 工具表加 `bash`（干净但把「只读」变成了自觉）。这条不定，#14 的两份 review 模板就定不下来，`code_review` 工具的实现也没法写。

**A17 · Standards 轴的材料：清单谁扫、baseline 放哪。** (a) standards 文件清单是运行期扫 repo 得到的（草稿假设）还是静态写死？跨仓库复用时静态清单一定错。(b) smell baseline 十二条在**两份**模板里各有一份会漂移（要找 12 条只需一处改），但 ADR-0004 定的键是五个；备选：加第 6 个键 `_smell-baseline`（改 ADR-0004）、或放进代码镜像（撞「prompt 不烧进镜像」）、或就接受两份重复（接受漂移）。

## 这份初稿不覆盖

- runner 的内部结构（task/phase、工具集、section 拼接）——留给 spec 阶段的 `/codebase-design`
- 模型与 thinking 档位、reviewer 的模型（[#20](https://github.com/2017fighting/remote-agent/issues/20)）；工作副本播种、凭证、固定点取值（[#17](https://github.com/2017fighting/remote-agent/issues/17)）；Job 与卷的预算（[#18](https://github.com/2017fighting/remote-agent/issues/18)）；PVC 回收（[#19](https://github.com/2017fighting/remote-agent/issues/19)）；Job 何时可删（[#23](https://github.com/2017fighting/remote-agent/issues/23)）
