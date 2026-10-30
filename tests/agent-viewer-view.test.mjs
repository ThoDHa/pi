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
 * entry's open key drives ctx.ui.custom with the top-anchored
 * full-width overlay options and the double-open guard; the entry
 * wires the navigator's sessionFile source to
 * ctx.sessionManager.getSessionFile(), so t on a seeded finished agent
 * reads the transcript through the real shortcut handler; the frame
 * fills the full terminal height (the viewBodyRows body budget plus
 * the view's own header and hints lines) and stays fixed across short
 * content and agent switches; the scroll keys
 * move only the detail window while selectedId/selectedIndex stay
 * fixed; the pane shows the newest output by default and re-anchors
 * on selection changes; the indicator appears for output arriving
 * during a hold and clears on end; a held field line keeps the window
 * in place while its value mutates on a poll; the tool-noise filter
 * hides read/grep/find/ls calls by default, ctrl+t and ctrl+o flip it
 * in both directions (through the manager's action ids and through the
 * raw-key fallback when a manager lacks those ids), and the toggle
 * re-anchors the scroll window;
 * thinking entries render dim with a marker prefix; the full-text
 * thinking section renders below the activity log in thinkingText
 * italic with a live label; the t keybinding on a finished agent
 * streams that agent's full, uncapped thinking from the current
 * session transcript through the injected sessionFile source and
 * reader (latest matching subagent toolResult wins), rendering a
 * `reading transcript…` loading note between press and resolution,
 * toggles back off, aborts the in-flight read on re-press, on cursor
 * moves, and on dispose without ever landing an abandoned read, lands
 * a failed read on the unavailable note, survives polls, and is
 * cleared by moving the cursor, while a running agent ignores t and a
 * missing or unreadable transcript renders a note instead of
 * throwing; a transcript lookup miss keeps the live thinking section
 * beneath a record-absence note when the agent's live buffer holds
 * thinking (the finished detached case) and renders the plain note
 * when it does not, never rendering another agent's record; a
 * matching record holding no thinking renders the found-but-empty
 * note instead of denying the record, with the same live-buffer
 * retention; live tasks render
 * their rows above the Completed umbrella row holding settled ones; tree overflow budgets the window one
 * row short so the newest line and the indicator survive the +N more
 * clip; a taller resize while held suppresses the marker once the
 * tail is actually visible and the following pageDown re-acquires the
 * follow; a shrink resize keeps the frame at exactly the shrunk
 * terminal's height while following and while held; the wheel (stub
 * pi-tui TuiMouseEvent wheel events) claims every wheel with
 * { handled: true } and scrolls the detail pane by the signed
 * accelerated wheelDelta, clamped to the per-event ceiling, fractional
 * deltas truncing to whole lines and non-finite ones moving nothing,
 * wheel up
 * releasing the follow and arming the indicator for output arriving
 * during the hold, wheel down reacquiring the follow at the bottom,
 * short content staying a no-op, presses and clicks passing through
 * unclaimed, and the selection never moving; tree toggling is
 * unchanged; short content
 * keeps the scroll keys as no-ops; escape resolves the done callback;
 * a press of the open key closes the view with the same resolution
 * from the default and transcript-loading states, including while the
 * real streamed transcript read is mid-flight, where the close's
 * dispose aborts the read and the aborted read never lands; a remapped
 * navigatorKey registers, opens, and closes under the configured key
 * while the default key does not close the remapped view; and the
 * hints line truncates instead of overflowing a narrow width.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPiTui } from "./provision-pi-tui.mjs";
import { createDispatchRegistry, getSharedDispatchState } from "../extensions/subagent/registry.ts";
import { SCROLL_NEW_INDICATOR, viewBodyRows } from "../extensions/agent-viewer/detail-scroll.ts";
import { buildNavigatorTasks, createExpansionState, flattenNavigatorTree, resolveDetailModel } from "../extensions/agent-viewer/navigator.ts";

// view.ts statically imports @earendil-works/pi-tui, so both its import
// and the suite's own specifier bindings must wait for the shim provisioning
// that importPiTui performs.
const { KeybindingsManager, CURSOR_MARKER, sliceByColumn, truncateToWidth, visibleWidth } = await importPiTui();
const { NavigatorView, WHEEL_MAX_DELTA_LINES } = await import("../extensions/agent-viewer/view.ts");

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
const ALT_N = "\x1bn";
const ALT_V = "\x1bv";
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

// Tags thinking styling so the thinking-section scenario can pin the
// thinkingText italic rendering, distinct from plain text and from the
// dim activity one-liners.
const thinkingTheme = {
	fg: (color, text) => (color === "thinkingText" ? `<think:${text}>` : color === "muted" ? `<muted:${text}>` : text),
	italic: (text) => `<i:${text}>`,
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

// Stub pi-tui TuiMouseEvent for the wheel: the shape the fullscreen
// overlay dispatch hands a component (signed accelerated wheelDelta
// in lines, negative up), overridable for press/click/move variants.
const wheelEvent = (wheelDelta, overrides = {}) => ({
	type: "wheel",
	button: "none",
	x: 40,
	y: 5,
	screenX: 40,
	screenY: 5,
	width: 120,
	height: ROWS,
	shift: false,
	alt: false,
	ctrl: false,
	wheelDelta,
	...overrides,
});

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
	const view = new NavigatorView(tui, theme, keybindings, { navigatorKey: "alt+n", ...sources }, resolveDone);
	try {
		await run(view, done);
	} finally {
		view.dispose();
	}
}

// Settles to done's value when the view closes within the window and
// to a unique sentinel when it does not, so a red or regressed close
// pin fails as a clean assertion instead of hanging the suite on an
// unsettled done.
const CLOSE_NOT_REACHED = Symbol("close-not-reached");
const closeOrTimeout = (done) =>
	Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(CLOSE_NOT_REACHED), 25))]);

// Yields one event-loop turn: after an injected reader resolves or
// rejects, the view's landing callback has run once this resolves.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Attempt budgets for the real-transcript wait helpers below; comments
// cite these identifiers rather than restating the numerals, so a
// recalibration cannot leave a stale citation behind.
const WAIT_FRAME_ATTEMPTS = 1_200;
const WAIT_OPEN_DESCRIPTOR_ATTEMPTS = 200;
const WAIT_CLOSED_DESCRIPTOR_ATTEMPTS = 50;

