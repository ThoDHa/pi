#!/usr/bin/env node
/**
 * Unit suite for the navigator view's pure tree layer
 * (extensions/agent-viewer/navigator.ts). Plain node, no test
 * framework:
 *
 *   node tests/agent-viewer-navigator-tree.test.mjs
 *
 * Covers the tree model the view renders: buildNavigatorTasks
 * assembling task -> dispatch round -> agent views from the dispatch
 * registry plus detached-job snapshots (detached jobs as task nodes
 * with their agents as children, labels from the EXT-1-2 heuristic,
 * glyphs keyed off job.status on detached tasks, lazy parallel
 * rounds rendering only picked-up agents, the zero-agent round
 * staying live-empty, and liveness dominating settled task glyphs
 * while the task has an unfinished round), and
 * flattenNavigatorTree turning views plus expansion state into
 * visible rows (completed rounds collapsed to single glyph lines, the
 * live round auto-expanded, user expand/collapse overrides sticky,
 * task collapse hiding the whole subtree). Also covers the cursor
 * helpers: moveCursor clamping and nextTaskRow wrapping on Tab.
 */

import assert from "node:assert/strict";
import { createDispatchRegistry } from "../extensions/subagent/registry.ts";
import {
	buildNavigatorTasks,
	createExpansionState,
	flattenNavigatorTree,
	moveCursor,
	nextTaskRow,
	toggleNavigatorRow,
} from "../extensions/agent-viewer/navigator.ts";

// --- buildNavigatorTasks: registry task -> rounds -> agents ---

const registry = createDispatchRegistry();
const chainTask = registry.startTask({ mode: "chain", prompt: "Task: EXT-9-9 nav probe", now: 1_000 });
registry.startRound(chainTask.id, [{ agent: "scout", step: 1 }], 1_000);
registry.updateAgent(chainTask.id, 1, 0, { status: "done", finishedAt: 21_000 });
registry.startRound(chainTask.id, [{ agent: "worker", step: 2 }], 22_000);
registry.updateAgent(chainTask.id, 2, 0, { lastActivity: "$ rg pattern" });

const detached = {
	id: "job-1",
	mode: "single",
	status: "running",
	agentNames: ["observer"],
	taskPreview: "watch the probe",
	startedAt: 30_000,
	agents: [{ agent: "observer", status: "running", startedAt: 30_000, lastActivity: "read nav.log" }],
};

const tasks = buildNavigatorTasks(registry, [detached], 40_000);
assert.equal(tasks.length, 2, "one task view per registry task plus one per detached job");

const chainView = tasks[0];
assert.equal(chainView.id, chainTask.id);
assert.equal(chainView.source, "registry");
assert.equal(chainView.label, "EXT-9-9", "registry task labels resolve from the prompt's fleet reference");
assert.equal(chainView.mode, "chain");
assert.equal(chainView.live, true, "a task with a running agent is live");
assert.equal(chainView.glyph, "running");
assert.equal(chainView.rounds.length, 2);

const finishedRound = chainView.rounds[0];
assert.equal(finishedRound.index, 1);
assert.equal(finishedRound.live, false);
assert.equal(finishedRound.glyph, "done");
assert.equal(finishedRound.summary, "1/1 done");
assert.equal(finishedRound.durationText, "20s", "finished round duration = finish - start");
assert.equal(finishedRound.agents[0].name, "scout");
assert.equal(finishedRound.agents[0].step, 1);
assert.deepEqual(finishedRound.agents[0].ref, { source: "registry", ownerId: chainTask.id, roundIndex: 1, slot: 0 });

const liveRound = chainView.rounds[1];
assert.equal(liveRound.live, true);
assert.equal(liveRound.glyph, "running");
assert.equal(liveRound.agents[0].activity, "$ rg pattern");
assert.deepEqual(liveRound.agents[0].ref, { source: "registry", ownerId: chainTask.id, roundIndex: 2, slot: 0 });

// --- buildNavigatorTasks: detached jobs as task nodes with agent children ---

const detachedView = tasks[1];
assert.equal(detachedView.source, "detached");
assert.equal(detachedView.id, "job-1");
assert.equal(detachedView.label, "watch the probe", "detached labels resolve from the task preview");
assert.equal(detachedView.mode, "single");
assert.equal(detachedView.live, true);
assert.equal(detachedView.glyph, "running", "detached task glyphs key off job.status");
assert.equal(detachedView.rounds.length, 0, "detached tasks have no round level");
assert.equal(detachedView.agents.length, 1, "detached agents hang directly off the task node");
assert.equal(detachedView.agents[0].name, "observer");
assert.equal(detachedView.agents[0].activity, "read nav.log");
assert.equal(detachedView.agents[0].startedAt, 30_000);
assert.deepEqual(detachedView.agents[0].ref, { source: "detached", ownerId: "job-1", slot: 0 });

