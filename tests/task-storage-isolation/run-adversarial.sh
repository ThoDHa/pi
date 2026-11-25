#!/usr/bin/env bash
#
# Adversarial bypass suite and integration gate (ORCH-4-10-4), pi
# column. The opencode column (the BrokerService through the real
# bridge client) lives with the opencode enforcement surface in the
# dotfiles repo; this pi-side copy carries the pi machine column, the
# shared hermetic fixtures, and the pi recovery/concurrency column.
#
# Drives the eight bypass classes from the parent's Testing Strategy plus
# the compound-composition class added by the design-bearing reviews,
# through the REAL dispatch path of the pi harness, with a characterization
# twin per class that succeeds WITHOUT enforcement (proving the denial
# comes from the enforcement, never from the fixture):
#
#   pi column       - the production wrap argv (the bwrap invocation the
#                     activated vendored-extension seam spawns, built by
#                     the suite's parity-pinned mirror in lib/
#                     isolation_common.py; run-suite.sh pins mirror ==
#                     installed block, so deny evidence here cannot drift
#                     from the production mechanism), against the real
#                     escape-channel service so sanctioned shapes stay
#                     reachable inside the same namespaces
#
# Classes: symlink, relative-path, worktree, alternate-command,
# child-process, inherited-fd, git-history smuggling (write and read),
# write side (redirect/tee/sed -i/mv/rm against storage paths including
# the claim sidecar and lock), compound-composition shapes. The
# transcript-copy-store class (10-2's deferred DC2) and the
# recovery/concurrency column land in their own sections alongside the
# fixes they mandate; the routed findings and the output-cap class are
# opencode-column findings tested in the dotfiles copy.
#
# Degradation contract: with ISOLATION_ALLOW_DEGRADED=1 (set by the
# container verify chain, which has no bwrap and no model gateway) the
# machine-probe columns are announced as skipped and the suite gates on
# what ran; without the flag a missing tool fails the suite loudly.
# Enforced labels are decided by full-mode host runs only.
#
# Exit contract: non-zero unless every check passed; on failure the run
# directory is kept and its path printed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUITE_DIR="$REPO_ROOT/tests/task-storage-isolation"
LIB="$SUITE_DIR/lib"
SERVICE_PY="$REPO_ROOT/extensions/task-storage-isolation-service.py"
CLIENT_PY="$REPO_ROOT/extensions/task-storage-isolation-client.py"
RUN="$(mktemp -d /tmp/adversarial-suite.XXXXXX)"
DC2_XDG=""
SERVICE_PID=""
status=0

trap '{
	status=$?
	if [[ -n "$SERVICE_PID" ]]; then
		kill "$SERVICE_PID" 2>/dev/null || true
	fi
	if [[ "$status" -eq 0 ]]; then
		rm -rf "$RUN"
		if [[ -n "$DC2_XDG" ]]; then
			rm -rf "$DC2_XDG"
		fi
	else
		echo "adversarial suite artifacts kept for inspection: $RUN"
		if [[ -n "$DC2_XDG" ]]; then
			echo "dc2 store seed kept for inspection: $DC2_XDG"
		fi
	fi
}' EXIT

fail_fast() {
	echo "ADVERSARIAL-FAIL: $*" >&2
	exit 1
}

# shellcheck source=/dev/null
source "$LIB/harness.sh"
# shellcheck disable=SC2034
pass=0
# shellcheck disable=SC2034
fail=0
# shellcheck disable=SC2034
skip=0

absorb_results() { # <label> <output> <rc>
	local label="$1" output="$2" rc="$3"
	local line
	while IFS= read -r line; do
		case "$line" in
			"ok "*) ok "${line#"ok "}";;
			"bad "*) bad "${line#"bad "}";;
			"skip "*) skip_test "${line#"skip "}";;
			*) printf '    runner: %s\n' "$line" ;;
		esac
	done <<<"$output"
	if [[ "$rc" -ne 0 ]]; then
		bad "$label (runner exited $rc)"
	fi
}

DEGRADED="${ISOLATION_ALLOW_DEGRADED:-0}"

# Imports of repo-source modules (the lib service under test) must not
# drop __pycache__ into the repo tree; untracked litter would dirty the
# working tree the suites run from.
export PYTHONDONTWRITEBYTECODE=1

command -v python3 >/dev/null || fail_fast "python3 not installed"
command -v tasks >/dev/null || fail_fast "tasks CLI not on PATH"
# The fixture board shim and the recovery column resolve the tasks CLI
# once here, before any PATH manipulation.
TASKS_BIN="$(command -v tasks)"
if command -v shellcheck >/dev/null; then
	if shellcheck "$SUITE_DIR/run-adversarial.sh"; then
		ok "shellcheck clean on run-adversarial.sh"
	else
		bad "shellcheck clean on run-adversarial.sh"
	fi
else
	if [[ "$DEGRADED" == "1" ]]; then
		skip_test "shellcheck clean on run-adversarial.sh (shellcheck not installed; degraded mode)"
	else
		fail_fast "shellcheck not installed"
	fi
