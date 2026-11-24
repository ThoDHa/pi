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

Known posture: on this host the run needs PISCOPE_EXTRA_ROOTS to cover
this repo (the masked child runs the deployed cwd-scope gate), and its
sanctioned-write leg is currently red at source: the hosted service
resolves the board from its cwd under a minimal environment by design,
while the current tasks CLI never resolves local .tasks directories
(central-store resolution), so the fixture's writes refuse with
NO_BOARD. The denial, read, and child-probe legs pass. See the
PIRELOC-1 record for the analysis.

## Known environmental reds

tests/condensed-footer.test.mjs and tests/periscope-view.test.mjs fail
in provisioning on hosts where no pi installation carrying
@earendil-works/pi-tui can be located up-tree from `which pi`
(tests/provision-pi-tui.mjs). That is environmental, not a regression;
they are excluded from run-all.sh for that reason and run standalone
where the shim provisions.

## Manager-body regeneration flow (manual, cross-repo by design)

Edit the fleet manager.md body in the dotfiles repo and run its
pin-manager-body target there, then refresh extensions/manager-body.md
and the PINNED_BODY_DIGEST constant in extensions/manager-mode.ts here
together; node tests/manager-body-pin.test.mjs must stay green (the
suite is self-contained: sidecar sha256 vs the embedded pin).
