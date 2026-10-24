#!/usr/bin/env node
/**
 * Headless smoke suite for the navigator overlay's detail-pane
 * scrolling (extensions/agent-viewer/overlay.ts). Plain node, no test
 * framework:
 *
 *   node tests/agent-viewer-overlay-scroll.test.mjs
 *
 * Drives the real NavigatorOverlay with a stub TUI (requestRender
 * plus terminal rows/columns) and a pass-through theme, feeding the
 * real escape sequences pi-tui's matchesKey binds to pageUp/pageDown/
 * home/end. Pins: the scroll keys move only the detail window while
 * selectedId/selectedIndex stay fixed; the pane shows the newest
 * output by default and re-anchors on selection changes; the
 * indicator appears for output arriving during a hold and clears on
 * end; a held field line keeps the window in place while its value
 * mutates on a poll (structural keys, no teleport to the pane head);
 * tree overflow budgets the window one row short so the newest line
 * and the indicator survive the +N more clip; a taller resize while
 * held suppresses the marker once the tail is actually visible;
 * tree toggling and the tree "+N more" clip are unchanged; short
 * content keeps the scroll keys as no-ops; escape resolves the done
 * callback; and the footer hints line truncates instead of
 * overflowing a narrow frame.
 */

import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createDispatchRegistry } from "../extensions/subagent/registry.ts";
import { NavigatorOverlay } from "../extensions/agent-viewer/overlay.ts";
import { SCROLL_NEW_INDICATOR, overlayBodyRows } from "../extensions/agent-viewer/detail-scroll.ts";
import { buildNavigatorTasks, createExpansionState, flattenNavigatorTree } from "../extensions/agent-viewer/navigator.ts";

const ROWS = 24;
const BODY_ROWS = overlayBodyRows(ROWS);
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

const themeStub = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const stubTui = () => ({ requestRender() {}, terminal: { rows: ROWS, columns: 120 } });

const activityEntry = (index, from = 0) => ({
	at: from + index * 100,
	kind: index % 2 === 0 ? "text" : "toolCall",
	text: `log line ${index}`,
});

const mapperLog = (count) => Array.from({ length: count }, (_, index) => activityEntry(index, 2_000));

function scrollFixture() {
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-1 scroll probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }, { agent: "mapper" }], 1_000);
	registry.updateAgent(task.id, 1, 0, {
		activity: [
			{ at: 1_100, kind: "text", text: "scout note 0" },
			{ at: 1_200, kind: "text", text: "scout note 1" },
		],
	});
	registry.updateAgent(task.id, 1, 1, { activity: mapperLog(30) });
	return { registry, task };
}

async function withOverlay(sources, run, tui = stubTui()) {
	let resolveDone;
	const done = new Promise((resolve) => (resolveDone = resolve));
	const overlay = new NavigatorOverlay(tui, themeStub, sources, resolveDone);
	try {
		await run(overlay, done);
	} finally {
		overlay.dispose();
	}
}

// --- key composition, tail anchor, indicator, and re-anchor on selection change ---