fi
HAVE_BWRAP=0
if command -v bwrap >/dev/null; then
	HAVE_BWRAP=1
	ok "bwrap available for the machine columns"
else
	if [[ "$DEGRADED" == "1" ]]; then
		skip_test "bwrap available for the machine columns (bwrap not installed; degraded mode)"
	else
		fail_fast "bwrap not installed (machine probes cannot run)"
	fi
fi

echo "== 1. hermetic fixtures =="
FIX="$RUN/fixtures"
AGENT_DIR="$FIX/agent"
REPO_FIX="$FIX/repo"
WORKTREE_FIX="$FIX/worktree"
TWIN="$RUN/twin-repo"
TWIN_SECRET="ADV-TWIN-SECRET-6c41"
ESCAPE_DIR="$RUN/escape"
SOCKET="$ESCAPE_DIR/service.sock"
TRUST_FILE="$ESCAPE_DIR/trust.json"
python3 - "$FIX" "$LIB" <<'EOF' || fail_fast "fixture build failed"
import os
import sys

fix, lib = sys.argv[1], sys.argv[2]
sys.path.insert(0, lib)
import isolation_common as ic

os.makedirs(fix, exist_ok=True)
ic.make_fixture_agent_dir(fix)
repo_fix, _ = ic.make_fixture_repo(fix)
ic.add_fixture_worktree(repo_fix, os.path.join(fix, "worktree"))
EOF
if [[ ! -d "$REPO_FIX/.tasks" || ! -d "$WORKTREE_FIX/.tasks" ]]; then
	fail_fast "fixtures incomplete"
fi

export TASKS_SESSION=adversarial-suite
(cd "$REPO_FIX" && TASKS_DIR="$REPO_FIX/.tasks" tasks init >/dev/null) || fail_fast "tasks init failed on fixture"
(cd "$REPO_FIX" && TASKS_DIR="$REPO_FIX/.tasks" tasks new --id ADV-1 --name "Adversarial Target" >/dev/null) || fail_fast "tasks new failed on fixture"
TASKFILE_BASE="$(cd "$REPO_FIX" && find .tasks/current -maxdepth 1 -name 'ADV-1-*.md' -printf '%f\n' | head -1)"
[[ -n "$TASKFILE_BASE" ]] || fail_fast "fixture task file was not created"
mkdir -p "$REPO_FIX/.tasks/reports"
printf 'secret: SUITE-SECRET-2d97-masked\n' >"$REPO_FIX/.tasks/reports/secret.md"
ok "fixture board ready (task file $TASKFILE_BASE)"

SECRET_MARKER="SUITE-SECRET-2d97-masked"
SIBLING_MARKER="SIBLING-SECRET-71ce-masked"

# Twin fixture: a second repo with the identical board shape so
# characterization twins that MUTATE storage never corrupt the
# enforcement fixture's board state.
mkdir -p "$TWIN/.tasks/current" "$TWIN/.tasks/reports"
git -C "$TWIN" init -q
git -C "$TWIN" config user.email adv@fixture
git -C "$TWIN" config user.name adv
echo ".tasks/" >"$TWIN/.gitignore"
printf 'fixture readme\n' >"$TWIN/README.md"
printf 'secret: %s\n' "$TWIN_SECRET" >"$TWIN/.tasks/current/secret.md"
printf 'secret: %s\n' "$TWIN_SECRET" >"$TWIN/.tasks/reports/secret.md"
git -C "$TWIN" add -A
git -C "$TWIN" commit -qm "twin fixture"
(cd "$TWIN" && TASKS_DIR="$TWIN/.tasks" tasks init >/dev/null) || fail_fast "tasks init failed on twin"
(cd "$TWIN" && TASKS_DIR="$TWIN/.tasks" tasks new --id ADV-1 --name "Adversarial Twin" >/dev/null) || fail_fast "tasks new failed on twin"
TWIN_TASKFILE="$(cd "$TWIN" && find .tasks/current -maxdepth 1 -name 'ADV-1-*.md' -printf '%f\n' | head -1)"
[[ -n "$TWIN_TASKFILE" ]] || fail_fast "twin task file was not created"
ok "twin fixture ready (task file $TWIN_TASKFILE)"

