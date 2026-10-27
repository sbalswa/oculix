# Agent notes

Setup, commits, and mise troubleshooting: [CONTRIBUTING.md](CONTRIBUTING.md).
Tooling layout: [README.md](README.md).

- Always `mise install --locked` (and `mise -E <env> install --locked`) inside a
  clone. Unlocked `mise install` rewrites lockfiles. Do not invent a personal
  lockfile outside the repo to “fix” unrelated `--locked` noise — see
  [CONTRIBUTING.md](CONTRIBUTING.md#troubleshooting).
- Pins are deliberate (Actions by full SHA; tools by version + lockfile
  checksums/attestations). Do not relax them to make something pass.
- Cross-platform `mise/tasks/` entries are paired `<task>` / `<task>.ps1`. Edit
  both in the same change.
- `hk` steps must be deterministic. Do not add an LLM reviewer as an `hk` step
  (see #91).