// Detached labels go through the same heuristic: a fleet reference wins.
const labeledJob = {
	id: "job-2",
	mode: "single",
	status: "running",
	agentNames: ["worker"],
	taskPreview: "for EXT-4-1 sweep the module",
	startedAt: 1_000,
	agents: [{ agent: "worker", status: "running", startedAt: 1_000 }],
};
const labeledView = buildNavigatorTasks(registry, [labeledJob], 2_000)[1];
assert.equal(labeledView.label, "EXT-4-1", "detached labels honor the fleet-reference heuristic");

// --- buildNavigatorTasks: legacy snapshots without per-agent nodes fall back ---

const legacyJob = {
	id: "job-3",
	mode: "single",
	status: "failed",
	agentNames: ["ghost"],
	taskPreview: "legacy snapshot",
	startedAt: 1_000,
	finishedAt: 31_000,
};
const legacyView = buildNavigatorTasks(registry, [legacyJob], 40_000)[1];
assert.equal(legacyView.agents.length, 1);
assert.equal(legacyView.agents[0].name, "ghost", "agentNames seed the children when no node data exists");
assert.equal(legacyView.agents[0].status, "failed", "fallback children key off job.status");
assert.equal(legacyView.agents[0].finishedAt, 31_000);
assert.equal(legacyView.glyph, "failed");

// --- buildNavigatorTasks: empty and partial agents arrays (lazy detached node creation) ---

const notStartedJob = {
	id: "job-4",
	mode: "chain",
	status: "running",
	agentNames: ["first", "second", "third"],
	taskPreview: "chain not started",
	startedAt: 1_000,
	agents: [],
};
const notStartedTasks = buildNavigatorTasks(registry, [notStartedJob], 2_000);
const notStartedView = notStartedTasks[notStartedTasks.length - 1];
assert.equal(notStartedView.agents.length, 0, "an empty agents array renders no agent children (nothing started yet)");
const notStartedRows = flattenNavigatorTree(notStartedTasks, createExpansionState());
assert.deepEqual(
	notStartedRows.filter((row) => row.taskId === "job-4").map((row) => row.id),
	["t:job-4"],
	"a job whose steps have not started shows only its task row",
);

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
const brokenTasks = buildNavigatorTasks(registry, [brokenChainJob], 10_000);
const brokenView = brokenTasks[brokenTasks.length - 1];
assert.equal(brokenView.agents.length, 1, "a chain broken at step 1 publishes only the started step");
assert.equal(brokenView.agents[0].status, "failed");
assert.equal(brokenView.agents[0].finishedAt, 4_000, "the started step keeps its own finish, not the job's");
const brokenRows = flattenNavigatorTree(brokenTasks, createExpansionState());
assert.deepEqual(
	brokenRows.filter((row) => row.taskId === "job-5").map((row) => row.kind),
	["task", "agent"],
	"never-started chain steps render no rows instead of ghost failures",
);

// --- buildNavigatorTasks: aggregate task glyph over settled agents ---

