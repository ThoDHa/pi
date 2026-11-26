#!/bin/bash
#
# tests/run-all.sh: run every hermetic suite in this repo, one invocation
# per suite, exit-gated. Each suite prints its own summary; the loop
# stops at the first failing suite and exits nonzero naming it.
#
#   bash tests/run-all.sh
#
# Deliberately absent (manual, LLM-calling, documented in tests/README.md):
#   bash tests/task-storage-isolation/run-skeleton.sh
#   bash tests/task-storage-isolation/run-e2e-roundtrip.sh
#
# Node suites are discovered from tests/*.test.mjs, so a new suite is
# covered by default. The exclusions below are conscious, not an
# oversight: both depend on the repo-local @earendil-works/pi-tui shim
# that tests/provision-pi-tui.mjs provisions by walking up from
# `which pi`; on hosts where no pi installation carrying that package is
# locatable they fail in provisioning, which is environmental, not a
# regression. Run them standalone on a host where the shim provisions.
#
# Known postures: the moved shell suites degrade per their own contracts
# (ISOLATION_ALLOW_DEGRADED=1 gates tool-dependent sections), so run-all
# works on the host fully and in bare environments on what ran. The
# subagent-thinking-level suite carries two gated checks that print a
# named skip instead of failing when their subject is absent: the
# external pin against pi's installed ThinkingLevel vocabulary (needs a
# locatable pi installation) and the deployed-fleet chart pin (needs
# ~/.pi/agent/agents, gitignored machine config the repo does not
# carry); every other check in every suite runs everywhere.

set -u
cd "$(dirname "$0")/.." || exit 1

EXCLUDED_NODE_SUITES="condensed-footer periscope-view"
NODE_SUITES=""
for suite_path in tests/*.test.mjs; do
	[[ -e "$suite_path" ]] || continue
	suite="${suite_path#tests/}"
	suite="${suite%.test.mjs}"
	case " $EXCLUDED_NODE_SUITES " in
		*" $suite "*) continue ;;
	esac
	NODE_SUITES="$NODE_SUITES $suite"
done
SHELL_SUITES="task-storage-isolation/run-suite.sh task-storage-isolation/run-adversarial.sh"

for suite in $NODE_SUITES; do
	echo "=== node tests/$suite.test.mjs ==="
	node "tests/$suite.test.mjs" || { echo "run-all: FAILED: node tests/$suite.test.mjs"; exit 1; }
done
for suite in $SHELL_SUITES; do
	echo "=== bash tests/$suite ==="
	bash "tests/$suite" || { echo "run-all: FAILED: bash tests/$suite"; exit 1; }
done
echo "run-all: all suites passed"
