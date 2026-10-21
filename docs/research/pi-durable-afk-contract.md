# pi-durable 的 AFK 契约：存储归属、续跑、outcome、provider、subagent 与 skills

调查对象：GitHub issue #21（wayfinder:research）。执行面基座从 `pi -p --mode json` 换成 `@earendil-works/pi-durable`——一个**库**，`package.json` 没有 `bin`，没有 CLI；runner 是 remote-agent 自己写的 TypeScript 程序。本笔记是下一张 grilling 票 #22 的输入。

标注约定沿用 `research/pi-afk-contract`：`[直接证据]` = 源码/规范/官方文档原文或实测；`[解读]` = 对直接证据的解释；`[推断]` = 未被直接证据覆盖的推理；`[未确认]` = 没找到 primary source，不猜。

---

## 证据基线与版本（先读这一节，它改变了很多结论）

- **本地源码 HEAD**：`/root/clone/pi`，`git describe` = `v1.3.0-61-g16f5f0af4`（HEAD = `16f5f0af4`）。`packages/durable/package.json` 的 `version` 仍是 `1.3.0`，但 `packages/durable/CHANGELOG.md` 有一个 **`[Unreleased]`** 段，里面列着若干 **Breaking Changes**。`[直接证据]`
- **npm 上真正发布的 1.3.0**：`npm view @earendil-works/pi-durable version` → `1.3.0`，`engines` → `>=22.19.0`；下载 tarball 核对：**没有 `bin` 字段**、`files` 只含 `dist`/`README.md`/`CHANGELOG.md`（`docs/spec.md` **不在** npm 包里）。`[直接证据]`（`npm view` + `registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.3.0.tgz` 实测）
- **两者不是同一份东西。** 本地 HEAD 在 npm 1.3.0 之后又走了 61 个提交，`[Unreleased]` 里的能力**没有进 npm 1.3.0**。实测差异（在 npm tarball 的 `dist/` 与 `README.md` 里 grep，结果全为 0）：

| 能力 | 本地源码 HEAD | npm 1.3.0 |
|---|---|---|
| `settings.restartLimit`（默认 5）/ park `restart_limit` | 有（`README.md:214`、`docs/spec.md §5.4`） | **无**（`grep -c restartLimit dist/index.js` = 0） |
| `TaskRecord.restarts` 计数 | 有（`src/types.ts:686`） | **无**（published `dist/types.d.ts` 无 `restarts`） |
| `TaskInspection.blocked` 的 `restart_limit` | 有（`docs/spec.md §2.2`） | **无**，只有 `missing_task｜task_too_old｜migration_failed`（published `dist/harness/types.d.ts:565`） |
| `runtime.sleepUntil()` / `sleeping` 状态 | 有（`docs/spec.md §5.6`） | **无**；有旧的 `TaskRuntime.sleep(until, context)`（published `dist/types.d.ts:196`），即 in-phase 等待 |
| `HarnessOptions.setTimer` / `onWake` / `Harness.wake()` | 有（`docs/spec.md §5.6`、`README.md`「Sleeping and Waking Up」） | **无**（published `Harness` 接口无 `wake`/`retryTask`） |
| `Harness.retryTask(id)` | 有（`docs/spec.md §2.2`） | **无** |
| `settings.afterFailedRun` | 有 | **无** |
| `defineDoc()` 的 `checkpointWhen` 必填 | 必填（`src/documents.ts:89`） | 可选（published `dist/documents.d.ts:39` `checkpointWhen?`） |
| `onReport(error, info: ReportInfo)` 第二参数 | 有（`docs/spec.md §2.2`） | **无**，是 `onReport?: (error: unknown) => void`（published `dist/harness/types.d.ts:537`） |

- **在 npm 1.3.0 里就有的、与 #21 直接相关的**：存储归属「one process owns a storage at a time; there is no cross-process locking」（published `README.md:682`，本地 `README.md:788`，两版一致）、SQLite 的 WAL + `synchronous = NORMAL`（published `README.md:661`，本地 `README.md:763`）、`submission.wait()` 的 `done`/`unanswered`、task outcome、`control: { terminate: true }`、`replay`（默认 `unsafe`）、`harness.closed` + `reopen on failed`（published `README.md:711-721`）、`onReport(error)` 单参数。

`[解读]` **#21 的问题里点名要查的 `settings.restartLimit`（默认 5）与 park（`restart_limit`），在 npm 1.3.0 里根本不存在**，只存在于 `/root/clone/pi` 未发布的 HEAD。这不影响「该怎么设计」，但直接决定「今天能不能靠 `npm install` 拿到」——见文末「风险与钉版策略」。

- **规范（normative spec）**：`/root/clone/pi/packages/durable/docs/spec.md`，`docs/spec.md` 自称 normative（`spec.md:3`「This document is normative.」），但**不随 npm 发布**。本笔记对规范小节的引用都指本地 HEAD 的那份。
- **example 代码**：`/root/clone/pi/packages/durable/test/examples/*.ts`，也是本地 HEAD；npm 包不含 `test/`。
- **pi-ai / pi-env**：`/root/clone/pi/packages/ai`、`/root/clone/pi/packages/env`，HEAD 同上；npm 上 `@earendil-works/pi-env@1.3.0`、`@earendil-works/pi-ai@1.3.0` 均存在，`engines` 同为 `>=22.19.0`（`npm view` 实测）。
- **home-ops**：`/root/clone/home-ops`（只读），HEAD = `a20dcea`。

---

## 结论速览

