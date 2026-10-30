#!/usr/bin/env node
/**
 * Unit suite for the ambient strip's pure rendering layer
 * (extensions/agent-viewer/strip.ts). Plain node, no test framework:
 *
 *   node tests/agent-viewer-strip-render.test.mjs
 *
 * Covers the line budget the strip owns: the navigator-key hint line
 * always last, live tasks prioritized before the Completed line,
 * finished views collapsed to that one line, the
 * "+N more" overflow summary (content lines are capped at maxLines minus the overflow and hint reservations), the
 * no-dispatch placeholder, the glyph/color conventions shared
 * with the blocking path, and render-time task-label derivation from
 * the prompt. Also covers buildStripTasks assembling
 * views from a live registry plus detached jobs: live rounds first,
 * collapsed finished rounds, lazy parallel rounds rendering only
 * picked-up agents and a zero-agent round staying live with no
 * entries, detached labels resolving through the
 * same heuristic as blocking tasks (fleet reference wins, first-words
 * fallback, "(detached)" on an empty preview) and keying glyphs off
 * job.status, and detached per-agent nodes (the EXT-1-3 wiring)
 * streaming per-agent activity and status onto the strip with the
 * agentNames fallback for snapshots predating it.
 */

import assert from "node:assert/strict";
import { createDispatchRegistry, formatDuration, statusGlyph } from "../extensions/subagent/registry.ts";
import { buildStripTasks, renderStripLines, STRIP_MAX_LINES } from "../extensions/agent-viewer/strip.ts";

/** Join a strip line's segment texts into the plain line string. */
function lineText(line) {
	return line.segments.map((segment) => segment.text).join("");
}

function lineContains(line, needle) {
	return lineText(line).includes(needle);
}

// --- statusGlyph: the fleet glyph conventions ---

assert.equal(statusGlyph("running"), "⏳");
assert.equal(statusGlyph("done"), "✓");
assert.equal(statusGlyph("failed"), "✗");
assert.equal(statusGlyph("mixed"), "◐");

// --- formatDuration (shared contract module) ---

assert.equal(formatDuration(45_000), "45s");
assert.equal(formatDuration(62_000), "1m2s");
assert.equal(formatDuration(3_600_000), "1h0m");
assert.equal(formatDuration(-5), "0s");

// --- renderStripLines: live task, agent lines, hint last ---

const liveTask = {
	label: "EXT-1-2",
	mode: "parallel",
	live: true,
	glyph: "running",
	entries: [
		{ kind: "agent", name: "worker", glyph: "running", activity: "$ rg pattern", durationText: "45s" },
		{ kind: "agent", name: "scout", glyph: "done", durationText: "1m2s" },
	],
};
const lines = renderStripLines([liveTask], { hint: "alt+n navigator · alt+s hide" });

assert.ok(lineContains(lines[0], "EXT-1-2"), "first line is the task header");
assert.ok(lineContains(lines[0], "parallel"), "header carries the mode");
assert.equal(lines[0].segments[0].bold, true, "header label is bold");
assert.ok(lineContains(lines[1], "⏳"), "running agent shows the hourglass glyph");
assert.ok(lineContains(lines[1], "worker"));
assert.ok(lineContains(lines[1], "$ rg pattern"), "agent line carries the last activity");
assert.ok(lineContains(lines[1], "45s"), "agent line carries the duration");
assert.equal(lines[1].segments[0].color, "warning", "running glyph uses the warning color");
assert.ok(lineContains(lines[2], "✓"));
assert.equal(lines[2].segments[0].color, "success", "done glyph uses the success color");
assert.equal(lines[2].segments[1].bold, true, "agent name is bold");
assert.equal(lines[lines.length - 1].segments[0].text, "alt+n navigator · alt+s hide", "hint line is last");
assert.equal(lines.length, 4, "header + two agents + hint");

// --- failed glyph color (a live task holding a failed agent) ---

const failedTask = {
	label: "broken",
	mode: "single",
	live: true,
	glyph: "running",
	entries: [{ kind: "agent", name: "worker", glyph: "failed", durationText: "5s" }],
};
const failedLines = renderStripLines([failedTask], { hint: "hint" });
assert.equal(failedLines[1].segments[0].color, "error", "failed glyph uses the error color");

// --- live tasks are prioritized before the Completed line ---

