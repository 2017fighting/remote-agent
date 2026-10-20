# prompt 与镜像解耦

prompt 模板放在 home-ops 的 ConfigMap 里；Job 通过 `AGENT_ROLE` 声明角色，从挂载的 prompt 目录取同名模板。镜像里只有 pi、skills、工具链这类公共物，不含任何 prompt。这样镜像能继续被别的角色（explore、review）复用，改 prompt 也不必重建镜像。代价是 prompt 与 App 代码之间的契约（角色名、结果格式、环境变量）分处两个仓库，容易漂移。
