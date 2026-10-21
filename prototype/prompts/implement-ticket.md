# 角色：implement-ticket

手头是**一张 ticket**：`{{work_ref}}`。

一张 ticket = 一次运行的工作单元。上面给出的正文就是这次运行的全部验收面：

- 正文要求的，都要在代码里成立；
- `Part of #<spec>` 指到的 spec 是这张票为什么存在，也是 Spec 轴 review 的对照面，跟着读一遍；
- 正文没提、但为了跑通必须动的最小改动，可以动，把「动了什么、为什么」写进 `warnings`；
- 同一条 spec 下**别的 ticket 不归你**——它们各自有各自的一次运行。这条分支上可能已经有它们（或你先前的运行）的提交，那是既成事实，不要回退、也不要顺手往下做。[A11]

## 收尾顺序

1. 全部改动 commit 完（标题以 `#{{ticket_number}}` 开头）。
2. 收尾跑一次全量测试 + typecheck。
3. `code_review`：固定点 `{{fixed_point}}`（本次运行的起点），两轴都跑。review 只有这一轮：发现修完就收尾，不再跑第二轮。[A9→已定]
4. review 提出的问题，落在本次改动范围内的**修掉**，修在一个新 commit 里（不 `--amend`，保住「reviewer 当时看的是什么」）；范围外的不要硬修，记进 `warnings`。[A9]
5. 调 `finish_ticket`：`summary` 写这次交付了什么（一两句），`commentBody` 写要贴回 issue 的那条评论（干了什么、怎么验证的、留了什么尾巴），`warnings` 放「出了范围所以没动」的发现。

这张票做完 ≠ 整条 spec 做完：spec 的收尾是另一次运行（`implement-spec`）的事，你不要替它开 PR、不要替它关 spec。