board_hash() { # fixture dir -> stable hash of the seeded board content
	( cd "$1" && find .tasks -type f -not -name "*.claim" -print0 | sort -z \
		| xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}
BASE_HASH="$(board_hash "$REPO_FIX")"

echo "== 2. pi escape-channel service (real wiring for the wrap namespaces) =="
if [[ "$HAVE_BWRAP" == "1" ]]; then
	mkdir -p "$ESCAPE_DIR"
	chmod 700 "$ESCAPE_DIR"
	printf '{}\n' >"$TRUST_FILE"
	mkdir -p "$RUN/bin"
	cat >"$RUN/bin/tasks" <<LAUNCHER
#!/usr/bin/env bash
# Fixture board pin: a /tmp scratch board resolves only through the
# explicit TASKS_DIR override, so the service exec carries the pin for
# its cwd (the fixture repo root).
exec env TASKS_DIR="\$PWD/.tasks" "$TASKS_BIN" "\$@"
LAUNCHER
	chmod +x "$RUN/bin/tasks"
	PI_TASK_STORAGE_TOKEN="adv-suite-token" PATH="$RUN/bin:$PATH" python3 "$SERVICE_PY" "$SOCKET" "$REPO_FIX" "$RUN/service.log" &
	SERVICE_PID=$!
	for _ in $(seq 1 50); do
		[[ -S "$SOCKET" ]] && break
		sleep 0.1
	done
	if [[ -S "$SOCKET" ]]; then
		ok "pi escape-channel service listening on the 0700 escape dir"
	else
		fail_fast "pi service socket never appeared"
	fi
else
	skip_test "pi escape-channel service (bwrap not installed; degraded mode)"
fi

echo "== 3. pi machine column (production wrap argv, parity-pinned mirror) =="
run_pi_probe() { # <payload-shell-text> [repo-root-for-mask] -> JSON result on stdout
	local payload="$1" mask_repo="${2:-$REPO_FIX}"
	ISOLATION_LIB="$LIB" ISOLATION_FIX="$REPO_FIX" ISOLATION_MASK_REPO="$mask_repo" \
		ISOLATION_AGENT_DIR="$AGENT_DIR" ISOLATION_WORKTREE="$WORKTREE_FIX" \
		ISOLATION_SOCKET="$SOCKET" ISOLATION_TRUST="$TRUST_FILE" \
		PI_TASK_STORAGE_ISOLATION=1 PI_TASK_STORAGE_TOKEN="adv-suite-token" \
		TASKS_SESSION="adversarial-child" \
		python3 - "$payload" <<'PYEOF'
import json
import os
import subprocess
import sys

payload = sys.argv[1]
fix = os.environ["ISOLATION_FIX"]
lib = os.environ["ISOLATION_LIB"]
sys.path.insert(0, lib)
import isolation_common as ic

env = dict(os.environ)
env["PI_TASK_STORAGE_MASK_PATHS"] = "\n".join([
	os.path.realpath(os.path.join(os.environ["ISOLATION_MASK_REPO"], ".tasks")),
	os.path.realpath(os.path.join(os.environ["ISOLATION_WORKTREE"], ".tasks")),
])
env["PI_TASK_STORAGE_SOCKET"] = os.environ["ISOLATION_SOCKET"]
env["PI_TASK_STORAGE_TRUST_FILE"] = os.environ["ISOLATION_TRUST"]
argv = ic.build_isolation_argv("/bin/bash", ["-c", payload], env,
                               agent_dir=os.environ["ISOLATION_AGENT_DIR"])
# The composed wiring env rides the child too: the wrap's parent hands
# the mask, socket, and trust wiring to the spawned child, and the
# escape-channel client inside reads it from there.
completed = subprocess.run(argv, capture_output=True, text=True, timeout=120,
                           cwd=fix, env=env)
print(json.dumps({"rc": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}))
PYEOF
}

run_pi_twin() { # <payload-shell-text> -> JSON result (no enforcement: plain sh -c)
	ISOLATION_TWIN="$TWIN" TASKS_SESSION="adversarial-twin" \
		python3 - "$1" <<'PYEOF'
import json
import os
import subprocess
import sys

payload = sys.argv[1]
completed = subprocess.run(["/bin/sh", "-c", payload], capture_output=True,
                           text=True, timeout=120, cwd=os.environ["ISOLATION_TWIN"])
print(json.dumps({"rc": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}))
PYEOF
}

verify_json() { # <name> <probe-json> <python-assert-script> [args...]
	# A probe-runner crash surfaces here too: its stdout stops being valid
	# JSON, the assert script dies on the parse, and the check flips bad.
	local name="$1" probe_json="$2"
	shift 2
	local verdict rc=0
	verdict="$(python3 - "$probe_json" "$@" 2>&1)" || rc=$?
	if [[ "$rc" -eq 0 ]]; then
		ok "$name"
	else
		bad "$name: ${verdict:0:300}"
	fi
}

if [[ "$HAVE_BWRAP" == "1" ]]; then
	# -- Classes 1-3: symlink, relative path, worktree.
	pi_payload="cat ./.tasks/current/secret.md
cat .tasks/../.tasks/current/secret.md
cat sub/deeper/../../.tasks/current/secret.md
cat sub/deeper/link-updown
(cd /tmp && cat '$REPO_FIX/.tasks/current/secret.md')
cat link-rel; cat link-abs
cat '$WORKTREE_FIX/.tasks/current/sibling.md'
python3 '$CLIENT_PY' tasks show '$TASKFILE_BASE' --json >/dev/null && echo CHANNEL-OK
true"
	probe_json="$(run_pi_probe "$pi_payload")"
	verify_json "pi deny: symlink, relative-path, and worktree classes all denied while the sanctioned channel stays reachable" \
		"$probe_json" "$SECRET_MARKER" "$SIBLING_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret, sibling = sys.argv[2], sys.argv[3]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the path classes"
assert sibling not in combined, "SIBLING MARKER LEAKED through the worktree class"
assert combined.count("No such file or directory") >= 7, \
	f"expected seven path denials, got: {combined}"
assert "CHANNEL-OK" in result["stdout"], \
	f"sanctioned channel unreachable inside the same namespace: {result['stdout'][-300:]}"
PYEOF

	twin_json="$(run_pi_twin "cat ./.tasks/current/secret.md; cat '$REPO_FIX/link-rel' 2>/dev/null; cat '$WORKTREE_FIX/.tasks/current/sibling.md'; true")"
	verify_json "pi twin: the same read shapes succeed without enforcement (characterization)" \
		"$twin_json" "$TWIN_SECRET" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
combined = result["stdout"] + result["stderr"]
assert result["rc"] == 0, f"twin failed: {combined[:300]}"
assert sys.argv[2] in combined, f"twin could not read its own board (fixture broken): {combined[:300]}"
PYEOF

	# -- Class 4: alternate commands against storage paths.
	pi_payload="rg -a SUITE '$REPO_FIX/.tasks'
sed -n 1p '$REPO_FIX/.tasks/current/secret.md'
awk '1' '$REPO_FIX/.tasks/current/secret.md'
head -1 '$REPO_FIX/.tasks/current/secret.md'
tail -1 '$REPO_FIX/.tasks/current/secret.md'
dd if='$REPO_FIX/.tasks/current/secret.md' bs=1 count=8 2>/dev/null
tar -C '$REPO_FIX' -cf - .tasks 2>/dev/null | head -c 64
cp '$REPO_FIX/.tasks/current/secret.md' /tmp/adv-copied 2>/dev/null && head -1 /tmp/adv-copied
find '$REPO_FIX/.tasks' -name '*.md' -exec head -1 {} \;
stat '$REPO_FIX/.tasks/current/secret.md'
git -C '$REPO_FIX' diff --no-index /dev/null '$REPO_FIX/.tasks/current/secret.md'
git -C '$REPO_FIX' hash-object '$REPO_FIX/.tasks/current/secret.md'
python3 -c \"open('$REPO_FIX/.tasks/current/secret.md').read()\"
node -e \"require('fs').readFileSync('$REPO_FIX/.tasks/current/secret.md','utf8')\"
perl -e \"open my \$h,'<','$REPO_FIX/.tasks/current/secret.md'; print <\$h>\"
iconv -f utf8 -t utf8 '$REPO_FIX/.tasks/current/secret.md'
sort '$REPO_FIX/.tasks/current/secret.md'
uniq '$REPO_FIX/.tasks/current/secret.md'
md5sum '$REPO_FIX/.tasks/current/secret.md'
true"
	probe_json="$(run_pi_probe "$pi_payload")"
	verify_json "pi deny: alternate-command class (rg/sed/awk/head/tail/dd/tar/cp/find/stat/git/python/node/perl/iconv/sort/uniq/md5sum) leaks no board bytes" \
		"$probe_json" "$SECRET_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the alternate-command class"
PYEOF

	twin_json="$(run_pi_twin "head -1 .tasks/current/secret.md; md5sum .tasks/current/secret.md; git diff --no-index /dev/null .tasks/reports/secret.md; true")"
	verify_json "pi twin: alternate commands read the twin board without enforcement (characterization)" \
		"$twin_json" "$TWIN_SECRET" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert sys.argv[2] in result["stdout"], \
	f"twin alternate commands did not recover the marker: {result['stdout'][:300]} {result['stderr'][:200]}"
PYEOF

	# -- Class 5: child-process wrappers.
	pi_payload="bash -c \"cat '$REPO_FIX/.tasks/current/secret.md'\"
sh -c \"cat '$REPO_FIX/.tasks/current/secret.md'\"
echo \"\$(cat '$REPO_FIX/.tasks/current/secret.md')\"
env cat '$REPO_FIX/.tasks/current/secret.md'
timeout 5 cat '$REPO_FIX/.tasks/current/secret.md'
nohup cat '$REPO_FIX/.tasks/current/secret.md' 2>/dev/null
python3 -c \"print(open('$REPO_FIX/.tasks/current/secret.md').read())\"
perl -0777 -ne 'print' '$REPO_FIX/.tasks/current/secret.md'
node -e \"console.log(require('fs').readFileSync('$REPO_FIX/.tasks/current/secret.md','utf8'))\"
true"
	probe_json="$(run_pi_probe "$pi_payload")"
	verify_json "pi deny: child-process class (bash -c/sh -c/substitution/env/timeout/nohup/interpreters) leaks no board bytes" \
		"$probe_json" "$SECRET_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the child-process class"
PYEOF

	# -- Class 6: inherited descriptors.
	pi_payload="exec 3< '$REPO_FIX/.tasks/current/secret.md' 2>/dev/null || echo OPEN-REFUSED
cat <&3 2>/dev/null || echo FD-READ-REFUSED
cat 0< '$REPO_FIX/.tasks/current/secret.md' 2>/dev/null || echo STDIN-REDIR-REFUSED
echo FD-LIST-BEGIN
ls -l /proc/self/fd 2>/dev/null
echo FD-LIST-END
true"
	probe_json="$(run_pi_probe "$pi_payload")"
	verify_json "pi deny: inherited-fd class (exec 3<, cat <&3, cat 0<) cannot open storage and leaks no descriptors" \
		"$probe_json" "$SECRET_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the inherited-fd class"
assert "OPEN-REFUSED" in combined, f"fd open unexpectedly succeeded: {combined[:300]}"
listing = combined.split("FD-LIST-BEGIN")[-1].split("FD-LIST-END")[0]
assert ".tasks" not in listing, \
	f"storage descriptors present in /proc/self/fd: {listing[-400:]}"
PYEOF

	twin_json="$(run_pi_twin "exec 3< .tasks/current/secret.md && cat <&3")"
	verify_json "pi twin: inherited-fd read recovers the marker without enforcement (characterization)" \
		"$twin_json" "$TWIN_SECRET" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert sys.argv[2] in result["stdout"], \
	f"twin fd read did not recover the marker: {result['stdout'][:300]} {result['stderr'][:200]}"
PYEOF

	# -- Class 7: git-history smuggling (write and read), against the
	# twin's identical mask shape (the -f add mutates git state, so the
	# enforcement fixture board must stay untouched).
	pi_smuggle_out="$(run_pi_probe "git add -f .tasks/reports/secret.md 2>&1
git -c user.email=adv@fixture -c user.name=adv commit -qm smuggle 2>&1
git show HEAD:.tasks/reports/secret.md 2>&1
git hash-object .tasks/reports/secret.md 2>&1
true" "$TWIN")"
	verify_json "pi deny: git-history smuggling (add -f, commit, show, hash-object) closed under the mask" \
		"$pi_smuggle_out" "$SECRET_MARKER" "$TWIN_SECRET" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the git-smuggling class"
assert "No such file" in combined or "did not match" in combined or "bad revision" in combined, \
	f"smuggling shapes did not surface file-level denials: {combined[:400]}"
PYEOF

	twin_json="$(run_pi_twin "git add -f .tasks/reports/secret.md && git -c user.email=adv@fixture -c user.name=adv commit -qm twin-smuggle && git show HEAD:.tasks/reports/secret.md")"
	verify_json "pi twin: git-history smuggling recovers the marker without enforcement (characterization)" \
		"$twin_json" "$TWIN_SECRET" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert sys.argv[2] in result["stdout"], \
	f"twin smuggling did not recover the marker: {result['stdout'][:300]} {result['stderr'][:200]}"
PYEOF

	# -- Class 8: write side (redirect, tee, sed -i, mv, rm against
	# storage paths including the claim sidecar and lock), against the
	# twin; in-namespace writes land in the empty tmpfs mask only, and
	# the twin board hash must not move.
	twin_hash_before="$(board_hash "$TWIN")"
	pi_write_out="$(run_pi_probe "echo ADV-WRITEPIN > .tasks/current/secret.md && cat .tasks/current/secret.md
echo tee-pin | tee .tasks/reports/secret.md
sed -i 's/secret/REPLACED/' .tasks/reports/secret.md
mv .tasks/reports/secret.md .tasks/reports/moved.md
rm -f .tasks/reports/moved.md
rm -rf .tasks
touch .tasks/.lock
ls .tasks
true" "$TWIN")"
	twin_hash_after="$(board_hash "$TWIN")"
	verify_json "pi deny: write side (redirect/tee/sed -i/mv/rm/lock) lands only in the empty tmpfs mask" \
		"$pi_write_out" "$SECRET_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the write-side class"
PYEOF
	verify_json "pi deny: write-side class leaves the twin board byte-identical" \
		"{}" <<PYEOF
import sys
assert "${twin_hash_before}" == "${twin_hash_after}", "twin board mutated under the mask"
PYEOF

	twin_json="$(run_pi_twin "echo ADV-WRITEPIN > .tasks/current/secret.md; cat .tasks/current/secret.md")"
	verify_json "pi twin: the write class mutates the twin board without enforcement (characterization)" \
		"$twin_json" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert "ADV-WRITEPIN" in result["stdout"], \
	f"twin write did not mutate the twin board: {result['stdout'][:200]} {result['stderr'][:200]}"
PYEOF

	# -- Class 9 (review-added): compound-composition shapes.
	# SC2016/SC2140: the payload intentionally carries payload-level
	# quoting (single-quoted paths, split-quoted words) for the masked
	# bash to parse; suppressing the outer script's expansion lint is the
	# targeted form of expressing that intent.
	# shellcheck disable=SC2016,SC2140
	pi_payload="cat '$REPO_FIX/.tasks/current/secret.md' && echo AND-RAN
cat '$REPO_FIX/.tasks/current/secret.md' || echo OR-RAN
cat '$REPO_FIX/.tasks/current/secret.md' ; echo SEQ-RAN
cat '$REPO_FIX/.tasks/current/secret.md' | grep -a SUITE
echo \"subst=\$(cat '$REPO_FIX/.tasks/current/secret.md')\"
echo \"backtick=\`cat '$REPO_FIX/.tasks/current/secret.md'\`\"
grep -a SUITE <(cat '$REPO_FIX/.tasks/current/secret.md')
echo brace-{a,b}; head -c 3 '$REPO_FIX/.tasks/current/secret.md'
cat <<EOF
heredoc-$(cat '$REPO_FIX/.tasks/current/secret.md')
EOF
cat '$REPO_FIX/.tasks'"/current/secret.md"
true"
	probe_json="$(run_pi_probe "$pi_payload")"
	verify_json "pi deny: compound-composition class (&&/||/;/pipe/substitution/backtick/process-sub/brace/heredoc/continuation) leaks no board bytes" \
		"$probe_json" "$SECRET_MARKER" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
secret = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert secret not in combined, "SECRET MARKER LEAKED through the compound-composition class"
PYEOF

	twin_json="$(run_pi_twin "echo TWIN-COMPOSE-9a11 > .tasks/current/secret.md; grep -a TWIN-COMPOSE .tasks/current/secret.md; echo \"s=\$(cat .tasks/current/secret.md)\"; true")"
	verify_json "pi twin: compound compositions read the twin board without enforcement (characterization)" \
		"$twin_json" "TWIN-COMPOSE-9a11" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert sys.argv[2] in result["stdout"], \
	f"twin compositions did not recover the marker: {result['stdout'][:300]}"