// Waits for the default streamed reader to land within
// WAIT_FRAME_ATTEMPTS polls, a budget sized to outlast the sized
// fixtures' real .jsonl reads even under sustained suite IO (their
// measured read pace lives in the realFillerLine sizing note below).
async function waitForFrame(view, probe) {
	for (let attempt = 0; attempt < WAIT_FRAME_ATTEMPTS; attempt++) {
		if (probe(view.render(120).join("\n"))) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.ok(probe(view.render(120).join("\n")), "the streamed transcript read did not land within the wait budget");
}

// Counts this process's open file descriptors resolving inside `dir`
// via /proc/self/fd. This is the only observable of the default
// reader's close-on-abort path: the view drops an aborted read's
// landing by its abort-handle guard either way, so a reader that
// ignores the signal differs in no rendered frame, only in the fd it
// keeps reading through to EOF.
function openTranscriptDescriptors(dir) {
	return readdirSync("/proc/self/fd").filter((fd) => {
		try {
			return readlinkSync(join("/proc/self/fd", fd)).startsWith(dir);
		} catch {
			return false;
		}
	}).length;
}

// Waits until the streamed read's descriptor is open, proving the read
// is genuinely in flight, on a bounded budget the open clears within a
// few poll ticks, far inside waitForFrame's WAIT_FRAME_ATTEMPTS budget.
async function waitForOpenDescriptor(dir) {
	for (let attempt = 0; attempt < WAIT_OPEN_DESCRIPTOR_ATTEMPTS; attempt++) {
		if (openTranscriptDescriptors(dir) > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.ok(openTranscriptDescriptors(dir) > 0, "the streamed transcript read never opened the session file");
}

// Waits until the aborted read's descriptor is closed on a budget no
// riding fixture's full read can reach EOF within (the smallest real
// transcript file, ~39 MB, reads in ~170-430 ms here, >3x the
// WAIT_CLOSED_DESCRIPTOR_ATTEMPTS budget), so a reader that ignores
// the abort fails here instead of leaking the fd to EOF.
async function waitForClosedDescriptor(dir) {
	for (let attempt = 0; attempt < WAIT_CLOSED_DESCRIPTOR_ATTEMPTS; attempt++) {
		if (openTranscriptDescriptors(dir) === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.ok(openTranscriptDescriptors(dir) === 0, "the aborted transcript read left the session file open");
}

const realScoutResult = (thinking) => ({
	agent: "scout",
	agentSource: "user",
	task: "probe",
	exitCode: 0,
	messages: thinking.map(([timestamp, text]) => ({ role: "assistant", timestamp, content: [{ type: "thinking", thinking: text }] })),
	stderr: "",
	stopReason: "end",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
});
const realToolResult = (results) =>
	JSON.stringify({
		type: "message",
		message: { role: "toolResult", toolName: "subagent", toolCallId: "call_1", content: [], details: { mode: "single", results } },
	});
// Sizes a real transcript file past every timing budget riding its
// read: each filler line is 64 KB of text without the subagent
// substring, so the scan stays cheap while the read takes real time
// (600 fillers ≈ ~39 MB, ~170-430 ms here; 1_000 ≈ ~65 MB, ~460-600 ms).
// If a margin thins on a faster or loaded machine, raise fillerCount,
// keeping each fixture's full read past the budget it must outlast.
const realFillerLine = JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 9_500, content: [{ type: "text", text: "f".repeat(65_536) }] } });
const writeRealTranscriptFile = (dir, ownThinking, fillerCount) => {
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(
		sessionFile,
		[JSON.stringify({ type: "session", version: 3, id: "s1" }), realToolResult([realScoutResult(ownThinking)]), ...Array.from({ length: fillerCount }, () => realFillerLine)].join("\n"),
	);
	return sessionFile;
};

// --- hosting: the entry's open key drives ctx.ui.custom as a top-anchored full-width overlay ---

{
	const shortcuts = {};
	let sessionStart = null;
	const piStub = {
		getSettings: () => ({}),
		registerShortcut: (key, binding) => {
			shortcuts[key] = binding;
		},
		on: (event, handler) => {
			if (event === "session_start") sessionStart = handler;
		},
	};
	const { default: extensionMain } = await import("../extensions/agent-viewer/index.ts");
	await extensionMain(piStub);
	await sessionStart();
	assert.equal(shortcuts["alt+n"].description, "Toggle the subagent navigator view");

	// Seed the shared registry and a session transcript before the open
	// handler runs: the view snapshots the shared state at construction,
	// and the t drive below pins that the entry feeds
	// ctx.sessionManager.getSessionFile() into the view's sources.
	const wireDir = mkdtempSync(join(tmpdir(), "pi-navigator-wire-"));
	const wireSessionFile = join(wireDir, "session.jsonl");
	writeFileSync(
		wireSessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call_1",
					content: [],
					details: {
						mode: "single",
						results: [
							{
								agent: "scout",
								agentSource: "user",
								task: "probe",
								exitCode: 0,
								messages: [{ role: "assistant", timestamp: 5_000, content: [{ type: "thinking", thinking: "wired transcript thought" }] }],
								stderr: "",
								stopReason: "end",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
							},
						],
					},
				},
			}),
		].join("\n"),
	);
	const sharedState = getSharedDispatchState();
	const wireTask = sharedState.registry.startTask({ mode: "single", prompt: "Task: entry wire probe", now: 1_000 });
	sharedState.registry.startRound(wireTask.id, [{ agent: "scout" }], 1_000);
	sharedState.registry.updateAgent(wireTask.id, 1, 0, { status: "done", finishedAt: 9_000 });

	let capturedOptions = null;
	let capturedFactory = null;
	let resolveCustom;
	const ctx = {
		sessionManager: { getSessionFile: () => wireSessionFile },
		ui: {
			custom: (factory, options) => {
				capturedFactory = factory;
				capturedOptions = options;
				return new Promise((resolve) => {
					resolveCustom = resolve;
				});
			},
			setWidget() {},
		},
	};
	const opening = shortcuts["alt+n"].handler(ctx);
	assert.ok(capturedOptions, "the open handler calls ctx.ui.custom");
	assert.deepEqual(
		capturedOptions,
		{ overlay: true, overlayOptions: { anchor: "top-center", width: "100%", maxHeight: "100%" } },
		"the view hosts as a top-anchored full-width overlay clamped to the full terminal height",
	);

	await shortcuts["alt+n"].handler({
		ui: {
			custom: () => {
				throw new Error("a second open while the view shows must not reach ctx.ui.custom");
			},
			setWidget() {},
		},
	});

	const view = capturedFactory(stubTui(), themeStub, keybindings, () => {});
	assert.ok(view instanceof NavigatorView, "the custom factory builds the navigator view");
	view.handleInput(RIGHT);
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	view.handleInput(RIGHT);
	view.handleInput(DOWN);
	assert.ok(view.selectedId.endsWith(":a0"), "the seeded finished agent row is selectable in the entry-built view");
	view.handleInput("t");
	await waitForFrame(view, (frame) => frame.includes("wired transcript thought"));
	assert.ok(
		view.render(120).join("\n").includes("wired transcript thought"),
		"t streams the transcript through the sessionFile source the entry wires from ctx.sessionManager.getSessionFile()",
	);
	view.dispose();
	resolveCustom(undefined);
	await opening;
	rmSync(wireDir, { recursive: true, force: true });
}

// --- a remapped navigatorKey registers, opens, and closes under the configured key ---

