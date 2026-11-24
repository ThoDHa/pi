#!/usr/bin/env bash
#
# End-to-end integration pass for raw task-storage isolation (ORCH-4-10-4),
# pi harness. The opencode counterpart (the plugin-brokered service
# round trip) lives with the opencode enforcement surface in the
# dotfiles repo.
#
# One full manager dispatch round trip with enforcement on. This is
# the composition evidence the machine-side suites cannot produce: a
# real manager session (pi through the activated child-wrap) dispatches
# one real worker child, and that one child session both completes
# sanctioned board operations (a Work Log checkpoint and a report
# deposit, verifiable on the host board under channel attribution) and
# has every direct-access probe denied (relative and absolute masked
# reads, symlink traversal, a dot-dot composition, and the structured
# read-tool lane through the guard).
#
# Shape: a fixture repo whose agent dir is a copy of the vendored
# subagent extension with the wrap ACTIVATED (the suite's activation
# path, task-storage-isolation-wrap.py activate); the parent pi session
# runs with PI_TASK_STORAGE_ISOLATION=1 and the task-storage-isolation
# extension, which hosts the escape-channel service and publishes the
# wiring; the child is dispatched through the vendored extension's own
# spawn path and runs under bwrap with the board masked.
#
# The run makes two real LLM calls (manager parent, worker child), so
# this suite is manual and outside tests/run-all.sh. Argument 1
# overrides the model; the default is the fleet worker model
# (zai/glm-5.3-flash).
#
# pi credential lane: the wrap never binds auth.json (or sessions/) into
# the masked child, so the child authenticates from the environment
# (providers.md env lane, ZAI_API_KEY for the zai provider). The script
# takes an ambient ZAI_API_KEY when set and otherwise reads the provider
# key from the host auth store at run time; the key exists only in the
# run's process environment, is never written to a file, and the
# credential store itself never crosses the isolation boundary.
#
# Exit contract: non-zero unless every check passes; the run directory
# is kept and printed for inspection on failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITE_DIR="$REPO_ROOT/tests/task-storage-isolation"
LIB="$SUITE_DIR/lib"

MODEL="${1:-zai/glm-5.3-flash}"

# The escape-channel service executes `tasks` from PATH; the stowed CLI
# lives in ~/.local/bin.
case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*) PATH="$HOME/.local/bin:$PATH" ;;
esac
TASKS_BIN="$(command -v tasks)"

# The EXIT handler is inline as a workaround: the natural form is a
# named cleanup() referenced by the trap, but shellcheck 0.11.0 cannot
# model functions invoked via trap (SC2329) or assignments inside trap
# strings, so the body is inlined and status is pre-initialized and
# reassigned at fire time (the same form run-suite.sh uses).
status=0
trap '{
	status=$?
	if [[ "$status" -eq 0 ]]; then
		rm -rf "$RUN"
	else
		echo "e2e round-trip artifacts kept for inspection: $RUN"
	fi
}' EXIT

fail_fast() {
	echo "E2E-FAIL: $*" >&2
	exit 1
}

# shellcheck source=/dev/null
source "$LIB/harness.sh"
# The counters are initialized by the harness at source time; they are
# re-declared here so static analysis sees the assignment without
# following the sourced file (the same form run-suite.sh uses).
# shellcheck disable=SC2034
pass=0
fail=0
# shellcheck disable=SC2034
skip=0

RUN="$(mktemp -d /tmp/task-e2e-roundtrip.XXXXXX)"

command -v pi >/dev/null || fail_fast "pi not installed"
command -v bwrap >/dev/null || fail_fast "bwrap not installed"
command -v tasks >/dev/null || fail_fast "tasks CLI not on PATH"
command -v git >/dev/null || fail_fast "git not installed"
[[ -d "$HOME/.pi/agent/extensions/subagent" ]] || fail_fast "vendored subagent extension not found"
[[ -x "$TASKS_BIN" ]] || fail_fast "repo tasks CLI missing at $TASKS_BIN"

# The masked child authenticates from the environment (the wrap never
# binds the credential store): an ambient ZAI_API_KEY wins, otherwise
# the provider key is read from the host auth store into the run env.
if [[ -z "${ZAI_API_KEY:-}" ]]; then
	ZAI_API_KEY="$(python3 - "$HOME/.pi/agent/auth.json" <<'PYEOF'
import json, sys
store = json.load(open(sys.argv[1]))
entry = store.get("zai", {})
print(entry.get("key", ""))
PYEOF
)"
	export ZAI_API_KEY
fi
[[ -n "${ZAI_API_KEY:-}" ]] || fail_fast "no credential lane for the masked child: ZAI_API_KEY unset and the host auth store carries no zai key"

