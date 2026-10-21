# Playwright E2E harness

The harness separates provisioning from scenario execution:

- `mise run e2e:playwright:setup [BROWSER]` is the online setup phase. It runs
  the locked package installation, installs the selected Playwright browser,
  and installs browser OS prerequisites on Ubuntu.
- `mise run e2e:playwright:smoke [BROWSER]` and
  `mise run e2e:playwright:web-calculator [BROWSER]` are offline scenario
  phases. They reject missing or stale setup stamps instead of installing
  dependencies.
- `mise run e2e:playwright [BROWSER]` runs setup once, then smoke and
  web-calculator in order.

The browser may also be selected with `PLAYWRIGHT_PROJECT` or `E2E_BROWSER`.
`E2E_OS` must identify the current runner family. Setup stamps bind the lockfile
hash, browser, operating-system label, platform, and architecture so a matrix
cell cannot silently reuse an incompatible installation.
