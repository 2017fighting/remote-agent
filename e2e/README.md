# kind e2e — the spec's delivery gate

Ticket [#41](https://github.com/2017fighting/remote-agent/issues/41) of spec
[#33](https://github.com/2017fighting/remote-agent/issues/33). One spec + two
tickets + closeout, run to the end on a real kind cluster:

```
signed webhook → App Deployment → Ticket PVC + per-Job Secret + Job
  → Job runs (real clone, real model, real push) → run-result annotation
  → App closes the ticket → next ticket becomes Frontier
  → both closed → closeout Job → ready PR with `Closes #33` → spec ready-for-human
```

Nothing in `app/` or `job/` knows this is a test. The whole difference between
the e2e and production is three env values on the App Deployment:
`GITHUB_API_BASE_URL`, `GIT_BASE_URL`, `OMNIROUTE_BASE_URL`.

## Status

**Not green yet, and deliberately not marked required in CI.** The App has no
production port implementations: `app/src/adapters/octokit.ts` and
`app/src/adapters/k8s.ts` throw `not implemented` for all 14 + 18 methods, and
`app/src/main.ts` defaults to them. The App process therefore exits at its
startup list (`OctokitGitHub.listIssues not implemented`) before it can serve a
webhook. That work is
[#43](https://github.com/2017fighting/remote-agent/issues/43); when it merges,
this harness should go green without changes — it was built against the
`GitHubPort` / `K8sPort` contracts those adapters implement.

The harness fails loudly with that reason rather than skipping (see
`e2e/src/run.ts`, `waitForAppOrFailFast`), because a silently-skipped gate is
worse than a red one.

## Run it

Needs `docker`, `kind`, `kubectl` and `git` on PATH.

```sh
npm install
node e2e/run.mjs            # or: npm run e2e
```

Options:

| flag | meaning |
| --- | --- |
| `--verbose` | echo every command's stdout/stderr into the log |
| `--keep` | leave the harness's scratch directory (bare repo, scenario) behind |
| `--no-cleanup` | leave the kind cluster running afterwards |
| `--timeout <s>` | per-assertion bound, default 300 |
| `--cluster <name>` | kind cluster name, default `ra-e2e` |

The cluster is reused if it already exists. To tear it down:

```sh
kind delete cluster --name ra-e2e
```

## What runs where

| piece | file | notes |
| --- | --- | --- |
| stub GitHub | `stub-github/` | REST limited to the `GitHubPort` endpoints, plus **real** git over `git http-backend` |
| stub model | `stub-model/` | OpenAI-compatible streaming `/v1/chat/completions`, scripted per scenario |
| namespace contract | `src/manifests.ts` | namespace, both ServiceAccounts + Roles, guardrail quota, prompts ConfigMap, storage class |
| scenario | `src/scenario.ts` | the world (spec + 2 tickets) and the scripted model turns |
| driver | `src/run.ts` | bring-up, scenario, assertions, diagnostics |
| assertions | `src/assertions.ts` | bounded polling; no fixed sleeps |

### Why the git half is real

`stub-github` serves clone / `ls-remote` / push through `git http-backend`
against a real bare repository on disk. So Seed's clone, the runner's
`merge-base origin/main HEAD`, the commit list and the final push all execute
git's own code, and the push lands in a real repository. The stub records every
served operation with its service (`upload-pack` / `receive-pack`) and exit code;
the scenario asserts on that, which is how "the git work was real, not mocked
objects" is evidenced rather than claimed.

### Why the storage class exists

`app/src/renders/job-template.ts` hardcodes `truenas-iscsi-delete` (ADR-0010).
kind has no such class, so `src/manifests.ts` supplies one backed by kind's
`rancher.io/local-path`. The cluster adapts to the product here — not the other
way round.

## Failure attribution

The log is sectioned `cluster` → `images` → `stubs` → `app` → `job` → `assert`,
and a failure prints the section it happened in plus diagnostics: App logs,
Job/pod describe, PVCs, Secrets, and the last 120 lines of every `seed` /
`runner` container. A failure names the side that broke.

## Tests

`e2e/test/` holds the fast tests (no cluster): the stubs' external behaviour
(including a round trip through the real `pi-ai` client), the namespace contract
against `docs/deployment.md`, and the scenario fixture against the product's own
naming and tool tables. They run in `npm test` with everything else.