{
	const shortcuts = {};
	let sessionStart = null;
	const piStub = {
		getSettings: () => ({ subagentViewer: { navigatorKey: "alt+v" } }),
		registerShortcut: (key, binding) => {
			shortcuts[key] = binding;
		},
		on: (event, handler) => {
			if (event === "session_start") sessionStart = handler;
		},
	};
	const { default: extensionMain } = await import("../extensions/agent-viewer/index.ts");
	await extensionMain(piStub);
	await sessionStart();
	assert.ok(shortcuts["alt+v"], "the remapped navigator key registers as the open shortcut");
	assert.equal(shortcuts["alt+n"], undefined, "the default alt+n does not register once the key is remapped");

	let capturedFactory = null;
	let resolveCustom;
	const ctx = {
		sessionManager: { getSessionFile: () => undefined },
		ui: {
			custom: (factory) => {
				capturedFactory = factory;
				return new Promise((resolve) => {
					resolveCustom = resolve;
				});
			},
			setWidget() {},
		},
	};
	const opening = shortcuts["alt+v"].handler(ctx);
	assert.ok(capturedFactory, "the remapped key's handler hosts the view through ctx.ui.custom");

	let resolveDone;
	const done = new Promise((resolve) => (resolveDone = resolve));
	const view = capturedFactory(stubTui(), themeStub, keybindings, resolveDone);
	view.handleInput(ALT_N);
	assert.equal(await closeOrTimeout(done), CLOSE_NOT_REACHED, "the default alt+n does not close a view the remapped alt+v opened");
	view.handleInput(ALT_V);
	assert.equal(await closeOrTimeout(done), undefined, "the configured alt+v closes the view with the escape-equivalent resolution (done(undefined))");
	view.dispose();
	resolveCustom(undefined);
	await opening;
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
		assert.equal(frame.length, ROWS, "the frame is the full terminal height: the overlay hosts the view full screen");
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

// --- the frame is full height for short content and stays fixed across agent switches ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-9-2 frame probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }, { agent: "mapper" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: [{ at: 1_100, kind: "text", text: "scout note 0" }] });
	registry.updateAgent(task.id, 1, 1, { activity: mapperLog(30) });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

		const scoutFrame = view.render(120);
		assert.equal(scoutFrame.length, ROWS, "a short agent's frame still fills the terminal");
		assert.equal(scoutFrame[scoutFrame.length - 2], "", "the body's last row is padding while the detail content is short");

		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a1");
		const mapperFrame = view.render(120);
		assert.equal(mapperFrame.length, ROWS, "switching to a taller agent keeps the frame height fixed");
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
	const view = new NavigatorView(stubTui(), themeStub, bareKeybindings, { registry, detachedJobs: [], navigatorKey: "alt+n" }, () => {});
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
		const liveIndex = rendered.indexOf("live detached probe");
		const umbrellaIndex = rendered.indexOf("Completed");
		assert.ok(
			liveIndex !== -1 && umbrellaIndex !== -1 && liveIndex < umbrellaIndex,
			"the live task's rows render above the Completed umbrella row",
		);
		assert.ok(!rendered.includes("EXT-9-1"), "the settled task renders no rows outside the umbrella");
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
		// 36 lines put one pageUp's landing (scrollTop = lines - 35 at the
		// 22-row body budget) on the field block, below the pane header,
		// which is the scenario this block pins.
		activity: mapperLog(36),
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

// --- a press of the open key closes the view like escape (the toggle) ---

// While the overlay shows it holds keyboard focus, so the open key
// reaches the view's own input loop, matched by nothing before the
// toggle: the view itself closes on its configured key with the same
// resolution escape produces.
await withView({ registry: scrollFixture().registry, detachedJobs: [] }, async (view, done) => {
	view.handleInput(ALT_N);
	assert.equal(await closeOrTimeout(done), undefined, "a press of the open key closes the view with the escape-equivalent resolution (done(undefined))");
});

// The close is state-blind like escape: it fires while a transcript
// read is in flight (the close's dispose path aborts the read), held
// here by a never-settling injected reader so the loading state is
// deterministic and no file is ever opened.
{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-13-1 toggle probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000 });
	await withView(
		{
			registry,
			detachedJobs: [],
			sessionFile: () => join(tmpdir(), "pi-navigator-toggle", "session.jsonl"),
			readTranscriptLines: () => new Promise(() => {}),
		},
		async (view, done) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput("t");
			assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the fixture holds the transcript-loading state with the read in flight");
			view.handleInput(ALT_N);
			assert.equal(await closeOrTimeout(done), undefined, "the open key closes the view from the transcript-loading state with the escape-equivalent resolution (done(undefined))");
		},
	);
}

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

// --- a shrink resize: the frame tracks the terminal down while following and while held ---

{
	const tui = stubTui();
	const { registry } = scrollFixture();
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a1", "the block selects the long-activity agent as its premise");

		tui.terminal.rows = 60;
		poll();
		assert.equal(view.render(120).length, 60, "the frame fills the taller terminal before the shrink");

		tui.terminal.rows = 12;
		poll();
		assert.equal(view.render(120).length, 12, "the frame tracks a shrink resize exactly while following");

		view.handleInput(PAGE_UP);
		poll();
		assert.equal(view.scroll.following, false, "the block's pageUp holds the window as its premise");
		assert.equal(view.render(120).length, 12, "the frame tracks a shrink resize exactly while held");
	}, tui);
}

// --- wheel: the signed wheelDelta scrolls the detail pane like the keyboard path, every wheel is claimed, the selection never moves ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-7-6 wheel probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "mapper" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: mapperLog(120) });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		const MAPPER_ID = "t:task-1:r1:a0";

		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, MAPPER_ID);
		view.render(120);
		const tailTop = view.scroll.scrollTop;
		assert.ok(tailTop > WHEEL_MAX_DELTA_LINES, "the fixture is tall enough to tell the per-event clamp from the content clamp");

		assert.deepEqual(view.handleMouse(wheelEvent(-3)), { handled: true }, "wheel up is claimed with handled");
		assert.equal(view.selectedId, MAPPER_ID, "wheel up leaves the selection fixed");
		assert.equal(view.scroll.scrollTop, tailTop - 3, "wheel up moves the window by the signed delta");
		assert.equal(view.scroll.following, false, "wheel up releases the follow like pageUp");

		registry.updateAgent(task.id, 1, 0, { activity: [...mapperLog(120), activityEntry(120)] });
		poll();
		const indicatorRender = view.render(120).join("\n");
		assert.ok(indicatorRender.includes(SCROLL_NEW_INDICATOR), "output arriving during a wheel hold shows the indicator");
		assert.ok(!indicatorRender.includes("log line 120"), "the unseen tail stays below the held window");

		assert.deepEqual(view.handleMouse(wheelEvent(-200, { alt: true })), { handled: true }, "an accelerated alt wheel is claimed");
		assert.equal(view.scroll.scrollTop, tailTop - 3 - WHEEL_MAX_DELTA_LINES, "a pathological delta clamps to the per-event ceiling");
		assert.equal(view.selectedId, MAPPER_ID, "the clamped wheel leaves the selection fixed");
		assert.ok(view.render(120).join("\n").includes(SCROLL_NEW_INDICATOR), "the clamped wheel keeps the hold and its indicator");

		assert.deepEqual(view.handleMouse(wheelEvent(2.9)), { handled: true }, "a fractional wheel is claimed");
		assert.equal(view.scroll.scrollTop, tailTop - 3 - WHEEL_MAX_DELTA_LINES + 2, "a fractional wheel truncs to whole lines");
		assert.notEqual(view.scroll.heldTopKey, null, "the truncated wheel keeps the hold anchored on a real line");

		const heldTopBefore = view.scroll.heldTopKey;
		assert.deepEqual(view.handleMouse(wheelEvent(NaN)), { handled: true }, "a non-finite wheel is claimed");
		assert.equal(view.scroll.scrollTop, tailTop - 3 - WHEEL_MAX_DELTA_LINES + 2, "a non-finite wheel moves nothing");
		assert.equal(view.scroll.heldTopKey, heldTopBefore, "a non-finite wheel leaves the hold anchor untouched");

		assert.equal(view.handleMouse(wheelEvent(-3, { type: "press", button: "left", wheelDelta: undefined })), undefined, "a press passes through unclaimed");
		assert.equal(view.handleMouse(wheelEvent(0, { type: "click", button: "left", wheelDelta: undefined })), undefined, "a click passes through unclaimed");
		assert.equal(view.handleMouse(wheelEvent(0, { type: "move", wheelDelta: undefined })), undefined, "a move passes through unclaimed");
		assert.equal(view.scroll.following, false, "unclaimed events leave the hold untouched");

		assert.deepEqual(view.handleMouse(wheelEvent(WHEEL_MAX_DELTA_LINES)), { handled: true }, "wheel down is claimed");
		assert.equal(view.scroll.following, false, "wheel down short of the tail keeps the hold");
		assert.deepEqual(view.handleMouse(wheelEvent(WHEEL_MAX_DELTA_LINES)), { handled: true }, "a second wheel down is claimed");
		assert.equal(view.scroll.following, true, "wheel down that reaches the tail reacquires the follow");
		assert.equal(view.scroll.heldTopKey, null, "the reacquire clears the hold");
		assert.ok(!view.render(120).join("\n").includes(SCROLL_NEW_INDICATOR), "the reacquire clears the indicator");
		assert.equal(view.selectedId, MAPPER_ID, "wheel down leaves the selection fixed");
	});
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