| # | 问题 | 一句话结论 |
|---|---|---|
| 1 | 存储归属 | durable **自身没有任何跨进程锁**；一个 SQLite 文件同时只能有一个进程开。k8s 下必须由 Job 的「单 pod + 旧进程先真正退出」来保证，且 sqlite 必须落 **block 卷（`truenas-iscsi-retain`）而非 NFS（`truenas-nfs-retain`）**。 |
| 2 | 续跑语义 | `resume()` 从每个 task 的最后一个 checkpoint 续；phase 崩溃后**整个 phase 从顶重跑**；tool call 崩溃后默认 `unsafe`→`interrupted`（**连 built-in `read` 也是 unsafe**）；模型请求崩溃后 partial 变 aborted assistant + 重发。**`restartLimit`/park 只在不发布的 HEAD 里**。 |
| 3 | outcome 契约 | `submission.wait()` 给 `done`/`unanswered(reason)`；task outcome 是 `completed/failed/aborted/orphaned`；`terminate: true` 让 run 以「成功结束」收尾。映射：自述 blocked→`blocked`，其余一切（`model_error`、`faulted`、parked、`session_failed`、驱逐/超时）→`error`。 |
| 4 | provider 接线 | `createModels()` + `setProvider(createProvider({ id, baseUrl, models, api: openAICompletionsApi(), auth: { apiKey } }))`；`configure({ model, thinkingLevel })` 等价于 pi 的 `--model`/`--thinking`；两个 model id 就是 provider `models` 数组里的两个条目 + 两个 conversation 各自的 `model`。 |
| 5 | skills 与 subagent | durable **没有 Skill 工具、没有 slash command、没有内置 skills extension**；规范里的 `Skills`/`ContextFiles`/`renderSkills` 只是**参考草图，未实现**。subagent 要抄 `22`（foreground，`replay:"safe"` + `ownership:{kind:"task"}` + `requestId`）与 `23`（background anchor + reporter）。reviewer 建议用**独立 conversation**（同存储，白得续跑），不用独立 Job。 |
| 6 | 打包与版本 | 库 + 无 CLI；镜像里 `npm install` 三个包（durable/ai/chord 1.3.0），Node ≥ 22.19（SQLite 走 `node:sqlite`）；runner 需 `tsc` 编译（或 `--experimental-strip-types`）。与 ADR-0005 的关系：镜像仍自建，但 entrypoint 契约从「跑 pi + 写 annotation」变成「跑 runner + 写 annotation」。 |
| 7 | 缺口 B 的余地 | 「单写者、无跨进程锁」直接排除「两个进程同时读同一 sqlite」这条路；人/App 只能在 Job 不跑时**独占打开同一存储**读，或读**只读副本/导出**。现在就要避开的是：把 session sqlite 和一次性工作副本绑死在同一个可丢弃卷上。 |
| 8 | pi-env | v1（runner 与工具同 pod、worktree 在 PVC）**用不上**；它是「harness 移出 pod」时的现成接线，也是缺口 B 里 `openTerminal`/`RemoteWatcher`/`listFiles` 的来源；它**不是沙箱**，不解决 base PVC/快照。 |

---

## 0. 一句话模型

`[解读]` durable 把「一次运行」表示成 **storage 里的 task 状态机**：每次推进（模型请求、工具调用、等待、睡眠、终态）都先原子 commit 到 storage，再对外可见（`docs/spec.md §1` 核心规则「A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable.」）。所以「续跑」不是 replay 日志，而是「重新打开 storage，读每个 task 的 checkpoint，从那里继续」。这也是为什么**存储必须单一写者**——没有中心服务协调，只有「谁开着这个文件」。

---

## 1. 存储归属（#21 第 1 条）

### 1.1 durable 的约束原文

`[直接证据]` `README.md:788`（本地；published `README.md:682` 同句）：

> One process owns a storage at a time; there is no cross-process locking.

`[直接证据]` IndexedDB 那条旁边还专门提醒：`README.md:767-769`「One owner must hold the database at a time; use a Web Lock around its lifetime rather than opening it in competing tabs or workers.」——durable 把「单写者」当调用方的责任，库本身不做仲裁。

`[直接证据]` `docs/spec.md §13 Non-goals` 明确没有「CRDT/offline multi-writer merge」，也没有「Session-kernel semantic event journal」。`[解读]` 不存在「两个进程各写一半再合并」的路径。

### 1.2 SQLite 落在哪种卷上

`[直接证据]` SQLite 后端：`README.md:763`「One database file. WAL mode with `synchronous = NORMAL`: commits survive process crashes; the newest may be lost on power or host failure.」实现处 `packages/chord/src/sqlite/node.ts:237-238`：

```
await adapter.exec("PRAGMA journal_mode = WAL");
await adapter.exec("PRAGMA synchronous = NORMAL");
```

`[直接证据]` WAL 自动 checkpoint 默认 1000 页，可配（`packages/chord/src/sqlite/node.ts:15` `DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000`；`:231` 读取 `options.walAutoCheckpointPages`）。

`[直接证据]` home-ops 已记录 SQLite-over-NFS 不可取：`/root/clone/home-ops/docs/superpowers/specs/2026-06-26-new-api-deploy-design.md:73`「SQLite 官方不推荐 NFS……若出现 `database is locked` 或损坏，后备路径：迁移到 MySQL……备选 `local-path`（k3s 自带，SQLite 最稳，但数据绑节点、备份需单独处理）」；`/root/clone/home-ops/docs/adr/0008-hapi-hub-returns-to-sqlite.md:9` 把「Hub store 变成 NFS PVC 上的一个文件」记为**接受的降级**；`/root/clone/home-ops/docs/adr/0004-auto-jav-subtitles-webhook-gpu-job.md:12` 记录「inotify over NFS is unreliable」。

`[直接证据]` home-ops 里可用的 StorageClass：`truenas-nfs-retain`（`infrastructure/storage/storageclass-truenas-nfs.yaml`，NFS）与 `truenas-iscsi-retain`（`infrastructure/database/cnpg-cluster/storageclass-iscsi.yaml`，raw-block ZVOL，专为 cnpg 的 WAL 而建）。

`[解读]` **结论：session sqlite 落 iSCSI block 卷（`truenas-iscsi-retain`），不落 NFS。** 理由有三：(a) durable 要求单写者但无锁，NFS 上 POSIX 锁/`-shm` 的可靠性是历史弱点，一旦两个节点先后挂同一 NFS 目录，WAL 的共享内存与锁语义会退化；(b) WAL 的 crash 恢复依赖本地文件系统语义，NFS 上的 `synchronous=NORMAL` 承诺更弱；(c) home-ops 自己的 ADR 已经把 SQLite-on-NFS 记为降级、把 iSCSI-block 记为 WAL 的正解。`truenas-iscsi-retain` 的 `volumeBindingMode: Immediate` + `reclaimPolicy: Retain` 与 base PVC 的既有语义一致。

### 1.3 pod 被驱逐/重启时会不会重叠，需要什么挡住

`[直接证据]` k8s 层没有 durable 能依赖的锁；durable 端也没有。`[解读]` 所以重叠的防线只能建在「同一时刻只有一个 runner 进程打开这个 storage」这条不变量上，手段有两层：

1. **Job 层**：ADR-0003 已是「一 ticket 一个 Job」+ ADR-0001 的确定性 Job 名。Job 用 `parallelism: 1, completions: 1`，k8s Job 控制器对同一 Job 同一时刻只保留一个活跃 pod。`[推断]` 但 pod **优雅终止**（SIGTERM + `terminationGracePeriodSeconds`）期间旧容器可能仍在跑，而 Job 控制器要等旧 pod 真的消失才建新 pod——这个窗口就是「旧进程还没退出、新进程可能已经在别处起来」的风险点。稳妥做法：`terminationGracePeriodSeconds` 足够小、且 runner 收到 SIGTERM 时**先 `harness.close()` 再退出**，保证旧进程在 grace 内真正关掉 storage。
2. **进程层**：`[直接证据]` `harness.closed` 会在 `close()` 或 storage 错误后 settle（published `README.md:715`；`docs/spec.md §10.1`）；`[解读]` runner 应把它当成「该退出了」的信号，而不是继续跑。

