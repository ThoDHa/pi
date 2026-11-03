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
 * Matches a task-file citation's filename: the fleet's dispatch
 * convention names task files EXT-N[-M]-YYYYMMDD-HHMM-slug.md, cited
 * from .tasks/current/ or, for report deposits, from
 * .tasks/reports/<basename>/NN-slug.md, where the basename still
 * terminates at .md before the following slash. Case insensitive like
 * the reference primitive.
 */
const TASK_FILE_SUMMARY_PATTERN = /\b(EXT-\d+(?:-\d+)?)-\d{8}-\d{4}-([a-z0-9]+(?:-[a-z0-9]+)*)\.md\b/i;

/**
 * Truncate text to width on a word boundary with a trailing ellipsis,
 * returning it unchanged when it already fits; a single word longer
 * than the width is hard-sliced. The truncation contract shared by
 * the first-words fallback and the summary resolver, so it lives once.
 */
function truncateWithEllipsis(text: string, width: number): string {
	if (text.length <= width) return text;
	const ellipsis = "…";
	let filled = "";
	for (const word of text.split(" ")) {
		const candidate = filled ? `${filled} ${word}` : word;
		if (candidate.length > width - ellipsis.length) break;
		filled = candidate;
	}
	if (!filled) filled = text.slice(0, width - ellipsis.length);
	return `${filled}${ellipsis}`;
}

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
	return truncateWithEllipsis(collapsed, TASK_LABEL_MAX_WIDTH);
}

/**
 * Summary label for a dispatch from its prompt text: the first
 * task-file citation's id plus its filename slug read as words
 * ("EXT-24 · fix the strip label truncation"), capped at
 * TASK_LABEL_MAX_WIDTH by truncating the slug words on a word boundary
 * with the trailing ellipsis (a single over-long slug word
 * hard-slices). Null when the prompt cites no task file, so callers
 * can fall back to resolveTaskLabel; a bare EXT-N reference is not a
 * citation, since no slug exists without the filename. First citation
 * wins, matching the fleet convention of naming the dispatched task
 * before the ones it coordinates with.
 */
export function resolveTaskSummary(prompt: string): string | null {
	const match = TASK_FILE_SUMMARY_PATTERN.exec(prompt);
	if (!match) return null;
	const prefix = `${match[1].toUpperCase()} · `;
	return prefix + truncateWithEllipsis(match[2].replace(/-/g, " "), TASK_LABEL_MAX_WIDTH - prefix.length);
}

/**
 * Display label for a dispatch task from its prompt text, the label
 * contract both surfaces render: the task-file citation summary when
 * the prompt cites one, the fleet-reference/first-words label
 * otherwise, and "(detached)" when both come up empty, so a task
 * header never renders bare. The chain and the placeholder wording
 * live here so they are written and pinned once.
 */
export function resolveTaskDisplayLabel(prompt: string): string {
	return resolveTaskSummary(prompt) ?? (resolveTaskLabel(prompt) || "(detached)");
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
