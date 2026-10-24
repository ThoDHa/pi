#!/usr/bin/env node
/**
 * Unit suite for the navigator view's pure detail-pane scroll
 * model (extensions/agent-viewer/detail-scroll.ts). Plain node, no
 * test framework:
 *
 *   node tests/agent-viewer-detail-scroll.test.mjs
 *
 * Covers the follow-end anchor semantics: a fresh state windows the
 * tail; an upward page releases the follow and arms the new-output
 * indicator only once content actually arrives; a held window is
 * stabilized on line identity keys so appends and head evictions
 * never yank it, with static lines keyed on structural slots so a
 * mutating field's text never evicts the hold; a held top line aging
 * out of the log clamps without reacquiring; paging to the bottom,
 * end, and home behaviors; the indicator suppressing once the window
 * itself reaches the newest line; short content keeping every scroll
 * key neutral; and the body-budget arithmetic shared with the view
 * frame.
 */

import assert from "node:assert/strict";
import {
	BLANK_LINE_KEY,
	HEADER_LINE_KEY,
	PAGE_SCROLL_OVERLAP_LINES,
	PLACEHOLDER_LINE_KEY,
	RESULT_LINE_KEY,
	SCROLL_NEW_INDICATOR,
	USAGE_LINE_KEY,
	VIEW_CHROME_ROWS,
	VIEW_DOCK_ROWS,
	VIEW_RESERVED_ROWS,
	activityLineKey,
	createDetailScrollState,
	detailWindow,
	fieldLineKey,
	memberLineKey,
	pageStepRows,
	scrollDetailBy,
	scrollDetailTo,
	stabilizeDetailScroll,
	viewBodyRows,
} from "../extensions/agent-viewer/detail-scroll.ts";

const VIEWPORT = 10;

const keysOf = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

const entryKey = (index) => activityLineKey({ at: 2_000 + index * 100, kind: "text", text: `log line ${index}` });

function heldState(keys, viewport) {
	const state = createDetailScrollState();
	scrollDetailBy(state, -pageStepRows(viewport), keys, viewport);
	return state;
}

// --- anchor default: a fresh state windows the tail and follows ---

{
	const state = createDetailScrollState();
	const keys = keysOf(60, "line-");
	const visible = detailWindow(state, keys, VIEWPORT);
	assert.equal(state.following, true, "a fresh state follows the tail");
	assert.equal(visible.newOutput, false, "a fresh state shows no indicator");
	assert.deepEqual([visible.start, visible.end], [50, 60], "the tail fills the window");
	assert.equal(keys[visible.start], "line-50");
}

// --- scroll release: pageUp moves by viewport minus the overlap and releases the follow ---

{
	assert.equal(PAGE_SCROLL_OVERLAP_LINES, 1, "one context line of overlap per page");
	const keys = keysOf(60, "line-");
	const state = heldState(keys, VIEWPORT);
	assert.equal(pageStepRows(VIEWPORT), VIEWPORT - 1, "the page step keeps one context line");
	assert.equal(state.following, false, "an upward page releases the follow");
	assert.equal(state.scrollTop, 50 - (VIEWPORT - 1));
	assert.equal(state.heldTopKey, "line-41", "the hold anchors on the new top line");
	assert.equal(state.heldTailKey, "line-59", "the hold records the tail at release");
	const visible = detailWindow(state, keys, VIEWPORT);
	assert.equal(visible.newOutput, false, "no indicator before new content arrives");
	assert.equal(keys[visible.start], "line-41");
}

// --- line-key builders: activity entries key on log identity, static lines on structural slots ---

{
	assert.equal(activityLineKey({ at: 5, kind: "toolCall", text: "$ rg" }), "activity:5:toolCall:$ rg");
	assert.notEqual(
		activityLineKey({ at: 5, kind: "text", text: "same" }),
		activityLineKey({ at: 6, kind: "text", text: "same" }),
		"different timestamps yield different keys",
	);
	assert.notEqual(
		activityLineKey({ at: 5, kind: "text", text: "same" }),
		activityLineKey({ at: 5, kind: "toolCall", text: "same" }),
		"different kinds yield different keys",
	);
	assert.equal(HEADER_LINE_KEY, "header");
	assert.equal(BLANK_LINE_KEY, "blank");
	assert.equal(USAGE_LINE_KEY, "usage");
	assert.equal(RESULT_LINE_KEY, "result");
	assert.equal(PLACEHOLDER_LINE_KEY, "placeholder");
	assert.equal(fieldLineKey("tokens"), "field:tokens");
	assert.equal(memberLineKey(2), "member:2");
	assert.notEqual(fieldLineKey("at"), activityLineKey({ at: 0, kind: "text", text: "at" }), "structural and activity keys never collide");
	assert.equal(SCROLL_NEW_INDICATOR, "↓ new · end to follow");
}