const settled = createDispatchRegistry();
const mixedTask = settled.startTask({ mode: "parallel", prompt: "fan", now: 1_000 });
settled.startRound(mixedTask.id, [{ agent: "a" }, { agent: "b" }], 1_000);
settled.updateAgent(mixedTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
settled.updateAgent(mixedTask.id, 1, 1, { status: "failed", finishedAt: 3_000 });
const mixedView = buildNavigatorTasks(settled, [], 10_000)[0];
assert.equal(mixedView.live, false);
assert.equal(mixedView.glyph, "mixed", "a settled task with both outcomes uses the mixed glyph");
settled.updateAgent(mixedTask.id, 1, 0, { status: "failed", finishedAt: 2_000 });
const allFailedView = buildNavigatorTasks(settled, [], 10_000)[0];
assert.equal(allFailedView.glyph, "failed", "all-failed settles on the failed glyph");

// --- buildNavigatorTasks: task duration ends at the latest slot finish ---

const ordered = createDispatchRegistry();
const lateFirst = ordered.startTask({ mode: "parallel", prompt: "fan", now: 1_000 });
ordered.startRound(lateFirst.id, [{ agent: "slow" }, { agent: "quick" }], 1_000);
ordered.updateAgent(lateFirst.id, 1, 0, { status: "done", finishedAt: 9_000 });
ordered.updateAgent(lateFirst.id, 1, 1, { status: "done", finishedAt: 3_000 });
const lateFirstView = buildNavigatorTasks(ordered, [], 10_000)[0];
assert.equal(lateFirstView.durationText, "8s", "task duration ends at the latest slot finish, not the last slot's");

// --- buildNavigatorTasks: live tasks partition above settled ones, stable within groups ---

{
	const mixedRegistry = createDispatchRegistry();
	const settledTask = mixedRegistry.startTask({ mode: "single", prompt: "settled probe", now: 1_000 });
	mixedRegistry.startRound(settledTask.id, [{ agent: "early" }], 1_000);
	mixedRegistry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const settledDetached = {
		id: "job-settled",
		mode: "single",
		status: "done",
		agentNames: ["finished"],
		taskPreview: "settled detached probe",
		startedAt: 1_000,
		finishedAt: 3_000,
	};
	const liveDetached = {
		id: "job-live",
		mode: "single",
		status: "running",
		agentNames: ["busy"],
		taskPreview: "live detached probe",
		startedAt: 4_000,
	};
	const mixed = buildNavigatorTasks(mixedRegistry, [settledDetached, liveDetached], 5_000);
	assert.deepEqual(
		mixed.map((view) => view.id),
		["job-live", settledTask.id, "job-settled"],
		"live tasks lead settled ones across registry and detached sources",
	);
	assert.deepEqual(
		mixed.filter((view) => view.live).map((view) => view.id),
		["job-live"],
		"the live group keeps insertion order",
	);
	assert.deepEqual(
		mixed.filter((view) => !view.live).map((view) => view.id),
		[settledTask.id, "job-settled"],
		"the settled group keeps insertion order (registry task, then detached snapshot order)",
	);

	// Partitioning is a no-op when liveness is uniform.
	assert.deepEqual(
		buildNavigatorTasks(mixedRegistry, [settledDetached], 5_000).map((view) => view.id),
		[settledTask.id, "job-settled"],
		"an all-settled list keeps its insertion order",
	);
	const liveRegistry = createDispatchRegistry();
	const firstLive = liveRegistry.startTask({ mode: "single", prompt: "first live probe", now: 1_000 });
	liveRegistry.startRound(firstLive.id, [{ agent: "a1" }], 1_000);
	const secondLive = liveRegistry.startTask({ mode: "single", prompt: "second live probe", now: 2_000 });
	liveRegistry.startRound(secondLive.id, [{ agent: "a2" }], 2_000);
	assert.deepEqual(
		buildNavigatorTasks(liveRegistry, [liveDetached], 3_000).map((view) => view.id),
		[firstLive.id, secondLive.id, "job-live"],
		"an all-live list keeps its insertion order",
	);

	// The tree renders rows in the partitioned order.
	const mixedRows = flattenNavigatorTree(mixed, createExpansionState());
	assert.deepEqual(
		mixedRows.map((row) => row.taskId),
		["job-live", "job-live", settledTask.id, settledTask.id, "job-settled", "job-settled"],
		"the live task's rows render before the settled tasks' rows",
	);
}

// --- buildNavigatorTasks: lazy parallel rounds (only picked-up agents render) ---

{
	const lazyRegistry = createDispatchRegistry();
	const lazyTask = lazyRegistry.startTask({ mode: "parallel", prompt: "Task: EXT-7-1 lazy fan out", now: 100_000 });
	lazyRegistry.startRound(lazyTask.id, [], 100_000);
	lazyRegistry.startAgent(lazyTask.id, 1, 0, { agent: "scout" }, 101_000);
	lazyRegistry.startAgent(lazyTask.id, 1, 1, { agent: "worker" }, 121_000);

	const [lazyView] = buildNavigatorTasks(lazyRegistry, [], 122_000);
	assert.equal(lazyView.live, true);
	assert.equal(lazyView.glyph, "running");
	assert.equal(lazyView.durationText, "22s", "task duration still runs from task start");
	assert.equal(lazyView.rounds.length, 1);
	const lazyRound = lazyView.rounds[0];
	assert.equal(lazyRound.live, true);
	assert.equal(lazyRound.glyph, "running");
	assert.equal(lazyRound.agents.length, 2, "queued slots render no agent children");
	assert.equal(lazyRound.agents[0].name, "scout");
	assert.equal(lazyRound.agents[0].durationText, "21s", "agent duration runs from its own pickup, not round start");
	assert.equal(lazyRound.agents[1].durationText, "1s");
	assert.equal(lazyRound.durationText, "21s", "round duration spans first pickup to the latest unfinished agent");
	assert.equal(lazyRound.summary, "0/2 done");
}

// --- buildNavigatorTasks: the zero-agent round renders live-empty, never done/NaN ---

{
	const emptyRegistry = createDispatchRegistry();
	const emptyTask = emptyRegistry.startTask({ mode: "parallel", prompt: "Task: EXT-7-1 empty window", now: 100_000 });
	emptyRegistry.startRound(emptyTask.id, [], 100_000);
	const settledTask = emptyRegistry.startTask({ mode: "single", prompt: "Task: EXT-7-1 settled", now: 10_000 });
	emptyRegistry.startRound(settledTask.id, [{ agent: "scout" }], 10_000);
	emptyRegistry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 20_000 });

	const emptyViews = buildNavigatorTasks(emptyRegistry, [], 122_000);
	assert.deepEqual(
		emptyViews.map((view) => view.id),
		[emptyTask.id, settledTask.id],
		"the zero-agent task keeps its live-first placement above settled tasks",
	);
	const emptyView = emptyViews[0];
	assert.equal(emptyView.live, true);
	assert.equal(emptyView.glyph, "running", "a live task with no started agents never aggregates to done");
	assert.equal(emptyView.durationText, "22s", "task duration stays non-NaN through the empty window");
	const emptyRound = emptyView.rounds[0];
	assert.equal(emptyRound.live, true);
	assert.equal(emptyRound.glyph, "running", "a zero-agent round renders the running glyph, not done");
	assert.equal(emptyRound.agents.length, 0);
	assert.equal(emptyRound.durationText, "0s", "round duration stays non-NaN with no started agents");
	assert.equal(emptyRound.summary, "0/0 done");
}