`[推断]` 如果以后要更硬，可以在 App 侧用「同一 ticket 同一时刻只创建一个 Job」+ 确定性 Job 名来兜底（ADR-0001 已具备），但**不要**指望 durable 自己挡住。

### 1.4 「每 ticket 一个」PVC 的命名与归属（呼应 ADR-0001）

`[解读]` 与 #22 的已定前提一致：v1 工作副本 + session sqlite 同卷。建议：

- **命名**：与确定性 Job 名同源。ADR-0001 用的是「确定性 Job 名」，那 PVC 就叫 `agent-<repo-slug>-<issue-number>`（或直接复用 Job 名做前缀），保证「同一 ticket 重跑」拿到同一块卷、可续跑；不同 ticket 天然不同卷。`[未确认]` 现有 ADR/README 里没有给 Job 名的具体格式，本笔记不替它定名——留给 #22。
- **归属**：runner 是唯一写者（durable 的单写者约束）；Job 结束后**保留**卷（error/blocked 留证据，与 ADR-0006 对快照的处置一致）。`[直接证据]` durable 没有「卷归谁」的概念，这层完全由 k8s 拥有。

`[未确认]` v1 是否真的每 ticket 一块 PVC（而不是每 ticket 一个 Job + 快照），以及这块卷是 `ReadWriteOnce` 还是 `ReadWriteOncePod`，不在本票 primary sources 内；#22 的 Notes 只说「工作副本 + session sqlite 同卷」。

---

## 2. 续跑语义（#21 第 2 条）

### 2.1 `resume()` / checkpoint

`[直接证据]` `README.md`「Persist and Resume」：

> Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler; submitting or waiting starts it too.

`[直接证据]` `docs/spec.md §5.6`：一个 phase 可以 `runtime.sleepUntil(until, checkpoint, context)`（本地 HEAD）或返回 `{ status: "sleeping", until, checkpoint }`；`[直接证据]` npm 1.3.0 里是旧的 `TaskRuntime.sleep(until, context)`（published `dist/types.d.ts:196`），**phase 内等待**，崩溃后 phase 重跑会把等待重来。

`[直接证据]` `docs/spec.md §5.6` 明确：「There is no sleep inside a phase: a phase reruns from its top after a crash or close」。`[解读]` 这决定了 checkpoint 的粒度：**每次跨 phase 才落一个可续跑点**，phase 内部的中间进度不保证。

### 2.2 三种崩溃点分别会怎样

- **phase 中间崩溃**：`[直接证据]` phase 从顶重跑（`§5.6`）。`[解读]` 幂等要靠你自己：同一 phase 里的副作用要么可重复执行，要么放在 commit 里当 checkpoint。
- **tool call 中间崩溃**：`[直接证据]` `docs/spec.md §7.3`：工具的 `call` phase 先 commit「intent」（最终参数 + replay 策略，`src/harness/tool.ts:175` `replay: tool.replay ?? "unsafe"`），然后执行；恢复时进 `execute` phase，**只有 stored 与 current 两处都声明 `safe` 才重跑**（`src/harness/tool.ts:185`），否则返回 `interrupted` error result（含已提交的部分输出）。`[直接证据]` `§7.3`「Omitted `replay` is `unsafe`.」
- **模型请求中间崩溃**：`[直接证据]` `docs/spec.md §8.3`：`request` phase 会把 `pi.live` 里 committed 的 partial 转成一条 aborted 的 `pi.assistant` entry，然后用**同样的 committed messages** 重发；恢复时 `beforeRequest` 再跑一遍。`[解读]` 模型请求是可重跑的，但不是 exactly-once：被中断的那次 partial 会作为「aborted 的助手消息」留在 transcript 里。

### 2.3 哪些 tool 必须 `replay: "safe"`（对照 built-in）

`[直接证据]` `/root/clone/pi/packages/durable/src/tools/` 里 `read.ts:91`、`write.ts:17`、`edit.ts:91`、`bash.ts:146` 四个 `defineTool` **都没有声明 `replay`**（`grep -n "replay" src/tools/*.ts` 无输出）→ 全部落到默认 `unsafe`。`[直接证据]` `src/harness/tool.ts:175`。

| tool | 声明 | 崩溃中调用后模型看到 |
|---|---|---|
| `read` | 无（→ `unsafe`） | `interrupted`，不是重读 |
| `write` | 无（→ `unsafe`） | `interrupted`，可能已写了一半 |
| `edit` | 无（→ `unsafe`） | `interrupted`，可能已改了一半 |
| `bash` | 无（→ `unsafe`） | `interrupted`，外部副作用可能已发生 |

`[解读]` 关键点：**`read` 本可以是 `safe`，但库没给。** 如果你希望崩溃后 `read` 自动重跑，得自己 `wrapTool(createReadTool(), ...)` 或自建一个声明 `replay: "safe"` 的 read；`write`/`edit`/`bash` 保持 `unsafe` 是对的（有外部副作用，重跑要靠自己的幂等）。

### 2.4 `restartLimit`（默认 5）与 park（`restart_limit`）

`[直接证据]` **只在本地 HEAD**：`README.md:214`「Once the count reaches `settings.restartLimit` (default 5; `Infinity` never parks), the task is parked: `inspect()` and the task graph show it as blocked with reason `restart_limit`, `wake()` does not count it as active, and `onReport` gets it once as `task_parked`.」`docs/spec.md §5.4`：

> Open counts every surviving `running` task as cut off: it writes the task back as `pending` with `restarts` one higher. A close is not a crash… Once `restarts` reaches `settings.restartLimit` … the task is parked… `Harness.retryTask(id)` … runs the task again.

`[直接证据]` **npm 1.3.0 没有这个能力**：published `dist/types.d.ts` 无 `restarts`，published `dist/harness/types.d.ts:565` 的 blocked 原因只有 `missing_task｜task_too_old｜migration_failed`。

`[解读]` 在 npm 1.3.0 上，一个「每次都在 checkpoint 前耗尽内存/CPU」的 task 会**无限重启**，没有 park。要拿到 crash-loop 保护，必须用本地 HEAD 构建，或在 runner 里自己数重启次数（但 npm 1.3.0 的 `TaskRecord` 连 `restarts` 都没有，只能自己在外层记）。

`[解读]` **park 的状态该怎么映射到 `done/blocked/error`**：park 的成因是「崩溃循环」，属于基础设施/进程级失败，不是 agent 自述「卡住」。按 ADR-0007「一切非 agent 自述的失败都是 `error`」，**park 应映射成 `error`，`reason=restart_limit`**，而不是 `blocked`。

