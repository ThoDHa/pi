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
# Also absent: tests/condensed-footer.test.mjs and
# tests/periscope-view.test.mjs. Both depend on the repo-local
# @earendil-works/pi-tui shim that tests/provision-pi-tui.mjs provisions
# by walking up from `which pi`; on hosts where no pi installation
# carrying that package is locatable the two fail in provisioning, which
# is environmental, not a regression. Run them standalone on a host where
# the shim provisions.
#
# Known postures: the moved shell suites degrade per their own contracts
# (ISOLATION_ALLOW_DEGRADED=1 gates tool-dependent sections), so run-all
# works on the host fully and in bare environments on what ran.

set -u
cd "$(dirname "$0")/.." || exit 1

NODE_SUITES="cooldown cooldown-invariant fence-ask manager-body-pin permission-gate shim-convention subagent-dispatch-registry subagent-module-load subagent-prompt-temp workspace-fence periscope-activity-filter periscope-detail-scroll periscope-navigator-detail periscope-navigator-tree periscope-strip-render periscope-task-label periscope-transcript-thinking"
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