// --- buildNavigatorTasks: liveness dominates settled glyphs on a live task ---

{
	const mixedLiveRegistry = createDispatchRegistry();
	const mixedLiveTask = mixedLiveRegistry.startTask({ mode: "parallel", prompt: "Task: EXT-7-1 failed plus empty window", now: 100_000 });
	mixedLiveRegistry.startRound(mixedLiveTask.id, [{ agent: "scout" }], 100_000);
	mixedLiveRegistry.updateAgent(mixedLiveTask.id, 1, 0, { status: "failed", finishedAt: 110_000 });
	mixedLiveRegistry.startRound(mixedLiveTask.id, [], 111_000);

	const [mixedLiveView] = buildNavigatorTasks(mixedLiveRegistry, [], 122_000);
	assert.equal(mixedLiveView.live, true);
	assert.equal(mixedLiveView.glyph, "running", "a live task never carries a settled glyph, failed included");
	const failedRound = mixedLiveView.rounds[0];
	assert.equal(failedRound.live, false);
	assert.equal(failedRound.glyph, "failed", "a settled round keeps its own glyph");
	assert.equal(mixedLiveView.rounds[1].live, true);
	assert.equal(mixedLiveView.rounds[1].glyph, "running");
}

// --- flattenNavigatorTree: rows, depths, completed collapsed, live expanded ---

const state = createExpansionState();
const rows = flattenNavigatorTree(tasks, state);
assert.deepEqual(
	rows.map((row) => row.kind),
	["task", "round", "round", "agent", "task", "agent"],
	"completed round 1 collapses to its glyph line, live round 2 auto-expands under the worker",
);
assert.deepEqual(
	rows.map((row) => row.depth),
	[0, 1, 1, 2, 0, 1],
);
assert.deepEqual(rows.map((row) => row.taskOrder), [0, 0, 0, 0, 1, 1]);

const taskRow = rows[0];
assert.equal(taskRow.label, "EXT-9-9");
assert.equal(taskRow.detail, "chain");
assert.equal(taskRow.glyph, "running");

const round1Row = rows[1];
assert.equal(round1Row.label, "round 1");
assert.equal(round1Row.roundIndex, 1);
assert.equal(round1Row.detail, "1/1 done · 20s");
assert.equal(round1Row.glyph, "done");

const round2Row = rows[2];
assert.equal(round2Row.live, true);
const workerRow = rows[3];
assert.equal(workerRow.kind, "agent");
assert.equal(workerRow.label, "worker");
assert.equal(workerRow.detail, "18s", "live agent duration = now - startedAt");
assert.equal(workerRow.activity, "$ rg pattern");
assert.ok(workerRow.agentRef, "agent rows carry the detail-pane ref");

// --- flattenNavigatorTree: expand/collapse overrides are sticky ---

state.roundOverrides.set(round1Row.id, true);
const expandedRows = flattenNavigatorTree(tasks, state);
assert.deepEqual(
	expandedRows.map((row) => row.kind),
	["task", "round", "agent", "round", "agent", "task", "agent"],
	"expanding a completed round reveals its agents",
);
assert.equal(expandedRows[2].label, "scout");

state.roundOverrides.set(round1Row.id, false);
state.roundOverrides.set(round2Row.id, false);
const collapsedLiveRows = flattenNavigatorTree(tasks, state);
assert.deepEqual(
	collapsedLiveRows.map((row) => row.kind),
	["task", "round", "round", "task", "agent"],
	"collapsing the live round hides its agents and completed rounds stay collapsed by default",
);

// --- flattenNavigatorTree: collapsing a task hides its whole subtree ---

const freshState = createExpansionState();
freshState.collapsedTasks.add(chainTask.id);
const collapsedTaskRows = flattenNavigatorTree(tasks, freshState);
assert.deepEqual(
	collapsedTaskRows.map((row) => row.id),
	[`t:${chainTask.id}`, "t:job-1", "t:job-1:a0"],
	"a collapsed task renders only its header row; the detached task stays expanded",
);

// --- moveCursor: clamped movement over visible rows ---

