# pi 的 AFK 调用契约：`pi -p --mode json` 到底保证什么

调查对象：GitHub issue #6（wayfinder:research）。调用形态：`pi -p --mode json -- "${prompt}"`。

## 证据基线与版本

- 安装的 pi CLI：`pi --version` → `1.3.0`（实测）。
- pi 官方文档（随 1.3.0 安装）：`/root/.local/share/mise/installs/pi/1.3.0/pi/docs/`。
- pi 源码：`/root/clone/pi`，HEAD = `73f8de80b`，`git describe` = `v1.3.0-42-g73f8de80b`。
  - 本笔记引用的每个源码文件都用 `git rev-list v1.3.0..HEAD -- <file>` 验证过：**自 v1.3.0 起 0 次提交**，即与 1.3.0 安装版一致。涉及文件：`packages/coding-agent/src/modes/print-mode.ts`、`main.ts`、`core/extensions/runner.ts`、`core/session-manager.ts`、`modes/json-event.ts`、`packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`。
- sandcastle 对照实现：`/root/clone/sandcastle/src/AgentProvider.ts`、`SessionStore.ts`、`Orchestrator.ts`。其 pi 解析注释自称「Verified against @mariozechner/pi-coding-agent 0.73.1」（`AgentProvider.ts:550-553`），比 1.3.0 旧，需按 1.3.0 复核。
- 标注约定：`[直接证据]` = 源码/官方文档原文或实测；`[解读]` = 我对直接证据的解释；`[推断]` = 未被直接证据覆盖的推理；`[未确认]` = 没找到 primary source，不猜。

---

## 结论速览

| # | 问题 | 一句话结论 |
|---|---|---|
| 1 | 退出码语义 | **JSON 模式下退出码不反映 agent 失败**：`error`/`aborted`/`length` 都可能是 0。只有「调用本身抛错」才非 0；SIGTERM=143、SIGHUP=129、SIGINT=130（Node 默认）。pi 没有「agent 自判没做完」的退出码。 |
| 2 | stdout json 流 | 严格 JSONL：第一行 `session` header，然后是 session 事件。**pi 1.3.0 没有 `type:"result"` 事件**；最终答复取 `message_end`（role=assistant）或 `agent_end.messages` 里最后一条 assistant 文本。 |
| 3 | 截断 | JSONL 逐行解析，残缺的**最后一行**解析失败可跳过，之前完整事件仍可用。被 kill 时 `writeRawStdout` 串行队列里未 flush 的字节可能丢失；SIGTERM handler 不 flush 就 `process.exit(143)`。 |
| 4 | session 位置 | `~/.pi/agent/sessions/--<encoded-cwd>--/<ISO时间戳>_<session-id>.jsonl`，print/json 默认持久化。逐条 `appendFileSync`，被 kill 也保留到最后一条已落盘 entry。 |
| 5 | 模型/thinking | `--model <provider>/<id>`（或 `--provider X --model <id>`），可选 `:<thinking>` 后缀；`--thinking off\|minimal\|low\|medium\|high\|xhigh\|max`。model id 由 provider 决定，`default`/`review` 属于 OmniRoute 侧的 id。 |
| 6 | 非交互下的确认 | 内置工具不问确认；扩展 UI 弹窗在 print/json 下是 no-op（confirm→false）；project trust 在非交互下自动判为「不信任」不阻塞。**唯一已知会读 stdin 阻塞的是「跨项目 session fork?」确认**。 |

---

## 1. 退出码语义

### 1.1 JSON 模式：agent 失败不产生非 0

`[直接证据]` `print-mode.ts:35` `let exitCode = 0;`；失败判定只写在 `if (mode === "text")` 分支里（`print-mode.ts:139-157`）：

- `stopReason === "error" || "aborted"` → `exitCode = 1`（`:145-147`）
- `stopReason === "length"` → 打印警告到 stderr、`exitCode = 1`（`:154-156`）
- `return exitCode`（`:162`）；只有 `prompt()` 抛异常才走 `catch` → `return 1`（`:163-165`）

JSON 模式走同一函数但 `mode === "json"`，**不进入 `if (mode === "text")` 分支，`exitCode` 保持 0**，只在订阅回调里写事件（`print-mode.ts:108-110`）。

`[直接证据]` 官方文档同口径：`docs/cli-integration.md:46`「A failed or aborted assistant response appears in the event stream but **does not by itself produce a nonzero exit status**. Inspect the events when success or failure matters. Pi still exits nonzero if the invocation throws an error.」对照 text 模式 `docs/cli-integration.md:30` 明确说 error/aborted/length 会产生非 0。

