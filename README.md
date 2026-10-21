# oculix

## Mise layout

Repository tooling lives under the grouped `mise/` configuration directory:

```text
mise/
├── config.toml                    # base policy tools + setup/ci tasks
├── mise.lock                      # lock for config.toml (mise naming)
├── config.oculix.toml             # Java + Oculix jar (MISE_ENV=oculix)
├── mise.oculix.lock               # lock for config.oculix.toml
├── config.web-e2e.toml            # Node.js 24 LTS (MISE_ENV=web-e2e)
├── mise.web-e2e.lock              # lock for config.web-e2e.toml
└── tasks/
    ├── oculix/
    │   ├── run                    # low-level Unix/macOS runner
    │   └── run.ps1                # low-level Windows runner
    └── e2e/
        ├── fixtures/
        │   └── web-calculator/     # fixture serve, smoke, and lifecycle tasks
        ├── oculix/                 # visual/native scenarios + aggregate
        ├── selenium/               # setup, smoke, scenario, and aggregate
        ├── cypress/                # smoke, scenario, and aggregate
        ├── playwright/             # setup, smoke, scenario, and aggregate
        └── all                     # ordered Ubuntu Phase 1 aggregate
```

- **Base config** (`mise install --locked`): lightweight policy tools only.
- **`oculix` environment** (`mise -E oculix install --locked`): additionally installs Java and the Oculix artifact.
- **`web-e2e` environment** (`mise -E web-e2e install --locked`):
  additionally installs the locked Node.js 24 LTS runtime used by the web
  fixture and browser harnesses.

Each optional environment has an adjacent `mise/config.<env>.toml` and
`mise/mise.<env>.lock` pair without adding configuration files to the repository
root.

After pulling a config-path move, you may need to trust the new paths once (`mise trust`).

## Oculix E2E tasks

Oculix (the `oculixide` jar) and Java (Temurin 17) are pinned in the
`oculix` mise environment. Install that environment, then run an individual
canonical scenario or the ordered aggregate:

```sh
mise -E oculix install --locked
# Linux is headless, so wrap in Xvfb:
xvfb-run -a mise -E oculix run e2e:oculix:smoke
xvfb-run -a mise -E oculix run e2e:oculix:native-calculator
# The Ubuntu aggregate includes the browser scenario:
mise -E oculix,web-e2e install --locked
xvfb-run -a mise -E oculix,web-e2e run e2e:oculix
# macOS / Windows have a desktop session:
mise -E oculix run e2e:oculix
```

`e2e:oculix` always runs `e2e:oculix:smoke`, runs
`e2e:oculix:web-calculator` on Ubuntu, and then runs
`e2e:oculix:native-calculator`. The web scenario also requires the
`web-e2e` environment:

```sh
xvfb-run -a mise -E oculix,web-e2e run e2e:oculix:web-calculator \
  --os ubuntu --browser chromium
```

The smoke scenario initializes Oculix and reports the detected screens and
geometry without launching a target application. The web scenario visibly
clicks the shared calculator and OCR-verifies `238`. The native-calculator
scenario drives the operating system's calculator using platform-specific
reference images.

The lower-level `oculix:run` task (alias: `oculix`) remains available for
running any Oculix bundle without adding a canonical scenario task. Its
optional argument defaults to `tests/e2e/oculix/smoke.sikuli`:

```sh
xvfb-run -a mise -E oculix run oculix:run
mise -E oculix run oculix:run tests/e2e/oculix/native-calculator.sikuli
```

In `.github/workflows/cross-platform.yml`, the `oculix` and `calculator` jobs
run the smoke and native-calculator scenarios separately on `ubuntu-latest`,
`macos-latest`, and `windows-latest`.

## Web calculator fixture

The self-contained calculator at
`tests/e2e/fixtures/web-calculator/index.html` is served only on
`127.0.0.1`. It has no package dependencies or external assets. Install the
`web-e2e` environment before using its tasks:

```sh
mise -E web-e2e install --locked
mise -E web-e2e run e2e:fixtures:web-calculator:smoke
```

The smoke task exercises calculator behavior and the complete server lifecycle,
including successful and failing child commands, interruption handling, and
server cleanup.

Framework tasks should use the lifecycle wrapper instead of managing a fixture
server themselves:

```sh
mise -E web-e2e run e2e:fixtures:web-calculator:with-server -- \
  node -e 'console.log(process.env.WEB_CALCULATOR_URL)'
```

The wrapper starts the server on an available loopback port, waits for its
readiness message and `/healthz` response, then exposes its URL to the child as
`WEB_CALCULATOR_URL`. It preserves the child's exit status or forwarded signal
and stops the server afterward. For manual inspection, the lower-level
`e2e:fixtures:web-calculator:serve` task starts the same server and prints its
JSON readiness message; pass `-- --port PORT` to request a specific port.

## Browser E2E tasks

Selenium, Cypress, and Playwright each own an isolated package under
`tests/e2e/<tool>/`. Running one tool installs only that package. Every
aggregate runs a calculator-independent browser smoke first and then the shared
`clear → 7 → × → 3 → 4 → = → 238` scenario:

```sh
mise -E web-e2e run e2e:selenium
mise -E web-e2e run e2e:cypress
mise -E web-e2e run e2e:playwright
```

Phase 1 browser selection can be explicit:

```sh
E2E_OS=ubuntu E2E_BROWSER=chromium \
  mise -E web-e2e run e2e:selenium
E2E_OS=ubuntu E2E_BROWSER=chrome \
  mise -E web-e2e run e2e:cypress
E2E_OS=ubuntu E2E_BROWSER=chromium \
  mise -E web-e2e run e2e:playwright
```

Leaf tasks follow `e2e:<tool>:<scenario>`, for example
`e2e:selenium:smoke` and `e2e:selenium:web-calculator`. Setup remains a
separate operation where deterministic browser provisioning requires it:
`e2e:selenium:setup` and `e2e:playwright:setup`.

On an Ubuntu desktop with the Oculix native prerequisites installed, the
ordered aggregate runs all four tool aggregates:

```sh
mise -E oculix,web-e2e run e2e:all
```

## CI execution and evidence

The `Cross-platform runners` workflow has an opt-in `run_e2e` input. Ordinary
pull requests leave it disabled and allocate no browser E2E matrix runners.
Manual or reusable invocations can enable the four explicit Phase 1
capabilities:

- Selenium on Ubuntu/Chromium
- Cypress on Ubuntu/Chrome
- Playwright on Ubuntu/Chromium
- Oculix on Ubuntu/Chromium

The matrix is an explicit allowlist rather than an OS × browser product.
Each capability runs its canonical aggregate or leaf with locked mise
environments, bounded timeouts, and `fail-fast: false`.

Successful runs retain a final `238` screenshot for every capability.
Cypress and Playwright also retain native video. Evidence and diagnostics are
always uploaded for seven days under the capability ID. Oculix's hosted
Chromium launch explicitly disables its browser sandbox because the Ubuntu
runner's AppArmor policy otherwise makes Chromium abort; that opt-in is
rejected outside GitHub Actions and the fixture remains loopback-only.

Framework-native accessibility audits and detailed result reports are tracked
in [#55](https://github.com/sbalswa/oculix/issues/55). Demand-driven capability
catalogs, labels, and dispatch selectors are tracked in
[#15](https://github.com/sbalswa/oculix/issues/15).

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
