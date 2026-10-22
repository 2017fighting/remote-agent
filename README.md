# Remote Agent

## 运行环境

k8s @/root/clone/home-ops(git@github.com:2017fighting/home-ops.git)

## Github Appas

Name: Raenzo-Remote-Agent
App ID: 5390512
Client ID: Iv23lipjSurEcAJNUaNW
Homepage URL: https://remote-agent.raenzo.com/
Webhook URL: https://remote-agent.raenzo.com/webhook
WebhookSecret: f789e284ca3f2babf324c92a174f4ef26f4dfac296101f030f6016b3

## mattpocock-skills 生成的issue label

> @/root/clone/mattpocock-skills(git@github.com:mattpocock/skills.git)

- `needs-triage`: maintainer needs to evaluate
- `needs-info`: waiting on reporter for more information
- `ready-for-agent`: fully specified, ready for an AFK agent
- `ready-for-human`: needs human implementation
- `wontfix`: will not be actioned

## 我们需要用到的issue label

- `agent:implement`: 标记这个 issue(spec or ticket) 需要由 remote agent 进行实现；**人写，App 永不删**（它记的是「人授权过」，不是「此刻在跑」）
- `agent:in-progress`: `github app` 已 Claim 这个 ticket（此刻有 Job 占着它）；**只出现在 ticket 上，spec 从不带它**
- `agent:error`: Job 非正常退出 / 读不到 run result / label 与 Job 漂移，由 `github app` 设置；**没有自动重试**，人改 label 是唯一重入方式
- `agent:blocked`: agent 自述没做完、需要人做决定，由 `github app` 按 run result 设置

## implement整体流程

1. `人`：给`ready-for-agent`的issue添加`agent:implement`的label
2. `github app`: 接收到hook请求，检测当前issue是`spec`(mattpocock-skills的`/to-spec`)还是`ticket`(mattpocock-skills的`to-tickets`)
3. `github app`: 如果当前issue是`spec`，则找当前frontier ticket,仅实现这个frontier ticket; 如果当前issue就是某个`ticket`，这实现这个ticket
4. `github app`: 给这个ticket issue添加`agent:in-progress`的label，启动一个k8s job去实现这个ticket
5. `implement job`: 运行`pi -p --mode json -- "${prompt}"` 通过prompt确保它可以按照我们的流程操作gh
6. `github app`或者k8s job里给pi包装一层：检查`pi -p`的最终结果(示例可以查看这里@/root/.pi/agent/sessions)，判断是否非正常退出，如果非正常退出则给issue设置`ready-for-human,agent:error`

## 如何区分issue是`spec`还是`ticket`

spec-ticket的关系是一对多的，spec会有sub issue，ticket通常没有(explore一下：ticket是否会有sub issue？如果ticket也会有，则需要新加label来区分spec和ticket)

## 如何找spec当前frontier ticket

list then open children，keep only those passing the Gate（`open` ∧ no open blocker ∧ `ready-for-agent` ∧ `agent:implement` ∧ no `agent:*` label），first wins.

## job并发

由`github app`控制，默认情况下：全局最多同时运行3个agent job，每个git仓库`repo`最多同时运行2个

## branch

每个spec一个branch`agent/spec-<spec-issue-number>`，这个spec下的sub issue，都在这个branch下工作，每次工作前都从最新commit开始，多个job并发时，由后面`push`的job解决冲突

## Spec implement循环

每次都选择当前frontier ticket进行实现，如果当前frontier ticket completed完成了（状态由agent判断并关闭closeed issue）
`github app`接收到某个job完成的事件时，重新计算当前spec的frontier ticket，实现这个最新的ticket
直到所有`ready-for-agent`的issue都被实现完成
如果当前spec没有任何open的sub issue了，则由`github app`新开一个k8s job去做最后的收尾工作，并提交pr

如果某个ticket并未完全complete，给这个ticket添加`agent:blocked`的label，由agent去给这个issue写评论，说明做了什么（这时不close issue），并停下来

## k8s job的pvc哪来

storageClass是truenas-csi，应该是支持snapshot的

每个repo一个base pvc,在github app接收到第一个hook时创建，每个job的pvc都是从这个base pvc创建snapshot而来(这一步由`github app`来创建并attach到k8s job，每次都会确保base pvc同步到了最新的main分支,snapshot里创建`agent/spec-<spec-issue-number>`的branch（如果branch已经存在则不创建，而是拉下最新的改动)
这样可以防止每次都从零拉取仓库

1. 来一个webhook，提前repo地址，发现没有对应的base pvc，创建base pvc，创建snapshot，将snapshot给k8s job
2. 来了同一个repo的webhook，发现有了base pvc，将base pvc拉取到最新提交，创建snapshot，将snapshot给k8s job

