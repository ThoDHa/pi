#!/usr/bin/env bash
#
# Suite result counters for the task-storage-isolation family.
#
# Sourced by run-suite.sh, run-adversarial.sh, and
# run-e2e-roundtrip.sh. Initializes pass/fail/skip at source time;
# ok/bad/skip_test record one check each and print it; print_result
# prints the suite summary. The exit decision stays with the caller
# (gates on the fail counter), matching the family's exit contract.
#
# Reconstructed for the pi-side landing from the family's call sites:
# the dotfiles shared tests/lib/harness.sh stays with the opencode
# column there, and no pi-repo suite shared it, so the moved family
# carries this suite-local equivalent with the same contract.

pass=0
fail=0
skip=0

ok() {
	pass=$((pass + 1))
	printf 'ok    %s\n' "$*"
}

bad() {
	fail=$((fail + 1))
	printf 'FAIL  %s\n' "$*"
}

skip_test() {
	skip=$((skip + 1))
	printf 'skip  %s\n' "$*"
}

print_result() {
	printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
}