{
	const { registry, task } = scrollFixture();
	await withOverlay({ registry, detachedJobs: [] }, async (overlay) => {
		// The 300ms poll never fires inside a synchronous suite: refresh()
		// is the exact method the poll interval calls, so registry updates
		// are picked up by calling it directly.
		const poll = () => overlay.refresh();
		const SCOUT_ID = "t:task-1:r1:a0";
		const MAPPER_ID = "t:task-1:r1:a1";

		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedIndex, 3);
		assert.equal(overlay.selectedId, MAPPER_ID);

		const tailRender = overlay.render(120).join("\n");
		assert.equal(overlay.render(120).length, BODY_ROWS + 3, "the frame fills exactly the body budget plus borders and hints");
		assert.ok(tailRender.includes("log line 29"), "the default view shows the newest output");
		assert.ok(!tailRender.includes("log line 0"), "the default view clips the oldest output");

		overlay.handleInput(PAGE_UP);
		assert.equal(overlay.selectedId, MAPPER_ID, "pageUp leaves the selection fixed");
		assert.equal(overlay.selectedIndex, 3);
		const heldRender = overlay.render(120).join("\n");
		assert.ok(heldRender.includes("log line 0"), "pageUp reveals the oldest output");
		assert.ok(!heldRender.includes("log line 29"), "pageUp moves the newest output out of the window");
		assert.ok(!heldRender.includes(SCROLL_NEW_INDICATOR), "no indicator before new content arrives");

		overlay.handleInput(PAGE_DOWN);
		const returnedRender = overlay.render(120).join("\n");
		assert.ok(returnedRender.includes("log line 29"), "pageDown returns to the tail");
		assert.ok(!returnedRender.includes("log line 0"));

		overlay.handleInput(PAGE_UP);
		registry.updateAgent(task.id, 1, 1, { activity: [...mapperLog(30), activityEntry(30)] });
		poll();
		const indicatorRender = overlay.render(120).join("\n");
		assert.ok(indicatorRender.includes(SCROLL_NEW_INDICATOR), "output arriving during a hold shows the indicator");
		assert.ok(indicatorRender.includes("log line 0"), "the held window does not yank on new output");
		assert.ok(!indicatorRender.includes("log line 30"), "the unseen tail stays below the window");

		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, MAPPER_ID, "down at the last row cannot move the selection");
		overlay.handleInput(UP);
		assert.equal(overlay.selectedId, SCOUT_ID, "up moves the tree cursor");
		const scoutRender = overlay.render(120).join("\n");
		assert.ok(scoutRender.includes("scout note 1"));
		assert.ok(!scoutRender.includes(SCROLL_NEW_INDICATOR), "a selection change re-anchors and clears the indicator");
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, MAPPER_ID);
		const reanchoredRender = overlay.render(120).join("\n");
		assert.ok(reanchoredRender.includes("log line 30"), "returning to the agent re-anchors on its newest output");
		assert.ok(!reanchoredRender.includes("log line 0"), "the re-anchored window clips the oldest output");
		assert.ok(!reanchoredRender.includes(SCROLL_NEW_INDICATOR));

		overlay.handleInput(HOME);
		const homeRender = overlay.render(120).join("\n");
		assert.ok(homeRender.includes("log line 0"), "home jumps to the first detail line");
		assert.ok(!homeRender.includes(SCROLL_NEW_INDICATOR), "home with an unchanged tail shows no indicator");

		overlay.handleInput(END);
		const endRender = overlay.render(120).join("\n");
		assert.ok(endRender.includes("log line 30"), "end returns to the tail");
		assert.ok(!endRender.includes("log line 0"));
		assert.ok(!endRender.includes(SCROLL_NEW_INDICATOR), "end clears the indicator");
	});
}

// --- a held field line survives its value mutating on the next poll (no teleport to the pane head) ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-2 field hold probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }, { agent: "mapper" }], 1_000);
	const usage = (contextTokens) => ({ turns: 3, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.012, contextTokens });
	registry.updateAgent(task.id, 1, 1, {
		model: "probe-model-9",
		cwd: "/probe/cwd-9",
		usage: usage(900),
		activity: mapperLog(28),
	});
	await withOverlay({ registry, detachedJobs: [] }, async (overlay) => {
		const poll = () => overlay.refresh();
		const MAPPER_ID = "t:task-1:r1:a1";

		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, MAPPER_ID);

		const tailRender = overlay.render(120).join("\n");
		assert.ok(tailRender.includes("ctx:900"), "the fixture wires the usage summary into the pane");

		overlay.handleInput(PAGE_UP);
		const heldRender = overlay.render(120).join("\n");
		assert.ok(heldRender.includes("tokens: 900"), "one pageUp puts the tokens field at the window top");
		assert.ok(!heldRender.includes("model: probe-model-9"), "the fields above the window stay clipped");

		registry.updateAgent(task.id, 1, 1, { usage: usage(9_800) });
		poll();
		const mutatedRender = overlay.render(120).join("\n");
		assert.ok(mutatedRender.includes("tokens: 9.8k"), "the mutated field value stays inside the held window");
		assert.ok(!mutatedRender.includes("tokens: 900"), "the stale value leaves the window with the poll");
		assert.ok(!mutatedRender.includes("model: probe-model-9"), "the window does not teleport to the pane head");
		assert.ok(!mutatedRender.includes("cwd: /probe/cwd-9"), "the window top stays on the held field, not one line up");
	});
}

// --- the existing keys keep working: cursor movement and tree toggling ---

await withOverlay({ registry: scrollFixture().registry, detachedJobs: [] }, async (overlay) => {
	overlay.handleInput(DOWN);
	overlay.handleInput(DOWN);
	overlay.handleInput(DOWN);
	overlay.handleInput(UP);
	overlay.handleInput(UP);
	overlay.handleInput(UP);
	assert.equal(overlay.selectedId, "t:task-1", "the cursor reaches the task header row");

	overlay.handleInput(LEFT);
	const collapsedRender = overlay.render(120).join("\n");
	assert.ok(!collapsedRender.includes("scout"), "collapsing the task hides its agents from the tree");

	overlay.handleInput(RIGHT);
	const expandedRender = overlay.render(120).join("\n");
	assert.ok(expandedRender.includes("scout"), "expanding the task shows its agents again");
	assert.ok(expandedRender.includes("mapper"));

	overlay.handleInput(ESC);
});

// --- escape resolves the done callback ---

await withOverlay({ registry: scrollFixture().registry, detachedJobs: [] }, async (overlay, done) => {
	overlay.handleInput(ESC);
	assert.equal(await done, undefined, "escape resolves the done callback with undefined");
});

// --- the tree pane keeps its "+N more" clip while the detail pane windows ---