`[直接证据]` 为什么 provider 报错不会让 `prompt()` 抛异常：agent 把失败转成一条 assistant 消息——`packages/agent/src/agent.ts:533-543` `handleRunFailure` 构造 `stopReason: aborted ? "aborted" : "error"` 的 assistant 消息，然后 `agent-loop.ts:245-253` 发 `turn_end` + `agent_end` 并**正常 return**。所以一次「模型 401 / 限流 / 断流」在 JSON 模式下通常退出码 0。

### 1.2 什么情况非 0

`[直接证据]` 调用级错误 → `process.exit(1)` / `process.exitCode`：

- 缺 model：`main.ts:928-930`（`formatNoModelsAvailableMessage` 后 `process.exit(1)`）
- 启动期 runtime diagnostics 有 error：`main.ts:916-925`
- session 记录的 cwd 不存在且非交互：`main.ts:705-707`（`MissingSessionCwdError` → `process.exit(1)`）
- 参数/flag 校验：`main.ts:311/326/334/344/354/373/387/411` 等
- 写 stdout 失败：`core/output-guard.ts:88-92` `void rawStdoutWriteTail.catch(() => process.exit(1))`
- `runPrintMode` 抛异常：`print-mode.ts:163-165` → 1，再由 `main.ts:996` `process.exitCode = exitCode`

### 1.3 信号

`[直接证据]` `print-mode.ts:50-68` 只注册 `SIGTERM` 与（非 win32 的）`SIGHUP`：handler 里 `killTrackedDetachedChildren()` → `disposeRuntime()` → `process.exit(signal === "SIGHUP" ? 129 : 143)`。

`[直接证据]` print/json 路径没有注册 `SIGINT`（全仓 `grep SIGINT` 只命中 interactive-mode 的 suspend 逻辑与 rpc）。因此 SIGINT 走 Node 默认：`[实测]` node v24.22.0，`kill -INT` → exit 130，`kill -TERM` → exit 143。`[解读]` k8s 的优雅终止默认发 SIGTERM → pi 主动 `exit(143)`；无 TTY 的 AFK 场景不会有 Ctrl-C。

`[未确认]` OOM kill（SIGKILL / cgroup OOM）在 pi 侧无法自证：进程被 SIGKILL 时没有任何退出码语义，需要由 k8s Job/Pod 的 `OOMKilled` 状态或 sandbox exec 的退出码判定。这些来源不在本次 primary sources 内。

### 1.4 「agent 自己判断没做完」

`[解读]` pi 没有这种信号。agent 的「做完了 / 没做完 / 阻塞」只体现在它的最终文本里（例如应用自定义的 completion signal），退出码一律 0。`[直接证据]` 佐证：JSON 模式没有任何根据文本内容改退出码的代码路径（`print-mode.ts` 全文）；sandcastle 也是靠扫文本里的 `<promise>COMPLETE</promise>` 判完成（`Orchestrator.ts:246` `DEFAULT_COMPLETION_SIGNAL`），而不是退出码。

**对 App 的含义**：`ready-for-human,agent:error`（非正常退出）与 `agent:blocked`（正常退出但没做完）**不能靠退出码区分**。`[推断]` 必须解析事件流 + 最终文本。这是本票最重要的结论。

---

## 2. stdout 的 JSON 流

### 2.1 框架

`[直接证据]` `docs/json.md:15`：严格 JSONL，每条一个 JSON 对象 + LF；只在 LF 切分；`docs/json.md:19` stdout 只放 JSONL，诊断走 stderr；读取方要持续消费，否则管道写满会卡住 pi。

`[直接证据]` 第一行是 session header（`print-mode.ts:122-126`；`docs/json.md:23`）：`{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}`。

### 2.2 事件类型（pi 1.3.0）

`[直接证据]` 事件类型来自 `AgentSessionEvent`（`core/agent-session.ts:196-230`）+ 基础 `AgentEvent`（`packages/agent/src/types.ts:516-539`）。官方参考 `docs/json.md:50-160`：

- 生命周期：`agent_start`、`agent_end{messages,willRetry}`、`agent_settled{aborted}`、`turn_start`、`turn_end{message,toolResults}`
- 消息：`message_start{message}`、`message_update{usage,assistantMessageEvent}`、`message_end{message}`
- 工具：`tool_execution_start/update/end`
- 队列/状态：`queue_update`、`entry_appended`、`session_info_changed`、`thinking_level_changed`
- 压缩/重试：`compaction_start/end`、`auto_retry_start/end`、`summarization_retry_*`