PYEOF

	# -- DC2 (10-2's deferred class): the other harness's transcript-copy
	# store. The seed lives under /var/tmp because the wrap replaces /tmp
	# with an empty tmpfs, which would hide the seed for the wrong reason.
	DC2_XDG="$(mktemp -d /var/tmp/adversarial-dc2.XXXXXX)"
	chmod 700 "$DC2_XDG"
	mkdir -p "$DC2_XDG/opencode/storage/session/default"
	printf '{"content":"DC2-PI-SEED-MARKER-9d41"}\n' > "$DC2_XDG/opencode/storage/session/default/transcript.jsonl"
	dc2_probe_out="$(XDG_DATA_HOME="$DC2_XDG" run_pi_probe "cat '$DC2_XDG/opencode/storage/session/default/transcript.jsonl'
true")"
	verify_json "pi deny: DC2 transcript-copy store masked from the namespace" \
		"$dc2_probe_out" "DC2-PI-SEED-MARKER-9d41" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
marker = sys.argv[2]
combined = result["stdout"] + result["stderr"]
assert marker not in combined, "DC2 TRANSCRIPT MARKER LEAKED under the wrap"
assert result["rc"] != 0 or "No such file" in combined or "not a directory" in combined, \
	f"store read unexpectedly succeeded: {combined[:300]}"
