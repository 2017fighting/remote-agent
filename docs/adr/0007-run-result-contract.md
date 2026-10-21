# run result 由 pi 自定义工具写出，wrapper 落到 Job annotation

pi 1.3.0 的 `-p --mode json` 既没有 `result` 事件，退出码也分不出「agent 自判没做完」与「正常跑完」（`error`/`aborted`/`length` 都不产生非 0；SIGTERM 直接 `exit(143)` 且不 flush 尾部事件，见 `research/pi-afk-contract`）。所以这次运行的结论只能由 agent 主动产出一个结构化产物。决定：镜像里烧一个 pi 自定义工具（`run_result`），agent 收尾时调用它，把 `{v, outcome, summary, commentBody?, newTickets?[], reason?, warnings?[]}` 原子写到 `$RUN_RESULT_PATH`；entrypoint wrapper 在 pi 退出后读这个文件，把同一份 JSON 写进 Job 自己的 annotation（`remote-agent/run-result`）。工具带 `terminate: true`，agent 调完它就结束本次 run，不多花一轮 LLM；wrapper 是唯一的 k8s writer，工具只写文件。

选它而不是「约定文本块」（模型措辞、markdown 围栏、转义都会伤到它，多行 `newTickets.body` 尤其难）或「wrapper 纯推断」（`blocked` 这类自述会彻底丢失）：工具是类型化、可校验、且模型在工具表里直接看得到的通道。代价是镜像里多一份属于 entrypoint 契约的代码——ADR-0004 禁的是 prompt，不是契约。

## Considered Options

- **约定文本块**（最终回复里带 `<run-result>{...}</run-result>`，wrapper 从流里解析）：不加代码，但依赖模型严格守格式，长 body 与转义会坏，且与 `terminate: true` 相性差。
- **wrapper 纯推断**（只看 `stopReason` 与有没有新 commit）：无格式依赖，但「agent 自认卡住」无法表达，`blocked` 几乎不可能产生。
- **shell helper 而非 pi 工具**：能力等价，但模型得靠 prompt 记住命令名与参数，没有 schema 校验、没有工具表里的自述。

## Consequences

- outcome 描述「这次运行是怎么结束的」，不描述为什么没做成：一切非 agent 自述的失败（infra、超时、OOM、被驱逐、pi 的 `stopReason ∈ error|aborted|length`、没有 result）都是 `error`，享有一次自动重试；`blocked` 只留给「pi 正常跑完 + agent 自述卡住」。细分原因在 `reason` 里，不进枚举、不进状态机。
- **超时/驱逐压过文件里的 `done`**：被 deadline 打断的运行其 commit/push 未必走完，认 done 会让 App 去 close 一个并未真正完成的 issue。
- App 对「已终态但读不到 result」的 Job 兜底判 `error`（`reason=no-result`），证据取 pod 终态（`OOMKilled`/`DeadlineExceeded`/exitCode）与容器日志；**Job 与它的 pod 在 App 成功读到 result 之前不得被删**（保留多久由清理策略那张票定）。
- 用了 `terminate: true` 之后，本次 run 最后一条 assistant 消息的 `stopReason` 是 `toolUse` 而不是 `stop`：wrapper 判 pi 层失败只能用「最后一条 assistant 的 `stopReason ∈ {error, aborted, length}`」这个谓词（pi 自己在 text 模式用的也是它）。
- 结果文件是「agent 自述」的载体，session jsonl 与保留的 PVC 是全文（含被截断的 `commentBody`）的家。
