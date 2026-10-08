# oculix

## Oculix cross-platform smoke test

Oculix (the `oculixide` jar) and Java (Temurin 17) are pinned in the
`oculix` mise environment. Run the minimal `.sikuli` smoke script locally:

```sh
mise -E oculix install --locked
# Linux is headless, so wrap in Xvfb:
xvfb-run -a mise -E oculix run oculix
# macOS / Windows have a desktop session:
mise -E oculix run oculix
```

In CI, the `oculix` job in `.github/workflows/cross-platform.yml` runs this on
`ubuntu-latest`, `macos-latest`, and `windows-latest` (trigger via
**Actions → Cross-platform runners → Run workflow**).

### Not yet built (backlog)

- **Runner-service path:** `oculix-org/oculix-runner` is an HTTP service (Docker
  Compose, VNC targets) for CI. It is Linux/container-centric and not part of
  this cross-platform PoC; add later as a Linux-only job if needed.
- **Uniform screen resolution:** only Linux's resolution (Xvfb `1280x1024x24`)
  is ours to set; macOS/Windows use the runner image defaults. The smoke script
  logs the detected geometry so this can be normalized later with real data.

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