PYEOF
	twin_json="$(run_pi_twin "cat '$DC2_XDG/opencode/storage/session/default/transcript.jsonl'")"
	verify_json "pi twin: DC2 store seed reads back without enforcement (characterization)" \
		"$twin_json" "DC2-PI-SEED-MARKER-9d41" <<'PYEOF'
import json, sys
result = json.loads(sys.argv[1])
assert sys.argv[2] in result["stdout"], \
	f"twin could not read the DC2 seed: {result['stdout'][:300]} {result['stderr'][:200]}"
PYEOF
else
	for section in "symlink/relative/worktree" "alternate-command" "child-process" \
		"inherited-fd" "git-history smuggling" "write side" "compound-composition" \
		"DC2 transcript-copy store"; do
		skip_test "pi deny + twin: $section class (bwrap not installed; degraded mode)"
	done
fi

if [[ "$(board_hash "$REPO_FIX")" == "$BASE_HASH" ]]; then
	ok "pi column leaves the enforcement fixture board byte-identical"
else
	bad "pi column leaves the enforcement fixture board byte-identical"
fi

echo "== 4. recovery and concurrency (claims, lock, crashed child; pi column) =="
if [[ "$HAVE_BWRAP" == "1" ]]; then
RECOVERY_TASKS_BIN="$(dirname "$TASKS_BIN")"
RECOVERY_OUT="$(REPO_ROOT="$REPO_ROOT" ISOLATION_LIB="$LIB" ISOLATION_FIX="$REPO_FIX" \
	ISOLATION_WORKTREE="$WORKTREE_FIX" ISOLATION_TASKFILE="$TASKFILE_BASE" \
	ISOLATION_SOCKET="$SOCKET" ISOLATION_CLIENT="$CLIENT_PY" \
	ISOLATION_TWIN="$TWIN" \
	ISOLATION_AGENT_DIR="$AGENT_DIR" ISOLATION_TRUST="$TRUST_FILE" \
	TASKS_BIN_DIR="$RECOVERY_TASKS_BIN" \
	python3 - <<'PYEOF'