// --- wheel on short content: claimed like every wheel, but the pane render is a no-op ---

{
	const detached = {
		id: "job-wheel",
		mode: "single",
		status: "running",
		agentNames: ["observer"],
		taskPreview: "watch the wheel probe",
		startedAt: 1_000,
	};
	await withView({ registry: createDispatchRegistry(), detachedJobs: [detached] }, async (view) => {
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:job-wheel:a0");
		const before = view.render(120).join("\n");
		assert.deepEqual(view.handleMouse(wheelEvent(-3)), { handled: true }, "wheel up on short content is still claimed");
		assert.deepEqual(view.handleMouse(wheelEvent(3)), { handled: true }, "wheel down on short content is still claimed");
		assert.equal(view.scroll.following, true, "short content keeps the follow");
		assert.equal(view.render(120).join("\n"), before, "short content keeps wheel a no-op");
	});
}

// --- live thinking section: full-text blocks below the activity log, thinkingText italic ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-8-1 thinking probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "dreamer" }], 1_000);
	registry.updateAgent(task.id, 1, 0, {
		activity: [
			{ at: 1_100, kind: "text", text: "plain note" },
			{ at: 1_200, kind: "thinking", text: "snippet thought" },
		],
		thinkingLog: [
			{ at: 1_050, text: "first full thought\n\nsecond line of it" },
			{ at: 1_900, text: "revised full thought" },
		],
	});
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

		const frame = view.render(120).join("\n");
		assert.ok(frame.includes("thinking · live"), "the live thinking section carries its label below the activity log");
		assert.ok(frame.indexOf("plain note") !== -1 && frame.indexOf("plain note") < frame.indexOf("thinking · live"), "the section sits below the activity log");
		assert.ok(frame.includes("<i:<think:first full thought>>"), "a full block renders thinkingText italic, not the dim one-liner styling");
		assert.ok(frame.includes("<i:<think:second line of it>>"), "block source lines render as separate pane lines");
		assert.ok(frame.includes("\u200b"), "a blank source line renders a zero-width space so the paragraph break survives pi-tui's empty-text-is-zero-rows rule");
		assert.ok(frame.includes("<i:<think:revised full thought>>"));
		assert.ok(!frame.includes("… first full thought"), "full blocks carry no truncation marker");
		assert.ok(frame.includes("> … snippet thought"), "the activity log's one-liner keeps its own dim one-liner shape");
	}, stubTui(), thinkingTheme);
}

// --- t keybinding: full thinking from the session transcript on a finished agent ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		const entry = (object) => JSON.stringify(object);
		const scoutResult = (thoughts) => ({
			agent: "scout",
			agentSource: "user",
			task: "probe",
			exitCode: 0,
			messages: thoughts.map((text, index) => ({ role: "assistant", timestamp: 5_000 + index, content: [{ type: "thinking", thinking: text }] })),
			stderr: "",
			stopReason: "end",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		});
		const toolResult = (results) =>
			entry({
				type: "message",
				message: { role: "toolResult", toolName: "subagent", toolCallId: "call_1", content: [], details: { mode: "single", results } },
			});
		const blocks = Array.from({ length: 25 }, (_, i) => `block ${i} thought`);
		writeFileSync(
			sessionFile,
			[
				entry({ type: "session", version: 3, id: "s1" }),
				toolResult([scoutResult(["old run thought"])]),
				toolResult([scoutResult(blocks)]),
				'{"type":"message","message":{"role":"toolRes',
			].join("\n"),
		);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-8-2 transcript probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, activity: [{ at: 1_100, kind: "text", text: "live note" }], thinkingLog: [{ at: 1_050, text: "live buffer thought" }] });
		const sources = { registry, detachedJobs: [], sessionFile: () => sessionFile };
	await withView(sources, async (view) => {
		const poll = () => view.refresh();
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");

				view.handleInput("t");
				await waitForFrame(view, (frame) => frame.includes("block 24 thought"));
				const transcriptFrame = view.render(120).join("\n");
				assert.ok(transcriptFrame.includes("block 24 thought"), "t opens the transcript reading view, tail-following its newest block");
				view.handleInput("\x1b[H");
				const transcriptHead = view.render(120).join("\n");
				assert.ok(transcriptHead.includes("full thinking"), "the transcript view carries its label at the pane head");
				assert.ok(transcriptFrame.includes("block 24 thought"), "the transcript view loads thinking beyond the live buffer's caps");
				assert.ok(!transcriptFrame.includes("block 0 thought"), "the latest matching subagent result wins over earlier runs");
				assert.ok(!transcriptFrame.includes("old run thought"), "earlier dispatches of the same agent are discarded");
				assert.ok(!transcriptFrame.includes("live buffer thought"), "the transcript view replaces the live pane body");
				assert.ok(!transcriptFrame.includes("duration:"), "the transcript view replaces the header fields");
				assert.ok(!transcriptFrame.includes("live note"), "the transcript view replaces the activity log");
				view.handleInput("\x1b[F");

				poll();
				assert.ok(view.render(120).join("\n").includes("block 24 thought"), "the transcript view survives polls");

				view.handleInput("t");
				const liveFrame = view.render(120).join("\n");
				assert.ok(liveFrame.includes("duration:"), "a second t returns to the live pane");
				assert.ok(liveFrame.includes("live buffer thought"), "the live thinking section is back");
				assert.ok(!liveFrame.includes("block 24 thought"));

				view.handleInput("t");
				await waitForFrame(view, (frame) => frame.includes("block 24 thought"));
				assert.ok(view.render(120).join("\n").includes("block 24 thought"));
				view.handleInput("\x1b[H");
				assert.ok(view.render(120).join("\n").includes("full thinking"), "t reopens the transcript view");
				view.handleInput("\x1b[F");
				view.handleInput(UP);
				view.handleInput(UP);
				assert.equal(view.selectedId, "t:task-1");
				assert.ok(!view.render(120).join("\n").includes("full thinking"), "moving the cursor clears the transcript view");
				view.handleInput(DOWN);
				assert.ok(view.render(120).join("\n").includes("duration:"), "the live pane is restored after the transcript view clears");
		}, stubTui(), thinkingTheme);

		// A failed agent qualifies as finished for t.
		const chain = registry.startTask({ mode: "chain", prompt: "Task: EXT-8-3 failed probe", now: 20_000 });
		registry.startRound(chain.id, [{ agent: "scout", step: 1 }], 20_000);
		registry.updateAgent(chain.id, 1, 0, { status: "failed", finishedAt: 21_000, result: { exitCode: 1, stopReason: "error" } });
		await withView(sources, async (view) => {
			// Both settled tasks fold under the Completed umbrella: expand it,
			// walk past scout and the task-2 header, then expand r2 to reach
			// the failed agent.
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1");
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-2");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-2:r1");
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-2:r1:a0");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("block 24 thought"));
			view.handleInput("\x1b[H");
			assert.ok(view.render(120).join("\n").includes("full thinking"), "t works on a failed agent");
		}, stubTui(), thinkingTheme);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- t scope: the selected round's run window picks that run's record, not the session-latest one ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-window-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		const scoutResult = (thought, slotTimestamp) => ({
			agent: "scout",
			agentSource: "user",
			task: "probe",
			exitCode: 0,
			messages: [{ role: "assistant", timestamp: slotTimestamp, content: [{ type: "thinking", thinking: thought }] }],
			stderr: "",
			stopReason: "end",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		});
		const windowToolResult = (timestamp, thought, slotTimestamp) =>
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "subagent", toolCallId: "call_1", timestamp, content: [], details: { mode: "single", results: [scoutResult(thought, slotTimestamp)] } },
			});
		writeFileSync(
			sessionFile,
			[JSON.stringify({ type: "session", version: 3, id: "s1" }), windowToolResult(5_000, "run one thought", 2_000), windowToolResult(12_000, "run two thought", 9_000)].join("\n"),
		);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-9-1 window probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 5_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 8_000);
		registry.updateAgent(task.id, 2, 0, { status: "done", finishedAt: 12_000 });

		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			// The settled task folds under the Completed umbrella: expand it
			// and walk to r1's scout.
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1");
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("run one thought"));
			const runOneFrame = view.render(120).join("\n");
			assert.ok(runOneFrame.includes("run one thought"), "t on the older run shows that run's thinking");
			assert.ok(!runOneFrame.includes("run two thought"), "t on the older run never shows the newer run's thinking");

			view.handleInput("t");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r2");
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r2:a0");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("run two thought"));
			const runTwoFrame = view.render(120).join("\n");
			assert.ok(runTwoFrame.includes("run two thought"), "t on the newer run shows the newer run's thinking");
			assert.ok(!runTwoFrame.includes("run one thought"), "t on the newer run never shows the older run's thinking");
		}, stubTui(), thinkingTheme);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- t guard rails: running agents, task rows, and missing transcripts ---

