#!/usr/bin/env bats

load helper

setup() {
  setup_toolchain_fixture
}

@test "maintenance script is sourceable without GitHub calls and exposes the JDK watcher" {
  run env -u GITHUB_REPOSITORY bash -c '
    source "$1"
    declare -F configured_java_major >/dev/null
    declare -F watch_oculix_jdk >/dev/null
  ' _ "${MAINTENANCE_SCRIPT}"

  assert_success
  [[ ! -s "${GH_LOG}" ]]
}

@test "configured_java_major parses the configured Temurin major" {
  set_configured_java "21.0.4"

  run bash -c '
    cd "$1"
    export GITHUB_REPOSITORY=sbalswa/oculix
    source "$2"
    configured_java_major
  ' _ "${TEST_REPOSITORY_ROOT}" "${MAINTENANCE_SCRIPT}"

  assert_success
  [[ "$output" == "21" ]]
}

@test "upstream discovery uses master and an immutable commit snapshot" {
  run_jdk_watch

  assert_success
  assert_file_contains "${GH_LOG}" "repos/oculix-org/Oculix"
  assert_file_contains "${GH_LOG}" "master"
  assert_file_contains "${GH_LOG}" "${SNAPSHOT_SHA}"
  assert_no_issue_mutation
}

@test "literal numeric declarations are normalized and ignored values remain evidence" {
  GH_SCENARIO="mismatch"
  export GH_SCENARIO
  run_jdk_watch

  assert_success
  [[ "$(grep -c '^create$' "${GH_EVENTS}")" -eq 1 ]]
  [[ "$(cat "${GH_TITLE}")" == "${FIXED_ALERT_TITLE}" ]]
  assert_file_contains "${GH_BODY}" "temurin-17"
  assert_file_contains "${GH_BODY}" "21"
  assert_file_contains "${GH_BODY}" "21.0.4"
  assert_file_contains "${GH_BODY}" "unquoted.yml"
  assert_file_contains "${GH_BODY}" "double-quoted.yml"
  assert_file_contains "${GH_BODY}" "single-quoted.yml"
  assert_file_contains "${GH_BODY}" '${{ matrix.java }}'
  assert_file_contains "${GH_BODY}" "17-21"
  assert_file_contains "${GH_BODY}" "${SNAPSHOT_SHA}"
  assert_file_contains "${GH_BODY}" "#L"
}

@test "strict dominant mismatch creates one fixed-title alert and repeated runs reuse it" {
  GH_SCENARIO="mismatch"
  export GH_SCENARIO

  run_jdk_watch
  assert_success
  run_jdk_watch
  assert_success

  [[ "$(grep -c '^create$' "${GH_EVENTS}")" -eq 1 ]]
  [[ "$(grep -c '^edit$' "${GH_EVENTS}")" -eq 1 ]]
  [[ "$(cat "${GH_TITLE}")" == "${FIXED_ALERT_TITLE}" ]]
}

@test "a matching dominant major resolves the existing alert with a comment and close" {
  GH_SCENARIO="match-existing"
  export GH_SCENARIO
  set_existing_alert
  run_jdk_watch

  assert_success
  [[ "$(grep -c '^comment$' "${GH_EVENTS}")" -eq 1 ]]
  [[ "$(grep -c '^close$' "${GH_EVENTS}")" -eq 1 ]]
  assert_file_contains "${GH_BODY}" "resolved automatically"
  [[ ! -s "${GH_STATE}" ]]
}

@test "a tied mode reports ambiguity and does not recommend a target major" {
  GH_SCENARIO="tie"
  export GH_SCENARIO
  run_jdk_watch

  assert_success
  [[ "$(grep -c '^create$' "${GH_EVENTS}")" -eq 1 ]]
  assert_file_contains "${GH_BODY}" "No unique dominant"
  assert_file_contains "${GH_BODY}" "17"
  assert_file_contains "${GH_BODY}" "21"
  assert_file_contains "${GH_BODY}" "2"
  assert_file_not_contains "${GH_BODY}" "Adopt Java"
}

@test "no literal declarations reports ambiguity and preserves ignored evidence" {
  GH_SCENARIO="no-declarations"
  export GH_SCENARIO
  run_jdk_watch

  assert_success
  [[ "$(grep -c '^create$' "${GH_EVENTS}")" -eq 1 ]]
  assert_file_contains "${GH_BODY}" "No unique dominant"
  assert_file_contains "${GH_BODY}" '${{ matrix.java }}'
  assert_file_contains "${GH_BODY}" "17-21"
  assert_file_not_contains "${GH_BODY}" "Adopt Java"
}

@test "upstream failures leave issue state unchanged" {
  local failure
  for failure in \
    default-branch-failure \
    snapshot-failure \
    workflow-list-failure \
    content-failure
  do
    GH_SCENARIO="$failure"
    export GH_SCENARIO
    : >"${GH_EVENTS}"
    set_existing_alert

    run_jdk_watch
    assert_success
    assert_no_issue_mutation
    [[ "$(cat "${GH_STATE}")" == "73" ]]
  done
}
