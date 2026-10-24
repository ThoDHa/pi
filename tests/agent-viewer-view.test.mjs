#!/usr/bin/env node
/**
 * Headless smoke suite for the navigator view component
 * (extensions/agent-viewer/view.ts). Plain node, no test framework:
 *
 *   node tests/agent-viewer-view.test.mjs
 *
 * Drives the real NavigatorView with a stub TUI (requestRender plus
 * terminal rows/columns), a pass-through theme, and a real
 * KeybindingsManager bound to pi's app.tree.filter action ids, feeding
 * the real escape sequences pi-tui's key matchers bind (pageUp,
 * pageDown, home, end, arrows, \x14 ctrl+t, \x0f ctrl+o). Pins: the
 * frame fills the viewBodyRows budget at full width; the scroll keys
 * move only the detail window while selectedId/selectedIndex stay
 * fixed; the pane shows the newest output by default and re-anchors
 * on selection changes; the indicator appears for output arriving
 * during a hold and clears on end; a held field line keeps the window
 * in place while its value mutates on a poll; the tool-noise filter
 * hides read/grep/find/ls calls by default, ctrl+t and ctrl+o flip it
 * in both directions (through the manager's action ids and through the
 * raw-key fallback when a manager lacks those ids), and the toggle
 * re-anchors the scroll window;
 * thinking entries render dim with a marker prefix; live tasks render
 * their rows above settled ones; tree overflow budgets the window one
 * row short so the newest line and the indicator survive the +N more
 * clip; a taller resize while held suppresses the marker once the
 * tail is actually visible and the following pageDown re-acquires the
 * follow; tree toggling is unchanged; short content
 * keeps the scroll keys as no-ops; escape resolves the done callback;
 * and the hints line truncates instead of overflowing a narrow width.
 */

import assert from "node:assert/strict";
import { importPiTui } from "./provision-pi-tui.mjs";
import { createDispatchRegistry } from "../extensions/subagent/registry.ts";
import { SCROLL_NEW_INDICATOR, viewBodyRows } from "../extensions/agent-viewer/detail-scroll.ts";
import { buildNavigatorTasks, createExpansionState, flattenNavigatorTree } from "../extensions/agent-viewer/navigator.ts";

// view.ts statically imports @earendil-works/pi-tui, so both its import
// and the suite's own specifier bindings must wait for the shim provisioning
// that importPiTui performs.
const { KeybindingsManager, truncateToWidth, visibleWidth } = await importPiTui();
const { NavigatorView } = await import("../extensions/agent-viewer/view.ts");

const ROWS = 24;
const BODY_ROWS = viewBodyRows(ROWS);
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const CTRL_T = "\x14";
const CTRL_O = "\x0f";

const themeStub = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

// Tags every dim span so the thinking styling scenario can pin that a
// thinking line renders dim with its marker, distinct from plain text.
const dimTaggingTheme = {
	fg: (color, text) => (color === "dim" ? `<dim:${text}>` : text),
	bold: (text) => text,
};

const stubTui = () => ({ requestRender() {}, terminal: { rows: ROWS, columns: 120 } });

const keybindings = new KeybindingsManager({
	"app.tree.filter.noTools": { defaultKeys: "ctrl+t" },
	"app.tree.filter.cycleForward": { defaultKeys: "ctrl+o" },
});

const activityEntry = (index, from = 0) => ({
	at: from + index * 100,
	kind: index % 2 === 0 ? "text" : "toolCall",
	text: `log line ${index}`,
});

const mapperLog = (count) => Array.from({ length: count }, (_, index) => activityEntry(index, 2_000));

// Tool-call log with named calls: even indices are noisy reads, odd
// indices are writes that stay visible under the default filter.
const namedLog = (count) =>
	Array.from({ length: count }, (_, index) => ({
		at: 2_000 + index * 100,
		kind: "toolCall",
		name: index % 2 === 0 ? "read" : "write",
		text: index % 2 === 0 ? `read batch ${index}` : `write batch ${index}`,
	}));

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

async function withView(sources, run, tui = stubTui(), theme = themeStub) {
	let resolveDone;
	const done = new Promise((resolve) => (resolveDone = resolve));
	const view = new NavigatorView(tui, theme, keybindings, sources, resolveDone);
	try {
		await run(view, done);
	} finally {
		view.dispose();
	}
}

// --- frame budget, full width, tail anchor, indicator, re-anchor on selection change ---