const finishedTask = {
	label: "earlier finished",
	mode: "single",
	live: false,
	glyph: "done",
	entries: [{ kind: "agent", name: "scout", glyph: "done", durationText: "9s" }],
};
const laterLive = { ...liveTask, label: "later live" };
const ordered = renderStripLines([finishedTask, laterLive], { hint: "hint" });
assert.ok(lineContains(ordered[0], "later live"), "live task header comes first");
assert.ok(lineContains(ordered[ordered.length - 2], "Completed"), "the Completed line renders after the live block");
assert.equal(ordered.length, 5, "live block (header + two agents) + Completed line + hint");

// --- collapsed round entries (a live task holding a finished round) ---

const collapsedRound = {
	label: "chain task",
	mode: "chain",
	live: true,
	glyph: "running",
	entries: [{ kind: "round", label: "round 1", glyph: "done", summary: "1/1 done", durationText: "2m" }],
};
const collapsedLines = renderStripLines([collapsedRound], { hint: "hint" });
assert.ok(lineContains(collapsedLines[1], "round 1"), "collapsed round keeps its round label");
assert.ok(lineContains(collapsedLines[1], "1/1 done"), "collapsed round summarizes its agents");
assert.ok(lineContains(collapsedLines[1], "✓"));
assert.equal(collapsedLines.length, 3, "collapsed round is one line: header + round + hint");

// --- no dispatches placeholder ---

const emptyLines = renderStripLines([], { hint: "hint" });
assert.ok(lineContains(emptyLines[0], "No active dispatches"));
assert.equal(emptyLines[1].segments[0].text, "hint");
assert.equal(emptyLines.length, 2);

// --- budget: overflow summarized as "+N more", hint always last ---

const bigTask = {
	label: "fan-out",
	mode: "parallel",
	live: true,
	glyph: "running",
	entries: Array.from({ length: 20 }, (_, i) => ({
		kind: "agent",
		name: `agent-${i}`,
		glyph: "running",
		durationText: `${i}s`,
	})),
};
const budgetLines = renderStripLines([bigTask], { hint: "hint", maxLines: 12 });
assert.equal(budgetLines.length, STRIP_MAX_LINES, "output never exceeds the budget");
assert.equal(budgetLines[budgetLines.length - 1].segments[0].text, "hint", "hint stays last under overflow");
assert.ok(lineContains(budgetLines[budgetLines.length - 2], "+11 more"), `overflow line summarizes omitted lines, got ${lineText(budgetLines[budgetLines.length - 2])}`);
assert.ok(lineContains(budgetLines[0], "fan-out"), "header survives the cut");
assert.equal(budgetLines.length - 3, 9, "content lines = header + budgeted agent lines");

// --- budget: content exactly at the cap does not add "+N more" ---

const exactTask = {
	label: "fits",
	mode: "single",
	live: true,
	glyph: "running",
	entries: Array.from({ length: 9 }, (_, i) => ({ kind: "agent", name: `a${i}`, glyph: "done", durationText: "1s" })),
};
const exactLines = renderStripLines([exactTask], { hint: "hint", maxLines: 12 });
assert.equal(exactLines.length, 11, "header + 9 agents + hint");
assert.ok(!exactLines.some((line) => lineContains(line, "more")), "no overflow line when everything fits");
assert.equal(exactLines[exactLines.length - 1].segments[0].text, "hint");

// --- budget: overflow under settled bulk is superseded by S5 below ---
// (the overflow-cuts-finished fixture was superseded by the EXT-17 S5
// fixtures: settled bulk collapses to one Completed line and can no
// longer trigger the overflow, while the +N more machinery stays
// pinned by the all-live budget fixtures and S5's live-overflow cut.)

// --- buildStripTasks: registry rounds (live first, finished collapsed) ---

const registry = createDispatchRegistry();
const chain = registry.startTask({ mode: "chain", prompt: "Task: EXT-7-1 steps", now: 1_000 });
registry.startRound(chain.id, [{ agent: "scout", step: 1 }], 1_000);
registry.updateAgent(chain.id, 1, 0, { status: "done", finishedAt: 61_000 });
registry.startRound(chain.id, [{ agent: "planner", step: 2 }], 62_000);
registry.updateAgent(chain.id, 2, 0, { lastActivity: "read plan.md" });

