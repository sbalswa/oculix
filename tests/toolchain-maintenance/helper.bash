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

  mkdir -p "${TEST_REPOSITORY_ROOT}/mise" "${TEST_BIN}"
  cp "${BATS_TEST_DIRNAME}/fixtures/gh" "${TEST_BIN}/gh"
  chmod +x "${TEST_BIN}/gh"
  printf 'java = "temurin-17"\n' \
    >"${TEST_REPOSITORY_ROOT}/mise/config.oculix.toml"
  : >"${GH_LOG}"
  : >"${GH_EVENTS}"

  export GITHUB_REPOSITORY="sbalswa/oculix"
  export GH_SCENARIO="match"
  export GH_LOG GH_EVENTS GH_BODY GH_TITLE GH_STATE SNAPSHOT_SHA
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
