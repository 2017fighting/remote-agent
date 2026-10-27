# prompt 随镜像走：Runner 从镜像内的 canonical 目录读模板，逐 key 记来源，只留一个事故覆盖口子

[ticket #76](https://github.com/2017fighting/remote-agent/issues/76)（Part of [#75](https://github.com/2017fighting/remote-agent/issues/75)）。

[ADR-0004](0004-prompts-live-in-configmap.md) 把 prompt 放 home-ops 的 ConfigMap、与镜像解耦，换来「改 prompt 不必重建镜像」。代价在这次 spec 里显出来了：**集群里跑的是哪一版 prompt，没有任何东西说得清**。ConfigMap 是 `prompts/` 的手抄副本，drift 检查按 pin 逐字比对——所以任何 prompt 都进不了集群而不经过一次 release，那条收益被自己的检查封死；而它明写的代价（prompt 与 runner 代码的契约分处两仓、容易漂移）一天都没停过。一次被遗忘的热改（有人为了救火直接改 ConfigMap，之后再没删）会静默地活在集群里，而 runner 的日志里没有任何一行能证明它存在。

## 决定

### prompt 的来源

- **`prompts/` 随 Job 镜像发布，落在 canonical 目录 `IMAGE_PROMPTS_DIR`（`/opt/remote-agent/prompts`，与 `seed.mjs` / `runner.mjs` 同级）**。常量在 `shared/src/paths.ts`，`job/Dockerfile` 把 repo 的 `prompts/` COPY 到那里。Runner 默认读这个目录，**不再依赖任何挂载的 ConfigMap**。
- **漏了某个 key 在单测阶段就抓住**：repo 的 `prompts/` 目录必须恰好是 `PROMPT_TEMPLATE_KEYS` 那五个键，且每个 Agent role 与 review axis 映射出的 key 都在里面（单测断言）。镜像按目录原样 COPY，所以「源里齐全」就是「镜像里齐全」。
- **解析是有序的两处、逐 key 回落**：先看覆盖目录（`PROMPTS_DIR`），缺这个 key 再看镜像目录。role 模板与 review axis 模板走**同一条**回落路径（`readPromptFile`），没有第二套规则。
- **逐 key 记来源**：每个 key 解析时打一行 `prompt-source=<key>:image` 或 `prompt-source=<key>:override`。一次运行**解析整个 key 面**（五个 key），不是只解析这个 role 用到的：ticket 运行永远不会读 `implement-spec`，若懒解析，一个被遗忘的 `implement-spec` 覆盖就永远不可见，而这正是这行日志存在的理由。多读五个小文件的代价换来「单次运行的日志点名每个 key 的来源」。
- **两处都没有该 key 时直接报错**，文案同时点名覆盖目录与镜像目录，让运维一次定位是挂载问题还是镜像问题。
- **Round header 仍由 runner 生成，不进模板**（[ADR-0017](0017-a-new-job-on-a-spent-ticket-volume-starts-a-new-round.md) 不变）：它说的事实只活在卷上。

### 覆盖口子（契约）

事故里一条 `kubectl create configmap` 就能改一个 prompt 而不发版，用完删掉即可。

- Job 模板常驻一个**可选**卷：卷名 `prompts-override`，ConfigMap 名 `remote-agent-prompts-override`，`optional: true`（对象不存在 = 空目录，常态就是没有它），挂载点与 `PROMPTS_DIR` 都是 `/mnt/prompts-override`。
- **`PROMPTS_DIR` 是这次唯一新增的环境变量**；未设时 Runner 只读镜像内 canonical 目录（这正是没有覆盖 ConfigMap 时的形态）。
- Job 模板不再渲染旧的 `remote-agent-prompts` 卷，`PROMPTS_CONFIGMAP_NAME` 常量随之退场；`K8sVolume` 端口类型增加 `optional`。App 不需要新的 RBAC（卷由 kubelet 挂载），Seed 容器的挂载一字不变。
- 热改步骤（含「用完要删」）只写一份，落在本仓的 [`docs/deployment.md` §8](../deployment.md#8-prompt-的载体)；home-ops 侧只留一行指针。

### ADR 与文档

- 本文**取代 ADR-0004 的载体决定**；ADR-0004 顶部加一行指向本文的指针，正文不改（历史可追）。它的键面（`_common` + 两份角色 + 两份 review）与「没有 skill 层」的结论仍然成立。
- 行为已变的引用改指本文：`job-template`、`shared/src/paths.ts`、`job/src/internal/prompt.ts`、App 的 k8s 端口类型、`docs/deployment.md`、`docs/agents/prompt-checklist.md`。

### 发布与切换

- **T1（镜像内 prompt，[#76](https://github.com/2017fighting/remote-agent/issues/76)）与 T2（可选覆盖卷，[#77](https://github.com/2017fighting/remote-agent/issues/77)）原计划分两次 release**，但两者落在同一张 spec 的同一分支上，随**同一次** release 发出：中间那个「镜像已带 prompt、旧 ConfigMap 仍挂着但没人读」的过渡态没有真实存在过，所以这两步不单独可回滚（回滚就是回滚整个 pin）。代价明写，缓解办法见下一条。
- **home-ops 的删链必须与含 T1+T2 的 pin bump 同一个 PR**（[docs/deployment.md §8](../deployment.md)）：旧 App 仍在渲染 `remote-agent-prompts` 卷，ConfigMap 先没则那些 Job 起不来。合在同一个 PR 里做，那个窗口就不存在；不要求先清空 Job——新 App 不再挂那个卷。

## Considered Options

- **继续用 ConfigMap 承载（ADR-0004 的现状）**：不要。它就是这次要修的东西——prompt 版本与镜像版本没有绑定，「集群里跑的是哪一版」不可观测。
- **镜像内 prompt + 无任何覆盖路径**：不要。放弃事故热改：改一句 prompt 要等一次 release，事故里没有出口。
- **目录级 all-or-nothing 覆盖**：不要。热改必须整份重建五个 key，事故里更慢；逐 key 落回的代价用日志兜住。
- **只解析用到的 key（懒解析）**：不要。日志的价值在于发现被遗忘的覆盖；一个 ticket 运行不看 `implement-spec`，懒解析就漏掉它。整个 key 面解析的成本是五个小文件读。
- **把「来源」做成结构化 annotation 而不是日志**：不要。日志是 runner 已有的、e2e 与 `kubectl logs` 都能看到的面；多一个 annotation 就多一个要维护、要清理的 per-run 文档，而它回答的问题一次运行就答完了。
- **由源仓库发布渲染好的 ConfigMap artifact（release asset / OCI）再由 home-ops 消费**：不要。它保留了解耦，却要两边各加一条发布/消费链。

## Consequences

- **改 prompt 要重建镜像、走一次发版**。这是有意的代价：prompt 与 runner 代码同版本、同一次发布，不再两仓漂移。今天副本本来就按 pin 逐字比，所以变化是「CI 会红但绕得过」变成「绕不过」。事故时的临时改动走 `PROMPTS_DIR` 覆盖。
- **home-ops 的 git 里不再能看到集群在跑什么 prompt**：可读性搬到 remote-agent 的 tag 与 PR；prompt 与代码的契约漂移在结构上不可能发生。
- **ADR-0004 的载体决定作废，键面与「无 skill 层」保留**；`docs/agents/prompt-checklist.md` 的「角色 prompt 放 home-ops ConfigMap」一行与承载形态一节改指本文。
- **为什么这次反转是诚实的**：ADR-0004 的两条收益里，只有一条与载体有关。**「同一份镜像被多个 Agent role 复用」与 prompt 进不进镜像无关**——五个 key 本来就一起发布，所以一份镜像仍然带全部五个 key、被两个 role 与 reviewer 共用（[ADR-0005](0005-self-built-job-image.md)）；而「改 prompt 不必重建镜像」被它自己的 drift 检查封死了（副本是 verbatim 的、按 pin 逐字比对）。于是这不是推翻一个还在生效的决定，而是承认它已经在事实上被推翻。**副本不要再加回来**：把它抄进 home-ops 是本仓唯一的例外，而那个例外的收益已经归零。
- **模板要自包含那条结论原样留下**：它与 prompt 住在哪里无关。
- **Seed 容器的挂载与行为一字未变**（[ADR-0009](0009-ticket-volume-seeding.md)）：seed 只做 git，从不读 prompt。
- **旧 ConfigMap 与它的挂载在 T2 之前仍是必需的**：Job 模板挂着它，k8s 要求被挂的 ConfigMap 存在，所以 home-ops 里的 `remote-agent-prompts` 暂时不能删——但它对 runner 已经没有意义。
