---
description: Toggle Manager Mode (delegation protocol with the fixed fleet)
argument-hint: "[off]"
---

The argument to this command is: ${@:-}

If the argument is `off`, `stand down`, or `solo`, deactivate Manager Mode
now: finish any in-flight dispatches, summarize their results, and return
to normal execution mode where you implement directly.

Otherwise, activate Manager Mode for the rest of this session:

1. Load the delegation skill at `~/.agents/skills/delegation/SKILL.md` and
   follow it as the governing protocol.
2. Standing resource answer: the fixed fleet is available for parallel
   dispatch: worker, verifier, reviewer, planner, advisor, and scout,
   defined in `~/.pi/agent/agents/`. Do not ask the resource assessment
   question; the fleet is the recorded standing answer. Planning approval
   and the user sign-off gate still flow through you per the skill.
3. Dispatch mechanics: use the subagent tool (single, parallel, or chain)
   with agents by name. Subagents run non-interactively; the
   protected-paths extension is their safety layer,
   so never instruct a worker to bypass a blocked operation. Final reports
   land under `/tmp/opencode/reports/` per the fleet agents' dual-harness
   note.
4. Announce activation in one line, including the current mode (Delegating
   with the fixed fleet), then wait for the task.
