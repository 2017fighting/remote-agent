# job 镜像由 remote-agent 自建

虽然 `/root/sandcastle-pi` 已经是一个「pi + 工具链 + mattpocock skills + 模型契约」的现成镜像，本项目的 job 镜像仍在 remote-agent 里自建，不 `FROM` 它。这是有意的重复：remote-agent 需要自己的 entrypoint 契约（读 `AGENT_ROLE`、跑 runner（durable harness）、把 run result 写回 Job annotation），不想把 sandcastle 的运行契约（bind mount、`ENTRYPOINT sleep infinity`、agent uid 对齐）带进 k8s Job。代价是两份 Dockerfile 的依赖会各自漂移，升级 pi 或工具链要动两处。
