/**
 * Navigator detail-pane scroll model
 *
 * Pure windowing state for the navigator view's detail pane, plus the
 * view's body-height budget. The window model implements the
 * follow-end contract of pi-tui's ScrollView over plain line lists:
 * the window follows the newest line by default, an effective upward
 * scroll releases the follow, and reaching the bottom again reacquires
 * it. While released, the window is stabilized on line identity keys
 * rather than a bare index, because the activity log evicts from its
 * head once it reaches its cap and an index-pinned window would
 * silently drift forward through the log. A real ScrollView is
 * deliberately not adopted even though the overlay hosting would run
 * its layout: the pure model is already pinned headlessly and
 * keeps the suites framework-free.
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * pin the window math directly.
 */

import type { DispatchActivityEntry } from "../subagent/registry.ts";

/** Chrome rows the view renders around its body: the header line above, the hints line below. */
export const VIEW_CHROME_ROWS = 2;

/** Context lines of overlap a pageUp/pageDown step keeps, so paging never loses the reading thread. */
export const PAGE_SCROLL_OVERLAP_LINES = 1;

/** Muted line rendered beneath the window while held output has arrived. */
export const SCROLL_NEW_INDICATOR = "↓ new · end to follow";

export interface DetailScrollState {
	/** True while the window is pinned to the tail (the default). */
	following: boolean;
	/** Index of the first visible detail line while held; ignored while following. */
	scrollTop: number;
	/** Key of the top visible line when the hold began; the stabilization anchor. */
	heldTopKey: string | null;
	/** Key of the tail line when the hold began; the new-output indicator compares against it. */
	heldTailKey: string | null;
}

export function createDetailScrollState(): DetailScrollState {
	return { following: true, scrollTop: 0, heldTopKey: null, heldTailKey: null };
}

/**
 * Body rows the view's tree and detail panes share: the terminal
 * minus the view's own frame lines, floored at one. The view is
 * hosted as a full-width top overlay while open and, on terminals of
 * three rows and up, renders exactly this budget plus the frame
 * lines every render, so its content-derived height meets the
 * overlay's maxHeight with no silent truncation: the frame is pinned
 * at row 0 and fills the terminal. The one-row floor is a safety
 * clamp below that: on a one- or two-row terminal the budget plus
 * the frame lines exceeds the terminal and the overlay's maxHeight
 * truncates the frame.
 */
export function viewBodyRows(terminalRows: number): number {
	return Math.max(1, terminalRows - VIEW_CHROME_ROWS);
}

/** Rows one pageUp/pageDown moves: the viewport minus the overlap, never below one so a page always moves. */
export function pageStepRows(viewportRows: number): number {
	return Math.max(1, viewportRows - PAGE_SCROLL_OVERLAP_LINES);
}

/** One detail-pane line: styled render text plus the identity key backing scroll stabilization. */
export interface DetailLine {
	text: string;
	key: string;
}

/**
 * Identity key for an activity line: the log entry's at/kind/text, so
 * the key survives re-renders and clock formatting, and a hold
 * survives appends and head evictions of the log.
 */
export function activityLineKey(entry: DispatchActivityEntry): string {
	return `activity:${entry.at}:${entry.kind}:${entry.text}`;
}

/**
 * Identity keys of the pane's static lines: structural slots, not
 * rendered text. A static line's text mutates while an agent runs
 * (the duration ticks, the token count moves, a member's summary
 * ages), so a text key would vanish from the rebuilt list on every
 * poll and park a held window at the head; the line's slot in the
 * pane keeps the anchor findable, the same identity rule the activity
 * keys follow. Duplicate keys resolve to the nearest match, the same
 * tiebreak activity keys accept.
 */
export const HEADER_LINE_KEY = "header";
export const BLANK_LINE_KEY = "blank";
export const USAGE_LINE_KEY = "usage";
export const RESULT_LINE_KEY = "result";
export const PLACEHOLDER_LINE_KEY = "placeholder";

/** Identity key of a field line: its label, independent of the value rendered beside it. */
export function fieldLineKey(label: string): string {
	return `field:${label}`;
}

/** Identity key of a member line: its position among the pane's members, independent of its rendered summary. */
export function memberLineKey(index: number): string {
	return `member:${index}`;
}

export interface DetailWindow {
	/** Index of the first visible line. */
	start: number;
	/** Index one past the last visible line. */
	end: number;
	/** True when held output has arrived and the indicator must render beneath the window. */
	newOutput: boolean;
}

function maxScrollTop(contentRows: number, viewportRows: number): number {
	return Math.max(0, contentRows - viewportRows);
}

function clampScrollTop(scrollTop: number, contentRows: number, viewportRows: number): number {
	return Math.min(Math.max(0, scrollTop), maxScrollTop(contentRows, viewportRows));
}

function tailKey(keys: readonly string[]): string | null {
	return keys.length > 0 ? keys[keys.length - 1] : null;
}