import hashlib
import os
import subprocess
import sys
import threading
import time

LIB = os.environ["ISOLATION_LIB"]
FIX = os.environ["ISOLATION_FIX"]
WORKTREE = os.environ["ISOLATION_WORKTREE"]
TWIN = os.environ["ISOLATION_TWIN"]
TASKS = os.path.join(os.environ["TASKS_BIN_DIR"], "tasks")
sys.path.insert(0, LIB)
import isolation_common as ic


def expect(label, cond, detail=""):
	print(("ok " if cond else "bad ") + label + (f" [{detail}]" if detail and not cond else ""))


def board_hash(root):
	out = subprocess.run(
		["bash", "-c",
		 f"cd '{root}' && find .tasks -type f -not -name '*.claim' -print0"
		 " | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1"],
		capture_output=True, text=True)
	return out.stdout.strip()


def board_snapshot(repo):
	# Entries carry their find %y type, so sockets and fifos that the
	# -type f hash walk never sees still count as residue.
	return subprocess.run(
		["bash", "-c",
		 f"cd '{repo}' && find .tasks -printf '%y %p\\n' | LC_ALL=C sort"],
		capture_output=True, text=True).stdout


RESIDUE_SNIPPET = (
	"mkdir -p .tasks/pi-residue-dir && "
	"python3 -c 'import socket; sock = socket.socket(socket.AF_UNIX); "
	"sock.bind(\".tasks/pi-residue.sock\")' && "
	"touch .tasks/pi-residue.lock .tasks/.lock.residue")


