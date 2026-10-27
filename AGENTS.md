# Agent notes

Setup, commits, and mise troubleshooting: [CONTRIBUTING.md](CONTRIBUTING.md).
Tooling layout: [README.md](README.md).

Normative bullets use [EARS](https://alistairmavin.com/ears/). An optional
`Rationale:` line is a Planguage-style sibling field — not part of the
requirement sentence.

- WHEN installing or updating tools inside a clone, the agent shall use
  `mise install --locked` (and `mise -E <env> install --locked`).
  Rationale: unlocked install rewrites repository lockfiles.
- IF `mise install --locked` reports tools this repository does not use,
  THEN the agent shall ignore it or silence it outside the clone; the agent
  shall not unlock install or create a personal lockfile as a repository fix.
  Rationale: mise merges personal config into the locked set; see
  [CONTRIBUTING.md](CONTRIBUTING.md#troubleshooting).
- WHEN changing a pin (Action SHA, tool version, checksum, or attestation),
  the agent shall not relax it to make a check pass.
  Rationale: pins are deliberate; updates go through maintenance or review.
- WHEN editing a cross-platform `mise/tasks/` entry that has a `.ps1` sibling,
  the agent shall change both files in the same change.
- WHEN changing `hk.pkl`, the agent shall add only deterministic steps.
  Rationale: LLM reviewers are non-deterministic; keep them out of `hk` (see
  #91).