assert.equal(moveCursor(rows, 0, 1), 1);
assert.equal(moveCursor(rows, 3, -2), 1);
assert.equal(moveCursor(rows, 0, -1), 0, "moving up from the first row clamps");
assert.equal(moveCursor(rows, rows.length - 1, 1), rows.length - 1, "moving down from the last row clamps");

// --- nextTaskRow: Tab jumps between task rows and wraps ---

assert.equal(nextTaskRow(rows, 0, 1), 4, "Tab from the first task lands on the next task row");
assert.equal(nextTaskRow(rows, 2, 1), 4, "Tab from a nested row skips to the next task row");
assert.equal(nextTaskRow(rows, 4, 1), 0, "Tab past the last task wraps to the first");
assert.equal(nextTaskRow(rows, 0, -1), 4, "Shift+Tab wraps backwards to the last task row");
assert.equal(nextTaskRow(rows, 5, -1), 4, "Shift+Tab from a nested row finds its own task row");

// --- toggleNavigatorRow: the collapse/expand semantics the view's left/right keys drive ---

const toggleState = createExpansionState();
const toggleRows = flattenNavigatorTree(tasks, toggleState);
const toggleTaskRow = toggleRows.find((row) => row.kind === "task" && row.taskId === chainTask.id);
const toggleRoundRow = toggleRows.find((row) => row.kind === "round" && row.roundIndex === 1);
const toggleAgentRow = toggleRows.find((row) => row.kind === "agent");
assert.ok(toggleTaskRow && toggleRoundRow && toggleAgentRow, "the fixture exposes one row of each kind");

toggleNavigatorRow(toggleState, toggleTaskRow, false);
assert.ok(toggleState.collapsedTasks.has(chainTask.id), "collapsing a task adds the raw task id (flatten contract)");
assert.equal(
	flattenNavigatorTree(tasks, toggleState).filter((row) => row.taskId === chainTask.id).length,
	1,
	"a collapsed task's subtree disappears",
);

toggleNavigatorRow(toggleState, toggleTaskRow, true);
assert.ok(!toggleState.collapsedTasks.has(chainTask.id), "expanding a task deletes the raw task id");
assert.ok(flattenNavigatorTree(tasks, toggleState).some((row) => row.kind === "round"), "the expanded task's rounds are visible again");

toggleNavigatorRow(toggleState, toggleRoundRow, true);
assert.equal(toggleState.roundOverrides.get(toggleRoundRow.id), true, "expanding a round stores the override under the namespaced row id");
toggleNavigatorRow(toggleState, toggleRoundRow, false);
assert.equal(toggleState.roundOverrides.get(toggleRoundRow.id), false, "collapsing a round overrides its auto state under the namespaced row id");

toggleNavigatorRow(toggleState, toggleAgentRow, false);
toggleNavigatorRow(toggleState, toggleAgentRow, true);
assert.ok(!toggleState.collapsedTasks.has(toggleAgentRow.id), "agent rows never touch the task set");
assert.equal(toggleState.roundOverrides.size, 1, "agent rows are a no-op on expansion state");

// --- moveCursor: the empty-tree clamp branch ---

assert.equal(moveCursor([], 0, 1), 0, "moving on an empty tree stays at index 0");

// >>> EXT-17 T1: the umbrella row over settled views, settled rows hidden
{
	const umbrellaRegistry = createDispatchRegistry();
	const liveTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 live probe", now: 1_000 });
	umbrellaRegistry.startRound(liveTask.id, [{ agent: "busy" }], 1_000);
	const doneTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 done probe", now: 2_000 });
	umbrellaRegistry.startRound(doneTask.id, [{ agent: "early" }], 2_000);
	umbrellaRegistry.updateAgent(doneTask.id, 1, 0, { status: "done", finishedAt: 3_000 });
	const failedJob = {
		id: "job-failed",
		mode: "single",
		status: "failed",
		agentNames: ["ghost"],
		taskPreview: "for EXT-17-2 sweep the ruins",
		startedAt: 1_000,
		finishedAt: 4_000,
	};
	const umbrellaTasks = buildNavigatorTasks(umbrellaRegistry, [failedJob], 5_000);
	const collapsedRows = flattenNavigatorTree(umbrellaTasks, createExpansionState());
	assert.deepEqual(
		collapsedRows.map((row) => row.id),
		["t:task-1", "t:task-1:r1", "t:task-1:r1:a0", "u:completed"],
		"the collapsed tree renders the live rows followed by exactly one umbrella row",
	);
	const umbrellaRow = collapsedRows.find((row) => row.kind === "umbrella");
	assert.ok(umbrellaRow, "the collapsed tree renders one umbrella row over the settled views");
	assert.equal(umbrellaRow.id, "u:completed");
	assert.equal(umbrellaRow.taskId, "completed");
	assert.equal(umbrellaRow.depth, 0);
	assert.equal(umbrellaRow.label, "Completed");
	assert.equal(umbrellaRow.detail, "2 dispatches");
	assert.equal(umbrellaRow.live, false);
	assert.equal(umbrellaRow.glyph, "mixed", "the umbrella glyph aggregates over the settled views (done + failed)");
	assert.ok(
		!collapsedRows.some((row) => row.taskId === doneTask.id || row.taskId === "job-failed"),
		"no settled task, round, or agent row renders outside the umbrella",
	);
}
// <<< EXT-17 T1