def tcli(*argv, session=None):
	env = dict(os.environ)
	env["TASKS_DIR"] = os.path.join(FIX, ".tasks")
	if session:
		env["TASKS_SESSION"] = session
	return subprocess.run([TASKS, *argv], capture_output=True, text=True,
	                      cwd=FIX, env=env, timeout=120)


cli_env = {**os.environ,
           "PI_TASK_STORAGE_SOCKET": os.environ["ISOLATION_SOCKET"],
           "PI_TASK_STORAGE_TOKEN": "adv-suite-token",
           "TASKS_SESSION": "recovery-driver"}


def cli(*argv):
	return subprocess.run([sys.executable, os.environ["ISOLATION_CLIENT"], *argv],
	                      capture_output=True, text=True, cwd=FIX,
	                      env=cli_env, timeout=180)


init = tcli("init")
new = tcli("new", "--id", "ADV-11", "--name", "Pi Recovery Target")
entries = sorted(f for f in os.listdir(os.path.join(FIX, ".tasks", "current"))
                 if f.startswith("ADV-11-"))
expect("pi recovery: fixture board scaffolded (setup)",
       init.returncode == 0 and new.returncode == 0 and bool(entries),
       f"init rc={init.returncode} new rc={new.returncode} err={new.stderr[:160]!r}")
entry = entries[0]

label = "iso-channel-" + hashlib.sha256(b"adv-suite-token").hexdigest()[:16]
claim = tcli("claim", entry, "--owner", label)
expect("pi recovery: claim taken on the fixture board (setup)",
       claim.returncode == 0, f"rc={claim.returncode} err={claim.stderr[:160]!r}")
out = tcli("claims", "--json")
expect("pi recovery: claims sweep reports the live channel-owned claim",
       out.returncode == 0 and label in out.stdout, out.stdout[:200])
out = cli("tasks", "log", entry, "--from", "someone-else",
          "pi recovery heartbeat through the channel")
expect("pi recovery: sanctioned channel log lands as the channel-owned claim heartbeat",
       out.returncode == 0,
       f"rc={out.returncode} out={out.stdout[:160]!r} err={out.stderr[:160]!r}")
out = cli("tasks", "show", entry, "--json")
expect("pi recovery: the heartbeat entry carries the channel attribution",
       out.returncode == 0 and "pi recovery heartbeat" in out.stdout
       and "iso-channel-" in out.stdout, out.stdout[-200:])

new2 = tcli("new", "--id", "ADV-12", "--name", "Recovery Foreign")
entries2 = sorted(f for f in os.listdir(os.path.join(FIX, ".tasks", "current"))
                  if f.startswith("ADV-12-"))
expect("pi recovery: foreign-claim task scaffolded (setup)",
       new2.returncode == 0 and bool(entries2),
       f"new rc={new2.returncode} err={new2.stderr[:160]!r}")
entry2 = entries2[0]
claim2 = tcli("claim", entry2, "--owner", "manager-main")
expect("pi recovery: foreign claim taken (setup)", claim2.returncode == 0,
       f"rc={claim2.returncode} err={claim2.stderr[:160]!r}")
out = tcli("release", entry2, session="intruder")
expect("pi recovery: a foreign session cannot release a live claim it does not own (fail closed)",
       out.returncode != 0 and "claimed by" in out.stderr,
       f"rc={out.returncode} out={out.stdout[:160]!r} err={out.stderr[:160]!r}")
out = cli("tasks", "log", entry2, "--from", label,
          "pi recovery foreign-claim write")
expect("pi recovery: the live foreign claim does not gate the sanctioned log, write lands channel-attributed",
       out.returncode == 0, f"rc={out.returncode} err={out.stderr[:160]!r}")
out = cli("tasks", "show", entry2, "--json")
expect("pi recovery: the foreign-claimed entry carries the channel-attributed write",
       out.returncode == 0 and "foreign-claim write" in out.stdout
       and "iso-channel-" in out.stdout, out.stdout[-200:])

results = {}


def log_thread(index):
	results[index] = cli("tasks", "log", entry, "--from", label,
	                     f"pi concurrent write {index}")


threads = [threading.Thread(target=log_thread, args=(i,)) for i in range(2)]
for thread in threads:
	thread.start()