{
	const registry = createDispatchRegistry();
	for (let index = 1; index <= 12; index++) {
		const task = registry.startTask({ mode: "single", prompt: `Task: EXT-9-${index} overflow probe`, now: 1_000 });
		registry.startRound(task.id, [{ agent: `agent-${index}` }], 1_000);
	}
	const treeRows = flattenNavigatorTree(buildNavigatorTasks(registry, [], Date.now()), createExpansionState()).length;
	assert.equal(treeRows, 36, "the fixture overflows the body budget from the tree side");
	await withOverlay({ registry, detachedJobs: [] }, async (overlay) => {
		const poll = () => overlay.refresh();
		const firstTask = registry.getTask("task-1");
		registry.updateAgent(firstTask.id, 1, 0, { activity: mapperLog(30) });
		poll();

		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, "t:task-1:r1:a0");

		const tailRender = overlay.render(120).join("\n");
		assert.ok(tailRender.includes("log line 29"), "while following the newest line survives the tree clip");
		assert.ok(tailRender.includes(`… +${treeRows - BODY_ROWS} more`), "tree overflow still renders the +N more clip");
		assert.equal(overlay.render(120).length, BODY_ROWS + 3, "the clip keeps the frame within its budget");

		overlay.handleInput(PAGE_UP);
		registry.updateAgent(firstTask.id, 1, 0, { activity: [...mapperLog(30), activityEntry(30, 2_000)] });
		poll();
		const indicatorRender = overlay.render(120).join("\n");
		assert.ok(indicatorRender.includes(SCROLL_NEW_INDICATOR), "the indicator renders inside the clipped budget when it fires");
		assert.ok(indicatorRender.includes(`… +${treeRows - BODY_ROWS} more`), "the indicator and the tree clip share the body budget");
		assert.ok(!indicatorRender.includes("log line 30"), "the unseen tail stays below the held window");
		assert.equal(overlay.render(120).length, BODY_ROWS + 3, "the frame still fits its budget with the indicator up");
	});
}

// --- a taller resize while held: the window grows over the tail, the marker yields, the hold stays ---

{
	const tui = stubTui();
	const { registry, task } = scrollFixture();
	await withOverlay({ registry, detachedJobs: [] }, async (overlay) => {
		const poll = () => overlay.refresh();
		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, "t:task-1:r1:a1");

		overlay.handleInput(PAGE_UP);
		registry.updateAgent(task.id, 1, 1, { activity: [...mapperLog(30), activityEntry(30)] });
		poll();
		assert.ok(overlay.render(120).join("\n").includes(SCROLL_NEW_INDICATOR), "the marker is up while the tail sits below the window");

		tui.terminal.rows = 60;
		const resizedRender = overlay.render(120).join("\n");
		assert.ok(resizedRender.includes("log line 30"), "the grown window shows the full tail");
		assert.ok(!resizedRender.includes(SCROLL_NEW_INDICATOR), "the marker suppresses once the newest line is visible");
		assert.equal(overlay.scroll.following, false, "the resize does not silently reacquire the follow");
	}, tui);
}

// --- short content: scroll keys are no-ops and the pane renders as before ---

{
	const detached = {
		id: "job-9",
		mode: "single",
		status: "running",
		agentNames: ["observer"],
		taskPreview: "watch the short probe",
		startedAt: 1_000,
	};
	await withOverlay({ registry: createDispatchRegistry(), detachedJobs: [detached] }, async (overlay) => {
		overlay.handleInput(DOWN);
		assert.equal(overlay.selectedId, "t:job-9:a0");
		const before = overlay.render(120).join("\n");
		assert.ok(before.includes("observer"));
		assert.ok(!before.includes(SCROLL_NEW_INDICATOR));
		overlay.handleInput(PAGE_UP);
		overlay.handleInput(PAGE_DOWN);
		overlay.handleInput(HOME);
		overlay.handleInput(END);
		assert.equal(overlay.render(120).join("\n"), before, "short content keeps every scroll key a no-op");
	});
}

// --- footer hints: the longer hints line truncates inside a narrow frame ---

await withOverlay({ registry: createDispatchRegistry(), detachedJobs: [] }, async (overlay) => {
	const FULL_HINTS = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · esc close";
	const lines = overlay.render(30);
	const innerW = 59;
	const hintsLine = lines[lines.length - 2];
	assert.ok(visibleWidth(FULL_HINTS) > innerW, "the hints line actually exceeds the narrow frame");
	assert.ok(hintsLine.startsWith(`│${truncateToWidth(FULL_HINTS, innerW)}`), "the hints line truncates, not overflows");
	assert.ok(!hintsLine.includes(FULL_HINTS));
	assert.equal(visibleWidth(hintsLine), innerW + 2, "the truncated hints line fits between the borders");
});

console.log("agent-viewer-overlay-scroll: all assertions passed");
