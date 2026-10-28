# brooks-triage

Turn a live brooks-lint scan into a burn-down backlog. File nothing until the
human approves each proposal.

Argument: a brooks-lint mode (`review`, `audit`, `debt`, `test`, `health`,
`sweep`) or `all`. Default `all`.

## Process

1. **Scan now.** Run the requested mode(s) against current `HEAD` and use that
   report only. Never file from a stored or stale report.
2. **Reshape.** Translate risk-grouped findings into **PR-sized units** (one
   coherent change per issue). Split findings that are many changes; fold
   findings that share one root cause.
3. **Dedupe.** For each unit, search open **and** closed issues for its marker
   (see Identity). Resolve the state machine before proposing anything.
4. **Filter.** Apply the worthiness filter. Failures are still proposed, but as
   file-and-close `not planned` (or open + `known-limitation` when premature).
5. **Propose only.** Present every proposed action for approval. Create, reopen,
   comment, or close **only** what is approved. Never bulk-apply.

## Identity

Every finding issue body ends with exactly one marker line:

```text
<!-- brooks-lint:<RISK>:<path> -->
```

That marker is the dedupe key (`path`, not `file:line`). Evidence lines in the
body may include `file:line` and may be updated by comment when the evidence
changes; line drift must not create a second issue.

Search example:

```sh
gh issue list --state all --search 'brooks-lint:R3 in:body'
```

Do not put a concrete marker in documentation or this command — only in real
finding issues — or dedupe will treat the finding as already tracked.

## Dedupe state machine

| Marker | State | Action when the finding reappears |
| --- | --- | --- |
| absent | — | **create** (after approval) |
| present | open | **skip** — already tracked; comment only if evidence changed |
| present | closed `completed` | **reopen** — regression |
| present | closed `not planned` | **ignore** — durable suppression |
| present | closed `duplicate` | **ignore** — follow the canonical issue |

## Parent structure (enduring burn-down)

There is **one** tracking parent: `brooks-lint burn-down` (no date in the title).

- Ensure that parent exists (create once if missing).
- Attach **new** finding issues as native sub-issues of that parent.
- Reopens stay on the original issue (same parent). Never open a second issue
  for the same marker under a new parent.
- Dated “batch” language belongs only in the triage run summary/comment, not in
  a new parent issue.

## Worthiness filter

File only findings that are **real, addressable, and well-documented**.

| Outcome | When |
| --- | --- |
| File open + assign `P0`–`P3` + `brooks-lint` (+ `ready` when implementable) | Real, addressable, worth burning down |
| File open + `known-limitation` + explicit closure condition (prefer an active trigger) | Valid but premature |
| File then close as `not planned` with reasoning | Not worth fixing, not a defect, justified deviation, or already resolved |
| Skip create | Marker already open / suppressed / duplicate per the state machine |

Assign exactly one of `P0`–`P3` at triage time (repository taxonomy; Critical /
High / Medium / Low live on the label descriptions).

Reuse existing labels where they fit (`automation`, `ready`, `known-limitation`,
`good first issue`). Do not invent severity or risk-code labels.

## Body template (new issues)

```markdown
**Symptom:** <what was observed, with measured evidence>
**Source:** <book — principle or smell>
**Consequence:** <what breaks or worsens if unfixed>
**Remedy:** <concrete imperative action>

**Acceptance:** <how to verify the fix>
**Blocked by:** #N          <!-- omit when unblocked -->

<!-- brooks-lint:<RISK>:<path> -->
```

## Proposal format

For each unit, show before acting:

- Proposed action (`create` / `skip` / `reopen` / `ignore` / `not planned` / `known-limitation`)
- Marker and dedupe resolution (issue number when present)
- Parent: `brooks-lint burn-down`
- Suggested title, priority (`P0`–`P3`), labels
- One-line rationale (worthiness)

After approvals, execute only the approved set and summarize what changed.
