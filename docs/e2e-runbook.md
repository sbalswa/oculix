# Run and watch E2E tests

This runbook covers the human-operated GitHub Actions path. For local commands,
capability details, and framework architecture, see
[CI execution and evidence](../README.md#ci-execution-and-evidence).

The workflow is named **Demand-driven E2E selectors**. Actual E2E execution is
opt-in: apply a `ci:e2e:*` label to a pull request or dispatch the workflow
manually. Label synchronization creates and updates label definitions; it does
not apply a label or start E2E work.

## Start E2E from a pull request

1. Open the pull request on GitHub.
2. In the right sidebar, select **Labels**.
3. Apply one or more `ci:e2e:*` labels:
   - `ci:e2e:smoke` runs the stable Selenium smoke selection.
   - `ci:e2e:<tool>:<os>:<browser>` runs one exact capability.
   - `ci:e2e:<tool>:all` runs every stable capability for one tool.
   - `ci:e2e:all` runs every stable capability.
4. Open the pull request's **Checks** tab or select the new
   **Demand-driven E2E selectors** run.

Adding or removing an E2E label replans the pull request and cancels obsolete
in-progress selector work. Applying multiple labels produces a de-duplicated
union.

## Start E2E manually

1. Open the repository's **Actions** tab.
2. Select **Demand-driven E2E selectors** in the workflow list.
3. Select **Run workflow**.
4. Select the branch containing the commit to test.
5. Choose a preset:
   - `smoke` runs the current stable smoke selection.
   - `full` runs every stable capability.
   - `custom` accepts comma- or newline-separated exact capability IDs or
     exact labels.
   - `none` intentionally runs no E2E capability.
6. For `custom`, enter selectors such as:

   ```text
   selenium-ubuntu-chromium
   ci:e2e:cypress:ubuntu:chrome
   ```

7. Enable experimental capabilities only when intentionally testing an exact
   experimental selector.
8. Select the green **Run workflow** button.

The equivalent GitHub CLI commands are:

```sh
# One-cell smoke selection:
gh workflow run e2e-selectors.yml \
  --ref main \
  -f preset=smoke \
  -f include_experimental=false

# Every stable capability:
gh workflow run e2e-selectors.yml \
  --ref main \
  -f preset=full \
  -f include_experimental=false

# Two exact capabilities:
gh workflow run e2e-selectors.yml \
  --ref main \
  -f preset=custom \
  -f selectors=selenium-ubuntu-chromium,ci:e2e:cypress:ubuntu:chrome \
  -f include_experimental=false
```

Replace `main` with a remote branch name to test that branch. A manual dispatch
validates the commit selected by `--ref`.

## Watch the run

In GitHub:

1. Open **Actions → Demand-driven E2E selectors**.
2. Open the newest run for the selected pull request or branch.
3. Confirm **Plan selected E2E capabilities** succeeds.
4. Open each `E2E <capability-id>` job to watch its steps and logs.
5. Review the job summary for the tool, operating system, browser, task,
   evidence path, report validation, and final result.

With the GitHub CLI:

```sh
gh run list \
  --workflow=e2e-selectors.yml \
  --event=workflow_dispatch \
  --limit=5

gh run watch RUN_ID --compact --exit-status
gh run view RUN_ID --web
```

`gh workflow run` prints the created run URL when GitHub returns it. Otherwise,
use `gh run list` to obtain `RUN_ID`.

### Skipped is not successful E2E

If **Plan selected E2E capabilities** and `E2E ${{ matrix.id }}` are marked
**skipped**, no browser capability ran. This is expected for a pull request
without a `ci:e2e:*` label and for a manual dispatch using `preset=none`.

Count a capability as executed only when its concrete
`E2E <capability-id>` job ran and completed successfully. The ordinary
cross-platform checks do not substitute for this evidence.

## Inspect and download evidence

Every selected capability uploads its diagnostics automatically, including
diagnostics produced before a failed test. The test harnesses generate this
media; it is not created or interpreted by an LLM.

1. Open the completed workflow run.
2. On its **Summary** page, scroll to **Artifacts**.
3. Download `e2e-<capability-id>`.
4. Extract the archive and inspect its reports and end-user evidence.

Artifacts are retained for seven days. Download all artifacts or one exact
capability with:

```sh
gh run download RUN_ID --dir e2e-artifacts

gh run download RUN_ID \
  --name e2e-cypress-ubuntu-chrome \
  --dir e2e-artifacts/cypress
```

Current evidence:

| Capability | End-user evidence and reports |
| --- | --- |
| Selenium | Final PNG screenshots, result JSON, and accessibility JSON/Markdown; no continuous video |
| Cypress | PNG screenshots, MP4 video, run/summary JSON and Markdown, and accessibility reports |
| Playwright | Final PNG screenshots, WebM video, native JSON/HTML reports, accessibility reports, and traces on failure |
| Oculix | Final PNG screenshot; no continuous video or accessibility report |

The exact paths and current artifact names are listed in the root README's
[Artifacts and reports](../README.md#artifacts-and-reports) table.

## Troubleshoot

- **No concrete E2E job:** add a valid `ci:e2e:*` label or dispatch `smoke`,
  `full`, or a nonempty `custom` selection.
- **Planner failure:** use an exact capability ID or exact label for `custom`;
  broad selectors belong in their corresponding preset.
- **Automation applied a label but nothing started:** labels applied with the
  default `GITHUB_TOKEN` do not recursively trigger the labeled event. Dispatch
  the selector workflow explicitly.
- **Missing artifact:** inspect **Validate reports and end-user result
  evidence** and **Upload E2E evidence and diagnostics** in the capability job.
- **Expired artifact:** rerun the same commit; retention is seven days.
- **Repeated browser failure:** rerun a transient failure once, then investigate
  repeated failures rather than changing the selector.

Automated lifecycle selection beyond these human-operated paths is tracked in
[issue #81](https://github.com/sbalswa/oculix/issues/81).
