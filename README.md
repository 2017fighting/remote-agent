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

- `agent:implement`: 标记这个issue(spec or ticket)需要由remote agent进行实现
- `agent:in-progress`: `github app`接收到了请求，计算出了frontier ticket，将这个ticket标记为了进行中
- `agent:error`: k8s job实现时非正常退出，由`github app`进行设置
- `agent:blocked`: k8s job实现时发现无法AFK（需要人来做决定），或者某些东西无法实现，没有做完，由k8s job进行设置

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

list then open children，drop any with an open blocker or an assignee or an `agent:*`(blocked/error/in-progress) label, first wins.

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

1. human在和Interactive agent确定好spec之后创建出来的
   status: open
   label: []

2. interactive agent将某些issue标记为`ready for an AFK agent`
   status: open
   label: [ready-for-agent]

3. human手动给某个spec/ticket添加agent:implement
   status: open
   label: [ready-for-agent, agent:implement]

4. github app将某个ticket设置为了进行中状态
   status: open
   label: [ready-for-agent, agent:in-progress]

5. k8s job正常退出，做完了，由k8s job将这个issue关闭
   status: close
   label: [ready-for-agent]

6. k8s job非正常退出
   status: open
   label: [ready-for-human, agent:error]

7. k8s job没有实现完
   status: open
   label: [ready-for-human, agent:blocked]

8. github app将spec设置为了进行中状态
   status: open
   label: [ready-for-agent, agent:implement, agent:in-progress]

9. k8s job正常退出，spec确认全做完了，提了pr(commit里有Closes #${spec-issue-number}，这样在merge时会自动关闭spec issue)
   status: open
   label: [ready-for-human, agent:implement]

10. k8s job非正常退出
    status: open
    label: [ready-for-human, agent:implement, agent:error]

11. k8s job正常退出，但是判断有真阻塞
    status: open
    label: [ready-for-human, agent:implement, agent:blocked]

12. 状态同3,k8s job发现没有实现完，需要它在这个spec下创建新的sub issue(如果新的issue可以AFK实现，就带`ready-for-agent`的label，否则就带`ready-for-human`的label，之后github app需要检测到有新的frontier ticket未实现完成，实现这些新的issue)
    status: open
    label: [ready-for-agent, agent:implement]