// >>> EXT-17 T2: expanded nesting depths, unchanged ids and refs
{
	const umbrellaRegistry = createDispatchRegistry();
	const liveTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 live probe", now: 1_000 });
	umbrellaRegistry.startRound(liveTask.id, [{ agent: "busy" }], 1_000);
	const doneTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 done probe", now: 2_000 });
	umbrellaRegistry.startRound(doneTask.id, [{ agent: "early" }], 2_000);
	umbrellaRegistry.updateAgent(doneTask.id, 1, 0, { status: "done", finishedAt: 3_000 });
	const failedJob = {
		id: "job-failed",
		mode: "single",
		status: "failed",
		agentNames: ["ghost"],
		taskPreview: "for EXT-17-2 sweep the ruins",
		startedAt: 1_000,
		finishedAt: 4_000,
	};
	const umbrellaTasks = buildNavigatorTasks(umbrellaRegistry, [failedJob], 5_000);
	const expandedState = createExpansionState();
	expandedState.completedExpanded = true;
	const expandedRows = flattenNavigatorTree(umbrellaTasks, expandedState);
	assert.deepEqual(
		expandedRows.map((row) => row.id),
		[
			"t:task-1",
			"t:task-1:r1",
			"t:task-1:r1:a0",
			"u:completed",
			`t:${doneTask.id}`,
			`t:${doneTask.id}:r1`,
			`t:${doneTask.id}:r1:a0`,
			"t:job-failed",
			"t:job-failed:a0",
		],
		"the expanded umbrella reveals every settled subtree with row ids unchanged",
	);
	assert.deepEqual(
		expandedRows.filter((row) => row.taskId === doneTask.id).map((row) => row.depth),
		[1, 2, 3],
		"a settled registry subtree renders one depth deeper under the expanded umbrella",
	);
	assert.deepEqual(
		expandedRows.filter((row) => row.taskId === "job-failed").map((row) => row.depth),
		[1, 2],
		"a settled detached subtree renders one depth deeper",
	);
	assert.deepEqual(
		expandedRows.map((row) => row.taskOrder),
		[0, 0, 0, 1, 1, 1, 1, 2, 2],
		"taskOrder keeps naming the owning task view's index in the build order",
	);
	const nestedAgent = expandedRows.find((row) => row.id === `t:${doneTask.id}:r1:a0`);
	assert.ok(nestedAgent, "the fixture exposes the nested settled agent row");
	assert.deepEqual(nestedAgent.agentRef, { source: "registry", ownerId: doneTask.id, roundIndex: 1, slot: 0 }, "agent refs are unchanged under the umbrella");
	assert.equal(nestedAgent.label, "early");
	assert.equal(nestedAgent.glyph, "done");
}
// <<< EXT-17 T2

// >>> EXT-17 T3: the umbrella toggle is sticky in both directions
{
	const settledRegistry = createDispatchRegistry();
	const settledTask = settledRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 toggle probe", now: 1_000 });
	settledRegistry.startRound(settledTask.id, [{ agent: "early" }], 1_000);
	settledRegistry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const settledViews = buildNavigatorTasks(settledRegistry, [], 3_000);
	const state = createExpansionState();
	const umbrellaRow = flattenNavigatorTree(settledViews, state).find((row) => row.kind === "umbrella");
	assert.ok(umbrellaRow, "the fixture exposes the umbrella row");
	toggleNavigatorRow(state, umbrellaRow, true);
	assert.equal(state.completedExpanded, true, "expanding the umbrella writes completedExpanded");
	assert.ok(
		flattenNavigatorTree(settledViews, state).some((row) => row.taskId === settledTask.id),
		"the expanded umbrella reveals the settled subtree, sticky across re-flattens",
	);
	toggleNavigatorRow(state, umbrellaRow, false);
	assert.equal(state.completedExpanded, false, "collapsing the umbrella writes completedExpanded");
	assert.equal(
		flattenNavigatorTree(settledViews, state).filter((row) => row.taskId === settledTask.id).length,
		0,
		"the collapsed umbrella hides the subtree again, still sticky",
	);
}
// <<< EXT-17 T3

