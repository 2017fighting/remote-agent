# Remote Agent

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues (`2017fighting/remote-agent`), driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to their own names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Releases

Version, tag and GitHub Release are owned by release-please (`release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release-please.yml`). Never tag or bump the version by hand: the release PR is the only place the version changes. Releasing means dispatching the `release-please` workflow, which merges that PR — the tag it makes is what publishes the images. See ADR-0019 and `docs/deployment.md` §10.
