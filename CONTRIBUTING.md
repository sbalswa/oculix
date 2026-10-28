# Contributing

## Instructions

Prerequisite: install [mise](https://mise.jdx.dev/installing-mise.html) once per
development environment.

```sh
mise install --locked   # pinned base toolchain
mise run setup          # install the Git hooks (hk)
mise run ci             # run the checks CI runs
```

Optional environments install beside the base toolchain. Use them when working
on Oculix or browser E2E tasks:

```sh
mise -E oculix install --locked
mise -E web-e2e install --locked
```

Commits use [Conventional Commits](https://www.conventionalcommits.org/) and land
on a branch, not `main` — `hk` enforces both on commit. See
[Development](README.md#development) and [Mise layout](README.md#mise-layout)
for the full toolchain layout and task syntax.

### Optional: brooks-lint review

[brooks-lint](https://github.com/hyhmrright/brooks-lint) runs code review inside
your own Claude Code session — no API key, nothing to configure:

```text
/plugin marketplace add hyhmrright/brooks-lint
/plugin install brooks-lint@brooks-lint-marketplace
```

Then `/brooks-review`, `/brooks-audit`, `/brooks-debt`, `/brooks-test`,
`/brooks-health`, or `/brooks-sweep`.

To turn a live scan into burn-down issues (propose only; human approves each
action), run `/brooks-triage` with a mode or `all`. See
[`.claude/commands/brooks-triage.md`](.claude/commands/brooks-triage.md) and
#91.

## Troubleshooting

### `mise install --locked` reports tools this repo does not use

```text
python@3.13.14: python@3.13.14 is not in the lockfile
```

mise merges your personal configs (`~/.config/mise/config.toml`, `~/mise.toml`)
with this repo's, and `--locked` applies to the merged set — so tools you pin
globally are checked against a lockfile this repo has no reason to contain.
Nothing is broken: the pinned tools resolve from `mise/mise.lock` as normal, and
`mise run setup` and `mise run ci` are unaffected.

Safe to ignore. To silence it, give your personal tools a lockfile of their own —
see [mise lockfiles](https://mise.jdx.dev/dev-tools/mise-lock.html). Do that from
outside a clone: an unlocked `mise install` inside the repository rewrites
`mise/mise.lock`.