{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-8-4 guard probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "busy" }, { agent: "done kid" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { status: "running", thinkingLog: [{ at: 1_050, text: "running thought" }] });
	registry.updateAgent(task.id, 1, 1, { status: "done", finishedAt: 2_000 });

	// Running agent: t is a no-op.
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");
		const before = view.render(120).join("\n");
		view.handleInput("t");
		assert.equal(view.render(120).join("\n"), before, "t on a running agent is a no-op");
	});

	// Task row: t is a no-op.
	await withView({ registry, detachedJobs: [] }, async (view) => {
		assert.equal(view.selectedId, "t:task-1");
		const before = view.render(120).join("\n");
		view.handleInput("t");
		assert.equal(view.render(120).join("\n"), before, "t on a task row is a no-op");
	});

	// Finished agent without a sessionFile source: a note, not a crash; t toggles back.
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a1");
		view.handleInput("t");
		const noted = view.render(120).join("\n");
		assert.ok(noted.includes("transcript unavailable"), "a missing sessionFile source renders a note");
		view.handleInput("t");
		assert.ok(view.render(120).join("\n").includes("duration:"), "t toggles back off the note");
	});

	// A source yielding undefined and an unreadable path land on the same note.
	await withView({ registry, detachedJobs: [], sessionFile: () => undefined }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput("t");
		assert.ok(view.render(120).join("\n").includes("transcript unavailable"), "an undefined session file renders the note");
	});
	await withView({ registry, detachedJobs: [], sessionFile: () => join(tmpdir(), "pi-navigator-missing", "no.jsonl") }, async (view) => {
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput("t");
		await waitForFrame(view, (frame) => frame.includes("transcript unavailable"));
		assert.ok(view.render(120).join("\n").includes("transcript unavailable"), "an unreadable session file renders the note without throwing");
	});
}

// --- t empty states: lookup miss and thinkingless-record notes, each keeping a live buffer's section ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-empty-"));
	try {
		// A transcript holding a subagent record for a different agent only:
		// t on scout lands in the empty state, the finished-detached case
		// whose note must not claim the thinking is gone. The records for
		// quiet and echo hold no thinking parts: t on them lands in the
		// found-but-empty state, where the note must not deny a record the
		// file demonstrably contains.
		const transcriptLine = (toolCallId, agentName, messages) =>
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "subagent", toolCallId, content: [], details: { mode: "single", results: [{ agent: agentName, agentSource: "user", task: "probe", exitCode: 0, messages, stderr: "", stopReason: "end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 } }] } },
			});
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(
			sessionFile,
			[
				transcriptLine("call_1", "other", [{ role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "other agent thought" }] }]),
				transcriptLine("call_2", "quiet", [{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "quiet words" }] }]),
				transcriptLine("call_3", "echo", [{ role: "assistant", timestamp: 3, content: [{ type: "text", text: "echo words" }] }]),
			].join("\n"),
		);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-8-6 empty-state probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }, { agent: "plain" }, { agent: "quiet" }, { agent: "echo" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_050, text: "detached buffer thought" }] });
		registry.updateAgent(task.id, 1, 1, { status: "done", finishedAt: 9_000 });
		registry.updateAgent(task.id, 1, 2, { status: "done", finishedAt: 9_000 });
		registry.updateAgent(task.id, 1, 3, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_060, text: "echo buffer thought" }] });

		// Lookup miss with a live buffer: the note names the record's absence and the live section stays visible.
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("no transcript record for this agent"));
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("no transcript record for this agent; showing live buffer"), "the empty note names the record's absence and says the live buffer stands in");
			assert.ok(frame.includes("detached buffer thought"), "the live thinking section survives the transcript lookup miss");
			assert.ok(!frame.includes("other agent thought"), "the miss renders no other agent's record");
		}, stubTui(), thinkingTheme);

		// Lookup miss with an empty buffer: the plain absent-record note.
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a1");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("no transcript record for this agent"));
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("no transcript record for this agent"), "the plain empty note names the record's absence");
			assert.ok(!frame.includes("showing live buffer"), "an empty live buffer gets no stand-in note");
			assert.ok(!frame.includes("detached buffer thought"), "another agent's live buffer never leaks into the empty state");
		}, stubTui(), thinkingTheme);

		// A record that exists but holds no thinking: the found-but-empty note
		// names the record's emptiness instead of denying the record exists.
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a2");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("this agent's transcript record holds no thinking"));
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("this agent's transcript record holds no thinking"), "a found thinkingless record gets the found-but-empty note");
			assert.ok(!frame.includes("no transcript record for this agent"), "the found-but-empty note never denies the record's existence");
			assert.ok(!frame.includes("showing live buffer"), "an empty live buffer gets no stand-in note in the found-but-empty state");
			assert.ok(!frame.includes("quiet words") && !frame.includes("other agent thought"), "no record content or other agent's data leaks into the found-but-empty state");
		}, stubTui(), thinkingTheme);

		// Found-but-empty with a live buffer: the stand-in note plus the retained live section.
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a3");
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("this agent's transcript record holds no thinking"));
			// render(200): the stand-in note exceeds the detail pane at 120 and would wrap mid-copy, splitting the pinned substring.
			const frame = view.render(200).join("\n");
			assert.ok(frame.includes("this agent's transcript record holds no thinking; showing live buffer"), "a found thinkingless record with a live buffer gets the stand-in note");
			assert.ok(frame.includes("echo buffer thought"), "the live thinking section survives the found-but-empty state");
			assert.ok(!frame.includes("no transcript record for this agent"), "the found-but-empty note never denies the record's existence");
			assert.ok(!frame.includes("echo words"), "the thinkingless record's content never leaks into the pane");
		}, stubTui(), thinkingTheme);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- t streamed read: the loading state and the abort rules ---

// A deferred injected reader: the press must return before the read
// resolves (no synchronous file I/O on the press path), so the pins
// start the read, drive lines into it, and resolve or reject on
// demand. The session file path is never opened by the injected
// reader; the default streamed reader is pinned end-to-end by the
// real-file scenarios above.
function deferredTranscriptReader() {
	const calls = [];
	let resolveRead;
	let rejectRead;
	const reader = (file, onLine, signal) => {
		calls.push({ file, onLine, signal });
		return new Promise((resolve, reject) => {
			resolveRead = resolve;
			rejectRead = reject;
		});
	};
	return { reader, calls, resolve: () => resolveRead(), reject: (error) => rejectRead(error) };
}