`[直接证据]` `message_update` 在线上是 delta-only：`toJsonEvent` 剥掉了累计 `partial` 快照（`modes/json-event.ts:50-66`；`docs/json.md:91-93`）。

### 2.3 「最后一条 result」不存在

`[直接证据]` pi 1.3.0 的 `AgentSessionEvent` / `AgentEvent` 联合里**没有 `type:"result"`**（`core/agent-session.ts:196-230`、`packages/agent/src/types.ts:516-539`），`docs/json.md` 的事件表里也没有。官方明确说 JSON 模式「is structured event output, **not a single JSON result**」（`docs/cli-integration.md:42` 附近，`docs/json.md:9` 同义）。

`[直接证据]` sandcastle 的 `result` 是它自己合成的，不是 pi 发的：`AgentProvider.ts:585-605` 从 `agent_end.messages` 里倒序找最后一条 assistant 文本，包成 `{type:"result", result}`；`AgentProvider.ts:581-584` 还兜底把 `agent_error`/`error` 事件也包成 result。

`[直接证据]` 但 `agent_error`/`error` 这两个顶层事件类型**在 pi 1.3.0 里不存在**（联合里没有；provider 失败走 assistant 消息的 `stopReason:"error"`）。`[解读]` 这段兜底对 1.3.0 是死代码，对应的是更早的 0.73.1 行为。`[推断]` 这解释了为什么 sandcastle 的注释把它标成 "defensive"。

### 2.4 怎么可靠取「最终答复」

`[直接证据]` `docs/json.md:68`「`message_end` … This is the authoritative final message.」；`docs/json.md:55` `agent_end.messages` 含该次 run 生成的消息。

`[解读]` 可靠取法（按稳健度排序）：

1. 取最后一个 `message_end` 且 `message.role === "assistant"` 的 `message.content` 中所有 `type:"text"` 块拼接。
2. 或取 `agent_end.messages` 里最后一条 assistant 文本（sandcastle 的做法，`AgentProvider.ts:585-605`）。
3. `agent_settled` 只用来判定「自动工作真的结束」（`docs/json.md:48`、`docs/cli-integration.md:50`），不携带正文。

`[直接证据]` 判定失败要看 assistant 消息的 `stopReason`：`"pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"`，失败时带 `errorMessage`（`docs/message-types.md:119-139`）。

---

## 3. 截断

`[直接证据]` 逐行解析的容错：sandcastle `parsePiStreamLine` 对 `JSON.parse` 失败的行直接返回 `[]`（`AgentProvider.ts:546-549`、`:610-612`）。`[解读]` 被 kill 时最后一行若是半条 JSON，解析失败被跳过，**之前所有完整事件仍可解析**，能拿到部分结论。

`[直接证据]` 但有两处会丢：

1. `writeRawStdout` 是串行队列，`process.exit()` 不会等队列 flush：`core/output-guard.ts:45-92`（`rawStdoutWriteTail`），而 SIGTERM handler 直接 `disposeRuntime().finally(() => process.exit(143))`，**不调用 `flushRawStdout`**（`print-mode.ts:56-61`；正常结束时才会 `flushRawStdout()`，`print-mode.ts:170`）。`[推断]` 被 SIGTERM 时，排在队列尾部还没真正 write 的事件可能丢失。
2. 读取方若中途停止消费，管道写满会卡住 pi（`docs/json.md:19`）；反过来读侧被 kill 也一样丢尾部。

`[直接证据]` sandcastle 的 docker 读取用 Node `readline`（`sandboxes/docker.ts:287` `createInterface({ input: proc.stdout! })`），而 pi 文档明确警告 **readline 不适用于该流**：它会额外把 Unicode 行分隔符 `U+2028/U+2029` 当成换行（`docs/json.md:17`）。`[实测]` node v24.22.0：`Readable.from(['{"a":"x\u2028y"}\n'])` 经 readline 被切成 `{"a":"x` 与 `y"}` 两条，JSON 就坏了。`[推断]` 只有当模型输出里出现 U+2028/U+2029 才会触发，概率低但确实是一条「残缺流」路径。

`[直接证据]` 非正常退出时 sandcastle 的兜底：`execResult.exitCode !== 0` → 用 stderr，其次 resultText，再次 stdout 最后 20 行非空行（`Orchestrator.ts:191-206`）。`[解读]` 这只保证「有东西可报」，不保证完整。