// >>> EXT-17 T4: the no-umbrella guard (all live)
{
	const allLiveRegistry = createDispatchRegistry();
	const liveTask = allLiveRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 live probe", now: 1_000 });
	allLiveRegistry.startRound(liveTask.id, [{ agent: "busy" }], 1_000);
	const liveJob = {
		id: "job-live",
		mode: "single",
		status: "running",
		agents: [{ agent: "mover", status: "running", startedAt: 2_000 }],
		agentNames: ["mover"],
		taskPreview: "Task: EXT-17-1 live job",
		startedAt: 2_000,
	};
	const allLiveRows = flattenNavigatorTree(buildNavigatorTasks(allLiveRegistry, [liveJob], 3_000), createExpansionState());
	assert.ok(!allLiveRows.some((row) => row.kind === "umbrella"), "an all-live tree renders no umbrella row");
	assert.deepEqual(
		allLiveRows.map((row) => row.id),
		["t:task-1", "t:task-1:r1", "t:task-1:r1:a0", "t:job-live", "t:job-live:a0"],
		"the all-live tree renders exactly the live rows, unchanged",
	);
}
// <<< EXT-17 T4

// >>> EXT-17 T5: the all-settled shape
{
	const settledRegistry = createDispatchRegistry();
	const settledTask = settledRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 settled probe", now: 1_000 });
	settledRegistry.startRound(settledTask.id, [{ agent: "early" }], 1_000);
	settledRegistry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const settledJob = {
		id: "job-settled",
		mode: "single",
		status: "done",
		agents: [{ agent: "late", status: "done", startedAt: 1_000, finishedAt: 3_000 }],
		agentNames: ["late"],
		taskPreview: "Task: EXT-17-1 settled job",
		startedAt: 1_000,
		finishedAt: 3_000,
	};
	const settledViews = buildNavigatorTasks(settledRegistry, [settledJob], 4_000);
	const collapsedRows = flattenNavigatorTree(settledViews, createExpansionState());
	assert.deepEqual(collapsedRows.map((row) => row.id), ["u:completed"], "an all-settled tree collapses to the umbrella row alone");
	assert.equal(collapsedRows[0].detail, "2 dispatches");
	const expandedState = createExpansionState();
	expandedState.completedExpanded = true;
	assert.deepEqual(
		flattenNavigatorTree(settledViews, expandedState).map((row) => row.id),
		["u:completed", `t:${settledTask.id}`, `t:${settledTask.id}:r1`, `t:${settledTask.id}:r1:a0`, "t:job-settled", "t:job-settled:a0"],
		"the expanded all-settled tree holds the umbrella plus both settled subtrees",
	);
}
// <<< EXT-17 T5

// >>> EXT-17 T6: the umbrella joins the tab jump set
{
	const mixedRegistry = createDispatchRegistry();
	const liveTask = mixedRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 live probe", now: 1_000 });
	mixedRegistry.startRound(liveTask.id, [{ agent: "busy" }], 1_000);
	const settledTask = mixedRegistry.startTask({ mode: "single", prompt: "Task: EXT-17-1 settled probe", now: 2_000 });
	mixedRegistry.startRound(settledTask.id, [{ agent: "early" }], 2_000);
	mixedRegistry.updateAgent(settledTask.id, 1, 0, { status: "done", finishedAt: 3_000 });
	const views = buildNavigatorTasks(mixedRegistry, [], 4_000);
	const collapsedRows = flattenNavigatorTree(views, createExpansionState());
	const liveTaskIndex = collapsedRows.findIndex((row) => row.kind === "task");
	const umbrellaIndex = collapsedRows.length - 1;
	assert.equal(nextTaskRow(collapsedRows, liveTaskIndex, 1), umbrellaIndex, "tab from the live task header reaches the umbrella row alone");
	assert.equal(nextTaskRow(collapsedRows, umbrellaIndex, 1), liveTaskIndex, "tab from the umbrella wraps back to the live task header");
	assert.equal(nextTaskRow(collapsedRows, umbrellaIndex, -1), liveTaskIndex, "shift+tab from the umbrella reaches the live task header");
	const expandedState = createExpansionState();
	expandedState.completedExpanded = true;
	const expandedRows = flattenNavigatorTree(views, expandedState);
	const expandedUmbrellaIndex = expandedRows.findIndex((row) => row.kind === "umbrella");
	const settledTaskIndex = expandedRows.findIndex((row) => row.kind === "task" && row.taskId === settledTask.id);
	assert.equal(nextTaskRow(expandedRows, expandedUmbrellaIndex, 1), settledTaskIndex, "tab from the umbrella reaches the settled task header under the expanded umbrella");
	assert.equal(nextTaskRow(expandedRows, settledTaskIndex, 1), expandedUmbrellaIndex, "tab from the settled task header wraps to the umbrella");
	assert.equal(nextTaskRow(expandedRows, settledTaskIndex, -1), expandedUmbrellaIndex, "shift+tab from the settled task header reaches the umbrella");
}
// <<< EXT-17 T6