`[直接证据]` 但有个坑：`docs/spec.md §5.4`「A run task that is parked keeps its conversation busy.」`[解读]` 即被 park 的 run task 不会 settle 它的 input submission，**`submission.wait()` 永远不会 resolve**。所以 runner 不能只等 `wait()`——必须同时监听 `onReport`（`task_parked`）或轮询 `inspect()`/task graph，发现 park 后自己收尾并决定 outcome。这一点在 npm 1.3.0 上更严重：没有 `task_parked` 报告，只能靠 `inspect()`（published `Harness.inspect()` 有）。

---

## 3. outcome 与结果契约（#21 第 3 条）

### 3.1 三个层级

`[直接证据]` `docs/spec.md §2.2` / `§6`：

- `Submission.wait(context)` → `SettledSubmissionRecord`，`status: "done"`（带 `answer` entry）或 `status: "unanswered"`（带 `reason`，可带 `detail`）。
- task outcome（`src/types.ts:562`）→ `completed` / `failed` / `aborted` / `orphaned`。
- `onReport(error, info)`（本地 HEAD）的 `info.type`：`session_failed`、`task_faulted`、`task_parked`、`migration_failed`、`task_outdated`、`task_error`、`extension_error`、`host_error`、`listener_error`。`[直接证据]` npm 1.3.0 是单参数 `onReport(error)`（published `dist/harness/types.d.ts:537`）。

`[直接证据]` `unanswered` 的 `reason` 取值（`§6`、`§8.3`）：`model_error`、`no_model`、`aborted`、`faulted`、`run_failed`（`afterFailedRun: "withdraw"`）、`reset`、`stale`，以及 orphaning 的 blocked 原因（`missing_task`/`task_too_old`/`migration_failed`）。

### 3.2 `control: { terminate: true }`

`[直接证据]` `README.md:181`：工具的 result 可以返回 `control: { terminate: true }`；「when every result of the round asks for it, the run ends without another model request」。`[直接证据]` `docs/spec.md §6`：`terminate` 是「successful run end」之一（连同 answer、handoff），会应用 final boundary 并把 inputs settle `done`。`[直接证据]` npm 1.3.0 的 `ToolControl.terminate?: true`（published `dist/harness/types.d.ts:93`）；本地 HEAD 改成 `boolean`（CHANGELOG Unreleased）。

`[解读]` 这正是 ADR-0007 里 `run_result` 工具那套「agent 自述 + 立刻结束本次 run」的天然对应物：agent 调一个自述工具，工具返回 `control: { terminate: true }`，run 成功收尾，`submission.wait()` 变 `done`。**不再需要** `terminate` 后去猜 `stopReason`。

### 3.3 outcome 映射表（建议）

| durable / k8s 信号 | 映射到 Outcome | reason |
|---|---|---|
| `submission.wait()` = `done`，且 agent 没自述阻塞 | `done` | — |
| `submission.wait()` = `done`，但 agent 的自述工具返回「卡住」 | `blocked` | 自述 |
| `submission.wait()` = `unanswered`，reason ∈ `model_error`/`no_model` | `error` | `model_error`/`no_model` |
| `submission.wait()` = `unanswered`，reason = `faulted`（task phase 抛异常） | `error` | `faulted` |
| `submission.wait()` = `unanswered`，reason = `aborted`（Esc/级联 abort） | `error` | `aborted` |
| `submission.wait()` = `unanswered`，reason ∈ `missing_task`/`task_too_old`/`migration_failed` | `error` | 原样 |
| run task 被 park（仅本地 HEAD） | `error` | `restart_limit` |
| `harness.closed` = `{ reason: "failed" }`（storage 错误） | `error` | `session_failed` |
| Job 被驱逐 / OOMKilled / DeadlineExceeded / 超时 | `error` | k8s 层原因 |
| 已终态但 App 读不到 result/annotation | `error` | `no-result`（ADR-0007 兜底） |

`[解读]` 与 ADR-0007 一致：`blocked` **只**留给「agent 正常跑完但自述卡住」；其余全 `error`，细分原因进 `reason`。`[直接证据]` ADR-0007「outcome 描述这次运行是怎么结束的……一切非 agent 自述的失败……都是 `error`」。

### 3.4 runner 退出前能拿到什么、annotation 的时机与原子性

`[直接证据]` runner 能读：`submission.wait()` 的结果、`harness.inspect()`（`HarnessInspection`：tasks + submissions）、`harness.getTask(id)`、`harness.usage()`、`conversation.viewState()`/`watch()`、`harness.taskGraph()`。

`[解读]` **写 Job annotation 的时机**：在「outcome 已确定」之后、「进程退出」之前。原子性有两层但**没有跨层事务**：(a) durable 的一次 commit 是原子的（`§1` invariant 1）；(b) k8s annotation 更新是单个对象的 PATCH，本身原子。两者之间没有事务，所以顺序只能是「先让 durable 落定 → 再写 annotation」。`[解读]` ADR-0007 的 wrapper 层可以保留，但**结果载体**从「读 `$RUN_RESULT_PATH` 文件」换成「读 durable 状态」；annotation 的字段（`remote-agent/run-result`）与 `{v, outcome, summary, ...}` 形状可以不动。

### 3.5 `harness.closed` 的 `failed` 分支怎么让 k8s 重启 pod

`[直接证据]` published `README.md:715-721`（本地同）：

```ts
harness.closed.then((end) => {
  if (end.reason === "failed") reopen(end.error);
});
```

`[直接证据]` `docs/spec.md §10.1`：storage 错误会结束 Session，`closed` settle `{ reason: "failed", error }`；「Reopening recovers from what was committed, which is always consistent, because commits are atomic; a call that threw may or may not have committed, so a host that resubmits after reopening reuses its `requestId`」。

`[解读]` 让 k8s 重启 pod 的最小形态：runner 在 `closed.reason === "failed"` 时 `process.exit(1)`，Job 设 `restartPolicy: OnFailure`；容器重启后重新 `Harness.open(sqlite)` + `resume()`，从最后一个 checkpoint 续。`[推断]` 如果不想靠容器重启，就由 App 在 Job 失败后按确定性名重建 Job（ADR-0001 的幂等 reconcile 天然支持）。`[直接证据]` 注意 `§10.1` 还警告：忽略 abort signal 的 task 代码会让 `close()` 一直 pending（`README.md` 同）。`[解读]` 所以 runner 自己的 tool/hook 必须响应 `context` 取消，否则重启会被拖住。

---

## 4. provider 接线（#21 第 4 条）

### 4.1 最小可用形态

`[直接证据]` `createModels()`（`packages/ai/src/models.ts:1012`）→ `models.setProvider(provider)`（`:412`）；`createProvider()`（`:1061`）要求 `id` + `auth` + `models` + 至少一个 `api`/`images`/`classifiers`（`:1023` 注释、`:1067` 校验）。`[直接证据]` `createProvider` 的注释（`models.ts:1054`）：「Built-in provider factories and models.json custom providers both go through this.」