---

## 4. session 落在哪

`[直接证据]` `docs/session-format.md:8-14`：`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`；`<session-id>` 默认 UUID，`--session-id` 可自定义；`<path>` 去前导分隔符后把 `/`、`\`、`:` 换成 `-`，再包 `--`。

`[直接证据]` 源码一致：目录编码 `core/session-manager.ts:589-593`（`` `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--` ``），文件名 `:1080` `` `${fileTimestamp}_${this.sessionId}.jsonl` ``，`fileTimestamp = timestamp.replace(/[:.]/g, "-")`（`:1079`）。`[解读]` 形如 `2026-10-19T22-46-26-123Z_<uuid>.jsonl`。

`[直接证据]` 覆盖优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting（`docs/cli.md:96`、`docs/sessions.md:50`、`docs/settings.md:66`、`docs/environment-variables.md:82`）。

`[直接证据]` print/json 默认持久化：只有 `--no-session` 才内存态（`main.ts:364` `if (parsed.noSession …) return SessionManager.inMemory(...)`；`docs/sessions.md:7`）。

`[直接证据]` 失败后 PVC 里能捞到 transcript：写入是**逐 entry 同步 append**——`core/session-manager.ts:1172-1191` `_persist`，首条 user/assistant 消息出现时用 `openSync(wx)` 落盘，之后每条 `appendFileSync`。且注释说明 user 消息在第一次 assistant 回复完成前就落盘（`:1161-1165`，#10000）。`[解读]` 即使进程被 SIGKILL，已 append 的 entry 都在，能拿到到最后一条已完成 entry 的完整树。

`[直接证据]` header 是首行 `{"type":"session","version":3,"id","timestamp","cwd"}`（`docs/session-format.md:64-70`）。sandcastle 靠它搬 session 并重写 `cwd`（`SessionStore.ts:398-424` `transferPiSession`；`AgentProvider.ts` 的 `makePiSessionStorage`）。`[直接证据]` `SessionStore.ts:391-395` 注释：pi 用 `assertSessionCwdExists`，print/json 下 cwd 不存在会终止进程，所以重写 header cwd 是 resume 的硬前提。

---

## 5. 模型与 thinking 参数

`[直接证据]` `docs/cli.md:63-75`、`pi --help`（实测）：

- `--model <pattern>`：精确 id 或模糊匹配，支持 `provider/id` 和可选 `:<thinking>` 后缀（如 `sonnet:high`）。
- `--provider <name>`：把 `--model` 的查找限制在一个 provider，且**必须搭配 `--model`**。
- `--thinking <level>`：`off|minimal|low|medium|high|xhigh|max`；覆盖 `--model` 的 `:<thinking>` 后缀，并按模型能力 clamp。
- `--models <patterns>`：逗号分隔的启动/循环范围（Ctrl+P），也支持 `:<thinking>`。

`[直接证据]` `--api-key` 只做运行时覆盖，且要求已有 `--model`/`--models` 选定模型（`docs/cli.md:67`；`main.ts:835-838` 校验）。

`[解读]` OmniRoute 的 `default` / `review` 两个 model id：本票的 primary sources（pi 文档/源码、sandcastle）里**没有**这两个 id，`/root/clone/remote-agent` 里也只把 OmniRoute 定义为「集群内 OpenAI 兼容模型网关」（`GLOSSARY.md:71-73`），未给出 model id。因此「怎么指定」的答案是可确定的，而「这两个 id 具体叫什么/属于哪个 provider 名」**未确认**：它们应由 App 在 pi 的 provider 配置（`models.json` 或 provider extension）里定义，再以 `--model <omniroute-provider>/default`、`--model <omniroute-provider>/review` 传入。

`[直接证据]` 兼容 OpenAI 的端点配置方式：`docs/models.md:45-57`（Configure a compatible endpoint，`models.json` 的 `providers.<name>.baseUrl/api/models`），并可用 `$ENV` 插值 key。`[解读]` 这与「Job 不持有上游 key、只指向 OmniRoute」的边界一致，但 OmniRoute 具体接线不在本票范围。

`[直接证据]` thinking 档位按模型能力 clamp（`docs/cli.md:69`）；模型侧可用 `samplingParamsByThinkingLevel` 覆盖采样（`docs/models.md`）。`[未确认]` OmniRoute 网关对哪些 thinking 档位真实生效，取决于它声明/映射的模型能力，本次无 source。

---

## 6. 非交互模式下「需要用户确认」的动作

`[直接证据]` 内置工具（read/bash/edit/write 等）执行前**不问确认**：`docs/security.md:3`「it does not ask for approval before every tool call」；`docs/usage.md:27`「Pi does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work.」所以 prompt 里「绝不提问」这条约束在工具层面没有对手。

`[直接证据]` 扩展 UI 弹窗在 print/json 下是 no-op：`print-mode.ts:77` 用 `mode: "json" | "print"` 绑定扩展；未传 `uiContext` 时 runner 用 `noOpUIContext`（`core/extensions/runner.ts:331-363`），其中 `select: async () => undefined`、`confirm: async () => false`、`input: async () => undefined`。`[解读]` 扩展要确认时会被自动判「否/空」，**不会挂起**。

`[直接证据]` project trust：非交互时 `projectTrustContext.hasUI = false`，`resolveProjectTrusted` 走到 `if (!options.projectTrustContext.hasUI) return false;`（`core/project-trust.ts:87-89`）；`cli/project-trust.ts` 的 `select/confirm/input` 在 `mode !== "interactive"` 时直接返回 `undefined/false/undefined`。`[解读]` 结果是不加载项目本地资源、不提问、不阻塞。

`[直接证据]` **唯一已知的 stdin 阻塞点**：`--session <id>` 解析到「跨项目」session 时，`main.ts:400-405` 打印提示并 `promptConfirm("Fork this session into current directory?")`；`promptConfirm` 用 `readline.createInterface({input: process.stdin})` 阻塞等输入（`main.ts:286-296`）。sandcastle 专门规避了它：把 session 文件落到**当前项目**的编码目录而不是沙箱的编码目录（`AgentProvider.ts` `makePiSessionStorage.captureToHost` 注释 + `SessionStore.ts:297-307`）。`[解读]` 如果 App 直接给 pi 传一个不在当前 cwd 目录下的 session id，就可能卡在这个确认上（stdin 是管道时可能等到 EOF 也可能一直等，取决于 stdin 是否被关闭）。`[推断]` 稳妥做法是让 session 文件落在 `--<enc-cwd>--/` 下，或别在 AFK 里用跨项目 `--session`。

`[直接证据]` MCP OAuth 登录不是普通 run 的自动行为：`signIn` 只由 `/mcp` 命令路径触发（`extensions/mcp/index.ts:927,1091`，命令注册在 `:1260` `pi.registerCommand("mcp", …)`）；命令行侧是显式的 `pi mcp login`（`docs/cli.md`）。`[解读]` 普通 prompt run 里，需要 OAuth 的 MCP server 只会连接失败/被报告，不会弹浏览器阻塞。

`[直接证据]` 交互式才有的能力在非交互下降级：`docs/cli-integration.md:70`「TUI-only extension capabilities are unavailable or degraded outside interactive mode.」

---

## 对 App 的直接含义（`[解读]`/`[推断]`，供后续 spec 参考，不构成本票结论）

1. **不要用退出码判 agent 成败**。`pi -p --mode json` 的 0 同时覆盖「干完了」「模型报错」「被 abort」「输出被 token 上限截断」。非 0 只说明「pi 这个进程/调用坏了」。
2. **失败判定解析事件流**：找 assistant 的 `message_end`，看 `stopReason ∈ {error, aborted, length}` 与 `errorMessage`；`agent_settled.aborted` 判 abort；正文取最后一条 assistant 文本。
3. **「没做完/blocked」是内容判断**，必须来自最终文本里的约定信号（sandcastle 用 `<promise>COMPLETE</promise>`），pi 不提供。
4. **截断可容错但会丢尾**：半行可跳过；SIGTERM/OOM 时未 flush 的尾部事件可能丢，所以别把关键结论只放在「最后一条事件」上。
5. **session 一定在**：print/json 默认落盘、逐条 append；失败后 PVC 里的 `--<enc-cwd>--/*.jsonl` 能还原到最后一个完成 entry。
6. **prompt 里「绝不提问」对内置工具是天然成立**；真正的坑是跨项目 `--session` 的 fork 确认，以及别依赖扩展 UI（非交互下恒为 no-op）。

## 未确认清单

- OOM kill / SIGKILL 在 pi 与 k8s Job 层面的具体退出码与可观测字段（不在 primary sources）。
- OmniRoute 的 `default`/`review` 两个 model id 的 provider 名、baseUrl、thinking 映射（primary sources 未提供）。
- sandcastle `readline` 读流在真实模型输出含 U+2028/U+2029 时的实际触发频率（只证明了机制存在）。
