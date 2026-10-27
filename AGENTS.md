# Agent notes

Facts that are easy to get wrong in this repository, and conventions that are
easy to violate. Prefer this file over rediscovering the environment.

Human contributor setup lives in [CONTRIBUTING.md](CONTRIBUTING.md). Tooling
layout and task syntax live in [README.md](README.md).

## Worktrees

Git worktrees for this repository live in `../oculix-worktrees/`, a sibling of
the clone. `.gitignore` lists `.worktrees/`, and some tooling defaults to
`.claude/worktrees/` — those are not the real location. Create worktrees under
`../oculix-worktrees/<name>`, not inside the clone.

## mise install and lockfiles

Always run `mise install --locked` (or `mise -E <env> install --locked`) inside
a clone. Never run unlocked `mise install` here: it rewrites `mise/mise.lock`
(and the adjacent env lockfiles) and produces a spurious diff. mise's own hint
suggests the unlocked form; ignore that hint inside this repository.

`mise install --locked` may report tools this repository does not use, for
example `python@… is not in the lockfile`. mise merges personal configs
(`~/.config/mise/config.toml`, `~/mise.toml`) into the request set, and
`--locked` applies to the merged set. The repository's pinned tools still
resolve from `mise/mise.lock`; `mise run setup` and `mise run ci` are
unaffected. Safe to ignore. Silence it from **outside** a clone by giving
personal tools their own lockfile — see
[mise lockfiles](https://mise.jdx.dev/dev-tools/mise-lock.html). Do not create
or update a lockfile in the contributor's home directory as a "fix" for this
repository, and do not commit personal lockfiles here. Details:
[CONTRIBUTING.md](CONTRIBUTING.md#troubleshooting).

## Pins are deliberate

Everything is pinned on purpose:

- GitHub Actions by full commit SHA, with a version comment
  (`uses: actions/checkout@<sha> # v…`)
- Tools by version in `mise/config*.toml`, with per-platform checksums and
  provenance (including GitHub attestations) in the adjacent lockfiles

Do not relax a pin, drop a checksum, or retarget an action to a floating tag to
make something pass. Update pins through the existing maintenance lanes or an
intentional, reviewed change that re-locks every supported platform.

## Commits and branches

Commits are signed (`commit.gpgsign` with SSH format) and follow
[Conventional Commits](https://www.conventionalcommits.org/). Work lands on a
branch, not `main`. `hk` enforces the latter two on commit
(`check_conventional_commit` on `commit-msg`, `no_commit_to_branch` on
`pre-commit`).

## Deterministic hk steps

`hk` steps must be deterministic. An LLM reviewer is not one — see #91 for the
brooks-lint triage design. Do not add non-deterministic checks to `hk.pkl`.

## Paired Unix / PowerShell tasks

Cross-platform mise tasks under `mise/tasks/` are paired as `<task>` and
`<task>.ps1` (for example `mise/tasks/oculix/run` and `run.ps1`, and the
Selenium / Cypress / Playwright / github task trees). Editing one without the
other silently diverges platforms. When changing a paired task, update both
sides in the same change.