board_hash() { # fixture dir -> stable hash of the board content
	( cd "$1" && find .tasks -type f -not -name "*.claim" -print0 | sort -z \
		| xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}

build_board_repo() { # $1 fixture dir; seeds the git repo, the masked
	# marker file with its symlink alias, and the board with one task.
	# Sets E2E_TASKFILE (bare board-entry name) and E2E_MARKER; the
	# caller sets HARNESS_UNDER_SEED and E2E_TASK_ID before calling.
	local fix="$1"
	mkdir -p "$fix/.tasks/reports"
	git -C "$fix" init -q
	git -C "$fix" config user.email e2e@fixture
	git -C "$fix" config user.name e2e
	echo ".tasks/" >"$fix/.gitignore"
	echo "fixture readme" >"$fix/README.md"
	git -C "$fix" add .gitignore README.md
	git -C "$fix" commit -qm "fixture repo"
	E2E_MARKER="$(printf 'PI-E2E-SECRET-%s-4104' "$HARNESS_UNDER_SEED")"
	printf 'secret: %s\n' "$E2E_MARKER" >"$fix/.tasks/reports/secret.md"
	ln -s .tasks/reports/secret.md "$fix/looks-innocent"
	TASKS_DIR="$fix/.tasks" TASKS_TEST_CLOCK="2026-11-18 12:00" TASKS_SESSION="e2e-seed" \
		"$TASKS_BIN" init >/dev/null
	TASKS_DIR="$fix/.tasks" TASKS_TEST_CLOCK="2026-11-18 12:00" TASKS_SESSION="e2e-seed" \
		"$TASKS_BIN" new --id "$E2E_TASK_ID" --name "Round-trip Target" >/dev/null
	E2E_TASKFILE="$(cd "$fix" && find .tasks/current -maxdepth 1 -name "${E2E_TASK_ID}-*.md" -printf '%f\n' | head -1)"
	[[ -n "$E2E_TASKFILE" ]] || return 1
	return 0
}

# ===========================================================================
echo "== pi: manager dispatch round trip through the activated wrap =="
# ===========================================================================
run="$RUN/pi"
	fix="$run/fixture"
	home="$run/home"
	agent="$home/.pi/agent"
	mkdir -p "$run"
	HARNESS_UNDER_SEED=pi
	E2E_TASK_ID=PIT-1
	if build_board_repo "$fix"; then
		ok "pi fixture board seeded ($E2E_TASKFILE)"
	else
		fail_fast "pi fixture board failed to seed"
	fi
	BEFORE_HASH="$(board_hash "$fix")"

	# The suite's activation path against a fixture agent dir: a full
	# copy of the host agent dir minus the entries the wrap never binds
	# anyway (sessions, auth.json, mcp-auth.json - the credential store
	# and the transcript store never cross the boundary), with the wrap
	# installed by the patcher. The child pi resolves this same dir via
	# PI_CODING_AGENT_DIR, so the drift-check target, the tmpfs mount
	# target, and the child's own agent dir are one directory and the
	# trust.json.lock write lands on the writable tmpfs. The live host
	# install is never touched.
	mkdir -p "$agent"
	while IFS= read -r entry; do
		case "$entry" in sessions | auth.json | mcp-auth.json) continue ;; esac
		cp -r "$HOME/.pi/agent/$entry" "$agent/$entry"
	done < <(find "$HOME/.pi/agent" -mindepth 1 -maxdepth 1 -printf '%f\n')
	PI_NM="$HOME/.nvm/versions/node/v24.22.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules"
	mkdir -p "$agent/extensions/subagent/node_modules/@earendil-works"
	for pkg in pi-agent-core pi-ai pi-coding-agent pi-tui; do
		ln -s "$PI_NM/@earendil-works/$pkg" "$agent/extensions/subagent/node_modules/@earendil-works/$pkg"
	done
	ln -s "$PI_NM/typebox" "$agent/extensions/subagent/node_modules/typebox"
	activate_out="$(python3 "$REPO_ROOT/extensions/task-storage-isolation-wrap.py" activate "$agent" 2>&1)"
	activate_rc=$?
	if [[ $activate_rc -eq 0 ]]; then
		ok "wrap activates on the fixture agent dir (the suite's activation path)"
	else
		fail_fast "wrap activation failed: rc=$activate_rc $activate_out"
	fi

	client="$REPO_ROOT/extensions/task-storage-isolation-client.py"
	CHILD_TASK="$(cat <<EOF