{
	const transcriptLine = (agentName, messages) =>
		JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "call_1",
				content: [],
				details: {
					mode: "single",
					results: [
						{
							agent: agentName,
							agentSource: "user",
							task: "probe",
							exitCode: 0,
							messages,
							stderr: "",
							stopReason: "end",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
						},
					],
				},
			},
		});
	const thinkingRecord = (thought) => [{ role: "assistant", timestamp: 5_000, content: [{ type: "thinking", thinking: thought }] }];
	const wordsRecord = (words) => [{ role: "assistant", timestamp: 5_000, content: [{ type: "text", text: words }] }];

	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "Task: EXT-10-1 stream probe", now: 1_000 });
	registry.startRound(task.id, [{ agent: "scout" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_050, text: "live buffer thought" }] });
	// The injected reader never opens this path; no temp file or cleanup needed.
	const sessionFile = join(tmpdir(), "pi-navigator-stream", "session.jsonl");
	const streamSources = (reader) => ({ registry, detachedJobs: [], navigatorKey: "alt+n", sessionFile: () => sessionFile, readTranscriptLines: reader });
	const selectScout = (view) => {
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");
	};

	// Press path: the handler returns with the read still in flight, the
	// loading note renders and survives polls, and the resolved read
	// lands the loaded view.
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			assert.equal(deferred.calls.length, 1, "the press starts exactly one read");
			assert.equal(deferred.calls[0].file, sessionFile, "the read targets the sessionFile source's path");
			assert.equal(deferred.calls[0].signal.aborted, false, "the read starts with a live abort signal");
			const loadingFrame = view.render(120).join("\n");
			assert.ok(loadingFrame.includes("reading transcript…"), "the press renders the loading note while the read is in flight");
			assert.ok(!loadingFrame.includes("landed thought"), "no transcript content renders before the read resolves");
			view.refresh();
			assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the loading note survives polls");
			deferred.calls[0].onLine(transcriptLine("scout", thinkingRecord("landed thought")));
			deferred.resolve();
			await settle();
			const landedFrame = view.render(120).join("\n");
			assert.ok(landedFrame.includes("landed thought"), "the resolved read lands the loaded transcript view");
			assert.ok(!landedFrame.includes("reading transcript…"), "the loading note clears when the read lands");
		});
	}

	// Re-press mid-read: toggles off, aborts the read, and the abandoned
	// read never lands.
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			view.handleInput("t");
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("duration:"), "a second t mid-read toggles back to the live pane");
			assert.ok(!frame.includes("reading transcript…"), "the loading note clears on the re-press");
			assert.equal(deferred.calls[0].signal.aborted, true, "the re-press aborts the in-flight read");
			deferred.resolve();
			await settle();
			assert.ok(!view.render(120).join("\n").includes("landed thought"), "a read aborted by the re-press never lands");
		});
	}

	// Selection change mid-read: aborts and never lands a stale result
	// for a different row.
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			view.handleInput(UP);
			assert.equal(view.selectedId, "t:task-1:r1");
			assert.equal(deferred.calls[0].signal.aborted, true, "moving the cursor aborts the in-flight read");
			assert.ok(!view.render(120).join("\n").includes("reading transcript…"), "the loading note clears with the cleared selection");
			deferred.calls[0].onLine(transcriptLine("scout", thinkingRecord("landed thought")));
			deferred.resolve();
			await settle();
			const frame = view.render(120).join("\n");
			assert.ok(!frame.includes("landed thought"), "a read aborted by a selection change never lands a stale result");
			assert.ok(!frame.includes("reading transcript…"), "the aborted read's loading note stays gone");
		});
	}

	// Dispose mid-read: aborts; the abandoned read then resolves
	// harmlessly without touching the disposed view.
	{
		const deferred = deferredTranscriptReader();
		const view = new NavigatorView(stubTui(), themeStub, keybindings, streamSources(deferred.reader), () => {});
		selectScout(view);
		view.handleInput("t");
		view.dispose();
		assert.equal(deferred.calls[0].signal.aborted, true, "disposing the view aborts the in-flight read");
		deferred.calls[0].onLine(transcriptLine("scout", thinkingRecord("landed thought")));
		deferred.resolve();
		await settle();
	}

	// A failed read lands on the unavailable note (parity with the
	// synchronous catch it replaces), and t toggles back off it.
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			deferred.reject(new Error("read boom"));
			await settle();
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("session transcript unavailable"), "a failed read renders the unavailable note");
			assert.ok(!frame.includes("reading transcript…"), "the loading note clears when the read fails");
			view.handleInput("t");
			assert.ok(view.render(120).join("\n").includes("duration:"), "t toggles back off the unavailable note");
		});
	}

	// Terminal-state parity through the injected reader: a record with no
	// thinking parts lands on the found-but-empty note; a miss (only
	// another agent's record) lands on the record-absence note.
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			deferred.calls[0].onLine(transcriptLine("scout", wordsRecord("scout finished wordlessly")));
			deferred.resolve();
			await settle();
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("this agent's transcript record holds no thinking"), "a landed thinkingless record gets the found-but-empty note");
			assert.ok(!frame.includes("scout finished wordlessly"), "the thinkingless record's content never leaks into the pane");
		});
	}
	{
		const deferred = deferredTranscriptReader();
		await withView(streamSources(deferred.reader), async (view) => {
			selectScout(view);
			view.handleInput("t");
			deferred.calls[0].onLine(transcriptLine("other", thinkingRecord("other agent thought")));
			deferred.resolve();
			await settle();
			const frame = view.render(120).join("\n");
			assert.ok(frame.includes("no transcript record for this agent"), "a landed miss gets the record-absence note");
			assert.ok(!frame.includes("other agent thought"), "the miss never renders another agent's record");
		});
	}
}

// --- t abort through the default reader: the real stream closes mid-read ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-abort-"));
	try {
		// The 1_000-filler file (~65 MB, ~460-600 ms here) keeps the read
		// well past waitForClosedDescriptor's WAIT_CLOSED_DESCRIPTOR_ATTEMPTS
		// budget: the streamed read must still be in flight when the pin
		// re-presses, and an un-aborted read cannot reach EOF within the
		// budget.
		const blocks = Array.from({ length: 25 }, (_, i) => [5_000 + i, `block ${i} thought`]);
		const sessionFile = writeRealTranscriptFile(dir, blocks, 1_000);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-10-1 abort probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_050, text: "live buffer thought" }] });
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput("t");
			assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the press renders the loading note through the default reader");
			await waitForOpenDescriptor(dir);
			view.handleInput("t");
			const liveFrame = view.render(120).join("\n");
			assert.ok(liveFrame.includes("duration:"), "a second t mid-read toggles back to the live pane through the default reader");
			assert.ok(!liveFrame.includes("reading transcript…"), "the loading note clears on the re-press");
			assert.ok(!liveFrame.includes("block 24 thought"), "no transcript content renders after the re-press");
			await waitForClosedDescriptor(dir);
			for (let attempt = 0; attempt < 25; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 2));
				const lateFrame = view.render(120).join("\n");
				assert.ok(!lateFrame.includes("reading transcript…"), "no second read starts on the re-press");
				assert.ok(!lateFrame.includes("block 24 thought"), "the aborted read never lands late");
			}
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- t through the default reader is capped at the open-time byte length: a record appended mid-read never lands ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-cap-"));
	try {
		// The own record sits at the press-time head of the file: its slot's
		// span (5_000, 5_024) sits inside the run's widened window. The
		// appended sibling ends at 5_030, later than the own end and closer
		// to the row's finishedAt 9_000, so under an uncapped feed it wins
		// under the latest-end rule and under the closest-end rule alike;
		// only a feed capped at the open-time length excludes it. The
		// 600-filler read (~39 MB, ~170-430 ms here) stays past the ~50 ms
		// append point and inside waitForFrame's WAIT_FRAME_ATTEMPTS budget.
		const sessionFile = writeRealTranscriptFile(dir, [[5_000, "own pressed thought"], [5_024, "own pressed second block"]], 600);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-12-1 cap probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_050, text: "live buffer thought" }] });
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			view.handleInput(DOWN);
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, "t:task-1:r1:a0");
			view.handleInput("t");
			assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the press renders the loading note through the default reader");
			await waitForOpenDescriptor(dir);
			// The open event's dispatch can lag the kernel-visible fd by a poll
			// tick, so an immediate append can precede the cap's capture and be
			// included in the open-time size. Settle a bounded 50 ms (a few
			// ticks, still under a third of the ~170-430 ms read) before appending so the
			// append lands mid-read past an already-captured cap.
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the read is still in flight at the append point");
			appendFileSync(sessionFile, `\n${realToolResult([realScoutResult([[5_030, "appended mid-read thought"]])])}`);
			await waitForFrame(view, (frame) => !frame.includes("reading transcript…"));
			const landed = view.render(120).join("\n");
			assert.ok(landed.includes("full thinking"), "the capped read lands on the reading view");
			assert.ok(landed.includes("own pressed thought"), "the capped read lands the press-time record's own slot");
			assert.ok(!landed.includes("appended mid-read thought"), "a same-name record appended mid-read never lands");
			await waitForClosedDescriptor(dir);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- a close via the open key while the default reader is mid-flight: the close's dispose aborts the read and it never lands ---

