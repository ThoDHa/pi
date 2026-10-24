# Agent Viewer

Ambient observation surfaces for subagent dispatches. This is a
standalone extension: it lives in its own directory under
`extensions/`, loads via pi's auto-discovery with zero `settings.json`
edits, and owns everything user-facing about dispatch observation —
the dispatch strip, the navigator overlay, their hotkey registration,
and the task-label heuristic.

The extension owns no dispatch state. The subagent extension owns
dispatch execution and publishes live state into the shared dispatch
state this extension reads (`extensions/subagent/registry.ts`,
converged on `globalThis`, since pi evaluates each extension's modules
in a fresh instance). Both extensions must be present; with no
dispatch in flight the strip shows its "No active dispatches"
placeholder.

## Dispatch Strip

The extension registers a global hotkey (default `alt+s`) that toggles an ambient strip widget above the editor. The strip is hidden until the first toggle and hidden again on the next one. While visible it renders, refreshed twice a second:

- One header line per dispatch, labeled with the dispatch's task label and mode
- One line per live agent: status glyph (⏳ running, ✓ done, ✗ failed), agent name, most recent streamed activity (tool call or text snippet), and elapsed duration
- Finished rounds collapsed to a single summary line per round (`✓ round 1 · 3/3 done · 2m`)
- Detached jobs appear alongside blocking dispatches, one line per started per-slot agent node carrying that node's status glyph, streamed activity, and duration (steps that have not started yet add no line); the one-line-per-agent-name rendering keyed off `job.status` remains only as a mixed-version defense for snapshots published before the per-agent wiring
- A hint line naming the navigator key, always last

The strip owns its own line budget (12 lines): live tasks render before finished ones, and content that does not fit is summarized as a `+N more` line above the hint, so the terminal never truncates the widget.

## Navigator

A second hotkey (default `alt+n`) opens the navigator: a blocking overlay (`ctx.ui.custom` with `overlay: true`) over every dispatch in the shared state, refreshed ~3× a second by the same polling the strip uses.

- **Left tree pane:** one row per dispatch task (labeled by the same heuristic as the strip), expanding to its dispatch rounds and their agents. Completed rounds render as a single summary glyph line; the live round auto-expands. Detached jobs render as task nodes with their started agents directly beneath, each keyed off its own node status (snapshots published before the per-agent wiring fall back to `agentNames` children keyed off `job.status`).
- **Right detail pane:** for a selected agent, a status header (status, model, cwd, context tokens, step for chain agents, duration) plus its streamed activity — timestamped lines for text snippets and tool calls with their arguments — the usage summary, and the final result when settled. For a task or round selection, a summary with one line per child. Selection follows a blocking or a detached agent alike; detached detail streams through the per-task `onUpdate` wiring in the subagent extension's `runDetachedJob`.
- **Keys (fixed in v1):** `↑`/`↓` move the cursor, `←`/`→` collapse/expand the selected task or round, `tab`/`shift+tab` jump to the next/previous task, `pgup`/`pgdn` page the detail pane, `home`/`end` jump to its first/last line, `esc` closes. The surface is strictly read-only: nothing in the overlay steers, aborts, or injects into a dispatch.
- **Detail-pane scrolling:** the pane follows the newest output by default. `pgup` releases the follow and pages up (keeping one line of context); while released the window holds its place as new output streams in, with a `↓ new · end to follow` line marking output still below the window (the line hides again once the window itself reaches the newest line, as after a terminal resize), and the hold survives the activity log evicting old entries at its 50-line cap; while the tree pane overflows into its `+N more` clip, the window and the marker share the body budget one row short so the newest output and the marker stay visible. Paging back to the bottom or pressing `end` re-follows and clears the marker; moving the cursor to a different row re-anchors on that row's newest output.

Pressing the open key while the navigator is already showing does nothing (no second overlay stacks).

### Task labels

Dispatch payloads carry no task-ID field, so the label is parsed from the prompt text: the first `EXT-N` or `EXT-N-M` fleet task reference when the prompt names one (first match wins on multi-reference prompts), otherwise the prompt's first words truncated to 60 characters. Labels resolve at render time, and detached jobs resolve their task preview through the same heuristic on both surfaces.

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

When the block or a key is absent, the hardcoded defaults apply (`alt+s` strip, `alt+n` navigator; both unused by pi's built-in keybindings). pi's native `keybindings.json` cannot rebind extension shortcuts, and extension settings are read when the shortcuts register, so a changed key takes effect after `/reload` (or a new session). The in-overlay navigation keys are fixed and not configurable.
