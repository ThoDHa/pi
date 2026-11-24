# The workspace fence family

The fence is the session's directory whitelist: reads, writes, and
command operands that resolve outside the allowed scope block instead
of silently succeeding. This document is the landing record for the
fence family as of FENCE-1: the policy, the configuration surface, the
environment variables, the forwarded-ask channel (units FENCE-1-1
through FENCE-1-4), the four design properties with their pins, and the
residuals stated where they belong. Module-level detail lives in the
source headers of `extensions/workspace-fence.ts` and
`extensions/fence-ask/`; this page is the map.

## Policy

The allowed scope is the session working directory, the temp directory,
and every extra root from the configuration surface below. A gated call
whose resolved target escapes that scope fails closed. Three postures
matter:

- Clean seal: out-of-scope access in an interactive session prompts the
  user; in a headless dispatched child it forwards the ask to the
  parent session over the channel below, waits the bounded wait, and
  blocks fail-closed on deny, timeout, or channel failure.
- Degraded seal: when the fence cannot establish its release seal, it
  blocks out-of-scope access without prompting and without forwarding.
  Degradation never manufactures channel evidence and never auto-grants
  (Decision Log D5, locked with the user).
- Unusable input: calls whose operands cannot be resolved safely block
  with an actionable reason.

An interactive Yes on an out-of-scope ask records a parent-own grant
into the grant ledger; that grant is what later dispatched children
inherit. A child's forwarded-ask grant never composes into any other
process's silent scope.

## Configuration

- `extensions/workspace-fence.config.json`: the tracked portable
  default extra roots.
- `extensions/workspace-fence.local.json`: the optional untracked
  overlay for machine-dependent roots; its absence is the normal case.
- `PISCOPE_EXTRA_ROOTS`: colon-separated absolute paths appended to the
  union.

The union evaluates once per process (memoized): a config or env edit
mid-session needs a restart. Dispatched children receive their starting
scope composed at spawn time: config union, parent-own runtime grants,
and the parent session cwd when the dispatch cwd differs from the
parent session cwd. Sibling child-ask grants never compose into that
inheritance; they dedup at ask time instead (properties 1 and 3 below).

## The forwarded-ask channel

A provisioned headless child whose gated call escapes scope writes a
forwarded ask under the forwarding root and polls for a decision:

- Provisioning: the spawn site mints one forwarding root per parent
  process (session id plus random component under the temp subtree,
  created at mode 0700) and stamps every dispatched child's env with
  `PISCOPE_ASK_FORWARDING_ROOT` and a per-child uuid token in
  `PISCOPE_ASK_CHILD_TOKEN`. The serving loop admits only asks carrying
  a token the parent issued and has not released.
- The bound: a child waits at most 120 seconds, overridable with
  `PISCOPE_ASK_WAIT_MS` (a missing or unusable override means the
  default). A missing decision after the bound means no authority
  ruled, never a denial, and the call blocks fail-closed. Raising the
  override is the multi-child knob: it extends every child's patience
  and, through the serving staleness bound, the parent's host lifetime
  together.
- Caps: one outstanding ask per child, same-directory asks coalesce,
  a queue to three, and a deny verdict beyond that, so a loop of
  out-of-scope calls cannot prompt-spam the parent.
- Provenance: the parent-side prompt names the child from the ledger's
  registry-bound lookup, never from the wire fields; the ask's own
  evidence rides the body. Denials carry their decision path (`via`:
  user, session-dedup, session-deny, or cap). A user-class denial
  writes the session's deny memory, so a later ask for that directory
  resolves without a new prompt; a cap denial judges the child's ask
  cadence, not the directory, and records nothing, so the directory
  stays askable once the cap clears.