`[直接证据]` OpenAI 兼容端点的现成 API 实现是 `openAICompletionsApi()`（`packages/ai/src/api/openai-completions.lazy.ts:4`），DeepSeek 就是这么接的（`packages/ai/src/providers/deepseek.ts`）：

```ts
createProvider({
  id: "deepseek",
  baseUrl: "https://api.deepseek.com",
  auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
  models: Object.values(DEEPSEEK_MODELS),
  api: openAICompletionsApi(),
});
```

`[解读]` OmniRoute 的最小接线（`[推断]`，OmniRoute 的具体 baseUrl/api 未在 primary sources 内）：

```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const models = createModels();
models.setProvider(createProvider({
  id: "omniroute",
  baseUrl: "http://omniroute.<ns>.svc.cluster.local:8080/v1",
  api: openAICompletionsApi(),
  auth: { apiKey: envApiKeyAuth("OmniRoute key", ["OMNIROUTE_API_KEY"]) },
  models: [
    { id: "default", name: "OmniRoute default", provider: "omniroute", api: "openai-completions",
      reasoning: true, input: ["text"], cost: {...}, contextWindow: 200000, maxTokens: 32768 },
    { id: "review",  name: "OmniRoute review",  provider: "omniroute", api: "openai-completions",
      reasoning: true, input: ["text"], cost: {...}, contextWindow: 200000, maxTokens: 32768 },
  ],
}));
```

`[直接证据]` `envApiKeyAuth`（`packages/ai/src/auth/helpers.ts:9`）语义：先看 stored credential，再依次看给定的 env var；都没有则 `resolve()` 返回 `undefined`。`[直接证据]` `Models.applyAuth` 在 `getAuth` 返回 `undefined` 时抛 `ModelsError("auth", "Provider is not configured: ...")`（`models.ts:867-869`）。

`[解读]` **若 OmniRoute 在集群内无需 key**：不能直接用它 + `envApiKeyAuth`（没设 env var 就「未配置」，每个请求都抛 auth 错）。需要一个**总是 resolve 出占位 key** 的自定义 `ApiKeyAuth`（`resolve: async () => ({ auth: { apiKey: "omniroute" } })`）。`[推断]` 这是 v1 最可能的形态，因为 GLOSSARY 说「Job 从不持有上游 key」。

`[未确认]` OmniRoute 是否需要 key、baseUrl 具体值、`default`/`review` 的真实 model id 与 thinking 映射——primary sources 未提供；`research/pi-afk-contract` 也已把这两条标为未确认。

### 4.2 `configure({ model, thinkingLevel })` ↔ pi 的 `--model` / `--thinking`

`[直接证据]` `AgentState`（`docs/spec.md §2.2`）：`model?: ModelRef { provider, modelId }`、`thinkingLevel?: ModelThinkingLevel`；`configure(tx, conversationId, change)` 或 `conversation.configure(change, context)`。

`[直接证据]` pi CLI 的 `--model`（`packages/coding-agent/src/cli/args.ts:117`）支持 `provider/id` 与 `:<thinking>` 后缀，`--thinking`（`:167`）取值 `off|minimal|low|medium|high|xhigh|max`（`:61`），默认 `medium`（`packages/coding-agent/src/core/defaults.ts:3`）。`[直接证据]` pi-ai 的 `ModelThinkingLevel` 同一组值（`models.ts:1242` `["off","minimal","low","medium","high","xhigh","max"]`）。

`[解读]` 对应关系：

| pi CLI | durable |
|---|---|
| `--model omniroute/default` | `configure({ model: { provider: "omniroute", modelId: "default" } })` |
| `--model omniroute/default:high` 或 `--thinking high` | `configure({ model: {...}, thinkingLevel: "high" })` |
| `--provider omniroute --model default` | 同上（provider 就是 `ModelRef.provider`） |

`[直接证据]` generation 在 `request` phase 把 `thinkingLevel` 当 `reasoning` 传给 pi-ai（`src/harness/generation.ts:231`：`thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }`）。

### 4.3 两个 model id（default / review）

`[直接证据]` 两个 id 就是 provider `models` 数组里的两个条目；每个 conversation 用各自的 `AgentState.model` 选择。`[直接证据]` `test/examples/28-reviewer.ts:79-90`：reviewer 用 `createConversation({ agent: { model: { provider: "faux", modelId: "small" }, ... } })` 拿到与主 agent 不同的模型。

`[解读]` 主 runner 用 `configure({ model: { provider:"omniroute", modelId:"default" } })`；reviewer conversation 用 `{ provider:"omniroute", modelId:"review" }`。`[直接证据]` `28-reviewer.ts:73-77` 的 faux 模型就是 `[{id:"big"},{id:"small"}]` 两个条目。

### 4.4 非密 / 密值怎么分

`[直接证据]` models.json（coding-agent 侧）的 provider 配置支持 `baseUrl`、`api`、`models`、`modelOverrides` 与 `apiKey`；`apiKey` 的取值是「literal / `$NAME` 环境插值 / `!command` 输出」（`packages/coding-agent/src/core/model-config.ts:73-114`，`:47` ModelDefinitionSchema，`:89` ProviderConfigSchema）。`[直接证据]` 但 **models.json 的解析在 `@earendil-works/pi-coding-agent`，不在 pi-ai**；durable 的 `createModels()` 不读 models.json。`[直接证据]` `ModelRuntime` 从 coding-agent 导出（`packages/coding-agent/src/index.ts:235`），`packages/evals/evals/configured-runtime.ts:56` 就是用它加载 `models.json`。

`[解读]` 两条路：

- **(a) 代码里 `createProvider`（推荐 v1）**：baseUrl/api/model id 非密，直接写进 runner 代码或 ConfigMap；key 密，从 env 读（sops secret → env → `envApiKeyAuth`）。不引入 coding-agent。
- **(b) 复用 `ModelRuntime` + models.json**：配置外置、可用 `$ENV` 插值，但会把整个 `@earendil-works/pi-coding-agent` 拉进 runner 镜像（也正是我们要换掉的旧 runtime 那一摊）。`[推断]` v1 不划算。

`[解读]` 与 GLOSSARY「Job 从不持有上游 key」一致：runner 只持有 **OmniRoute 的地址（非密）**，必要时持有 **OmniRoute 的 key（密，env）**，从不持有上游 provider 的 key。

---

## 5. skills 与 subagent（#21 第 5 条）

### 5.1 durable 没有 Skill 工具、没有 slash command

`[直接证据]` durable 的 `/tools` 只导出 `read`、`write`、`edit`、`bash`（+ `powershell`）与 `CodingTools`（`src/tools/index.ts`）；包内 `grep renderSkills|Skills` 只命中 `docs/spec.md` 与 `test/spec-usage.test.ts`（后者是 `declare function renderSkills(): string | undefined;`，纯类型占位）。`[直接证据]` 全仓 `grep renderSkills packages/` 只有这两处，**没有实现**。