const detachedRunning = {
	id: "job-1",
	mode: "parallel",
	status: "running",
	agentNames: ["worker", "reviewer"],
	taskPreview: "Task: EXT-5-1 fan out the reconciliation",
	startedAt: 90_000,
	agents: [
		{ agent: "worker", status: "running", startedAt: 90_000, lastActivity: "$ rg pattern" },
		{ agent: "reviewer", status: "done", startedAt: 90_000, finishedAt: 100_000 },
	],
};
const detachedFailed = {
	id: "job-2",
	mode: "single",
	status: "failed",
	agentNames: ["scout"],
	taskPreview: "scout the repo",
	startedAt: 30_000,
	finishedAt: 60_000,
};

const detachedBlank = {
	id: "job-6",
	mode: "single",
	status: "done",
	agentNames: ["scout"],
	taskPreview: "",
	startedAt: 30_000,
	finishedAt: 60_000,
};

const views = buildStripTasks(registry, [detachedRunning, detachedFailed, detachedBlank], 122_000);
assert.equal(views.length, 4);

const chainView = views[0];
assert.equal(chainView.label, "EXT-7-1", "label derives from the prompt's fleet reference at render time");
assert.equal(chainView.live, true, "task with a running agent is live");
assert.equal(chainView.entries.length, 2, "one entry per round: live round entry + collapsed finished round");
assert.equal(chainView.entries[0].kind, "agent");
assert.equal(chainView.entries[0].name, "planner");
assert.equal(chainView.entries[0].glyph, "running");
assert.equal(chainView.entries[0].activity, "read plan.md");
assert.equal(chainView.entries[0].durationText, "1m", "live agent duration = now - startedAt");
assert.equal(chainView.entries[1].kind, "round");
assert.equal(chainView.entries[1].label, "round 1");
assert.equal(chainView.entries[1].glyph, "done");
assert.equal(chainView.entries[1].summary, "1/1 done");
assert.equal(chainView.entries[1].durationText, "1m", "collapsed round duration = finish - start");

const detachedRunningView = views[1];
assert.equal(detachedRunningView.label, "EXT-5-1", "detached labels honor the fleet-reference heuristic like blocking tasks");
assert.equal(detachedRunningView.live, true);
assert.equal(detachedRunningView.entries.length, 2);
assert.equal(detachedRunningView.entries[0].name, "worker");
assert.equal(detachedRunningView.entries[0].glyph, "running");
assert.equal(detachedRunningView.entries[0].activity, "$ rg pattern", "per-agent activity streams onto the strip via the snapshot nodes");
assert.equal(detachedRunningView.entries[0].durationText, "32s", "node duration = now - node startedAt");
assert.equal(detachedRunningView.entries[1].glyph, "done", "per-agent glyphs come from the node status, not the job status");
assert.equal(detachedRunningView.entries[1].durationText, "10s", "finished node duration = finishedAt - startedAt");

const detachedFailedView = views[2];
assert.equal(detachedFailedView.label, "scout the repo", "detached labels fall back to first words like blocking tasks");
assert.equal(detachedFailedView.live, false);
assert.equal(detachedFailedView.entries[0].glyph, "failed", "detached glyph keys off job.status");
assert.equal(detachedFailedView.entries[0].durationText, "30s", "finished detached duration = finishedAt - startedAt");

const detachedBlankView = views[3];
assert.equal(detachedBlankView.label, "(detached)", "an empty taskPreview falls back to (detached) instead of a bare header");

// --- buildStripTasks: snapshots without node data fall back to agentNames ---

const legacyJob = {
	id: "job-3",
	mode: "single",
	status: "failed",
	agentNames: ["scout"],
	taskPreview: "legacy snapshot",
	startedAt: 30_000,
	finishedAt: 60_000,
};
const legacyView = buildStripTasks(createDispatchRegistry(), [legacyJob], 122_000)[0];
assert.equal(legacyView.entries.length, 1);
assert.equal(legacyView.entries[0].glyph, "failed", "the job-status glyph covers snapshots predating the per-agent nodes");
assert.equal(legacyView.entries[0].activity, undefined);
assert.equal(legacyView.entries[0].durationText, "30s");

// --- buildStripTasks: empty and partial agents arrays (lazy detached node creation) ---