// --- no-yank while held: appended output never moves the window and arms the indicator ---

{
	const keys = keysOf(60, "line-");
	const state = heldState(keys, VIEWPORT);
	const grown = [...keys, "line-60", "line-61", "line-62", "line-63", "line-64"];
	stabilizeDetailScroll(state, grown, VIEWPORT);
	assert.equal(state.scrollTop, 41, "the held top line stays at the window top after appends");
	const visible = detailWindow(state, grown, VIEWPORT);
	assert.equal(grown[visible.start], "line-41");
	assert.equal(visible.newOutput, true, "output arriving during a hold arms the indicator");
	assert.ok(visible.end - visible.start <= VIEWPORT - 1, "the window plus the indicator fit the viewport");
}

// --- activity-log identity: a hold survives key-based rebuilds with real entry keys ---

{
	const keys = Array.from({ length: 60 }, (_, index) => entryKey(index));
	const state = heldState(keys, VIEWPORT);
	const grown = [...keys, ...Array.from({ length: 5 }, (_, index) => entryKey(60 + index))];
	stabilizeDetailScroll(state, grown, VIEWPORT);
	assert.equal(grown[state.scrollTop], entryKey(41), "the held entry stays at the window top");
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, true);
}

// --- structural holds: a held field or member line keeps the window top while its rendered text mutates ---

{
	const keys = [
		HEADER_LINE_KEY,
		fieldLineKey("model"),
		fieldLineKey("cwd"),
		fieldLineKey("tokens"),
		fieldLineKey("duration"),
		BLANK_LINE_KEY,
		...Array.from({ length: 50 }, (_, index) => entryKey(index)),
		BLANK_LINE_KEY,
		USAGE_LINE_KEY,
	];
	const durationTop = keys.indexOf(fieldLineKey("duration"));
	const state = createDetailScrollState();
	scrollDetailTo(state, durationTop, keys, VIEWPORT);
	assert.equal(state.heldTopKey, fieldLineKey("duration"), "the hold anchors on the duration field's structural key");
	stabilizeDetailScroll(state, keys, VIEWPORT);
	assert.equal(state.following, false, "the hold survives the rebuild");
	assert.equal(state.scrollTop, durationTop, "a mutating field's text does not move the held window");

	const memberKeys = [
		HEADER_LINE_KEY,
		BLANK_LINE_KEY,
		memberLineKey(0),
		memberLineKey(1),
		memberLineKey(2),
		BLANK_LINE_KEY,
		...Array.from({ length: 50 }, (_, index) => entryKey(index)),
	];
	const memberState = createDetailScrollState();
	scrollDetailTo(memberState, 3, memberKeys, VIEWPORT);
	assert.equal(memberState.heldTopKey, memberLineKey(1));
	stabilizeDetailScroll(memberState, memberKeys, VIEWPORT);
	assert.equal(memberState.scrollTop, 3, "a member line holds by index while its detail text changes");
}

// --- head eviction: the cap rotating the oldest line shifts the hold up one, same top line ---

{
	const keys = keysOf(50, "line-");
	const state = heldState(keys, VIEWPORT);
	assert.equal(state.scrollTop, 40 - (VIEWPORT - 1));
	assert.equal(state.heldTopKey, "line-31");
	const rotated = [...keys.slice(1), "line-50"];
	stabilizeDetailScroll(state, rotated, VIEWPORT);
	assert.equal(state.following, false, "an eviction does not reacquire");
	assert.equal(rotated[state.scrollTop], "line-31", "the same top line stays visible after head eviction");
	const visible = detailWindow(state, rotated, VIEWPORT);
	assert.equal(visible.newOutput, true, "the rotated-in tail counts as unseen output");
}

// --- held-line eviction: the anchored line ages out; clamp without reacquiring ---

{
	const keys = keysOf(50, "line-");
	const state = createDetailScrollState();
	scrollDetailTo(state, 2, keys, VIEWPORT);
	assert.equal(state.heldTopKey, "line-2", "the hold anchors near the head");
	const rotated = [...keys.slice(5), ...keysOf(5, "new-")];
	stabilizeDetailScroll(state, rotated, VIEWPORT);
	assert.equal(state.following, false, "an evicted hold does not silently reacquire");
	assert.equal(state.scrollTop, 0, "the window rests on the oldest surviving content");
	const visible = detailWindow(state, rotated, VIEWPORT);
	assert.equal(visible.newOutput, true, "the indicator still flags output the hold has not seen");
}

// --- re-anchor: paging to the bottom and end reacquire; home releases at the top ---

