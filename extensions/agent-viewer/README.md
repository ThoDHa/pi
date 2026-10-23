# Agent Viewer

Ambient observation surfaces for subagent dispatches. This is a
standalone extension: it lives in its own directory under
`extensions/`, loads via pi's auto-discovery with zero `settings.json`
edits, and owns everything user-facing about dispatch observation —
the dispatch strip, its hotkey registration, the task-label
heuristic, and (in checkpoint 2) the navigator overlay.

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
- Detached jobs appear alongside blocking dispatches, one agent line per agent name, glyphs keyed off the live `job.status`
- A hint line naming the navigator key, always last

The strip owns its own line budget (12 lines): live tasks render before finished ones, and content that does not fit is summarized as a `+N more` line above the hint, so the terminal never truncates the widget.

### Task labels

Dispatch payloads carry no task-ID field, so the label is parsed from the prompt text: the first `EXT-N` or `EXT-N-M` fleet task reference when the prompt names one (first match wins on multi-reference prompts), otherwise the prompt's first words truncated to 60 characters. Labels resolve at render time, and detached jobs reuse their existing task preview as the label.

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