- Nested dispatch: a child that dispatches its own children mints and
  serves its own root and proxies unresolved grandchild asks up through
  its own token; the grandchild's identity rides the reason field as
  display content. The spawn-site server start installs the proxy role
  as the default for provisioned processes, so a one-shot json middle
  never depends on `session_start` delivery to serve its root; caps
  stay bounded per hop (one outstanding plus three queue at the top no
  matter how many grandchildren proxy through a middle). A denial's
  provenance crosses the hop with it: a top user refusal records the
  middle's deny memory, a top cap denial forwards as the block reason
  without writing memory, and every non-grant still blocks fail-closed.
- Lifecycle: the forwarding root is removed when the owning process's
  session shuts down normally. A process killed without its shutdown
  path (SIGKILL, hard kill) leaks a bounded, authority-free tree: the
  tokens die with the owning process's in-memory registry, so no live
  process honors the leaked root's contents, and OS tmp reaping is the
  backstop.

## The four properties and their pins

1. A child's starting scope is the parent's current granted scope:
   pinned by the spawn-composition pins (parent-own grants compose,
   sibling grants do not) in `tests/fence-ask.test.mjs` and the
   workspace-fence suite.
2. Out-of-scope access asks up instead of failing closed, bounded and
   fail-closed on every non-grant outcome: pinned end to end in the
   fence-ask suite (apply, deny, timeout, channel failure) and at the
   live factory handler level in the workspace-fence suite.
3. Grants are per child: a grant for child A is invisible to child B's
   checks: pinned at the ledger and channel levels in the fence-ask
   suite.
4. Session grant memory: a different child asking for a directory
   already granted this session resolves granted without a user
   round-trip (`session-dedup`): pinned at the ledger and served-tick
   levels in the fence-ask suite, and at the parent-side recorder in
   the workspace-fence suite.

## Residuals

Stated, not claimed away; each also lives in the module header where
the code carries it.

- Same-user wall: parent, children, and every descendant run as one OS
  user. A provisioned child holds the root and token in its env, the
  temp subtree is an always-allowed root, and `/proc/<pid>/environ` is
  same-user readable, so hostile same-user code (including
  prompt-injected code inside a child) can forge both sides of a
  forwarded ask and the honor site will accept it with no user
  round-trip. The echo check is an accident guard, not integrity. The
  statements live at the honor site (`workspace-fence.ts` header), the
  channel (`ask-channel.ts` header), and the wire (`ask-wire.ts`
  header).
- Env chain: the spawn composes the parent env wholesale, so the root
  path and token ride every grandchild's env through the plain spawn
  chain. Leaked by design; keeping other users out rests on the 0700
  root mode, not on env hygiene.
- Serial prompting: the serving loop prompts one ask at a time while
  each child's wait bound runs independently. With N concurrent
  children asking distinct directories and per-prompt human latency h,
  the Nth ask surfaces at roughly (N-1)*h against the 120s default:
  past h = 120s/(N-1) the ask surfaces after its own deadline and is
  never shown, and at around 40 seconds per prompt the third child's
  decision lands past its bound. The accepted mitigation is
  bound-aware ordering (the longest-waiting ask surfaces first) plus
  `PISCOPE_ASK_WAIT_MS` as the multi-child knob; batching all pending
  asks into one surface was rejected because one Yes would grant N
  directories at once, against the per-ask provenance discipline.
- Wall-clock: the child wait deadline runs on a monotonic clock, but
  the ask records and staleness sweep use wall time; a clock step
  shifts staleness judgment, never a fail-closed outcome.

## Deferred work

Enumerated for the task record; none of it blocks the channel.

- The `/var/tmp` seed cleanup identified during FENCE-1 is
  manager-owned and deliberately not touched by the landing unit.
- The composed e2e round-trip suite's sanctioned-write leg is red at
  source (board resolution from the hosted service cwd; analysis in the
  PIRELOC-1 record and `tests/README.md`).
- A distributed parent-side serving surface (parallel prompting) would
  remove the serial residual entirely at the cost of the per-ask
  provenance shape; rejected for now, revisitable if concurrent-child
  dispatch becomes the common posture.