{
	const keys = keysOf(60, "line-");
	const grown = [...keys, "line-60"];
	const state = heldState(keys, VIEWPORT);
	stabilizeDetailScroll(state, grown, VIEWPORT);
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, true);

	scrollDetailBy(state, pageStepRows(VIEWPORT), grown, VIEWPORT);
	assert.equal(state.following, false, "a page short of the tail keeps the hold");
	assert.equal(state.scrollTop, 50);
	scrollDetailBy(state, pageStepRows(VIEWPORT), grown, VIEWPORT);
	assert.equal(state.following, true, "paging down to the bottom reacquires the follow");
	assert.equal(state.heldTailKey, null, "reacquiring clears the hold");
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, false, "the indicator clears on reacquire");

	scrollDetailBy(state, -pageStepRows(VIEWPORT), grown, VIEWPORT);
	assert.equal(state.following, false);
	scrollDetailTo(state, Number.POSITIVE_INFINITY, grown, VIEWPORT);
	assert.equal(state.following, true, "end reacquires the follow");
	assert.equal(state.scrollTop, 51, "end rests on the tail");
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, false);

	scrollDetailTo(state, 0, grown, VIEWPORT);
	assert.equal(state.following, false, "home releases the follow");
	assert.equal(state.scrollTop, 0);
	assert.equal(state.heldTopKey, "line-0");
}

// --- held paging: a downward page short of the tail moves the anchor but keeps the follow released ---

{
	const keys = keysOf(60, "line-");
	const state = createDetailScrollState();
	scrollDetailTo(state, 0, keys, VIEWPORT);
	scrollDetailBy(state, 3, keys, VIEWPORT);
	assert.equal(state.following, false, "a downward page short of the tail keeps the hold");
	assert.equal(state.scrollTop, 3);
	assert.equal(state.heldTopKey, "line-3");
	assert.equal(detailWindow(state, keys, VIEWPORT).newOutput, false, "no indicator while no output arrived");
	const grown = [...keys, "line-60"];
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, true, "output during the hold arms the indicator");
	stabilizeDetailScroll(state, grown, VIEWPORT);
	scrollDetailBy(state, 3, grown, VIEWPORT);
	assert.equal(state.following, false, "a further short page keeps the hold");
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, true, "the indicator survives a downward page short of the tail");
}

// --- indicator suppression: once the window reaches the newest line the marker hides, but the hold stays held ---

{
	const keys = keysOf(60, "line-");
	const state = heldState(keys, VIEWPORT);
	const grown = [...keys, "line-60", "line-61"];
	assert.equal(detailWindow(state, grown, VIEWPORT).newOutput, true, "the indicator marks output still below the window");

	stabilizeDetailScroll(state, grown, VIEWPORT + 5);
	const mid = detailWindow(state, grown, VIEWPORT + 5);
	assert.equal(state.following, false, "a taller viewport does not silently reacquire");
	assert.equal(mid.newOutput, true, "the tail still lies below the window, so the marker stays");
	assert.deepEqual([mid.start, mid.end], [41, 55]);

	stabilizeDetailScroll(state, grown, VIEWPORT * 3);
	const tall = detailWindow(state, grown, VIEWPORT * 3);
	assert.equal(state.following, false, "the hold survives the resize");
	assert.equal(tall.end, grown.length, "the window shows the full tail");
	assert.equal(tall.newOutput, false, "the marker suppresses once the newest line is visible");
}

// --- short content: every scroll key is a clamped no-op ---

{
	const keys = keysOf(5, "line-");
	const state = createDetailScrollState();
	scrollDetailBy(state, -pageStepRows(VIEWPORT), keys, VIEWPORT);
	scrollDetailBy(state, pageStepRows(VIEWPORT), keys, VIEWPORT);
	scrollDetailTo(state, 0, keys, VIEWPORT);
	scrollDetailTo(state, Number.POSITIVE_INFINITY, keys, VIEWPORT);
	assert.equal(state.following, true, "short content keeps every scroll key a no-op");
	assert.deepEqual(detailWindow(state, keys, VIEWPORT), { start: 0, end: 5, newOutput: false });
}

// --- viewport discovery: the body budget shared with the view frame ---

{
	assert.equal(VIEW_DOCK_ROWS, 4, "the dock claims the transcript minimum, status plus footer, and one slack row");
	assert.equal(VIEW_CHROME_ROWS, 2, "the view renders a header line and a hints line around the body");
	assert.equal(VIEW_RESERVED_ROWS, VIEW_DOCK_ROWS + VIEW_CHROME_ROWS, "the total reserve sums the dock and the chrome");
	assert.equal(viewBodyRows(40), 40 - VIEW_RESERVED_ROWS, "the body budget is the terminal minus the reserved rows");
	assert.equal(viewBodyRows(2), 1, "a tiny terminal floors at one body row");
	assert.equal(viewBodyRows(VIEW_RESERVED_ROWS), 1, "a terminal exactly the size of the reserve still shows one body row");
	assert.equal(viewBodyRows(VIEW_RESERVED_ROWS - 1), 1, "a terminal smaller than the reserve clamps to one body row");
}

console.log("agent-viewer-detail-scroll: all assertions passed");