{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-thinking-close-"));
	try {
		// The own record sits at the file head, before the filler, so its
		// thinking is fed to the scanner before the close aborts the read,
		// making a guard-broken landing observable in the late frames. The
		// 600-filler read (~39 MB, ~170-430 ms here) stays past
		// waitForClosedDescriptor's WAIT_CLOSED_DESCRIPTOR_ATTEMPTS budget
		// (>3x margin): a close whose dispose fails to abort the read cannot
		// reach EOF within it.
		const sessionFile = writeRealTranscriptFile(dir, [[5_000, "close pin thought"], [5_024, "close pin second block"]], 600);

		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "single", prompt: "Task: EXT-14-1 close pin probe", now: 1_000 });
		registry.startRound(task.id, [{ agent: "scout" }], 1_000);
		registry.updateAgent(task.id, 1, 0, { status: "done", finishedAt: 9_000, thinkingLog: [{ at: 1_050, text: "live buffer thought" }] });

		let resolveDone;
		const done = new Promise((resolve) => (resolveDone = resolve));
		// The close mirrors the host's showExtensionCustom close callback
		// (resolve(result); component?.dispose?.()): the view resolves done
		// and the callback then synchronously disposes it, the link the
		// suite cannot instantiate but this pin composes the real mid-flight
		// read into.
		const view = new NavigatorView(
			stubTui(),
			themeStub,
			keybindings,
			{ registry, detachedJobs: [], navigatorKey: "alt+n", sessionFile: () => sessionFile },
			(result) => {
				resolveDone(result);
				view.dispose();
			},
		);
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		view.handleInput(RIGHT);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, "t:task-1:r1:a0");
		view.handleInput("t");
		assert.ok(view.render(120).join("\n").includes("reading transcript…"), "the press renders the loading note through the default reader");
		await waitForOpenDescriptor(dir);
		view.handleInput(ALT_N);
		assert.equal(await closeOrTimeout(done), undefined, "the open key closes the view mid-read with the escape-equivalent resolution (done(undefined))");
		await waitForClosedDescriptor(dir);
		await settle();
		for (let attempt = 0; attempt < 25; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
			const lateFrame = view.render(120).join("\n");
			assert.ok(!lateFrame.includes("close pin thought"), "the read aborted by the close never lands late");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- hints line: the longer hints line truncates inside a narrow width ---

await withView({ registry: createDispatchRegistry(), detachedJobs: [] }, async (view) => {
	const HINTS = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · ctrl+t tools · t thinking · esc close";
	const lines = view.render(30);
	assert.ok(visibleWidth(HINTS) > 30, "the hints line actually exceeds the narrow width");
	assert.equal(lines[lines.length - 1], truncateToWidth(HINTS, 30), "the hints line truncates, not overflows");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 30, "every line fits the narrow width");
	}
});

// >>> EXT-17 V1: the umbrella hides settled rows until expanded, keeps detail and t reachable
{
	const dir = mkdtempSync(join(tmpdir(), "pi-navigator-v1-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", version: 3, id: "s1" }),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolName: "subagent",
						toolCallId: "call_1",
						content: [],
						details: {
							mode: "single",
							results: [
								{
									agent: "early",
									agentSource: "user",
									task: "probe",
									exitCode: 0,
									messages: [{ role: "assistant", timestamp: 1_500, content: [{ type: "thinking", thinking: "revealed thought" }] }],
									stderr: "",
									stopReason: "end",
									usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
								},
							],
						},
					},
				}),
			].join("\n"),
		);

		const registry = createDispatchRegistry();
		const settledTask = registry.startTask({ mode: "single", prompt: "Task: EXT-17-1 view fold probe", now: 1_000 });
		registry.startRound(settledTask.id, [{ agent: "early" }], 1_000);
		registry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 2_000, activity: [{ at: 1_100, kind: "text", text: "early note" }] });
		await withView({ registry, detachedJobs: [], sessionFile: () => sessionFile }, async (view) => {
			const collapsed = view.render(120).join("\n");
			assert.deepEqual(view.rows.map((row) => row.id), ["u:completed"], "the collapsed tree holds the umbrella row alone");
			assert.ok(collapsed.includes("Completed"), "the collapsed umbrella row renders");
			assert.ok(!collapsed.includes("early"), "the settled agent row stays hidden behind the umbrella");
			assert.ok(collapsed.includes("dispatches: 1"), "the umbrella detail names the settled dispatch count");
			assert.ok(collapsed.includes("single · 1s"), "the umbrella detail lists one member line per settled dispatch");

			view.handleInput("t");
			assert.equal(view.render(120).join("\n"), collapsed, "t on the umbrella row is a no-op");

			view.handleInput(RIGHT);
			const expanded = view.render(120).join("\n");
			assert.ok(expanded.includes("EXT-17-1"), "right expands the umbrella and reveals the settled task row");
			assert.ok(expanded.includes("Completed"), "the umbrella row stays visible when expanded");

			view.handleInput(LEFT);
			assert.deepEqual(view.rows.map((row) => row.id), ["u:completed"], "left collapses the umbrella again");

			// The t affordance survives the fold: expand, walk to the finished agent, stream its transcript.
			view.handleInput(RIGHT);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, `t:${settledTask.id}`);
			view.handleInput(DOWN);
			assert.equal(view.selectedId, `t:${settledTask.id}:r1`);
			view.handleInput(RIGHT);
			assert.ok(view.render(120).join("\n").includes("early"), "the settled agent row renders under the expanded umbrella");
			view.handleInput(DOWN);
			assert.equal(view.selectedId, `t:${settledTask.id}:r1:a0`);
			view.handleInput("t");
			await waitForFrame(view, (frame) => frame.includes("revealed thought"));
			assert.ok(view.render(120).join("\n").includes("full thinking"), "t still streams the revealed finished agent's transcript");
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
// <<< EXT-17 V1

// >>> EXT-17 V2: a task settling mid-session clamps the selection onto a surviving row
{
	const registry = createDispatchRegistry();
	const settlingTask = registry.startTask({ mode: "single", prompt: "Task: EXT-17-1 settle clamp probe", now: 1_000 });
	registry.startRound(settlingTask.id, [{ agent: "settler" }], 1_000);
	const earlierTask = registry.startTask({ mode: "single", prompt: "Task: EXT-17-2 earlier probe", now: 500 });
	registry.startRound(earlierTask.id, [{ agent: "prior" }], 500);
	registry.updateAgent(earlierTask.id, 1, 0, { status: "done", finishedAt: 800 });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		// The poll never fires inside a synchronous suite: refresh() is the
		// exact method the 300ms interval calls, so the settle is picked up
		// by calling it directly (bounded, never an unbounded wait).
		view.handleInput(DOWN);
		assert.equal(view.selectedId, `t:${settlingTask.id}:r1`);
		view.handleInput(DOWN);
		assert.equal(view.selectedId, `t:${settlingTask.id}:r1:a0`);

		registry.updateAgent(settlingTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
		view.refresh();
		const frame = view.render(120);
		assert.ok(frame.join("\n").includes("Completed"), "the settled tree renders the umbrella");
		const surviving = view.rows[view.selectedIndex];
		assert.ok(surviving, "the clamped selection lands on a surviving row");
		assert.equal(surviving.id, view.selectedId, "the adopted selection names a rendered row");
		const model = resolveDetailModel(surviving, view.tasks);
		assert.notEqual(model.kind, "empty", "the adopted row's detail model resolves");
		assert.ok(frame.length > 0, "the view renders after the settle clamp");
	});
}
// <<< EXT-17 V2

