# 一个 ticket 一个 k8s Job

每次 agent 运行是由 App 通过 k8s API 创建的 Job，而不是复用 sandcastle 库、GitHub Actions self-hosted runner，或常驻 pod。理由是隔离与信号：每个 ticket 拿到自己的快照卷与自己的 pod，pod 的终态就是这次运行的结果，ResourceQuota 就是并发上限。代价是 App 要自己管 Job 模板、快照挂载与结果回收，其中一部分 sandcastle 本来已经提供。

## Considered Options

- **sandcastle 作为编排库**：白得 sandbox 分支策略、session 搬运与结果解析，但要为 k8s 写一个 sandbox provider，且在 pod 里跑容器很别扭。
- **GitHub Actions self-hosted runner**：少一套集群调度，但快照/PVC 挂载、并发上限与「运行结果」契约都更难做。