{
	const { registry, task } = scrollFixture();
	await withView({ registry, detachedJobs: [] }, async (view) => {
		// The 300ms poll never fires inside a synchronous suite: refresh()
		// is the exact method the poll interval calls, so registry updates
		// are picked up by calling it directly.
		const poll = () => view.refresh();
		const SCOUT_ID = "t:task-1:r1:a0";
		const MAPPER_ID = "t:task-1:r1:a1";

		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedIndex, 3);
		assert.equal(view.selectedId, MAPPER_ID);

		const frame = view.render(120);
		assert.equal(frame.length, BODY_ROWS + 2, "the frame fills exactly the body budget plus the header and hints lines");
		for (const line of frame) {
			assert.ok(visibleWidth(line) <= 120, "every rendered line fits the full width");
		}
		const tailRender = frame.join("\n");
		assert.ok(tailRender.includes("log line 29"), "the default view shows the newest output");
		assert.ok(!tailRender.includes("log line 0"), "the default view clips the oldest output");

		view.handleInput(PAGE_UP);
		assert.equal(view.selectedId, MAPPER_ID, "pageUp leaves the selection fixed");
		assert.equal(view.selectedIndex, 3);
		const heldRender = view.render(120).join("\n");
		assert.ok(heldRender.includes("log line 0"), "pageUp reveals the oldest output");
		assert.ok(!heldRender.includes("log line 29"), "pageUp moves the newest output out of the window");
		assert.ok(!heldRender.includes(SCROLL_NEW_INDICATOR), "no indicator before new content arrives");

		view.handleInput(PAGE_DOWN);
		const returnedRender = view.render(120).join("\n");
		assert.ok(returnedRender.includes("log line 29"), "pageDown returns to the tail");
		assert.ok(!returnedRender.includes("log line 0"));

		view.handleInput(PAGE_UP);
		registry.updateAgent(task.id, 1, 1, { activity: [...mapperLog(30), activityEntry(30)] });
		poll();
		const indicatorRender = view.render(120).join("\n");
		assert.ok(indicatorRender.includes(SCROLL_NEW_INDICATOR), "output arriving during a hold shows the indicator");
		assert.ok(indicatorRender.includes("log line 0"), "the held window does not yank on new output");
		assert.ok(!indicatorRender.includes("log line 30"), "the unseen tail stays below the window");

		view.handleInput(DOWN);
		assert.equal(view.selectedId, MAPPER_ID, "down at the last row cannot move the selection");
		view.handleInput(UP);
		assert.equal(view.selectedId, SCOUT_ID, "up moves the tree cursor");
		const scoutRender = view.render(120).join("\n");
		assert.ok(scoutRender.includes("scout note 1"));
		assert.ok(!scoutRender.includes(SCROLL_NEW_INDICATOR), "a selection change re-anchors and clears the indicator");
		view.handleInput(DOWN);
		assert.equal(view.selectedId, MAPPER_ID);
		const reanchoredRender = view.render(120).join("\n");
		assert.ok(reanchoredRender.includes("log line 30"), "returning to the agent re-anchors on its newest output");
		assert.ok(!reanchoredRender.includes("log line 0"), "the re-anchored window clips the oldest output");
		assert.ok(!reanchoredRender.includes(SCROLL_NEW_INDICATOR));

		view.handleInput(HOME);
		const homeRender = view.render(120).join("\n");
		assert.ok(homeRender.includes("log line 0"), "home jumps to the first detail line");
		assert.ok(!homeRender.includes(SCROLL_NEW_INDICATOR), "home with an unchanged tail shows no indicator");

		view.handleInput(END);
		const endRender = view.render(120).join("\n");
		assert.ok(endRender.includes("log line 30"), "end returns to the tail");
		assert.ok(!endRender.includes("log line 0"));
		assert.ok(!endRender.includes(SCROLL_NEW_INDICATOR), "end clears the indicator");
	});
}

// --- the tool-noise filter: hidden by default, ctrl+t and ctrl+o flip it, the toggle re-anchors ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-2 filter probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "sweeper" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: namedLog(60) });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

		const defaultRender = view.render(120).join("\n");
		assert.ok(!defaultRender.includes("read batch"), "noisy read calls hide under the default filter");
		assert.ok(defaultRender.includes("write batch 59"), "write calls stay visible and the filtered pane follows the newest output");
		assert.ok(defaultRender.includes("tools hidden"), "the header names the default filter state");

		view.handleInput(PAGE_UP);
		const heldRender = view.render(120).join("\n");
		assert.equal(view.scroll.following, false, "pageUp holds the window");
		assert.ok(!heldRender.includes("write batch 59"), "the held window clips the tail");

		view.handleInput(CTRL_T);
		assert.equal(view.scroll.following, true, "the toggle re-anchors the window on the tail");
		assert.equal(view.selectedId, "t:task-1:r1:a0", "the toggle leaves the selection fixed");
		const shownRender = view.render(120).join("\n");
		assert.ok(shownRender.includes("read batch 58"), "ctrl+t reveals the noisy read calls");
		assert.ok(shownRender.includes("write batch 59"), "the re-anchored window follows the newest output again");
		assert.ok(shownRender.includes("tools shown"), "the header names the shown state");

		view.handleInput(CTRL_T);
		const rehiddenRender = view.render(120).join("\n");
		assert.ok(!rehiddenRender.includes("read batch"), "a second ctrl+t hides the noise again");

		view.handleInput(CTRL_O);
		assert.ok(view.render(120).join("\n").includes("read batch 58"), "ctrl+o flips the filter on like ctrl+t");
		view.handleInput(CTRL_O);
		assert.ok(!view.render(120).join("\n").includes("read batch"), "a second ctrl+o hides the noise again");
	});
}