/**
 * Move the window by delta lines (negative up, positive down) over the
 * rebuilt line list. An effective upward move releases the follow and
 * begins a hold anchored on the new top line; a downward move that
 * reaches the tail reacquires the follow and clears the hold, including
 * a hold already parked at the tail (a taller viewport clamps one
 * there), so paging down there is the user asking to re-follow. Moves
 * that cannot change the window (content fitting the viewport, a held
 * window paged down while short of the tail, a following window paged
 * down) are no-ops that leave the hold keys untouched, so short content
 * keeps every scroll key neutral.
 */
export function scrollDetailBy(state: DetailScrollState, delta: number, keys: readonly string[], viewportRows: number): void {
	if (delta === 0 || keys.length === 0) return;
	const maxTop = maxScrollTop(keys.length, viewportRows);
	const current = state.following ? maxTop : clampScrollTop(state.scrollTop, keys.length, viewportRows);
	const next = clampScrollTop(current + delta, keys.length, viewportRows);
	if (delta < 0) {
		if (maxTop === 0 || (!state.following && next === state.scrollTop)) return;
		const release = state.following;
		state.following = false;
		state.scrollTop = next;
		state.heldTopKey = keys[next] ?? null;
		if (release) state.heldTailKey = tailKey(keys);
		return;
	}
	if (state.following) return;
	if (next >= maxTop) {
		state.following = true;
		state.scrollTop = maxTop;
		state.heldTopKey = null;
		state.heldTailKey = null;
		return;
	}
	if (next === state.scrollTop) return;
	state.scrollTop = next;
	state.heldTopKey = keys[next] ?? null;
}

/**
 * Jump the window to target (clamped into range; a target at or past
 * the last page lands on the tail). Landing on the tail reacquires
 * the follow and clears the hold; any other effective jump releases
 * it and anchors a hold on the landing line.
 */
export function scrollDetailTo(state: DetailScrollState, target: number, keys: readonly string[], viewportRows: number): void {
	if (keys.length === 0) return;
	const maxTop = maxScrollTop(keys.length, viewportRows);
	const next = clampScrollTop(target, keys.length, viewportRows);
	if (next >= maxTop) {
		state.following = true;
		state.scrollTop = maxTop;
		state.heldTopKey = null;
		state.heldTailKey = null;
		return;
	}
	if (!state.following && next === state.scrollTop) return;
	const release = state.following;
	state.following = false;
	state.scrollTop = next;
	state.heldTopKey = keys[next] ?? null;
	if (release) state.heldTailKey = tailKey(keys);
}

/**
 * Re-pin the window after the line list was rebuilt (every poll's
 * render): a following window re-pins to the tail; a hold re-finds
 * its anchored top line's key, scanning forward from the held index
 * first and then backward, because appends leave indices in place
 * while head evictions shift them down, and moves scrollTop onto it
 * so the same content stays at the window top. When the anchored line
 * itself has aged out of the log, the window rests on the oldest
 * surviving content (scrollTop 0) without reacquiring, so it can
 * never drift forward through the log.
 */
export function stabilizeDetailScroll(state: DetailScrollState, keys: readonly string[], viewportRows: number): void {
	const maxTop = maxScrollTop(keys.length, viewportRows);
	if (state.following || keys.length === 0 || state.heldTopKey === null) {
		state.scrollTop = maxTop;
		return;
	}
	const start = Math.min(state.scrollTop, keys.length - 1);
	const forward = keys.indexOf(state.heldTopKey, start);
	const found = forward !== -1 ? forward : keys.lastIndexOf(state.heldTopKey, start);
	state.scrollTop = found !== -1 ? Math.min(found, maxTop) : 0;
}

/**
 * Visible slice of the rebuilt line list for the current scroll
 * state: the tail while following, the clamped hold window otherwise.
 * When the new-output indicator is up it reserves the window's last
 * row, so the window plus the indicator never exceed the viewport.
 * The indicator marks output still below the window: once the window
 * itself reaches the newest line (a taller viewport after a resize,
 * for instance), it suppresses instead of claiming output that is
 * already visible, while the hold stays held.
 */
export function detailWindow(state: DetailScrollState, keys: readonly string[], viewportRows: number): DetailWindow {
	const maxTop = maxScrollTop(keys.length, viewportRows);
	const start = Math.min(state.following ? maxTop : clampScrollTop(state.scrollTop, keys.length, viewportRows), keys.length);
	const tailReachable = start + viewportRows >= keys.length;
	const newOutput =
		!state.following && state.heldTailKey !== null && keys.length > 0 && keys[keys.length - 1] !== state.heldTailKey && !tailReachable;
	const windowRows = newOutput ? Math.max(0, viewportRows - 1) : viewportRows;
	return { start, end: Math.min(keys.length, start + windowRows), newOutput };
}
