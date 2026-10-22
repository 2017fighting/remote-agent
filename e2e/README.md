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

**Green, and required in CI.** The closed loop holds end to end:

```
tickets closed: 34, 35
spec labels: ["agent:implement","ready-for-human"]
PR: #1 agent/spec-33 -> main (draft=false)
PR body carries Closes #33: yes (once)
real git services observed: receive-pack, upload-pack
```

`push-images` lists this job in `needs`, so nothing reaches GHCR unless the loop
closed.

The gate has already earned its keep. Every bug below was invisible to the unit
suite — each side was green on its own, or the in-memory fake was more permissive
than the real API server — and each was fatal in a cluster:

- the App bound `127.0.0.1:<random>` instead of `0.0.0.0:$PORT` (webhook unreachable)
- the readiness probe did `GET /webhook` on a POST-only path
- the ESM bundles had no `createRequire` banner, so their CJS dependencies failed
- the webhook was delivered with `wget`, absent from the image
- `Secret.data` was sent as plaintext, not base64 (400 on every Secret create)
- the seed init container inherited the image's runner `CMD` and died on runner-only env
- `secretKeyRef` / `fieldRef` env vars were dropped instead of nested under `valueFrom`
- the run-result PATCH used Node's `fetch` without the ServiceAccount CA (`fetch failed`)
- the Job template never mounted the prompts ConfigMap the runner reads
- provenance labels used values k8s rejects (`owner/name#n`), so no Job was ever created
- the Job image was tagged differently from the reference the App bakes

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