// --- the toggle falls back to the raw keys when the manager lacks the app.tree.filter ids ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-5 fallback probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "reader" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: namedLog(4) });
	const bareKeybindings = new KeybindingsManager({});
	const view = new NavigatorView(stubTui(), themeStub, bareKeybindings, { registry, detachedJobs: [] }, () => {});
	try {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");
		assert.ok(!view.render(120).join("\n").includes("read batch"), "the default filter hides noise regardless of the manager's bindings");
		view.handleInput(CTRL_T);
		assert.ok(view.render(120).join("\n").includes("read batch"), "ctrl+t toggles through the raw-key fallback");
		view.handleInput(CTRL_O);
		assert.ok(!view.render(120).join("\n").includes("read batch"), "ctrl+o toggles through the raw-key fallback");
	} finally {
		view.dispose();
	}
}

// --- thinking entries render dim with a marker prefix, in both filter states ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-3 thinking probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "dreamer" }], 1_000);
	registry.updateAgent(task.id, 1, 0, {
		activity: [
			{ at: 1_100, kind: "text", text: "plain note" },
			{ at: 1_200, kind: "toolCall", name: "read", text: "read a.ts" },
			{ at: 1_300, kind: "toolCall", name: "write", text: "write b.ts" },
			{ at: 1_400, kind: "thinking", text: "weighing options" },
		],
	});
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

		const defaultRender = view.render(120).join("\n");
		assert.ok(defaultRender.includes("<dim:… weighing options>"), "a thinking entry renders dim behind the marker");
		assert.ok(defaultRender.includes("<dim:plain note>"), "a text entry renders dim without the marker");
		assert.ok(!defaultRender.includes("<dim:… plain note"), "the marker belongs to thinking lines alone");

		view.handleInput(CTRL_T);
		const shownRender = view.render(120).join("\n");
		assert.ok(shownRender.includes("<dim:… weighing options>"), "thinking keeps its styling with tool noise shown");
		assert.ok(shownRender.includes("read a.ts"), "the toggled state reveals the read call");
	}, stubTui(), dimTaggingTheme);
}

// --- live tasks render their rows above settled ones ---

{
	const registry = createDispatchRegistry();
	const settledTask = registry.startTask({ mode: "single", prompt: "Task: EXT-9-1 settled probe", now: 1_000 });
	registry.startRound(settledTask.id, [{ agent: "early" }], 1_000);
	registry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const liveDetached = {
		id: "job-live",
		mode: "single",
		status: "running",
		agentNames: ["busy"],
		taskPreview: "live detached probe",
		startedAt: 4_000,
	};
	await withView({ registry, detachedJobs: [liveDetached] }, async (view) => {
		const rendered = view.render(120).join("\n");
		assert.ok(
			rendered.indexOf("live detached probe") !== -1 && rendered.indexOf("live detached probe") < rendered.indexOf("EXT-9-1"),
			"the live task's rows render above the settled task's rows",
		);
	});
}

// --- a held field line survives its value mutating on the next poll (no teleport to the pane head) ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-4 field hold probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }, { agent: "mapper" }], 1_000);
	const usage = (contextTokens) => ({ turns: 3, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.012, contextTokens });
	registry.updateAgent(task.id, 1, 1, {
		model: "probe-model-9",
		cwd: "/probe/cwd-9",
		usage: usage(900),
		activity: mapperLog(28),
	});
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		const MAPPER_ID = "t:task-1:r1:a1";

		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, MAPPER_ID);

		const tailRender = view.render(120).join("\n");
		assert.ok(tailRender.includes("ctx:900"), "the fixture wires the usage summary into the pane");

		view.handleInput(PAGE_UP);
		const heldRender = view.render(120).join("\n");
		assert.equal(view.scroll.following, false, "pageUp holds the window");
		assert.ok(heldRender.includes("tokens: 900"), "one pageUp puts the fields, including tokens, inside the held window");
		assert.ok(!heldRender.includes("log line 27"), "the held window clips the newest activity");

		registry.updateAgent(task.id, 1, 1, { usage: usage(9_800) });
		poll();
		const mutatedRender = view.render(120).join("\n");
		assert.ok(mutatedRender.includes("tokens: 9.8k"), "the mutated field value stays inside the held window");
		assert.ok(!mutatedRender.includes("tokens: 900"), "the stale value leaves the window with the poll");
		assert.ok(!mutatedRender.includes("log line 27"), "the window stays held, not pulled to the tail by the rebuild");
		assert.ok(!mutatedRender.includes("mapper running"), "the window top stays on the held field, not pulled to the pane head");
	});
}

