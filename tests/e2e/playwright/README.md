# Playwright E2E harness

The harness separates provisioning from scenario execution:

- `mise run e2e:playwright:setup [BROWSER]` is the online setup phase. It runs
  the locked package installation, installs the selected Playwright browser,
  and installs browser OS prerequisites on Ubuntu.
- `mise run e2e:playwright:smoke [BROWSER]` and
  `mise run e2e:playwright:web-calculator [BROWSER]` are offline scenario
  phases. They use npm's offline resolution and reject missing or stale setup
  stamps instead of installing dependencies.
- `mise run e2e:playwright [BROWSER]` runs setup once, then smoke and
  web-calculator in order.

The browser may also be selected with `PLAYWRIGHT_PROJECT` or `E2E_BROWSER`.
`E2E_OS` must identify the current runner family. Setup stamps bind the lockfile
hash, browser, operating-system label, platform, and architecture so a matrix
cell cannot silently reuse an incompatible installation. Versioned Ubuntu
labels must also match `/etc/os-release`'s `VERSION_ID`.

Phase 1 supports Ubuntu/Chromium and generic local POSIX hosts. Windows is
intentionally unsupported until #15 adds a native hosted capability row. The
PowerShell tasks and the Node process runner reject Windows before invoking
mise, npm, Playwright, a browser, or any other child process.

POSIX process groups are terminated on success, failure, cancellation, and
timeout. Direct-child waits and graceful/forced group cleanup have bounded
deadlines and explicit errors.

Each scenario writes isolated native Playwright output under
`test-results/<scenario>/`, including line output, an HTML report, a JSON
report, video, and retained failure traces/screenshots. A schema-versioned
`result.json` records the environment, assertions, policy, counts, and
repository-relative artifact paths.

The web-calculator scenario audits the final rendered `238` state with the
pinned official `@axe-core/playwright` integration. WCAG 2.0, 2.1, and 2.2
Level A/AA violations block only after raw JSON, summaries, the final
screenshot, and native-report attachments are written. Incomplete findings
remain visible for manual review but are initially nonblocking. Automated
auditing supplements rather than replaces manual accessibility review.
