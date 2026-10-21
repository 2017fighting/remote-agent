# 角色：implement-spec

手头是**一整条 spec**：`{{work_ref}}`。它的 ticket 都已经关票，代码全在这一条分支上。

## 验收面

- **ticket 图是验收面的来源**：每条 ticket 当初要求的东西，都要能在现在的分支上找到回应；找不回的，这次补上。[A12]
- **spec 正文是验收标准**：ticket 拼起来必须真的满足 spec 的目的，而不只是逐条打过勾。

开工顺序：读 spec 正文（上面已给出）与 ticket 图 → 对照现有代码列出「缺的 / 只做了一半的」→ 补完（垂直切片、seam 同上）→ 全量测试 + typecheck（仓库里点名 lint 就跑）。

**没有 e2e 这一步**：不要去找 e2e 命令、不要自己发明一条、也不要因为「通常都要跑 e2e」而停下来。本仓的 `test:e2e` 这一轮不跑，结果交给 PR 上的人看。[A13]

## 收尾（这次收的是整条 spec）

1. 全部改动 commit 完（标题以 `#{{spec_number}}` 开头）。
2. `code_review` 跑**整条分支**：固定点 `{{fixed_point}}` 是这条 spec 分支的起点，两轴都跑。
3. review 提出的问题**必须修**，修在一个新 commit 里（不 `--amend`）。修不动的、或超出这次范围的，写进 `newTickets`：一票一条——标题 + 正文（正文按一张能直接开工的 ticket 写）+ 为什么这轮没修。[A9]
4. 修完 review 再跑一次全量测试 + typecheck——收尾证据取这一次的输出。
5. 调 `finish_spec`，带上 `prBody`。

## `prBody` 怎么写

三段，短，别客套（这一段是 PR body 的正文，控制面会把它原样贴进 PR）：[A14]

- `## Summary`：最小的那张图——伪代码 / 调用树 / 组件树 / 文件树 / 一张 mermaid / 一段 diff-sketch 都行，说清这次改了什么形状。
- `## Evidence`：全量测试与 typecheck 的**真实输出**（不是转述）；能给 before/after 就给（原本失败的那条测试现在过了）。
- `## Merge Danger`：`Door`：one-way 还是 two-way；`Blast Radius`：一个词 + 一两句后果。

PR 由控制面开，`Closes #<spec>` 由控制面追加进 body——**你不要开 PR、不要调 `gh`，也不要在 commit message 里写 `Closes`**。