const notStartedJob = {
	id: "job-4",
	mode: "chain",
	status: "running",
	agentNames: ["first", "second", "third"],
	taskPreview: "chain not started",
	startedAt: 1_000,
	agents: [],
};
const notStartedStrip = buildStripTasks(createDispatchRegistry(), [notStartedJob], 2_000)[0];
assert.equal(notStartedStrip.entries.length, 0, "a job whose steps have not started shows only its header");

const brokenChainJob = {
	id: "job-5",
	mode: "chain",
	status: "failed",
	agentNames: ["planner", "worker", "reviewer"],
	taskPreview: "broken chain",
	startedAt: 1_000,
	finishedAt: 9_000,
	agents: [{ agent: "planner", status: "failed", step: 1, startedAt: 1_000, finishedAt: 4_000 }],
};
const brokenStrip = buildStripTasks(createDispatchRegistry(), [brokenChainJob], 10_000)[0];
assert.equal(brokenStrip.entries.length, 1, "the never-started chain steps render no strip entries");
assert.equal(brokenStrip.entries[0].name, "planner");
assert.equal(brokenStrip.entries[0].durationText, "3s", "the started step's duration ends at its own finish");

// --- buildStripTasks: labels resolve from the prompt at render time ---

const labeled = createDispatchRegistry();
labeled.startTask({ mode: "single", prompt: "Task: EXT-9-2 parser fixes", now: 1_000 });
labeled.startTask({ mode: "single", prompt: "Reply ready for the fleet", now: 1_000 });
labeled.startTask({ mode: "single", prompt: "", now: 1_000 });
const labeledViews = buildStripTasks(labeled, [], 2_000);
assert.equal(labeledViews[0].label, "EXT-9-2", "fleet-reference prompts label by the reference");
assert.equal(labeledViews[1].label, "Reply ready for the fleet", "plain prompts label by first words");
assert.equal(labeledViews[2].label, "(detached)", "an empty prompt falls back like detached jobs instead of a bare header");

// --- buildStripTasks: mixed failed round collapses with the mixed glyph ---

