/**
 * Shared agent-viewer presentation helpers
 *
 * A dispatch carries no task-ID field, only its prompt text, so the
 * label for a task node is parsed from that text: the first fleet
 * task reference (EXT-N or EXT-N-M) when the prompt carries one, the
 * prompt's first words up to a fixed width otherwise. Alongside the
 * label heuristic this module hosts the helpers the navigator and
 * strip surfaces share: the settled-dispatch count wording and the
 * settled-glyph aggregation over outcome glyphs.
 */

import type { StatusGlyphName } from "../subagent/registry.ts";

/** Fixed upper width for first-words fallback labels, ellipsis included. */
export const TASK_LABEL_MAX_WIDTH = 60;

const FLEET_REFERENCE_PATTERN = /\bEXT-\d+(?:-\d+)?\b/i;

/** Matches a trailing eight-digit segment, the shape of a task-file filename's date (EXT-19-20261030). */
const DATE_SEGMENT_PATTERN = /-\d{8}$/;

/**
 * First fleet task reference in the prompt text, normalized to
 * uppercase ("ext-4-1" -> "EXT-4-1"), or null when the prompt names
 * no EXT-N[-M] task. A trailing eight-digit date segment is stripped
 * from the capture: prompts citing their task file by path
 * (…/EXT-19-20261030-0918-….md) would otherwise capture the
 * filename's date segment, a span mimicking the EXT-N-M child-id
 * shape; real child ids carry small sequential numbers, so only
 * filename dates match the shape. Multi-reference prompts yield the
 * first reference, matching the fleet convention of naming the
 * dispatched task before the ones it coordinates with.
 */
export function findFleetTaskReference(prompt: string): string | null {
	const match = FLEET_REFERENCE_PATTERN.exec(prompt);
	return match ? match[0].toUpperCase().replace(DATE_SEGMENT_PATTERN, "") : null;
}

/**
 * Label for a dispatch task node from its prompt text: the first
 * fleet EXT-N[-M] reference when present, otherwise the prompt's
 * first words collapsed to single spaces and truncated at
 * TASK_LABEL_MAX_WIDTH on a word boundary with a trailing ellipsis
 * (a single word longer than the width is hard-sliced). An empty or
 * blank prompt yields an empty label.
 */
export function resolveTaskLabel(prompt: string): string {
	const reference = findFleetTaskReference(prompt);
	if (reference) return reference;

	const collapsed = prompt.replace(/\s+/g, " ").trim();
	if (collapsed.length <= TASK_LABEL_MAX_WIDTH) return collapsed;

	const ellipsis = "…";
	let filled = "";
	for (const word of collapsed.split(" ")) {
		const candidate = filled ? `${filled} ${word}` : word;
		if (candidate.length > TASK_LABEL_MAX_WIDTH - ellipsis.length) break;
		filled = candidate;
	}
	if (!filled) filled = collapsed.slice(0, TASK_LABEL_MAX_WIDTH - ellipsis.length);
	return `${filled}${ellipsis}`;
}

/**
 * Aggregated glyph over settled task views: done when every view's
 * glyph is done, failed when every one is failed, mixed otherwise.
 * The structural parameter serves both the navigator's
 * NavigatorTaskView and the strip's StripTaskView without coupling
 * this module to either; the flatten and strip callers guard a
 * non-empty list, while the detail caller receives the umbrella row
 * only when the settled partition is non-empty (an empty list
 * vacuously yields "done").
 */
export function aggregateSettledGlyph(views: readonly { glyph: StatusGlyphName }[]): StatusGlyphName {
	if (views.every((view) => view.glyph === "done")) return "done";
	if (views.every((view) => view.glyph === "failed")) return "failed";
	return "mixed";
}

/**
 * Dispatch-count wording for the Completed surfaces: "1 dispatch" in
 * the singular, "N dispatches" otherwise.
 */
export function dispatchCountText(count: number): string {
	return count === 1 ? "1 dispatch" : `${count} dispatches`;
}
