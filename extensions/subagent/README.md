# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Detached dispatch**: Optional `detach: true` runs any mode in the background and returns job IDs immediately
- **Jobs tool**: `jobs status` polls detached jobs without blocking; `jobs wait` blocks for final outputs and collects them
- **Wake on completion**: Finished detached results are delivered the moment a job finishes; an idle session wakes with exactly one turn, and nothing runs while jobs are still in flight
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Dispatch strip**: a toggleable ambient widget above the editor summarizing every live dispatch as task → round → agent lines with status glyphs, current activity, and duration

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── labels.ts            # Task-label heuristic (fleet EXT-N[-M] parse, first-words fallback)
├── registry.ts          # Active-dispatch registry (task → round → agent live state)
├── strip.ts             # Ambient strip rendering (line budget, glyphs, view assembly)
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents in untrusted projects. Trusted projects skip the additional prompt. Set `confirmProjectAgents: false` to disable confirmation.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Detached execution
```
Run scout in the background to map the auth module (detach: true), then ask jobs status for job-1
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

All three modes accept an optional `detach: true` flag; see [Detached Dispatch](#detached-dispatch-and-the-jobs-tool). Blocking dispatch is the default and is unchanged.

## Detached Dispatch and the Jobs Tool

Adding `detach: true` to any subagent call spawns the same child `pi` processes as blocking dispatch (identical tools, models, gates, and confirmations) but returns immediately with job IDs such as `job-1`. Each job registers in a session-scoped registry, and its results persist there until they are collected or the session ends. Blocking dispatch without `detach` remains the default and behaves exactly as before.

The `jobs` tool inspects and collects detached jobs:

| Action | Behavior |
|--------|----------|
| `jobs { action: "status" }` | Non-blocking per-job state: running/done/failed, elapsed time, task preview, and whether results are already collected |
| `jobs { action: "wait", id?, timeout? }` | Blocks until the selected jobs finish or the timeout elapses (default 120s, max 900s), then returns final outputs once and marks them collected |

Omitting `id` selects every job in the session. A second `wait` for an already-collected job reports `collected earlier; output not repeated` in its text instead of re-printing the results, and the completion wake never re-delivers them; the wait's result details still carry the job's outputs, so a result lost to a failed delivery stays recoverable with one wait. A job whose child process is killed mid-run (including jobs still running when the session shuts down) is marked `failed` with the abort reason. At most 4 detached jobs run at once; a detach call that would exceed the cap is rejected until earlier jobs finish.

Detached jobs carry the fleet status glyphs across their surfaces: ⏳ while running, ✓ when done, ✗ when failed, in `jobs status` lines, `jobs wait` output, and the completion wake message, keyed off the live `job.status`.

**Wake on completion**: when a detached job finishes (done, failed, or hard timeout), the extension sends its final outputs as a custom message with a turn trigger. An idle session wakes immediately with exactly one turn; while a run is active, the message is queued into it. Each job's results are delivered at most once. A `jobs wait` already blocked on the job when it finishes collects the outputs itself and suppresses the wake, and settlement keeps a fallback that delivers finished-but-uncollected results with one continuation if completion races settlement, so no result can fall through.

**Timeouts**: every child process has a 60 minute hard timeout in the spawn path, after which it is killed (SIGTERM, then SIGKILL) and the job is marked failed. This applies to blocking dispatch too, where a hung subagent previously waited forever. The `SUBAGENT_TIMEOUT_MS` environment variable raises the timeout for legitimately long single-child work; values below or at the 60 minute default are clamped up to the default and values above 2147483647 ms (Node.js's largest timer delay, about 24.8 days) are clamped down to it, so the env var is raise-only and a run can never hang forever.

**Per-agent policy**: an agent whose frontmatter sets `detach: false` rejects detached dispatch with a clear error and can only be dispatched in blocking mode; blocking dispatch of that agent is unaffected. There are no hardcoded agent names in the extension; the flag is discovered from frontmatter like `tools` and `model`.

## Dispatch Strip

The extension registers a global hotkey (default `alt+s`) that toggles an ambient strip widget above the editor. The strip is hidden until the first toggle and hidden again on the next one. While visible it renders, refreshed twice a second:

- One header line per dispatch, labeled with the dispatch's task label and mode
- One line per live agent: status glyph (⏳ running, ✓ done, ✗ failed), agent name, most recent streamed activity (tool call or text snippet), and elapsed duration
- Finished rounds collapsed to a single summary line per round (`✓ round 1 · 3/3 done · 2m`)
- Detached jobs appear alongside blocking dispatches, one agent line per agent name, glyphs keyed off the live `job.status`
- A hint line naming the navigator key, always last

The strip owns its own line budget (12 lines): live tasks render before finished ones, and content that does not fit is summarized as a `+N more` line above the hint, so the terminal never truncates the widget.

### Task labels

Dispatch payloads carry no task-ID field, so the label is parsed from the prompt text: the first `EXT-N` or `EXT-N-M` fleet task reference when the prompt names one (first match wins on multi-reference prompts), otherwise the prompt's first words truncated to 60 characters. Detached jobs reuse their existing task preview as the label.

### Hotkey configuration

Both extension hotkeys are configurable through the `subagentViewer` settings block in `settings.json`:

```json
{
  "subagentViewer": {
    "stripKey": "alt+s",
    "navigatorKey": "alt+n"
  }
}
```

When the block or a key is absent, the hardcoded defaults apply (`alt+s` strip, `alt+n` navigator; both unused by pi's built-in keybindings). pi's native `keybindings.json` cannot rebind extension shortcuts, and extension settings are read when the shortcuts register, so a changed key takes effect after `/reload` (or a new session).

The navigator itself (opened by the navigator key) is a separate checkpoint; the strip's hint line already shows the key that will open it.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
detach: false
---

System prompt for the agent goes here.
```

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level. The optional `detach: false` key bars the agent from detached (background) dispatch; see [Detached Dispatch](#detached-dispatch-and-the-jobs-tool).

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon (blocking only, `detach: false`) | glm-5.3-flash | read, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **stopReason "timeout"**: Child exceeded the hard timeout (default 60 minutes, raisable via `SUBAGENT_TIMEOUT_MS`) and was killed
- **Chain mode**: Stops at first failing step, reports which step failed
- **Detached jobs**: Failures mark the job `failed` in the registry; the outputs of failed jobs are delivered like any other result

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details (for detached jobs, in the delivered message's entry details)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
- Detached jobs and their results live in memory for the current session only; a new session starts with an empty registry and kills any still-running children
- At most 4 detached jobs run at a time per session; further detach calls are rejected until running jobs finish