这些操作在哪做？github app这个pod? 还是每个k8s job都弄一个initContainer，来专门做这些操作?
磁盘预算可以先请求github api(https://api.github.com/repos/agegr/pi-web)，里面有个size字段，当然不用特别小，还得给写代码，编译啥的预留空间
base pvc可以一直保留，不用删，除非我是手动操作，snapshot在k8s job正常运行完，issue被关闭后就可以删掉了，那些运行出错，ready-for-human的需要留着

## implement ticket prompt

我会给镜像里装上@mattpocock-skills

- 显式提示让agent调用implement: `/implement #123`
- mattpocock-skills的implement有需要`问用户`的分支，我们这里提前掐掉：
  1. issue号
  2. base分支是`agent/spec-<spec-issue-number>`
  3. 两轴code review前让他本地commit，使用subagent的reviewer agent，spec来源是parent issue，seam来源也看parent issue
  4. 小bug直接修，不用问，真有阻塞就走`agent:blocked`

## implement Spec prompt

e2e验证
开pr(/skill:pr)到main
commit需要有`Closes #<spec-issue-number>`

## implement job的结果

如何读取可以看@/root/clone/sandcastle/src/AgentProvider.ts 

1. 正常退出，提交了commit

- 如果做完了，需要close issue
- 如果没有做完则需要添加`agent:blocked`的label，给这个issue写评论，说明做了什么(k8s job去做)

2. 非正常退出

- 由`github app`(还是给`pi -p`包装一层?)去给这个issue添加`agent:error`的label

## issue状态机

完整表格与状态机图见 [docs/architecture.md 第 4 节](docs/architecture.md#4-状态机)；这里只留三条前提、入口门和一张 label 清单。

**三条前提**

1. **Job 的终态只有三种**：`Complete`（runner 自述 done/blocked 后已写 annotation）、`Failed(reason=BackoffLimitExceeded)`、`Failed(reason=DeadlineExceeded)`。**只有 Job 终态会移动 label**；pod 层的 OOMKilled / 驱逐 / SIGTERM / CrashLoopBackOff 与重启后的 `resume()` 全程对 GitHub **不可见**（[ADR-0008](docs/adr/0008-durable-runtime-base.md)）。「Job 在跑但 pod 在重启」是一个对 GitHub 不可见的自环：label 停在 `agent:in-progress`、不评论、Slot 继续占着——票看起来一动不动，那是正常的。
2. **写者各一个**：label、评论、关 issue、开 PR 全是 **App**（[ADR-0002](docs/adr/0002-app-is-sole-github-writer.md)）；annotation 只有 **Runner**（[ADR-0007](docs/adr/0007-run-result-contract.md)）。Job 从不碰 issue。
3. **label 是三个维度**：triage（`ready-for-agent` / `ready-for-human`，人写，表示谁该干）、授权（`agent:implement`，人写）、运行事实（`agent:in-progress` / `agent:error` / `agent:blocked`，只有 App 写）。**assignee 不参与状态机**，App 不读也不写。

**入场门（Gate）**

```
open ∧ 无 open blocker ∧ 有 ready-for-agent ∧ 有 agent:implement ∧ 无任何 agent:*
```

四条件缺一不动。`ready-for-agent` 是门的一部分而不是装饰：spec 收尾后把它换成 `ready-for-human`，就是靠这一条退出门。额度满时 **Defer**（本轮不建 Job、不改 label、不评论，只写一条日志，见 #13）。

| 场景（Job 终态 · annotation） | ticket 的 label | spec 的 label |
|---|---|---|
| —（Claim：Job 非终态，含 pod 重启自环） | `open` · `[ready-for-agent, agent:implement, agent:in-progress]` | `[ready-for-agent, agent:implement]`（不变，spec 不写 `agent:in-progress`） |
| `Complete` · `done` | `closed` · `[ready-for-agent, agent:implement]` | `[ready-for-human, agent:implement]` + 已开 PR |
| `Complete` · `done` + `newTickets` | `closed` · 同上，新 sub-issue 已建 | `[ready-for-agent, agent:implement]`（**不开 PR**，新票进 frontier） |
| `Complete` · `blocked` | `open` · `[ready-for-human, agent:implement, agent:blocked]` + 评论 | 同左 |
| 任何 `error`（自述 / backoffLimit / DeadlineExceeded / no-result / no-job） | `open` · `[ready-for-human, agent:implement, agent:error]` + 评论 | 同左 |
| 人重入 | 摘 `agent:blocked`/`agent:error`、`ready-for-human` → `ready-for-agent` | 同左 |
| 额度满 · Defer | 一字不变 | 一字不变 |

每个 `error` / `blocked` 终态 App 都会发一条评论（reason + Job/pod 名 + pod 终态证据 + 保留的 Ticket PVC 名 + 它的保留期 + `kubectl logs` 指引）——因为那几条路上根本没有 annotation。
