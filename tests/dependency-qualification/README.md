# Dependency qualification contract

Issue #74 defines the data boundary between dependency collectors, isolated
validation, traffic control, combined cohort validation, and reporting.
Providers do not communicate with each other and do not decide cohort
readiness.

## Documents

Every document uses `schema_version: 1`, binds a repository commit, carries a
UTC generation timestamp, rejects unknown fields, and has one discriminating
`kind`:

- `observation`: current and candidate components plus their relations.
- `validation`: independent capability results for one candidate digest.
- `plan`: bounded traffic-controller assignments and blockers.
- `cohort`: combined capability results for one admitted cohort.

Documents also bind the semantic digest and schema version of the committed
capability catalog. A catalog change therefore makes old validation evidence
stale even when a capability keeps the same ID.

Lifecycle states are intentionally scoped to their document kind. In
particular, `candidate` is an observation, `independently-qualified` is an
isolated validation result, `cohort-planned` is a solver result, and
`ready-before-release` is a combined qualification result. The latter is not
GitHub's ready-for-review state.

## Canonical data and digests

Contract arrays are unordered sets. Canonicalization recursively sorts object
keys and array members using platform-independent lexical JSON ordering, then
emits exactly one trailing newline.

Three digest projections serve different purposes:

- `subjectDigest`: binds the candidate or cohort identity, repository
  revision, constraints, managed paths, and affected capabilities.
- `evidenceDigest`: binds semantic source/test evidence and result status
  without binding workflow URLs or rendering timestamps.
- `contentDigest`: binds the complete document except volatile execution
  timestamps.

Changing a candidate, constraint, repository commit, result, warning, or
artifact digest changes the appropriate digest. Rerunning equivalent work at a
different time does not change subject or evidence identity.

## Safety rules

- Capability IDs must exist in `tests/e2e/capabilities.json`, which is
  validated through the existing E2E catalog validator.
- Unknown or unavailable states require stable reason codes.
- Independent and combined qualification require every result to pass without
  warnings.
- Eventual managed paths are POSIX repository-relative paths without globbing,
  backslashes, or traversal.
- Exact, ancestor/descendant, and case-folded managed-path collisions fail.
- Provider aggregation rejects duplicate provider, component, and relation
  IDs plus dangling relation endpoints. Every provider in one set must bind
  the same repository revision and capability-catalog digest.
- Independent qualification must bind the observation's exact subject digest,
  provider, repository revision, and complete affected-capability set.
- A planned frontier must contain only warning-free passing capability
  results.
- Final qualification must bind the plan digest, base revision, exact admitted
  candidate set, independently qualified evidence, combined commit, and
  complete frontier capability set.

These paths identify what a later consumer may change. Contract validation and
collection must not modify them.

Collector jobs exchange data through a directory of JSON observation
documents. `readProviderSet()` ignores non-JSON files, reads JSON files in
lexical filename order, validates every document, and only then returns the
aggregate provider set. A malformed or stale producer fails aggregation rather
than being silently omitted.