for thread in threads:
	thread.join(180)
expect("pi recovery: two concurrent sanctioned writes both land under the board lock",
       results[0].returncode == 0 and results[1].returncode == 0,
       f"rc0={results[0].returncode} rc1={results[1].returncode} "
       f"e0={results[0].stderr[:120]!r} e1={results[1].stderr[:120]!r}")
out = cli("tasks", "show", entry, "--json")
expect("pi recovery: both concurrent entries present in the Work Log",
       out.returncode == 0 and "pi concurrent write 0" in out.stdout
       and "pi concurrent write 1" in out.stdout, out.stdout[-200:])

twin_snap_before = board_snapshot(TWIN)
plant = subprocess.run(["bash", "-c",
                        RESIDUE_SNIPPET + " && "
                        "test -S .tasks/pi-residue.sock -a -d .tasks/pi-residue-dir "
                        "-a -f .tasks/pi-residue.lock -a -f .tasks/.lock.residue"],
                       capture_output=True, text=True, cwd=TWIN, timeout=60)
expect("pi recovery twin: the residue payload plants sockets, temp dirs, and lock files without enforcement (setup)",
       plant.returncode == 0, f"rc={plant.returncode} err={plant.stderr[:200]!r}")
twin_snap_planted = board_snapshot(TWIN)
expect("pi recovery twin: the board snapshot detector sees the planted residue (detector validation)",
       all(name in twin_snap_planted for name in
           ("pi-residue-dir", "pi-residue.sock", "pi-residue.lock", ".lock.residue"))
       and twin_snap_planted != twin_snap_before, twin_snap_planted[-300:])
cleanup = subprocess.run(["bash", "-c",
                          "rm -rf .tasks/pi-residue-dir .tasks/pi-residue.sock "
                          ".tasks/pi-residue.lock .tasks/.lock.residue"],
                         capture_output=True, text=True, cwd=TWIN, timeout=60)
expect("pi recovery twin: the twin board snapshot is restored after cleanup (detector validation)",
       cleanup.returncode == 0 and board_snapshot(TWIN) == twin_snap_before)

hash_before = board_hash(FIX)
snap_before_fix = board_snapshot(FIX)
snap_before_wt = board_snapshot(WORKTREE)
claims_before = tcli("claims", "--json").stdout
wrapped_env = dict(os.environ)
wrapped_env.update({
	"PI_TASK_STORAGE_ISOLATION": "1",
	"PI_TASK_STORAGE_MASK_PATHS": "\n".join([
		os.path.realpath(os.path.join(FIX, ".tasks")),
		os.path.realpath(os.path.join(WORKTREE, ".tasks")),
	]),
	"PI_TASK_STORAGE_SOCKET": os.environ["ISOLATION_SOCKET"],
	"PI_TASK_STORAGE_TOKEN": "adv-suite-token",
	"PI_TASK_STORAGE_TRUST_FILE": os.environ["ISOLATION_TRUST"],
})
argv = ic.build_isolation_argv("/bin/bash",
                               ["-c", RESIDUE_SNIPPET + " && "
                                "echo RESIDUE >> .tasks/dashboard.md; "
                                "touch /tmp/pi-residue-canary; sleep 60"],
                               wrapped_env,
                               agent_dir=os.environ["ISOLATION_AGENT_DIR"])
child = subprocess.Popen(argv, cwd=WORKTREE, env=wrapped_env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
if child.poll() is None:
	child.terminate()
	try:
		child.wait(timeout=30)
	except subprocess.TimeoutExpired:
		child.kill()
		child.wait()
else:
	child.wait()
expect("pi recovery: no namespace /tmp canary reached the host tmpfs",
       not os.path.exists("/tmp/pi-residue-canary"))
out = cli("tasks", "show", entry, "--json")
expect("pi recovery: the service keeps serving sanctioned calls after a wrapped child was killed",
       out.returncode == 0, f"rc={out.returncode} err={out.stderr[:160]!r}")
expect("pi recovery: the killed wrapped child left the fixture board byte-identical",
       board_hash(FIX) == hash_before)
snap_after_fix = board_snapshot(FIX)
snap_after_wt = board_snapshot(WORKTREE)
expect("pi recovery: the killed wrapped child left no board residue (no sockets, temp dirs, or lock files)",
       snap_after_fix == snap_before_fix and snap_after_wt == snap_before_wt,
       f"diff={sorted(set(snap_after_fix.splitlines()) ^ set(snap_before_fix.splitlines()))[:6]}")
claims_state = tcli("claims", "--json").stdout
expect("pi recovery: the killed wrapped child left no claim residue",
       claims_state == claims_before, claims_state[:200])
PYEOF
)" || RECOVERY_RC=$?
absorb_results "pi recovery and concurrency column" "$RECOVERY_OUT" "${RECOVERY_RC:-0}"
else
	for section in "claims" "concurrent writes" "crashed wrapped child"; do
		skip_test "pi recovery: $section (bwrap not installed; degraded mode)"
	done
fi

print_result
if ((fail > 0)); then
	exit 1
fi
exit 0
