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

Local E2E tasks use `e2e:<tool>[:<scenario>]`. Selenium, Cypress, and
Playwright aggregates run a calculator-independent browser smoke followed by
the shared `clear → 7 → × → 3 → 4 → = → 238` scenario:

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

On an Ubuntu desktop with the Oculix native prerequisites installed,
`e2e:all` runs the four current stable capabilities in order:

```sh
mise -E oculix,web-e2e run e2e:all
```

## CI execution and evidence

Remote E2E selection uses `ci:e2e:*` pull-request labels or the
`Demand-driven E2E selectors` workflow's manual inputs. It is separate from
the local `e2e:*` task syntax.

The stable capability catalog currently contains four Ubuntu cells:

- Selenium on Ubuntu/Chromium
- Cypress on Ubuntu/Chrome
- Playwright on Ubuntu/Chromium
- Oculix on Ubuntu/Chromium

The catalog is an explicit allowlist, not an OS × browser product. Every
selected cell has standard cost, uses a GitHub-hosted Ubuntu runner, has a
20-minute timeout, and runs with `fail-fast: false`. At most three cells run
concurrently, so a full four-cell selection runs as three cells followed by
the fourth when runner capacity is available. A pull request with no
`ci:e2e:*` label allocates no E2E matrix runner.

### Pull-request selectors

Apply one or more of these labels to a pull request:

| Selection | Label | Current expansion |
| --- | --- | ---: |
| Smoke | `ci:e2e:smoke` | 1 Selenium cell |
| Exact Selenium | `ci:e2e:selenium:ubuntu:chromium` | 1 cell |
| Exact Cypress | `ci:e2e:cypress:ubuntu:chrome` | 1 cell |
| Exact Playwright | `ci:e2e:playwright:ubuntu:chromium` | 1 cell |
| Exact Oculix | `ci:e2e:oculix:ubuntu:chromium` | 1 cell |
| All stable Selenium | `ci:e2e:selenium:all` | 1 cell |
| All stable Cypress | `ci:e2e:cypress:all` | 1 cell |
| All stable Playwright | `ci:e2e:playwright:all` | 1 cell |
| All stable Oculix | `ci:e2e:oculix:all` | 1 cell |
| All stable capabilities | `ci:e2e:all` | 4 cells |

Tool-wide counts will grow when stable OS/browser capabilities are added to
that tool. Multiple labels form a de-duplicated union. For example, applying
the exact Selenium and Cypress labels runs two cells; combining
`ci:e2e:smoke` with the exact Selenium label still runs one.

Adding or removing a `ci:e2e:*` label replans the pull request and cancels
obsolete in-progress selector work. Unrelated labels neither select E2E work
nor cancel it. An unknown `ci:e2e:*` label fails planning instead of silently
allocating the wrong runner.

Repository label synchronization manages the available label definitions and
their descriptions. It does not apply a selector to a pull request and
therefore does not start E2E work.

After changing `tests/e2e/capabilities.json`, preview and verify label drift
before applying it:

```sh
mise run github:e2e-labels
mise run github:e2e-labels -- --check
mise run github:e2e-labels -- --apply
```

The task is dry-run by default. `--check` is also read-only and exits nonzero
on drift. `--apply` creates and updates labels but retains stale managed labels;
deletion requires the explicit `--apply --prune` combination.

Labels applied by a workflow using GitHub's default `GITHUB_TOKEN` do not
recursively trigger a new `pull_request:labeled` workflow run. Automation that
needs to start E2E must dispatch the selector workflow explicitly or apply the
label using an appropriately authorized GitHub App installation token or
personal access token. Labels applied manually in the GitHub UI trigger the
selector workflow normally.

### Manual dispatch

Run `Demand-driven E2E selectors` from the Actions page with one preset:

- `none`: select nothing and allocate no E2E matrix runner.
- `smoke`: run the current one-cell stable smoke selection.
- `full`: run all four current stable cells.
- `custom`: run a comma- or newline-separated list of exact capability IDs or
  exact labels.

For example, a custom two-cell run accepts:

```text
selenium-ubuntu-chromium
ci:e2e:cypress:ubuntu:chrome
```

The custom field is used only with `preset=custom`; it rejects an empty list,
unknown selectors, and broad selectors such as `ci:e2e:all`,
`ci:e2e:smoke`, or `ci:e2e:<tool>:all`. Manual dispatch can opt into an exact
experimental capability with `include_experimental`; pull-request labels
select stable capabilities only.