// >>> EXT-19 V2 helpers: the pane geometry render(120) composes against, and ANSI stripping for row-shape pins
const TREE_W_AT_120 = Math.max(26, Math.floor(120 * 0.44));
const stripAnsi = (text) => text.replace(/\x1b(\[[0-9;]*[A-Za-z]|\]8;;\x07|_[^\x07]*\x07)/g, "");

// >>> EXT-19 V1: the task detail renders the job's full source text, stable across polls
{
	const registry = createDispatchRegistry();
	const prompt = "Read /home/x/.pi/.tasks/current/EXT-19-20261030-0918-show-what-each-job-is-working-on.md\n\nFollow the Work Log entry EXT-19-1 and log interim progress.";
	const task = registry.startTask({ mode: "single", prompt, now: 1_000 });
	registry.startRound(task.id, [{ agent: "worker" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: mapperLog(40) });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		const poll = () => view.refresh();
		assert.equal(view.selectedId, "t:task-1", "the fixture opens on the task row");

		// The pane follows the activity tail by default, so the prompt section above is clipped.

		// The pane follows the activity tail by default, so the prompt section above is clipped.
		const tailFrame = view.render(120).join("\n");
		assert.ok(!tailFrame.includes("Follow the Work Log entry"), "the tail view clips the prompt section above the activity");

		view.handleInput(HOME);
		const headFrame = view.render(120).join("\n");
		assert.ok(headFrame.includes("prompt"), "the section label renders below the header");
		assert.ok(
			headFrame.indexOf("prompt") < headFrame.indexOf("<dim:Read /home/x/.pi/.tasks/current/EXT-19-20261030"),
			"the section label sits above its source lines",
		);
		assert.ok(
			headFrame.includes("<dim:Read /home/x/.pi/.tasks/current/EXT-19-20261030-0918-show-what-each-job-is-working-on.md>"),
			"each source line renders as its own dim pane line",
		);
		assert.ok(headFrame.includes("<dim:Follow the Work Log entry EXT-19-1 and log interim progress."), "the last source line renders");
		assert.ok(headFrame.includes("\u200b"), "a blank source line renders a zero-width space so the paragraph break survives");
		assert.ok(!headFrame.includes("log line 39"), "the held head view clips the activity tail below");

		// A held window does not drift while the immutable prompt section re-renders on a poll.
		registry.updateAgent(task.id, 1, 0, { activity: [...mapperLog(40), activityEntry(40, 2_000)] });
		poll();
		const stableFrame = view.render(120).join("\n");
		assert.ok(stableFrame.includes("<dim:Read /home/x/.pi/.tasks/current/EXT-19-20261030"), "the held window stays on the prompt section across the poll");
		assert.ok(!stableFrame.includes("log line 40"), "the held window stays off the new tail after the poll");
	}, stubTui(), dimTaggingTheme);
}

// A task whose source text is empty renders no prompt section.
{
	const registry = createDispatchRegistry();
	const task = registry.startTask({ mode: "single", prompt: "", now: 1_000 });
	registry.startRound(task.id, [{ agent: "quiet" }], 1_000);
	registry.updateAgent(task.id, 1, 0, { activity: [{ at: 1_100, kind: "text", text: "quiet note" }] });
	await withView({ registry, detachedJobs: [] }, async (view) => {
		assert.equal(view.selectedId, "t:task-1");
		const frame = view.render(120).join("\n");
		assert.ok(frame.includes("quiet note"), "the empty-source task still renders its detail pane");
		assert.ok(!frame.includes("prompt"), "an empty source text renders no prompt section");
	});
}
// <<< EXT-19 V1

// >>> EXT-19 V2: an overlong tree row ends in an honest ellipsis and fits its pane width
{
	const registry = createDispatchRegistry();
	registry.startTask({ mode: "single", prompt: "Summarize the reconciliation report for the fourth quarter and list every mismatch found by the auditor", now: 1_000 });
	registry.startRound(registry.getTask("task-1").id, [{ agent: "worker" }], 1_000);
	await withView({ registry, detachedJobs: [] }, async (view) => {
		assert.equal(view.selectedId, "t:task-1", "the fixture opens on the long-label task row");
		const frame = view.render(120);
		const rowLine = frame.find((line) => line.includes("Summarize the reconciliation"));
		assert.ok(rowLine, "the fixture renders the overlong tree row");
		const row = stripAnsi(sliceByColumn(rowLine, 0, TREE_W_AT_120));
		assert.ok(row.trimEnd().endsWith("…"), "the overlong row ends in an honest ellipsis instead of a silent cut");
		assert.ok(visibleWidth(row.trimEnd()) <= TREE_W_AT_120, "the truncated row fits its pane width");
		const joined = frame.join("\n");
		assert.ok(!joined.includes("auditor"), "no continuation of the cut label renders anywhere in the frame");
		assert.ok(!joined.includes("… +"), "the fixture does not ride the tree-overflow clip");
		assert.ok(frame[frame.indexOf(rowLine) + 1].includes("round 1"), "the next tree row renders on the following line: one row per row, no wrap continuation");
	});
}
// <<< EXT-19 V2

// >>> EXT-19 V3: the focused selected row's cursor marker survives the ellipsis cut
{
	const registry = createDispatchRegistry();
	registry.startTask({ mode: "single", prompt: "Summarize the reconciliation report for the fourth quarter and list every mismatch found by the auditor", now: 1_000 });
	registry.startRound(registry.getTask("task-1").id, [{ agent: "worker" }], 1_000);
	await withView({ registry, detachedJobs: [] }, async (view) => {
		view.focused = true;
		assert.equal(view.selectedId, "t:task-1");
		const frame = view.render(120);
		const markerLine = frame.find((line) => line.includes(CURSOR_MARKER));
		assert.ok(markerLine, "the focused selected row renders the cursor marker");
		assert.ok(frame.join("").split(CURSOR_MARKER).length - 1 === 1, "exactly the selected row carries the marker");
		const row = stripAnsi(sliceByColumn(markerLine, 0, TREE_W_AT_120));
		assert.ok(row.trimEnd().endsWith("…"), "the marker rides the truncated row's honest ellipsis");
		assert.ok(markerLine.indexOf(CURSOR_MARKER) > markerLine.indexOf("…"), "the marker sits after the cut, at the row's end cell");
		assert.ok(visibleWidth(row.trimEnd()) <= TREE_W_AT_120, "the marker-carrying row still fits its pane width");
	});
}
// <<< EXT-19 V3

console.log("agent-viewer-view: all assertions passed");
