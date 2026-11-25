# Tests

Run everything hermetic with one command:

    bash tests/run-all.sh

The loop runs each suite as its own invocation, names it, prints its own
summary, and stops at the first failing suite. Suites degrade per their
own contracts where optional tooling is missing, so the same command
works on the host fully and in bare environments on what ran.

Each suite also runs standalone: `node tests/<name>.test.mjs` for the
node suites; the moved task-storage-isolation family under
`tests/task-storage-isolation/` runs as plain shell suites, with
`run-suite.sh` the flagship full-mode enforcement suite (its tool and
lint gates require python3, tasks, node, bwrap, and shellcheck on the
host; `ISOLATION_ALLOW_DEGRADED=1` runs the degraded posture instead).

## Manual harness-level smoke (needs the pi binary, not part of run-all)

    node tests/fence-ask-smoke.mjs

The FENCE-1 landing's live integration check. Leg A runs the real
`pi --mode json -p --no-session` binary with cwd at this repo, so the
real loader discovers the whole extensions/ family (every factory must
load; the incident rule at the binary level), plus a probe extension
recording session_start and session_shutdown to a marker file; the run
dies at the provider call on an invalid API key, so it is free and
fast, and the session_start marker is the live-delivery evidence for
one-shot json children (review 17 DC-2). Leg B drives the real
child-side production path (forwardHeadlessAsk from the real
workspace-fence module) in a subprocess against a stub parent serving
the forwarding root with the real tick: grant applies and becomes
visible to the per-call allowed-roots build, deny fails closed naming
the user decision, timeout fails closed naming the bound.

## Manual suites (LLM-calling, not part of run-all)

    bash tests/task-storage-isolation/run-skeleton.sh [model]

The walking skeleton: one parent pi dispatch through the wrapped
vendored extension, two LLM calls, needs the model gateway reachable.

    bash tests/task-storage-isolation/run-e2e-roundtrip.sh [model]

The end-to-end manager dispatch round trip through the activated wrap:
two LLM calls (manager parent, worker child), real sanctioned board
writes under channel attribution, and masked-read denials in the same
child session. The opencode counterpart of this gate lives in the
dotfiles repo with the opencode enforcement column.

Fixture posture: the hosted service hands its CLI a minimal
environment (PATH/HOME/TASKS_SESSION) by design and the tasks CLI
resolves no local .tasks tree, so the suite provides the fixture board
through the family's fixture launcher (a PATH shim that execs the real
CLI with the TASKS_DIR pin for its cwd, the same shape run-suite.sh
uses). The suite exports PISCOPE_EXTRA_ROOTS covering
extensions/ for the parent session so the masked child's cwd-scope
gate admits the channel client at its repo path (the child's /tmp is
a tmpfs, so the client cannot ride inside the fixture repo). The
operator needs no environment setup.

## Known environmental reds

tests/condensed-footer.test.mjs and tests/periscope-view.test.mjs fail
in provisioning on hosts where no pi installation carrying
@earendil-works/pi-tui can be located up-tree from `which pi`
(tests/provision-pi-tui.mjs). That is environmental, not a regression;
run-all.sh names both in its explicit exclusion list for that reason,
and they run standalone where the shim provisions.

## Manager-body regeneration flow (manual, cross-repo by design)

Edit the fleet manager.md body in the dotfiles repo and run its
pin-manager-body target there, then refresh extensions/manager-body.md
and the PINNED_BODY_DIGEST constant in extensions/manager-mode.ts here
together; node tests/manager-body-pin.test.mjs must stay green (the
suite is self-contained: sidecar sha256 vs the embedded pin).