### Artifacts and reports

Successful runs retain a final `238` screenshot for every capability.
Each selected cell uploads its complete diagnostics directory for seven days
as `e2e-<capability-id>` in the workflow run's **Artifacts** section:

| Artifact | End-user evidence and reports |
| --- | --- |
| `e2e-selenium-ubuntu-chromium` | `web-calculator/result.png`, `result.json`, `accessibility.json`, and `accessibility-summary.md` under `tests/e2e/selenium/diagnostics/` |
| `e2e-cypress-ubuntu-chrome` | Scenario screenshots and `.mp4` videos, `run.json`, `accessibility.json`, and `accessibility.md`, plus `summary.json` and `summary.md`, under `tests/e2e/cypress/diagnostics/` |
| `e2e-playwright-ubuntu-chromium` | `web-calculator/final.png`, `.webm` videos, trace-on-failure output, native JSON and HTML reports, `result.json`, `accessibility.json`, and accessibility summaries under `tests/e2e/playwright/test-results/` |
| `e2e-oculix-ubuntu-chromium` | `oculix-web-calculator-diagnostics/result.png` |

The Selenium, Cypress, and Playwright calculator reports enforce automated
axe-core accessibility policy. Cypress also audits its smoke scenario.
Incomplete findings remain visible for manual review; blocking violations
fail the capability after the reports are written. Oculix currently supplies
visual end-user evidence but no accessibility report.

The Oculix hosted Chromium launch explicitly disables its browser sandbox
because the Ubuntu runner's AppArmor policy otherwise makes Chromium abort.
That exception is rejected outside GitHub Actions, and the fixture remains
loopback-only. Cypress is pinned to Chrome; Electron is not an accepted
catalog browser.

### Troubleshooting

- **No E2E jobs:** verify that the pull request has a `ci:e2e:*` label, or that
  manual dispatch uses `smoke`, `full`, or a nonempty `custom` selection.
- **Planner failure:** remove an unknown selector. With `custom`, provide only
  exact capability IDs or exact labels, not preset or tool-wide selectors.
- **A label added by automation did nothing:** the default `GITHUB_TOKEN`
  suppresses recursive workflow events; explicitly dispatch the workflow or
  use an appropriately authorized GitHub App token or personal access token.
- **Transient browser startup or renderer timeout:** rerun the failed job once
  on the same commit. Investigate repeated failures rather than changing the
  selector.
- **Missing artifact:** artifacts are retained for seven days. Check the
  selected cell's `Validate reports and end-user result evidence` and
  `Upload E2E evidence and diagnostics` steps; failed runs upload any
  diagnostics that were produced.
- **Unexpected cost:** inspect the planner summary before execution. It lists
  every selected cell, runner, browser, cost class, and the maximum parallel
  job count.

### Not yet built (backlog)

- **Runner-service path:** `oculix-org/oculix-runner` is an HTTP service (Docker
  Compose, VNC targets) for CI. It is Linux/container-centric and not part of
  this cross-platform PoC; add later as a Linux-only job if needed.
- **Uniform screen resolution:** only Linux's resolution (Xvfb `1280x1024x24`)
  is ours to set; macOS/Windows use the runner image defaults. The smoke script
  logs the detected geometry so this can be normalized later with real data.

## Toolchain maintenance

Scheduled updates stack as `mise` → `tools` → parallel `extras/*`. Temurin
point releases remain automated through that stable maintenance lane.

Java major changes are issue-only alerts and require review. A detected
mismatch does not edit configuration, re-lock dependencies, or open a pull
request. Remediation must cite the commit-pinned upstream evidence,
intentionally update the Java configuration, re-lock every supported platform,
and run the full operating-system matrix before merge.

When the configured major matches Oculix again, maintenance adds a resolution
comment and closes the generated alert. If upstream evidence cannot be read,
maintenance leaves the existing issue state unchanged.

## Development

Prerequisite: install [mise](https://mise.jdx.dev/installing-mise.html) once per
development environment. See [CONTRIBUTING.md](CONTRIBUTING.md) for commit
policy, optional review tooling, and mise troubleshooting. Agent-facing
conventions live in [AGENTS.md](AGENTS.md).

After cloning:

```sh
mise install --locked
mise run setup
```

Run the checks:

```sh
mise run ci
```
