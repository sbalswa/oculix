#!/usr/bin/env bats

load helper

setup() {
  setup_plan_fixture
}

# A held pull request is the hold working as designed: a human has not marked the
# update ready yet. Reporting success keeps that state quiet, which is correct.
@test "a held update alone blocks the lane without failing the run" {
  set_open_toolchain_pull_request

  run_plan

  assert_success
  assert_file_contains "${GITHUB_OUTPUT}" "blocked=true"
  assert_file_contains "${GITHUB_OUTPUT}" "mise_candidate="
}

# A block alongside an open triage issue means validation failed and nobody acted.
# Reporting success there is what hid a four-day outage behind four green runs.
@test "a held update with an open triage issue fails the run" {
  set_open_toolchain_pull_request
  set_open_triage_issue

  run_plan

  assert_failure
  assert_file_contains "${GITHUB_OUTPUT}" "blocked=true"
}

@test "the failure names the blocking pull request and the triage issue" {
  set_open_toolchain_pull_request
  set_open_triage_issue 90

  run_plan

  assert_failure
  [[ "$output" == *"#89"* ]] || {
    printf 'Expected the blocking pull request in:\n%s\n' "$output" >&2
    return 1
  }
  [[ "$output" == *"#90"* ]] || {
    printf 'Expected the triage issue in:\n%s\n' "$output" >&2
    return 1
  }
}

@test "an unblocked lane neither fails nor reports a block" {
  run_plan

  assert_success
  assert_file_contains "${GITHUB_OUTPUT}" "blocked=false"
}