const mixed = createDispatchRegistry();
const parallelTask = mixed.startTask({ mode: "parallel", prompt: "fan", now: 1_000 });
mixed.startRound(parallelTask.id, [{ agent: "a" }, { agent: "b" }, { agent: "c" }], 1_000);
mixed.updateAgent(parallelTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
mixed.updateAgent(parallelTask.id, 1, 1, { status: "failed", finishedAt: 3_000 });
mixed.updateAgent(parallelTask.id, 1, 2, { status: "done", finishedAt: 4_000 });
const mixedView = buildStripTasks(mixed, [], 10_000)[0];
assert.equal(mixedView.live, false, "task with no running agents is not live");
assert.equal(mixedView.entries[0].kind, "round");
assert.equal(mixedView.entries[0].glyph, "mixed", "partially failed round uses the mixed glyph");
assert.equal(mixedView.entries[0].summary, "2/3 done, 1 failed");

// --- buildStripTasks: lazy parallel rounds (only picked-up agents render) ---

const lazy = createDispatchRegistry();
const lazyTask = lazy.startTask({ mode: "parallel", prompt: "Task: EXT-7-1 lazy fan out", now: 100_000 });
lazy.startRound(lazyTask.id, [], 100_000);
lazy.startAgent(lazyTask.id, 1, 0, { agent: "scout" }, 101_000);
lazy.startAgent(lazyTask.id, 1, 1, { agent: "worker" }, 121_000);
lazy.updateAgent(lazyTask.id, 1, 0, { lastActivity: "$ rg pattern" });

const lazyView = buildStripTasks(lazy, [], 122_000)[0];
assert.equal(lazyView.live, true);
assert.equal(lazyView.entries.length, 2, "only picked-up agents render; queued slots have no nodes");
assert.equal(lazyView.entries[0].name, "scout");
assert.equal(lazyView.entries[0].glyph, "running");
assert.equal(lazyView.entries[0].durationText, "21s", "duration runs from the agent's own pickup, not round start");
assert.equal(lazyView.entries[1].name, "worker");
assert.equal(lazyView.entries[1].durationText, "1s", "a later pickup's duration starts at its own pickup");

// --- buildStripTasks: a zero-agent round stays live with no entries ---

const emptyWindow = createDispatchRegistry();
const emptyTask = emptyWindow.startTask({ mode: "parallel", prompt: "Task: EXT-7-1 empty window", now: 100_000 });
emptyWindow.startRound(emptyTask.id, [], 100_000);
const emptyView = buildStripTasks(emptyWindow, [], 122_000)[0];
assert.equal(emptyView.live, true, "a zero-agent round counts as live instead of collapsing to a finished round");
assert.equal(emptyView.entries.length, 0);

// >>> EXT-17 S1: the Completed line renders after the live block
{
	const stripLive = { label: "EXT-17-1", mode: "parallel", live: true, glyph: "running", entries: [{ kind: "agent", name: "worker", glyph: "running", durationText: "5s" }] };
	const stripSettled = { label: "EXT-17-1 earlier", mode: "single", live: false, glyph: "done", entries: [{ kind: "agent", name: "scout", glyph: "done", durationText: "2s" }] };
	const completedLines = renderStripLines([stripLive, stripSettled], { hint: "hint" });
	assert.ok(lineContains(completedLines[0], "EXT-17-1"), "the live block still leads");
	assert.equal(completedLines[2].segments[0].text, "✓", "the Completed line opens with the aggregated glyph");
	assert.equal(completedLines[2].segments[1].text, " Completed");
	assert.equal(completedLines[2].segments[1].color, "accent", "Completed renders in the task-title styling");
	assert.equal(completedLines[2].segments[1].bold, true);
	assert.equal(completedLines[2].segments[2].text, " · 1 dispatch", "the count uses the singular wording");
	assert.equal(completedLines[2].segments[2].color, "dim");
	assert.equal(completedLines.length, 4, "live block + one Completed line + hint");
}
// <<< EXT-17 S1

// >>> EXT-17 S2: a settled-only strip shows the Completed line instead of the placeholder
{
	const stripSettled = { label: "only settled", mode: "single", live: false, glyph: "done", entries: [{ kind: "agent", name: "scout", glyph: "done", durationText: "2s" }] };
	const settledOnlyLines = renderStripLines([stripSettled], { hint: "hint" });
	assert.equal(settledOnlyLines.length, 2, "the settled-only strip is the Completed line plus the hint");
	assert.ok(lineContains(settledOnlyLines[0], "Completed"), "the Completed line replaces the no-dispatch placeholder");
	assert.ok(!settledOnlyLines.some((line) => lineContains(line, "No active dispatches")), "the placeholder stays hidden behind the Completed line");
	assert.ok(!settledOnlyLines.some((line) => lineContains(line, "only settled")), "the settled task header does not render");
	assert.ok(!settledOnlyLines.some((line) => lineContains(line, "scout")), "the settled task's entries do not render");
}
// <<< EXT-17 S2

// >>> EXT-17 S3: the no-settled guard (unchanged render)
{
	const liveOnly = { label: "EXT-17-1", mode: "single", live: true, glyph: "running", entries: [{ kind: "agent", name: "worker", glyph: "running", durationText: "5s" }] };
	const liveOnlyLines = renderStripLines([liveOnly], { hint: "hint" });
	assert.equal(liveOnlyLines.length, 3, "header + agent + hint");
	assert.ok(!liveOnlyLines.some((line) => lineContains(line, "Completed")), "no Completed line renders when nothing has settled");
	assert.ok(!liveOnlyLines.some((line) => lineContains(line, "No active dispatches")));
}
// <<< EXT-17 S3

// >>> EXT-17 S4: the Completed glyph aggregates done, failed, and mixed
{
	const doneView = { label: "settled done", mode: "single", live: false, glyph: "done", entries: [] };
	const failedView = { label: "settled failed", mode: "single", live: false, glyph: "failed", entries: [] };
	assert.equal(renderStripLines([doneView, { ...doneView, label: "settled done 2" }], { hint: "hint" })[0].segments[0].text, "✓", "all-done settles aggregate to the done glyph");
	assert.equal(renderStripLines([failedView], { hint: "hint" })[0].segments[0].text, "✗", "all-failed settles aggregate to the failed glyph");
	assert.equal(renderStripLines([doneView, failedView], { hint: "hint" })[0].segments[0].text, "◐", "mixed outcomes aggregate to the mixed glyph");
	assert.equal(renderStripLines([doneView, failedView], { hint: "hint" })[0].segments[2].text, " · 2 dispatches");
}
// <<< EXT-17 S4

// >>> EXT-17 S5: settled bulk never overflows; live overflow cuts the Completed line into +N more
{
	const settledBulk = Array.from({ length: 15 }, (_, index) => ({
		label: `settled ${index}`,
		mode: "single",
		live: false,
		glyph: "done",
		entries: Array.from({ length: 3 }, (_, slot) => ({ kind: "agent", name: `s${index}-${slot}`, glyph: "done", durationText: "1s" })),
	}));
	const bulkLines = renderStripLines(settledBulk, { hint: "hint", maxLines: 12 });
	assert.equal(bulkLines.length, 2, "15 settled views collapse to one Completed line plus the hint, never overflowing");
	assert.ok(lineContains(bulkLines[0], "Completed"));
	assert.ok(lineContains(bulkLines[0], "15 dispatches"));
	assert.ok(!bulkLines.some((line) => lineContains(line, "more")), "settled bulk never triggers the +N more overflow");
	assert.ok(!bulkLines.some((line) => lineContains(line, "settled 0")), "the settled views' own headers never render");

	const liveFlood = {
		label: "flood",
		mode: "parallel",
		live: true,
		glyph: "running",
		entries: Array.from({ length: 12 }, (_, index) => ({ kind: "agent", name: `live-${index}`, glyph: "running", durationText: "1s" })),
	};
	const overflowLines = renderStripLines([liveFlood, ...settledBulk.slice(0, 3)], { hint: "hint", maxLines: 12 });
	const overflowRendered = overflowLines.map(lineText).join("\n");
	assert.ok(overflowRendered.includes("live-7"), "the live block's lines lead and survive the cut");
	assert.ok(!overflowRendered.includes("live-11"), "the live block itself is long enough to reach the cut");
	assert.ok(overflowRendered.includes("+4 more"), "the overflow summarizes the cut content (14 content lines minus the 10-line budget)");
	assert.ok(!overflowRendered.includes("Completed"), "the Completed line is cut into the summary like ordinary content when live content alone overflows");
	assert.equal(overflowLines[overflowLines.length - 1].segments[0].text, "hint", "hint stays last under the live overflow");

	// Live content lands exactly at maxContent (header + 9 agents = 10 content
	// lines), so the one settled view's Completed line is what trips the
	// boundary and is the line cut into +1 more.
	const boundaryTask = {
		label: "boundary",
		mode: "parallel",
		live: true,
		glyph: "running",
		entries: Array.from({ length: 9 }, (_, index) => ({ kind: "agent", name: `edge-${index}`, glyph: "running", durationText: "1s" })),
	};
	const boundaryLines = renderStripLines([boundaryTask, ...settledBulk.slice(0, 1)], { hint: "hint", maxLines: 12 });
	assert.ok(boundaryLines.some((line) => lineContains(line, "+1 more")), `live content exactly at maxContent pushes the Completed line into a +1 more summary, got ${boundaryLines.map(lineText).join(" | ")}`);
}
// <<< EXT-17 S5

// >>> EXT-17 S6: a task joins the Completed line only once every agent completes
{
	const partialRegistry = createDispatchRegistry();
	const partialTask = partialRegistry.startTask({ mode: "parallel", prompt: "Task: EXT-17-1 strip partial", now: 1_000 });
	partialRegistry.startRound(partialTask.id, [{ agent: "a" }, { agent: "b" }], 1_000);
	partialRegistry.updateAgent(partialTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const partialViews = buildStripTasks(partialRegistry, [], 3_000);
	assert.equal(partialViews[0].live, true, "a task with a still-running agent is live on the strip too");
	const partialLines = renderStripLines(partialViews, { hint: "hint" });
	assert.ok(!partialLines.some((line) => lineContains(line, "Completed")), "the live block renders and nothing joins a Completed line yet");
	partialRegistry.updateAgent(partialTask.id, 1, 1, { status: "done", finishedAt: 4_000 });
	const settledLines = renderStripLines(buildStripTasks(partialRegistry, [], 5_000), { hint: "hint" });
	assert.ok(lineContains(settledLines[0], "Completed"), "the task joins the Completed line once every agent completes");
	assert.ok(lineContains(settledLines[0], "1 dispatch"));
	assert.equal(settledLines.length, 2, "Completed line + hint only");
}
// <<< EXT-17 S6

console.log("agent-viewer-strip-render: all assertions passed");