// --- the existing keys keep working: cursor movement and tree toggling ---

await withView({ registry: scrollFixture().registry, detachedJobs: [] }, async (view) => {
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	view.handleInput(UP);
	view.handleInput(UP);
	view.handleInput(UP);
	assert.equal(view.selectedId, "t:task-1", "the cursor reaches the task header row");

	view.handleInput(LEFT);
	const collapsedRender = view.render(120).join("\n");
	assert.ok(!collapsedRender.includes("scout"), "collapsing the task hides its agents from the tree");

	view.handleInput(RIGHT);
	const expandedRender = view.render(120).join("\n");
	assert.ok(expandedRender.includes("scout"), "expanding the task shows its agents again");
	assert.ok(expandedRender.includes("mapper"));
});

// --- escape resolves the done callback ---

await withView({ registry: scrollFixture().registry, detachedJobs: [] }, async (view, done) => {
	view.handleInput(ESC);
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
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		const firstTask = registry.getTask("task-1");
		registry.updateAgent(firstTask.id, 1, 0, { activity: mapperLog(30) });
		poll();

		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

		const tailRender = view.render(120).join("\n");
		assert.ok(tailRender.includes("log line 29"), "while following the newest line survives the tree clip");
		assert.ok(tailRender.includes(`… +${treeRows - BODY_ROWS} more`), "tree overflow still renders the +N more clip");
		assert.equal(view.render(120).length, BODY_ROWS + 2, "the clip keeps the frame within its budget");

		view.handleInput(PAGE_UP);
		registry.updateAgent(firstTask.id, 1, 0, { activity: [...mapperLog(30), activityEntry(30, 2_000)] });
		poll();
		const indicatorRender = view.render(120).join("\n");
		assert.ok(indicatorRender.includes(SCROLL_NEW_INDICATOR), "the indicator renders inside the clipped budget when it fires");
		assert.ok(indicatorRender.includes(`… +${treeRows - BODY_ROWS} more`), "the indicator and the tree clip share the body budget");
		assert.ok(!indicatorRender.includes("log line 30"), "the unseen tail stays below the held window");
		assert.equal(view.render(120).length, BODY_ROWS + 2, "the frame still fits its budget with the indicator up");
	});
}

// --- a taller resize while held: the window grows over the tail, the marker yields, the hold stays ---

{
	const tui = stubTui();
	const { registry, task } = scrollFixture();
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a1");

		view.handleInput(PAGE_UP);
		registry.updateAgent(task.id, 1, 1, { activity: [...mapperLog(30), activityEntry(30)] });
		poll();
		assert.ok(view.render(120).join("\n").includes(SCROLL_NEW_INDICATOR), "the marker is up while the tail sits below the window");

		tui.terminal.rows = 60;
		const resizedRender = view.render(120).join("\n");
		assert.ok(resizedRender.includes("log line 30"), "the grown window shows the full tail");
		assert.ok(!resizedRender.includes(SCROLL_NEW_INDICATOR), "the marker suppresses once the newest line is visible");
		assert.equal(view.scroll.following, false, "the resize does not silently reacquire the follow");

		view.handleInput(PAGE_DOWN);
		assert.equal(view.scroll.following, true, "pageDown at the clamped tail reacquires the follow by intent");
		assert.equal(view.scroll.heldTopKey, null, "the reacquire clears the hold");
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
	await withView({ registry: createDispatchRegistry(), detachedJobs: [detached] }, async (view) => {
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:job-9:a0");
		const before = view.render(120).join("\n");
		assert.ok(before.includes("observer"));
		assert.ok(!before.includes(SCROLL_NEW_INDICATOR));
		view.handleInput(PAGE_UP);
		view.handleInput(PAGE_DOWN);
		view.handleInput(HOME);
		view.handleInput(END);
		assert.equal(view.render(120).join("\n"), before, "short content keeps every scroll key a no-op");
	});
}

// --- hints line: the longer hints line truncates inside a narrow width ---

await withView({ registry: createDispatchRegistry(), detachedJobs: [] }, async (view) => {
	const HINTS = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · ctrl+t tools · esc close";
	const lines = view.render(30);
	assert.ok(visibleWidth(HINTS) > 30, "the hints line actually exceeds the narrow width");
	assert.equal(lines[lines.length - 1], truncateToWidth(HINTS, 30), "the hints line truncates, not overflows");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 30, "every line fits the narrow width");
	}
});

console.log("agent-viewer-view: all assertions passed");
