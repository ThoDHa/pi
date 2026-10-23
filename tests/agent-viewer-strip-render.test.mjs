#!/usr/bin/env node
/**
 * Unit suite for the ambient strip's pure rendering layer
 * (extensions/agent-viewer/strip.ts). Plain node, no test framework:
 *
 *   node tests/agent-viewer-strip-render.test.mjs
 *
 * Covers the line budget the strip owns: the navigator-key hint line
 * always last, live tasks prioritized before finished ones, finished
 * rounds collapsed, the "+N more" overflow summary (content lines are
 * capped at maxLines minus the overflow and hint reservations), the
 * no-dispatch placeholder, the glyph/color conventions shared
 * with the blocking path, and render-time task-label derivation from
 * the prompt. Also covers buildStripTasks assembling
 * views from a live registry plus detached jobs: live rounds first,
 * collapsed finished rounds, detached jobs reusing taskPreview and
 * keying glyphs off job.status, and detached per-agent nodes (the
 * EXT-1-3 wiring) streaming per-agent activity and status onto the
 * strip with the agentNames fallback for snapshots predating it.
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

// --- failed glyph color ---

const failedTask = {
	label: "broken",
	mode: "single",
	live: false,
	entries: [{ kind: "agent", name: "worker", glyph: "failed", durationText: "5s" }],
};
const failedLines = renderStripLines([failedTask], { hint: "hint" });
assert.equal(failedLines[1].segments[0].color, "error", "failed glyph uses the error color");

// --- live tasks are prioritized before finished ones ---

const finishedTask = {
	label: "earlier finished",
	mode: "single",
	live: false,
	entries: [{ kind: "agent", name: "scout", glyph: "done", durationText: "9s" }],
};
const laterLive = { ...liveTask, label: "later live" };
const ordered = renderStripLines([finishedTask, laterLive], { hint: "hint" });
assert.ok(lineContains(ordered[0], "later live"), "live task header comes first");
const finishedLine = ordered.find((line) => lineContains(line, "earlier finished"));
assert.ok(finishedLine, "finished task still renders after the live one");

// --- collapsed round entries ---

const collapsedRound = {
	label: "chain task",
	mode: "chain",
	live: false,
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
	entries: Array.from({ length: 9 }, (_, i) => ({ kind: "agent", name: `a${i}`, glyph: "done", durationText: "1s" })),
};
const exactLines = renderStripLines([exactTask], { hint: "hint", maxLines: 12 });
assert.equal(exactLines.length, 11, "header + 9 agents + hint");
assert.ok(!exactLines.some((line) => lineContains(line, "more")), "no overflow line when everything fits");
assert.equal(exactLines[exactLines.length - 1].segments[0].text, "hint");

// --- budget: overflow cuts finished content first ---

const mixedTasks = [
	{
		label: "live",
		mode: "parallel",
		live: true,
		entries: Array.from({ length: 8 }, (_, i) => ({ kind: "agent", name: `live-${i}`, glyph: "running", durationText: "1s" })),
	},
	{
		label: "done",
		mode: "parallel",
		live: false,
		entries: Array.from({ length: 8 }, (_, i) => ({ kind: "agent", name: `done-${i}`, glyph: "done", durationText: "1s" })),
	},
];
const cutLines = renderStripLines(mixedTasks, { hint: "hint", maxLines: 12 });
const rendered = cutLines.map(lineText).join("\n");
assert.ok(rendered.includes("live-7"), "all live agent lines survive");
assert.ok(!rendered.includes("done-7"), "finished agent lines are cut first");
assert.ok(rendered.includes("+8 more"), "omitted lines are summarized (18 content lines minus the 10-line budget)");

// --- buildStripTasks: registry rounds (live first, finished collapsed) ---

const registry = createDispatchRegistry();
const chain = registry.startTask({ mode: "chain", prompt: "Task: EXT-7-1 steps", now: 1_000 });
registry.startRound(chain.id, [{ agent: "scout", step: 1 }], 1_000);
registry.updateAgent(chain.id, 1, 0, { status: "done", finishedAt: 61_000 });
registry.startRound(chain.id, [{ agent: "planner", step: 2 }], 62_000);
registry.updateAgent(chain.id, 2, 0, { lastActivity: "read plan.md" });

const detachedRunning = {
	mode: "parallel",
	status: "running",
	agentNames: ["worker", "reviewer"],
	taskPreview: "fan out the reconciliation",
	startedAt: 90_000,
	agents: [
		{ agent: "worker", status: "running", startedAt: 90_000, lastActivity: "$ rg pattern" },
		{ agent: "reviewer", status: "done", startedAt: 90_000, finishedAt: 100_000 },
	],
};
const detachedFailed = {
	mode: "single",
	status: "failed",
	agentNames: ["scout"],
	taskPreview: "scout the repo",
	startedAt: 30_000,
	finishedAt: 60_000,
};

const views = buildStripTasks(registry, [detachedRunning, detachedFailed], 122_000);
assert.equal(views.length, 3);

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
assert.equal(detachedRunningView.label, "fan out the reconciliation", "detached label reuses taskPreview");
assert.equal(detachedRunningView.live, true);
assert.equal(detachedRunningView.entries.length, 2);
assert.equal(detachedRunningView.entries[0].name, "worker");
assert.equal(detachedRunningView.entries[0].glyph, "running");
assert.equal(detachedRunningView.entries[0].activity, "$ rg pattern", "per-agent activity streams onto the strip via the snapshot nodes");
assert.equal(detachedRunningView.entries[0].durationText, "32s", "node duration = now - node startedAt");
assert.equal(detachedRunningView.entries[1].glyph, "done", "per-agent glyphs come from the node status, not the job status");
assert.equal(detachedRunningView.entries[1].durationText, "10s", "finished node duration = finishedAt - startedAt");

const detachedFailedView = views[2];
assert.equal(detachedFailedView.live, false);
assert.equal(detachedFailedView.entries[0].glyph, "failed", "detached glyph keys off job.status");
assert.equal(detachedFailedView.entries[0].durationText, "30s", "finished detached duration = finishedAt - startedAt");

// --- buildStripTasks: snapshots without node data fall back to agentNames ---

const legacyJob = {
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

console.log("agent-viewer-strip-render: all assertions passed");
