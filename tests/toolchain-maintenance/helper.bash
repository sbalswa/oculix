PROJECT_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
MAINTENANCE_SCRIPT="${PROJECT_ROOT}/.github/scripts/toolchain-maintenance"
export FIXED_ALERT_TITLE="Oculix JDK major drift detected"
SNAPSHOT_SHA="0123456789abcdef0123456789abcdef01234567"

# Bats assigns these globals after each `run` invocation.
declare status output

setup_toolchain_fixture() {
  TEST_REPOSITORY_ROOT="${BATS_TEST_TMPDIR}/repository"
  TEST_BIN="${BATS_TEST_TMPDIR}/bin"
  GH_LOG="${BATS_TEST_TMPDIR}/gh.log"
  GH_EVENTS="${BATS_TEST_TMPDIR}/gh.events"
  GH_BODY="${BATS_TEST_TMPDIR}/gh.body"
  GH_TITLE="${BATS_TEST_TMPDIR}/gh.title"
  GH_STATE="${BATS_TEST_TMPDIR}/gh.state"
  GH_COMMENTS="${BATS_TEST_TMPDIR}/gh.comments"
  GH_CLOSE_ATTEMPT="${BATS_TEST_TMPDIR}/gh.close-attempt"

  mkdir -p "${TEST_REPOSITORY_ROOT}/mise" "${TEST_BIN}"
  cp "${BATS_TEST_DIRNAME}/fixtures/gh" "${TEST_BIN}/gh"
  chmod +x "${TEST_BIN}/gh"
  printf 'java = "temurin-17"\n' \
    >"${TEST_REPOSITORY_ROOT}/mise/config.oculix.toml"
  : >"${GH_LOG}"
  : >"${GH_EVENTS}"
  : >"${GH_COMMENTS}"
  : >"${GH_CLOSE_ATTEMPT}"

  export GITHUB_REPOSITORY="sbalswa/oculix"
  export GH_SCENARIO="match"
  export GH_LOG GH_EVENTS GH_BODY GH_TITLE GH_STATE GH_COMMENTS
  export GH_CLOSE_ATTEMPT SNAPSHOT_SHA
  export PATH="${TEST_BIN}:${PATH}"
}

set_configured_java() {
  printf 'java = "temurin-%s"\n' "$1" \
    >"${TEST_REPOSITORY_ROOT}/mise/config.oculix.toml"
}

set_existing_alert() {
  printf '%s\n' "${1:-73}" >"${GH_STATE}"
}

run_jdk_watch() {
  run bash -c 'cd "$1" && "$2" watch-oculix-jdk' \
    _ "${TEST_REPOSITORY_ROOT}" "${MAINTENANCE_SCRIPT}"
}

# plan() resolves `git rev-parse HEAD`, so its fixture needs a real commit.
# Signing and hooks are disabled so the fixture does not depend on the
# developer's own Git configuration.
setup_plan_fixture() {
  setup_toolchain_fixture
  printf 'min_version = "2026.10.3"\n' \
    >"${TEST_REPOSITORY_ROOT}/mise/config.toml"
  git -C "${TEST_REPOSITORY_ROOT}" init --quiet
  git -C "${TEST_REPOSITORY_ROOT}" config user.name "Toolchain test"
  git -C "${TEST_REPOSITORY_ROOT}" config user.email "toolchain@example.invalid"
  git -C "${TEST_REPOSITORY_ROOT}" config commit.gpgsign false
  git -C "${TEST_REPOSITORY_ROOT}" add --all
  git -C "${TEST_REPOSITORY_ROOT}" commit --quiet --no-verify -m "fixture"
  GITHUB_OUTPUT="${BATS_TEST_TMPDIR}/github-output"
  : >"${GITHUB_OUTPUT}"
  export GITHUB_OUTPUT
}

# One open automation/toolchain pull request is all plan() counts as a block.
set_open_toolchain_pull_request() {
  local title="${1:-[HOLD] chore: update mise to 2026.10.10}"

  GH_OPEN_PULL_REQUESTS="$(
    printf '[{"number":89,"title":"%s","url":"%s","headRefName":"%s"}]' \
      "$title" \
      "https://github.com/sbalswa/oculix/pull/89" \
      "automation/toolchain/mise-2026.10.10-abcdef123456"
  )"
  export GH_OPEN_PULL_REQUESTS
}

set_open_triage_issue() {
  printf '%s\n' "${1:-90}" >"${GH_STATE}"
  GH_OPEN_ISSUE_TITLE="Toolchain maintenance needs triage"
  export GH_OPEN_ISSUE_TITLE
}

run_plan() {
  run bash -c 'cd "$1" && "$2" plan' \
    _ "${TEST_REPOSITORY_ROOT}" "${MAINTENANCE_SCRIPT}"
}

assert_failure() {
  if [[ "$status" -eq 0 ]]; then
    printf 'Expected failure, got status 0.\nOutput:\n%s\n' "$output" >&2
    return 1
  fi
}

assert_success() {
  if [[ "$status" -ne 0 ]]; then
    printf 'Expected success, got status %s.\nOutput:\n%s\n' \
      "$status" "$output" >&2
    return 1
  fi
}

assert_no_issue_mutation() {
  if grep -Eq '^(create|comment|close|edit)$' "${GH_EVENTS}"; then
    printf 'Unexpected issue mutation:\n' >&2
    cat "${GH_EVENTS}" >&2
    return 1
  fi
}

assert_file_contains() {
  local file="$1"
  local expected="$2"

  if ! grep -Fq -- "$expected" "$file"; then
    printf 'Expected %s to contain:\n%s\nActual:\n' "$file" "$expected" >&2
    cat "$file" >&2
    return 1
  fi
}

assert_file_not_contains() {
  local file="$1"
  local unexpected="$2"

  if grep -Fq -- "$unexpected" "$file"; then
    printf 'Expected %s not to contain:\n%s\nActual:\n' \
      "$file" "$unexpected" >&2
    cat "$file" >&2
    return 1
  fi
}
