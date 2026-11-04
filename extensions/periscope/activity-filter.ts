/**
 * Navigator tool-noise filter
 *
 * Pure classification and filtering of a detail pane's activity log:
 * the file-reading tool calls (read, grep, find, ls) are noise in the
 * default view, everything else (assistant text, child thinking, and
 * every write/edit/bash/unknown tool call) stays visible. The view
 * component in view.ts applies the filter between resolveDetailModel
 * and rendering and owns the toggled state; this module holds no UI
 * state and no pi imports, so plain-node suites pin it directly.
 */

import type { DispatchActivityEntry } from "../subagent/registry.ts";

/** Tool calls whose args-only output is noise in the default view: the file-reading and searching four. */
const NOISY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

/**
 * Whether an entry is a read/grep/find/ls tool call. Text, thinking,
 * unnamed tool calls, and any tool name outside the noise set are
 * not, so unknown third-party tools degrade to visible.
 */
export function isNoisyToolCall(entry: DispatchActivityEntry): boolean {
	return entry.kind === "toolCall" && entry.name !== undefined && NOISY_TOOL_NAMES.has(entry.name);
}

/**
 * The detail pane's activity under the current toggle state: with
 * showToolNoise set the log passes through unchanged, while the
 * default (cleared) drops the noisy tool calls and keeps text,
 * thinking, and every other tool call in order. Never mutates the
 * input.
 */
export function filterActivityEntries(entries: readonly DispatchActivityEntry[], showToolNoise = false): DispatchActivityEntry[] {
	if (showToolNoise) return [...entries];
	return entries.filter((entry) => !isNoisyToolCall(entry));
}