// >>> EXT-17 T7: the umbrella glyph aggregates done, failed, and mixed
{
	const buildSettledRegistry = (statuses) => {
		const registry = createDispatchRegistry();
		const task = registry.startTask({ mode: "parallel", prompt: "Task: EXT-17-1 glyph probe", now: 1_000 });
		registry.startRound(task.id, statuses.map((agent) => ({ agent })), 1_000);
		statuses.forEach((status, slot) => registry.updateAgent(task.id, 1, slot, { status, finishedAt: 2_000 + slot }));
		return registry;
	};
	const allDone = flattenNavigatorTree(buildNavigatorTasks(buildSettledRegistry(["done", "done"]), [], 3_000), createExpansionState());
	assert.equal(allDone.find((row) => row.kind === "umbrella").glyph, "done", "all-done settles aggregate to the done glyph");
	const allFailed = flattenNavigatorTree(buildNavigatorTasks(buildSettledRegistry(["failed", "failed"]), [], 3_000), createExpansionState());
	assert.equal(allFailed.find((row) => row.kind === "umbrella").glyph, "failed", "all-failed settles aggregate to the failed glyph");
	const mixed = flattenNavigatorTree(buildNavigatorTasks(buildSettledRegistry(["done", "failed"]), [], 3_000), createExpansionState());
	assert.equal(mixed.find((row) => row.kind === "umbrella").glyph, "mixed", "mixed outcomes aggregate to the mixed glyph");
}
// <<< EXT-17 T7

// >>> EXT-17 T8: a detached job folds only once its last agent completes
{
	const partialJob = {
		id: "job-partial",
		mode: "parallel",
		status: "running",
		agents: [
			{ agent: "first", status: "done", startedAt: 1_000, finishedAt: 2_000 },
			{ agent: "second", status: "done", startedAt: 1_000, finishedAt: 3_000 },
			{ agent: "third", status: "running", startedAt: 2_000 },
		],
		agentNames: ["first", "second", "third"],
		taskPreview: "Task: EXT-17-1 partial job",
		startedAt: 1_000,
	};
	const partialViews = buildNavigatorTasks(createDispatchRegistry(), [partialJob], 4_000);
	assert.equal(partialViews[0].live, true, "a job with a still-running agent is live");
	assert.equal(partialViews[0].glyph, "running", "the partial job keeps its running glyph");
	const partialRows = flattenNavigatorTree(partialViews, createExpansionState());
	assert.deepEqual(
		partialRows.map((row) => row.id),
		["t:job-partial", "t:job-partial:a0", "t:job-partial:a1", "t:job-partial:a2"],
		"the partial job renders live with its running agent visible and no umbrella row",
	);
	const finishedJob = {
		...partialJob,
		status: "done",
		finishedAt: 5_000,
		agents: [
			{ agent: "first", status: "done", startedAt: 1_000, finishedAt: 2_000 },
			{ agent: "second", status: "done", startedAt: 1_000, finishedAt: 3_000 },
			{ agent: "third", status: "done", startedAt: 2_000, finishedAt: 5_000 },
		],
	};
	const finishedRows = flattenNavigatorTree(buildNavigatorTasks(createDispatchRegistry(), [finishedJob], 6_000), createExpansionState());
	assert.deepEqual(finishedRows.map((row) => row.id), ["u:completed"], "the job folds under the umbrella once its last agent completes");
}
// <<< EXT-17 T8

// >>> EXT-17 T9: a registry parallel task folds like a job; a zero-agent queued round keeps it live
{
	const partialRegistry = createDispatchRegistry();
	const partialTask = partialRegistry.startTask({ mode: "parallel", prompt: "Task: EXT-17-1 registry partial", now: 1_000 });
	partialRegistry.startRound(partialTask.id, [{ agent: "a" }, { agent: "b" }], 1_000);
	partialRegistry.updateAgent(partialTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const partialViews = buildNavigatorTasks(partialRegistry, [], 3_000);
	assert.equal(partialViews[0].live, true, "a registry task with a running agent is live");
	assert.ok(!flattenNavigatorTree(partialViews, createExpansionState()).some((row) => row.kind === "umbrella"), "the partial task stays out of the fold");
	partialRegistry.updateAgent(partialTask.id, 1, 1, { status: "done", finishedAt: 4_000 });
	const settledRows = flattenNavigatorTree(buildNavigatorTasks(partialRegistry, [], 5_000), createExpansionState());
	assert.deepEqual(settledRows.map((row) => row.id), ["u:completed"], "the task folds once its last agent completes");
	partialRegistry.startRound(partialTask.id, [], 6_000);
	const queuedViews = buildNavigatorTasks(partialRegistry, [], 7_000);
	assert.equal(queuedViews[0].live, true, "a zero-agent queued round keeps its task live");
	assert.ok(!flattenNavigatorTree(queuedViews, createExpansionState()).some((row) => row.kind === "umbrella"), "the queued-round task stays out of the fold");
}
// <<< EXT-17 T9

console.log("agent-viewer-navigator-tree: all assertions passed");