`[解读]` **结论：skills 必须自研。** durable 没有「扫目录、按需加载、slash command」这套；它只有 `section()`（把文本拼进 system prompt）和 `defineTool()`（模型可调的工具）。`[直接证据]` `docs/spec.md §7.4`：prompt 由各 extension 的 sections 渲染，`section("skills", renderSkills)` 里的 `renderSkills` 是**参考草图的函数名**，输入输出形态由你定。

### 5.2 规范里那几个 extension 的参考设计到什么程度

`[直接证据]` `docs/spec.md:2783-2800` 是一段**参考代码**（在「Extensions」讲解里），不是随包发布的实现：

```ts
export const ContextFiles = defineExtension({ name: "context-files", sections: [section("agents-md", renderAgentsMd)] });
export const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
export const Permissions = defineExtension({
  name: "permissions",
  hooks: [hook(ToolTask, { beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});
export const Reviewer = defineExtension({
  name: "reviewer",
  sections: [section("role", () => "You review diffs. Report problems as a list. Never edit files.")],
  hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
});
```

`[解读]` 可用程度：

- `Permissions`：**可直接用**——`hook(ToolTask, { beforeTool })` 是完整 API（`docs/spec.md §7.2`）。`[直接证据]` `test/examples/28-reviewer.ts` 之外，`test/examples/30-tool-override.ts` 也用了 hook/wrap。
- `Reviewer`：**骨架可直接用**（`section` + `hook(GenerationTask, { onYield })`），`[直接证据]` `test/examples/28-reviewer.ts` 就是可运行的实现（role section + `onYield` 循环）。
- `ContextFiles`/`Skills`：**只是形状**。`renderAgentsMd`/`renderSkills` 是你要写的渲染函数；`section` 的输入是「resolved agent + env + committed documents」（`docs/spec.md §7.4`、`README.md` System Prompt）。`[未确认]` 没有目录扫描、没有按需加载、没有 slash command 的内置语义——这些得 runner 自己定。

`[直接证据]` `section()` 的输入形态（`README.md` System Prompt）：`section("cwd", (input) => input.env?.cwd)`，其中 `input` 是 `PromptInput`（`resolved agent`、`env`、committed documents）。`[直接证据]` `test/examples/26-coding-agent.ts:31-34` 演示了 `section("preamble", ...)` 与 `section("cwd", (input) => input.env?.cwd)`。

`[解读]` **`renderSkills` 的输入形态**：既然没有内置扫描，v1 最省事的形态是「runner 在启动时读挂载的 skills 目录，把内容拼成一个字符串，用一个闭包 section 返回」——即 `section("skills", () => skillsText)`。`[未确认]` mattpocock-skills 的 SKILL.md 格式与「按需加载」语义（`/implement` 之类）没有 primary source 说明 durable 能理解它；那属于 prompt 工程，不是 durable 能力。

### 5.3 subagent 自研要抄哪段

`[直接证据]` `test/examples/22-subagent-foreground.ts`（foreground，可运行）：

- `replay: "safe"`（`:47`）——崩溃重跑能找到同一个 child 与同一个 submission。
- 在 `api.commit()` 里 `tx.scanConversations({ ownerTaskId: api.taskId }, 1)` 找已存在的 child，找不到才 `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })`（`:53-58`）。
- `api.details({ conversationId: child })`（`:64`）让 UI 能挂到 child。
- `requestId: \`subagent:${api.taskId}\``（`:67`）——重跑拿到同一个 submission。
- child 默认复制 owner 的 agent（model/thinking/extensions/tools/cwd），再用 `configure(tx, child.id, { extensions: { remove: [Subagent] } })` 去掉递归（`:59`）。

`[直接证据]` `test/examples/23-subagent-background.ts`（background，可运行）：

- **anchor**：一个「立刻完成」的 background task（`Anchor`，`:62-70`），child conversation 由它 `ownership: { kind: "task", taskId: anchor }` 拥有（`:192`），这样 main agent 的 Esc/idle 不波及 subagent。
- **reporter**：每个 message 一个 background task（`Reporter`，`:80-124`），`deliver` phase 提交消息并等答案，`report` phase 把答案作为 follow-up 投回 main（`:117`）；`requestId` 保证重启不重复投递（`:91`、`:117`）。
- `replay: "unsafe"`（`:147`）给管理型 subagent 工具——`[直接证据]` 注释「A call interrupted by a crash is not rerun: repeating `stop` could stop newer work.」`[解读]` 这是「有副作用的管理操作不该自动重跑」的范例。
- `background: { ownership: { kind: "conversation" }, background: true }`（`:187`）。

`[解读]` **v1 该抄哪段**：如果 reviewer 只是「在同一个 run 里跑一次、要答案」，抄 `22`（foreground，最简单）；如果要「长跑、可多次 steer/stop」，抄 `23`（anchor + reporter）。`[直接证据]` `README.md`「Abort and Subagents」把两者都列为 product code 范式。

### 5.4 reviewer：独立 conversation 还是独立 Job

`[直接证据]` `test/examples/28-reviewer.ts:79-90` 用的是**独立 conversation**：`harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: small, extensions: [CodingTools, Reviewer], tools: [readTool], cwd: worktree } })`——自己的模型、自己的 extensions、只读工具、自己的目录，且注释说「A restart keeps all of it.」

`[解读]` **推荐独立 conversation，而不是独立 Job。** 理由：(a) 同一个 storage 里，reviewer 的会话天然跟着主 run 一起续跑（独立 Job 要自己一块卷、自己一份 storage，且跨 Job 拿不到主 run 的上下文）；(b) `28` 已经证明「独立模型 + 独立工具集 + 独立 cwd」都能 per-conversation 配置；(c) 独立 Job 只在「reviewer 必须跨 pod 隔离」时才值得，而 v1 的隔离边界是 Job（ADR-0003），不需要再切一层。`[直接证据]` `docs/spec.md §12` 的 footgun 提醒：foreground 的 child 会 hold owner（`completing` 到 child 结束）；要「不 hold」就用 `background`（`23` 的 anchor）。`[解读]` reviewer 通常希望阻塞主 run（等它的意见），所以 foreground/`22` 形态更自然。

---

## 6. 打包与版本（#21 第 6 条）

`[直接证据]` npm：`@earendil-works/pi-durable@1.3.0`、`@earendil-works/pi-ai@1.3.0`、`@earendil-works/chord@1.3.0`（durable 的 dependencies 里三者版本对齐，`packages/durable/package.json`）。`engines.node` = `>=22.19.0`（durable 与 pi-env 都是）。无 `bin`。`[直接证据]` `npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord`（`README.md` Installation）。

