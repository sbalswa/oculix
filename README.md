# oculix

## Mise layout

Repository tooling lives under the grouped `mise/` configuration directory:

```text
mise/
├── config.toml            # base policy tools + setup/ci tasks
├── mise.lock              # lock for config.toml (mise naming)
├── config.oculix.toml     # Java + Oculix jar (MISE_ENV=oculix)
├── mise.oculix.lock       # lock for config.oculix.toml
└── tasks/
    └── oculix/
        ├── run            # Unix/macOS runner
        └── run.ps1        # Windows runner
```

- **Base config** (`mise install --locked`): lightweight policy tools only.
- **`oculix` environment** (`mise -E oculix install --locked`): additionally installs Java and the Oculix artifact.
- Future environment pairs (for example `web-e2e`) add `mise/config.<env>.toml` + `mise/mise.<env>.lock` without cluttering the repository root.

After pulling a config-path move, you may need to trust the new paths once (`mise trust`).

## Oculix cross-platform smoke test

Oculix (the `oculixide` jar) and Java (Temurin 17) are pinned in the
`oculix` mise environment. The canonical runner task is `oculix:run`
(compatibility alias: `oculix`):

```sh
mise -E oculix install --locked
# Linux is headless, so wrap in Xvfb:
xvfb-run -a mise -E oculix run oculix:run
# macOS / Windows have a desktop session:
mise -E oculix run oculix:run
# Optional script argument (default: tests/e2e/oculix/basic.sikuli):
mise -E oculix run oculix:run tests/e2e/oculix/calculator.sikuli
```

In CI, the `oculix` job in `.github/workflows/cross-platform.yml` runs this on
`ubuntu-24.04`, `macos-latest`, and `windows-latest` (trigger via
**Actions → Cross-platform runners → Run workflow**).

Future E2E scenario tasks will follow `e2e:<tool>:<scenario>` and call
`oculix:run` rather than duplicating platform logic.

### Not yet built (backlog)

- **Runner-service path:** `oculix-org/oculix-runner` is an HTTP service (Docker
  Compose, VNC targets) for CI. It is Linux/container-centric and not part of
  this cross-platform PoC; add later as a Linux-only job if needed.
- **Uniform screen resolution:** only Linux's resolution (Xvfb `1280x1024x24`)
  is ours to set; macOS/Windows use the runner image defaults. The smoke script
  logs the detected geometry so this can be normalized later with real data.

## Toolchain maintenance

Scheduled updates stack as `mise` → `tools` → parallel `extras/*`

## Development

Prerequisite: install [mise](https://mise.jdx.dev/installing-mise.html) once per
development environment.

After cloning:

```sh
mise install --locked
mise run setup
```

Run the checks:

```sh
mise run ci
```