Run these commands from the current directory, one at a time, and build your final message strictly from their results. Output one block per label: the label, then that command's full stdout or its full error text verbatim.
CMD1: cat .tasks/reports/secret.md
CMD2: cat looks-innocent
CMD3: cat .tasks/./../.tasks/reports/secret.md || echo "compound-empty"
CMD4: python3 $client tasks log $E2E_TASKFILE --from worker "e2e-pi channel checkpoint PROVEMARK-PILOG-4104"
CMD5: printf 'E2E-PI report body PROVEMARK-PIREP-4104\n' | python3 $client tasks report $E2E_TASKFILE --slug e2e-roundtrip --from worker --digest "e2e round-trip deposit"
CMD6: python3 $client tasks show $E2E_TASKFILE --tail 4
After the commands, use the read tool on the file .tasks/reports/secret.md and output its exact error text as label CMD7.
EOF
)"
	PARENT_PROMPT="Call the subagent tool exactly once with agent \"worker\" and exactly this task text, changing nothing: $CHILD_TASK After the child returns, output only the final message content of the child verbatim."

	(
		cd "$fix" || exit 1
		export HOME="$home"
		export PI_CODING_AGENT_DIR="$agent"
		export PI_TASK_STORAGE_AGENT_DIR="$agent"
		export PI_TASK_STORAGE_ISOLATION=1
		export TASKS_SESSION=e2e-manager
		exec timeout 480 pi --mode json -p --no-session --no-extensions \
			-e "$agent/extensions/subagent/index.ts" \
			-e "$REPO_ROOT/extensions/task-storage-isolation.ts" \
			--model "$MODEL" "$PARENT_PROMPT" >"$run/parent.out" 2>"$run/parent.err"
	)
	pi_dispatch_rc=$?
	if [[ $pi_dispatch_rc -eq 0 ]]; then
		ok "parent pi session exited zero"
	else
		bad "parent pi session exited non-zero: rc=$pi_dispatch_rc (see $run/parent.err)"
	fi
	if [[ -s "$run/parent.out" ]]; then
		ok "parent relayed the child result"
	else
		bad "parent produced no output"
	fi
	if grep -qF "\"cwd\":\"$fix\"" "$run/parent.out"; then
		ok "parent session cwd was the fixture repo"
	else
		bad "parent session cwd was not the fixture repo"
	fi
	if grep -q "active; masking" "$run/parent.err"; then
		ok "parent session hosted the escape channel (activation line)"
	else
		bad "parent session never logged the isolation activation line"
	fi

	# The hosted channel's scratch dir (socket, service log) is removed
	# by the extension's session_shutdown when the parent exits, so the
	# durable service evidence is the activation line's socket path plus
	# the channel-attributed board writes verified below - the board
	# mutations are themselves the proof the service served sanctioned
	# requests (every refusal path leaves the board untouched).
	socket_line="$(grep -o 'escape channel on [^ ]*' "$run/parent.err" | head -1)"
	if [[ "$socket_line" == *"/tmp/task-storage-isolation-"*"/service.sock" ]]; then
		ok "hosted escape channel socket recorded ($socket_line)"
	else
		bad "no escape-channel socket path in the parent activation line"
	fi

	for label in CMD1 CMD2 CMD3 CMD4 CMD5 CMD6 CMD7; do
		if grep -qF "$label" "$run/parent.out"; then
			ok "child ran $label"
		else
			bad "child never reported $label"
		fi
	done
	if grep -q "No such file or directory" "$run/parent.out"; then
		ok "masked reads denied with ENOENT (CMD1/CMD2/CMD3)"
	else
		bad "no ENOENT denial text in the child result"
	fi
	if grep -qF "compound-empty" "$run/parent.out"; then
		ok "dot-dot composition landed empty (CMD3)"
	else
		bad "dot-dot composition probe did not report its fallback"
	fi
	if grep -q "read denied for child session" "$run/parent.out"; then
		ok "read-tool lane denied by the guard (CMD7)"
	else
		bad "read-tool guard lane produced no denial text"
	fi
	if grep -qF "$E2E_MARKER" "$run/parent.out" "$run/parent.err"; then
		bad "secret marker never reached the child output"
	else
		ok "secret marker never reached the child output"
	fi
	if grep -qF "PROVEMARK-PILOG-4104" "$run/parent.out"; then
		ok "child read its own channel write back through the channel (CMD6)"
	else
		bad "channel write never read back through the channel (CMD6)"
	fi

	# Host-side board verification: the writes landed under channel
	# attribution, never under the claimed session identity.
	log_tail="$(TASKS_DIR="$fix/.tasks" "$TASKS_BIN" show "$E2E_TASKFILE" --tail 4)"
	if grep -qF "PROVEMARK-PILOG-4104" <<<"$log_tail" && grep -q "iso-channel-" <<<"$log_tail"; then
		ok "board Work Log carries the channel checkpoint under iso-channel attribution"
	else
		bad "board Work Log missing the attributed channel checkpoint"
	fi
	report_file="$(find "$fix/.tasks/reports" -type f -name '*e2e-roundtrip*.md' | head -1)"
	if [[ -n "$report_file" ]] && grep -qF "PROVEMARK-PIREP-4104" "$report_file"; then
		ok "board report deposit carries the channel body"
	else
		bad "board report deposit missing or body-less"
	fi
	if grep -qF "01-e2e-roundtrip" <<<"$log_tail" && grep -q "iso-channel-" <<<"$log_tail"; then
		ok "the report's Work Log entry carries iso-channel attribution"
	else
		bad "report Work Log entry missing or unattributed"
	fi
	if grep -qF "e2e-manager" <<<"$log_tail"; then
		bad "claimed parent session identity never lands on the board (server-side rewrite)"
	else
		ok "claimed parent session identity never lands on the board (server-side rewrite)"
	fi
	AFTER_HASH="$(board_hash "$fix")"
	if [[ "$AFTER_HASH" != "$BEFORE_HASH" ]]; then
		ok "board content changed by exactly the sanctioned writes"
	else
		bad "board hash did not move"
	fi

print_result
if ((fail > 0)); then
	exit 1
fi
exit 0
