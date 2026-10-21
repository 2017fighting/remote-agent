# run result 由 agent 自述工具写出，runner 落到 Job annotation

这次运行的结论只能由 agent 主动产出一个结构化产物：durable 的 `submission.wait()` 只说得清「run 是正常收尾还是没答」（`done` / `unanswered(reason)`），说不清「agent 自判没做完」，而 `blocked` 是状态机需要的一等公民。决定：runner 里烧一个 durable 工具（`run_result`），agent 收尾时调用它自述 `{v, outcome, summary, commentBody?, newTickets?[], reason?, warnings?[]}`；工具返回 `control: { terminate: true }`（durable 会把这次 run 以成功收尾、把 inputs settle 成 `done`），runner 在 **outcome 已定之后**把同一份 JSON 写进 Job 自己的 annotation（`remote-agent/run-result`）。runner 是唯一的 k8s writer，工具只把自述交给 runner。

结果**载体**沿用 pi 时代的结论：pi 1.3.0 的 `-p --mode json` 既没有 `result` 事件、退出码也分不出「agent 自判没做完」与「正常跑完」（见 `research/pi-afk-contract`），所以「agent 主动自述」这条通道是必要的。换基座（[ADR-0008](0008-durable-runtime-base.md)）只砍掉了管线里「解析 pi json 流」那一层，判定证据从 pi 的 `stopReason`/退出码换成 durable 的 `submission.wait()` 与 task outcome。

选它而不是「约定文本块」（模型措辞、markdown 围栏、转义都会伤到它，多行 `newTickets.body` 尤其难）或「runner 纯推断」（`blocked` 这类自述会彻底丢失）：工具是类型化、可校验、且模型在工具表里直接看得到的通道。代价是 runner 里多一份属于 entrypoint 契约的代码——ADR-0004 禁的是 prompt，不是契约。

## Considered Options

- **约定文本块**（最终回复里带 `<run-result>{...}</run-result>`，runner 从 transcript 里解析）：不加代码，但依赖模型严格守格式，长 body 与转义会坏，且与 `terminate` 相性差。
- **runner 纯推断**（只看 `submission.wait()` 的 `done`/`unanswered` 与有没有新 commit）：无格式依赖，但「agent 自认卡住」无法表达，`blocked` 几乎不可能产生。
- **直接拿 durable 的 submission 当结果**：不留自定义工具，run 收尾即 `done`。不要：`blocked` 无处表达，而它是「人该接手了」的唯一信号。

## Consequences

- outcome 描述「这次运行是怎么结束的」，不描述为什么没做成：一切非 agent 自述的失败（`unanswered` 的 `model_error`/`no_model`/`faulted`/`aborted`/`missing_task`/`task_too_old`/`migration_failed`、`harness.closed` 的 `failed`、`backoffLimit` 耗尽、`DeadlineExceeded`、没有 annotation）都是 `error`；`blocked` 只留给「run 正常收尾 + agent 自述卡住」。细分原因在 `reason` 里，不进枚举、不进状态机。
- **`error` 不再自动重试**（ADR-0008）：重试的粒度是 k8s 重启 pod + 同卷 `resume()`，App 不重建 Job。所以 `error` 是**人的**入口，不是自动回路的入口。
- **annotation 只在 outcome 已定时写**：runner 被 SIGTERM / OOM / 驱逐时只 `harness.close()` 然后非零退出，不写 annotation——那不是终态，pod 会被 k8s 重启并接着跑。因此不再需要「超时压过文件里的 `done`」这条特例；取而代之的是：Job 已是终态却读不到 annotation → App 兜底判 `error`（`reason=no-result`），证据取 pod 终态（`OOMKilled`/`DeadlineExceeded`/exitCode）与容器日志。
- **Job 在 App 成功读到 annotation 之前不得被删**；Ticket PVC 比 Job 活得久（ADR-0008），所以「读不到」只发生在 runner 没走到终态的情形。
- durable storage（session）在保留的 Ticket PVC 上是对话全文（含被截断的 `commentBody`）的家。
