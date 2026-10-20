# App 是唯一往 GitHub 写状态的角色

Job 只做两件事：把 commit 推到分支，把自己的结果写在自己 Job 对象的 annotation 上。label 变更、评论、关闭 issue、开 PR 全部由 App 执行。这样同一个 issue 上永远只有一个 writer，不会出现「job 死了但 label 停在 in-progress」的中间态，错误处理也只有一条路径。代价是 Job 不能直接跟人对话：任何要写给人看的内容都得先变成 run result，再由 App 转写出去。