`[直接证据]` durable 是 ESM（`"type": "module"`）；SQLite 走 Node 内置 `node:sqlite`（`src/storage/sqlite/node.ts` 从 `@earendil-works/chord/sqlite/node` 拿 `openNodeSqliteDatabase`）。`[直接证据]` example 的跑法是 `node --conditions=source --experimental-strip-types test/examples/xx.ts`（`README.md` Examples）——`--conditions=source` 让 import 解析到 `src/*.ts`，仅开发用。

`[解读]` **镜像里怎么装（与 ADR-0005 的关系）**：

- ADR-0005 说镜像 remote-agent 自建、不 `FROM` sandcastle-pi，因为要自己的 entrypoint 契约。换成 durable 后**这条依然成立**：镜像仍自建，只是 entrypoint 从「跑 `pi -p` + 写 annotation」变成「跑 runner TS 程序 + 写 annotation」。
- 镜像需要：Node ≥ 22.19（满足 `node:sqlite`）、`npm install` 三个包、把 runner 用 `tsc` 编译成 JS（生产不建议 `--experimental-strip-types`）。`[推断]` 因为 durable 的 npm 包只发布 `dist`（编译后 JS），runner 侧自己编译即可。
- `[直接证据]` durable 的 npm 包**不含** `docs/spec.md`（`files` 只含 `dist`/`README.md`/`CHANGELOG.md`）。`[解读]` 钉版时不能指望在镜像里查规范；规范要留在 remote-agent 的这份 research 笔记 + 指向 `/root/clone/pi` 的 commit。
- `[直接证据]` `README.md:3`「**Experimental.** The API changes without notice between releases.」`[直接证据]` CHANGELOG 的 `[Unreleased]` 段已经列了 4 条 Breaking Changes（`sleep` 移除、`sleeping` 状态、SQLite schema v2 不可回滚、`restartLimit` 默认行为、`checkpointWhen` 必填）。`[解读]` 见文末「风险与钉版策略」。

`[未确认]` runner 的构建产物形态（单文件 bundle / `dist` + `node_modules`）、镜像里 Node 的确切版本——不在本票 primary sources 内。

---

## 7. pi-env 是否进方案（#21 第 8 条）

`[直接证据]` `@earendil-works/pi-env@1.3.0`：`engines.node >=22.19.0`，`dependencies` 含 `@earendil-works/pi-durable@1.3.0`。`[直接证据]` 实测下载 npm tarball，`bin/` 下**恰好 8 个预编译 daemon**：`pi-env-{linux,darwin,android,windows}-{x64,arm64}`（windows 是 `pi-env.exe`）。`[直接证据]` `README.md`「The package ships the daemon for every supported remote system in `bin/`.」

`[直接证据]` 传输是通用的：`ConnectionOptions.command`（`src/connection.ts:66-73`）是「任何能 spawn 出 daemon 的命令」，注释给的例子就是 `["ssh","-T","--","host","~/.pi/mobile/tools/pi-env"]`；`localDaemon()`（`src/ssh.ts:362`）返回本机 daemon 路径，`new Connection({ command: [localDaemon()] })` 即可本机跑。`[直接证据]` daemon 是 framed protocol over stdin/stdout（`docs/protocol.md`「Version 1. The client starts `pi-env serve --token <hex>` … talks to it over the process's stdin and stdout.」）。`[解读]` 所以它**不绑定 SSH**，只要能 spawn 一个进程即可——这是「pod 只当沙箱」时能用的关键。

`[直接证据]` `RemoteExecutionEnv` 是 durable `ExecutionEnv` 的远端实现（`src/remote-env.ts:354`），并实现可选 `listFiles()`（`:724`）；`RemoteWatcher`（`src/watch.ts:23`）与 `openTerminal()`（`src/terminal.ts:93`）都从 index 导出。`[直接证据]` `README.md`：「`openTerminal(connection, options)` runs a program … in a pseudo-terminal of the daemon … for interactive terminals.」`[直接证据]` `docs/semantics.md` 开头：「The reference is Durable's `NodeExecutionEnv` … on the remote machine.」`[直接证据]` 它**不是沙箱**：没有任何隔离/权限模型，只是「在另一台机器上执行文件与命令」。

`[解读]` **v1 是否用得上**：**用不上。** v1 是「runner 与工具同在一个 pod、worktree 在 PVC 上」——此时 `NodeExecutionEnv`（`README.md` Environment）就够了，`env: ({ cwd }) => new NodeExecutionEnv({ cwd })`。pi-env 的价值在「harness 移出 pod」（长驻 runner 持有存储与凭证、pod 只当沙箱），那是 #1 的「Not yet specified」里的「沙箱与 worker 分离」，不是 v1。

`[解读]` **它在缺口 B 里的位置**：如果以后 harness 移出 pod，`openTerminal` 就是「人接进去看历史/操作」的现成通道，`RemoteWatcher` 是文件变更流，`listFiles` 是目录列举。但它**不解决** base PVC / 快照那一摊（`[直接证据]` 它只是传输层 + `ExecutionEnv`，没有任何卷/快照语义）。

---

## 对缺口 B（人接进去看历史）的约束

这一节是 #21 第 7 条的专门展开。约束的根源只有一条：`[直接证据]` `README.md:788`「One process owns a storage at a time; there is no cross-process locking.」

`[解读]` 这条约束**排除**掉以后这些做法：

1. **「App 或人在 Job 跑的时候打开同一个 session sqlite 读」——不行。** durable 无跨进程锁，第二个进程开同一个文件会与 runner 的 mutation line 并发写/读，SQLite 层面即使不立刻损坏，durable 的「commits are atomic + only committed state observable」在跨进程时也没有保证（它假设单写者）。`[直接证据]` `§4`「The Session owns the mutation line, so storage implementations do not add a second caller-facing commit mutex.」
2. **「两个 attach pod 同时挂同一块 session PVC」——不行。** 同上；而且 k8s 的 `ReadWriteMany` 也不会给 durable 加锁。
3. **「运行中实时 tail」——不行。** 只能在 Job 不跑时（或由 runner 自己通过 `watch()`/`watchEvents()` 转发出去）读。`[直接证据]` `README.md`「Watching a Conversation」：`viewState()`/`watch()`/`watchEvents()` 都是**进程内**的 API，不是跨进程通道。
4. **「把 session sqlite 放在会被快照/复制并可能同时挂两处的卷上」——不行。** 任何「同一份存储被两个进程打开」的形态都违反单写者。

`[解读]` **可行的形态**（现在就要为它们留余地）：

- **只读副本 / 导出**：Job 不跑时，把 session sqlite 复制一份（或 `sqlite3 .backup` / 导出 JSON），人或 App 打开**副本**读。这就要求 session 文件是**普通文件**、能被单独复制——**不要把 session sqlite 和一次性工作副本绑死在同一个「用完即弃」的卷上**（否则 Job 一结束、卷一删，历史就没了）。这正是 #22 Notes 里「工作副本 + session sqlite 同卷」需要重新权衡的点：同卷可以，但卷的**生命周期**必须比 Job 长（error/blocked 保留证据是既有倾向，done 时是否保留要定）。
- **Job 不跑时独占打开原存储**：人/App 在 Job 终止后打开同一 sqlite（只读或读写）——这要求卷在 Job 结束后仍存在，且 App 有权限挂它（`[未确认]` 当前 App Role 的权限面；#1 提到 App Role 没有 `pods/exec`）。
- **运行时通道只能由 runner 自己开**：runner 可以 `watch()` 并把 frame 转成某种外部可读通道（HTTP/stream），但那是新增一个有状态的服务面，撞 ADR-0001/ADR-0002，需要单独论证。

`[解读]` **现在就要避开的三个设计选择**（否则把缺口 B 堵死）：

1. 不要选「Job 结束就删卷」。至少 error/blocked 保留（既有），done 也建议保留一段（否则「接着它之前的跑」无家可归）。
2. 不要把 session sqlite 放进**临时/内存**存储（`MemoryStorage`）——durable 支持 `MemoryStorage`（`README.md` Storage 表），但它不持久，崩溃即失，缺口 B 也就无从谈起。
3. 不要把 session 只放在 NFS 上——它本来就该在 block 卷（见 §1.2），且 NFS 的锁语义会让「以后想加只读副本/独占读」更难。

`[直接证据]` `docs/architecture.md` 第 8 节把缺口 B 的三条张力（ADR-0001/0002/0007）已列出；本笔记只补 durable 侧的硬约束。

---

## pi-durable 的风险与钉版策略

`[直接证据]` 风险清单：

1. **experimental，API 无预警变更**：`README.md:3`「The API changes without notice between releases.」`[直接证据]` CHANGELOG 的 `[Unreleased]` 已列 4 条 Breaking Changes（`sleep` 移除、`sleeping` 状态、SQLite schema v2 不可回滚、`checkpointWhen` 必填）。
2. **npm 1.3.0 落后于源码**：`[直接证据]` 本笔记 §证据基线实测——npm 1.3.0 **没有** `restartLimit`/park、`sleepUntil`、`setTimer`/`onWake`/`wake()`、`retryTask`、`afterFailedRun`、双参数 `onReport`；`checkpointWhen` 在 1.3.0 是可选的。`[解读]` 如果 #22 的续跑设计依赖 crash-loop 保护（它应该依赖），**npm 1.3.0 拿不到**。
3. **规范不随包发布**：`[直接证据]` `files` 只含 `dist`/`README.md`/`CHANGELOG.md`；`docs/spec.md` 不在包里。
4. **无 CLI**：`[直接证据]` package.json 无 `bin`。`[解读]` 这既是「换基座」的原因，也是「所有编排都得 runner 自己写」的成本。
5. **`engines.node >= 22.19`**：`[直接证据]` durable 与 pi-env 都是。`[解读]` 镜像的 Node 必须 ≥ 22.19（`node:sqlite`）。
6. **崩溃点粒度粗**：`[直接证据]` phase 内不 checkpoint（`§5.6`）、built-in 工具全 `unsafe`（`src/tools/*.ts`）。`[解读]` 「接着跑」的粒度是 phase，不是 tool call；一次长 phase（比如一个长 bash）崩溃后会整段重来。
7. **storage 错误致命**：`[直接证据]` `§10.1`「A storage error ends the Session.」`[解读]` sqlite 所在的卷一旦出问题，整个 run 失败 → `error`。

`[解读]` **钉版策略建议**：

- **钉到 commit，不只钉 npm 版本**。在 remote-agent 里记录 `/root/clone/pi` 的 `git describe`（当前 `v1.3.0-61-g16f5f0af4`），并把 durable 作为 **git 依赖或 vendored source**（`file:` / `git+`），而不是 `npm install @earendil-works/pi-durable@1.3.0`。理由：本笔记要用的 `restartLimit`/`sleeping`/`setTimer` 等只在该 commit 上。`[推断]` 若坚持 npm，则必须**放弃** crash-loop 保护并在 runner 层自己实现重启计数。
- **升级窗口**：experimental + Unreleased 已经跨了 4 条 Breaking Changes，说明「升级 = 改代码」。钉死一个 commit，把升级做成**显式的、跑一遍 example/conformance 的窗口**，不要浮动。`[直接证据]` `packages/durable` 自带 `registerStorageConformance`（`README.md` Storage）与 `registerEnvConformance`（`README.md` Environment），升级时可当回归基线。
- **把规范快照进 remote-agent**：既然 `docs/spec.md` 不随包发布，钉版时应把该 commit 的 spec/README 关键段落（或整份 spec）记进 remote-agent 的 `docs/research/`，否则以后无法对照。本笔记已覆盖 #21 相关的部分。
- **三个包版本对齐**：durable 的 dependencies 里 `@earendil-works/chord`/`pi-ai`/`pi-codemode`/`pi-telemetry` 都钉 `1.3.0`（`packages/durable/package.json`）。钉版时四个一起钉，避免混版。
- **与 renovate 的关系**：地图 #1「Not yet specified」里已有「pi / skills / 镜像依赖的版本升级策略（renovate）；含 pi-durable 的 experimental API 漂移（钉死版本 + 升级窗口）」——本笔记给它提供了具体理由（npm 1.3.0 ≠ 源码 HEAD）。

---

## 未确认清单

- **OmniRoute 的具体接线**：baseUrl、是否需要 key、`default`/`review` 的真实 model id、thinking 映射——primary sources 未提供（`research/pi-afk-contract` 亦同）。
- **k8s Job 的 pod 替换语义**在优雅终止窗口内是否可能短暂双 pod：本笔记给的是「durable 无锁，防线在 Job 层」的定性结论，未对某个 k8s 版本的 Job 控制器行为做实测。
- **v1 是否每 ticket 一块 PVC**、卷的 access mode、Job 名的具体格式：不在本票 primary sources 内，留给 #22。
- **`renderSkills`/skills 的输入形态**：规范只给了函数名，没有目录扫描/按需加载的内置语义；mattpocock-skills 的格式是否可被 durable 理解，属于 prompt 工程，未确认。
- **npm 1.3.0 与本地 HEAD 之间是否还有其他影响 AFK 的差异**：本笔记只对 #21 相关 API 做了 grep 核对，未做完整 diff。
- **pi-env daemon 在 pod 内以 `localDaemon()` 跑（无 SSH）的真实可行性**：README/源码说 `Connection({ command })` 通用、`localDaemon()` 返回本机路径，但未实测在 k8s pod 里跑 daemon。
