#!/usr/bin/env node
/**
 * Unit suite for the navigator view's pure tree layer
 * (extensions/periscope/navigator.ts). Plain node, no test
 * framework:
 *
 *   node tests/periscope-navigator-tree.test.mjs
 *
 * Covers the tree model the view renders: buildNavigatorTasks
 * assembling task -> dispatch round -> agent views from the dispatch
 * registry plus detached-job snapshots (detached jobs as task nodes
 * with their agents as children, labels resolved through the
 * task-summary chain (the EXT-1-2 heuristic as the no-citation
 * fallback),
 * glyphs keyed off job.status on detached tasks, lazy parallel
 * rounds rendering only picked-up agents, the zero-agent round
 * staying live-empty, and liveness dominating settled task glyphs
 * while the task has an unfinished round), and
 * flattenNavigatorTree turning views plus expansion state into
 * visible rows carrying each row's current expansion state as the
 * chevron's expanded input (completed rounds collapsed to single glyph lines, the
 * live round auto-expanded, user expand/collapse overrides sticky,
 * task collapse hiding the whole subtree, and the EXT-24-1
 * partition-keyed default: under an expanded umbrella a settled task
 * renders its task row alone until expanded while a live task keeps
 * the expanded default, the task toggle writing by the row's
 * partition and clearing the non-governing set so the latest intent
 * carries across live/settled flips). Also covers the cursor
 * helpers: moveCursor clamping, nextTaskRow wrapping on Tab, and
 * treeWindowStart's minimal-shift cursor-following window (a fitting
 * tree returns the top, a stale previous start clamps before the
 * cursor shift, walking past the window bottom shifts by one, a far
 * cursor snaps the window to its side, row 0 restores the top, and a
 * collapsed (zero-row) viewport pins the window to the top
 * idempotently).
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
	treeWindowStart,
} from "../extensions/periscope/navigator.ts";

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
assert.ok(!("activity" in liveRound.agents[0]), "agent views carry no activity field; the streamed command stays off the tree model");
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
assert.ok(!("activity" in detachedView.agents[0]), "detached agent views carry no activity field either");
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
const brokenUmbrellaExpanded = createExpansionState();
brokenUmbrellaExpanded.completedExpanded = true;
// EXT-24-1 adaptation, assertion intent unchanged: the settled default
// collapsed, so the fixture pre-expands job-5 through the real toggle
// to keep pinning the never-started steps' row shape.
const brokenPreRows = flattenNavigatorTree(brokenTasks, brokenUmbrellaExpanded);
toggleNavigatorRow(brokenUmbrellaExpanded, brokenPreRows.find((row) => row.id === "t:job-5"), true);
const brokenRows = flattenNavigatorTree(brokenTasks, brokenUmbrellaExpanded);
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
		mixedRows.map((row) => row.id),
		["t:job-live", "t:job-live:a0", "u:completed"],
		"the live task's rows render above the Completed umbrella row holding the settled tasks",
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

// --- buildNavigatorTasks / flattenNavigatorTree: the thinking level on the agent row ---

const levelRegistry = createDispatchRegistry();
const levelChain = levelRegistry.startTask({ mode: "chain", prompt: "Task: EXT-39 level rows", now: 1_000 });
levelRegistry.startRound(levelChain.id, [{ agent: "planner", step: 1, thinkingLevel: "high" }], 1_000);
levelRegistry.startRound(levelChain.id, [{ agent: "reviewer", step: 2, thinkingLevel: "medium" }], 2_000);
levelRegistry.startRound(levelChain.id, [{ agent: "scout", step: 3 }], 3_000);
const levelTasks = buildNavigatorTasks(levelRegistry, [], 5_000);
assert.equal(levelTasks[0].rounds[0].agents[0].thinkingLevel, "high", "agent views carry the node's recorded level through");
assert.equal(levelTasks[0].rounds[1].agents[0].thinkingLevel, "med");
assert.equal(levelTasks[0].rounds[2].agents[0].thinkingLevel, undefined, "a pre-wiring node carries no level");

const levelState = createExpansionState();
const levelRows = flattenNavigatorTree(levelTasks, levelState);
const levelAgentRows = levelRows.filter((row) => row.kind === "agent");
assert.equal(levelAgentRows[0].detail, "high · 4s", "a leveled agent row leads its detail with the compact level token");
assert.equal(levelAgentRows[1].detail, "med · 3s");
assert.equal(levelAgentRows[2].detail, "2s", "a level-less row renders the baseline duration-only detail (pre-wiring shape)");
assert.equal(levelAgentRows[2].detail.includes("undefined"), false, "the literal never leaks into the row detail");

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
assert.ok(!("activity" in workerRow), "tree rows carry no activity suffix");
assert.ok(workerRow.agentRef, "agent rows carry the detail-pane ref");
assert.equal(taskRow.expanded, true, "a live task row carries its expanded-by-default state");
assert.equal(round1Row.expanded, false, "a completed round row carries its collapsed-by-default state");
assert.equal(round2Row.expanded, true, "a live round row carries its expanded-by-default state");
assert.equal(workerRow.expanded, false, "agent rows are leaves and carry expanded false");

// --- flattenNavigatorTree: expand/collapse overrides are sticky ---

state.roundOverrides.set(round1Row.id, true);
const expandedRows = flattenNavigatorTree(tasks, state);
assert.deepEqual(
	expandedRows.map((row) => row.kind),
	["task", "round", "agent", "round", "agent", "task", "agent"],
	"expanding a completed round reveals its agents",
);
assert.equal(expandedRows[2].label, "scout");
assert.equal(expandedRows[1].expanded, true, "an override-expanded round carries expanded true");

state.roundOverrides.set(round1Row.id, false);
state.roundOverrides.set(round2Row.id, false);
const collapsedLiveRows = flattenNavigatorTree(tasks, state);
assert.deepEqual(
	collapsedLiveRows.map((row) => row.kind),
	["task", "round", "round", "task", "agent"],
	"collapsing the live round hides its agents and completed rounds stay collapsed by default",
);
assert.equal(collapsedLiveRows[1].expanded, false, "an override-collapsed round carries expanded false");

// --- flattenNavigatorTree: collapsing a task hides its whole subtree ---

const freshState = createExpansionState();
freshState.collapsedTasks.add(chainTask.id);
const collapsedTaskRows = flattenNavigatorTree(tasks, freshState);
assert.deepEqual(
	collapsedTaskRows.map((row) => row.id),
	[`t:${chainTask.id}`, "t:job-1", "t:job-1:a0"],
	"a collapsed task renders only its header row; the detached task stays expanded",
);
assert.equal(collapsedTaskRows[0].expanded, false, "a collapsed task row carries expanded false");

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

// >>> EXT-23-1: treeWindowStart, the cursor-following visible window the tree pane renders

assert.equal(treeWindowStart(10, 9, 21, 0), 0, "a tree that fits the viewport window at the top");
assert.equal(treeWindowStart(10, 9, 21, 8), 0, "a tree that fits ignores the previous start");
assert.equal(treeWindowStart(0, 0, 21, 0), 0, "an empty tree fits");
assert.equal(treeWindowStart(21, 20, 21, 0), 0, "a tree exactly the viewport's height fits");

assert.equal(treeWindowStart(36, 5, 21, 3), 3, "a cursor inside the window holds the window still");
assert.equal(treeWindowStart(36, 21, 21, 0), 1, "a cursor stepping past the window's bottom shifts the window by one");
assert.equal(treeWindowStart(36, 2, 21, 10), 2, "a cursor stepping above the window's top raises the window to the cursor");
assert.equal(treeWindowStart(36, 30, 21, 0), 10, "a far cursor (the tab jump) snaps the window to the cursor's side");
assert.equal(treeWindowStart(36, 35, 21, 0), 15, "the last row bottom-aligns the window at the maximum start");
assert.equal(treeWindowStart(36, 0, 21, 15), 0, "walking back to row 0 restores the top-aligned window");
assert.equal(treeWindowStart(36, 35, 21, 100), 15, "an out-of-range previous start clamps into range and holds when the cursor is inside");
assert.equal(treeWindowStart(36, 0, 21, -7), 0, "a negative previous start clamps to the top");
assert.equal(treeWindowStart(30, 25, 21, 100), 9, "the stale-start clamp precedes the cursor shift");

// The settle-folds composition (rows shrink under a stored start while
// the cursor clamps to the new tail): a green-by-design guard pinning
// that the clamp resolves all three moving parts in one call.
assert.equal(treeWindowStart(30, 29, 21, 15), 9, "a shrunk tree clamps the stored start and holds the clamped cursor's tail-aligned window");

// A collapsed viewport (detailViewportRows floors below one row on
// tiny terminals) pins the window to the top idempotently: the stored
// start never oscillates across consecutive frames and the clip then
// counts every hidden row below honestly.
assert.equal(treeWindowStart(36, 0, 0, 0), 0, "a zero-row viewport pins the window to the top");
const viewportZeroFirst = treeWindowStart(36, 0, 0, 0);
assert.equal(treeWindowStart(36, 0, 0, viewportZeroFirst), viewportZeroFirst, "a zero-row viewport is idempotent across consecutive frames");

// <<< EXT-23-1

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
	assert.equal(umbrellaRow.expanded, false, "the umbrella row carries its collapsed default");
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
	expandedState.roundOverrides.set(`t:${doneTask.id}:r1`, true);
	// EXT-24-1 adaptation, assertion intent unchanged: the settled default
	// collapsed, so the fixture pre-expands both settled task rows through
	// the real toggle to keep pinning the fully expanded shapes.
	const t2PreRows = flattenNavigatorTree(umbrellaTasks, expandedState);
	toggleNavigatorRow(expandedState, t2PreRows.find((row) => row.id === `t:${doneTask.id}`), true);
	toggleNavigatorRow(expandedState, t2PreRows.find((row) => row.id === "t:job-failed"), true);
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
	assert.equal(expandedRows.find((row) => row.kind === "umbrella").expanded, true, "the expanded umbrella row carries expanded true");
	assert.equal(expandedRows.find((row) => row.id === `t:${doneTask.id}`).expanded, true, "a pre-expanded settled task row carries expanded true");
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
	expandedState.roundOverrides.set(`t:${settledTask.id}:r1`, true);
	// EXT-24-1 adaptation, assertion intent unchanged: both settled task
	// rows pre-expanded through the real toggle, so the all-settled shape
	// pins the same fully expanded tree.
	const t5PreRows = flattenNavigatorTree(settledViews, expandedState);
	toggleNavigatorRow(expandedState, t5PreRows.find((row) => row.id === `t:${settledTask.id}`), true);
	toggleNavigatorRow(expandedState, t5PreRows.find((row) => row.id === "t:job-settled"), true);
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
	// EXT-24-1 adaptation, assertion intent unchanged: the settled task
	// row pre-expanded through the real toggle, so the tab-jump set is
	// pinned against the fully expanded tree as before.
	const t6PreRows = flattenNavigatorTree(views, expandedState);
	toggleNavigatorRow(expandedState, t6PreRows.find((row) => row.id === `t:${settledTask.id}`), true);
	const expandedRows = flattenNavigatorTree(views, expandedState);
	const expandedUmbrellaIndex = expandedRows.findIndex((row) => row.kind === "umbrella");
	const settledTaskIndex = expandedRows.findIndex((row) => row.kind === "task" && row.taskId === settledTask.id);
	assert.equal(nextTaskRow(expandedRows, expandedUmbrellaIndex, 1), settledTaskIndex, "tab from the umbrella reaches the settled task header under the expanded umbrella");
	assert.equal(nextTaskRow(expandedRows, settledTaskIndex, 1), 0, "tab from the last task header in cycle order wraps to the first live task header");
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

// >>> EXT-21 T1: the cursor path crosses the expanded umbrella in both directions
{
	const umbrellaRegistry = createDispatchRegistry();
	const liveTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-21-1 live probe", now: 1_000 });
	umbrellaRegistry.startRound(liveTask.id, [{ agent: "busy" }], 1_000);
	const doneTask = umbrellaRegistry.startTask({ mode: "single", prompt: "Task: EXT-21-1 done probe", now: 2_000 });
	umbrellaRegistry.startRound(doneTask.id, [{ agent: "early" }], 2_000);
	umbrellaRegistry.updateAgent(doneTask.id, 1, 0, { status: "done", finishedAt: 3_000 });
	const failedJob = {
		id: "job-failed",
		mode: "single",
		status: "failed",
		agentNames: ["ghost"],
		taskPreview: "for EXT-21-2 sweep the ruins",
		startedAt: 1_000,
		finishedAt: 4_000,
	};
	const umbrellaTasks = buildNavigatorTasks(umbrellaRegistry, [failedJob], 5_000);
	const expandedState = createExpansionState();
	expandedState.completedExpanded = true;
	expandedState.roundOverrides.set(`t:${doneTask.id}:r1`, true);
	// EXT-24-1 adaptation, assertion intent unchanged: both settled task
	// rows pre-expanded through the real toggle, so the cursor-path
	// landings stay pinned across the fully expanded tree.
	const t1PreRows = flattenNavigatorTree(umbrellaTasks, expandedState);
	toggleNavigatorRow(expandedState, t1PreRows.find((row) => row.id === `t:${doneTask.id}`), true);
	toggleNavigatorRow(expandedState, t1PreRows.find((row) => row.id === "t:job-failed"), true);
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
		"the expanded fixture lays out the live rows, the umbrella, and the settled member rows in that order",
	);
	const rowIdAt = (index) => expandedRows[index].id;
	let cursor = expandedRows.findIndex((row) => row.id === "t:task-1:r1:a0");
	const step = (delta) => {
		cursor = moveCursor(expandedRows, cursor, delta);
		return rowIdAt(cursor);
	};
	assert.equal(step(1), "u:completed", "down from the last live row lands on the umbrella row");
	assert.equal(step(1), `t:${doneTask.id}`, "down from the umbrella lands on the settled task header");
	assert.equal(step(1), `t:${doneTask.id}:r1`, "down walks the settled round row");
	assert.equal(step(1), `t:${doneTask.id}:r1:a0`, "down walks the settled agent row");
	assert.equal(step(1), "t:job-failed", "down walks the settled detached job header");
	assert.equal(step(1), "t:job-failed:a0", "down walks the settled detached agent row");
	assert.equal(step(1), "t:job-failed:a0", "down from the last visible row stays clamped on it");
	assert.equal(step(-1), "t:job-failed", "up from the deepest settled member row walks back to the detached job header");
	assert.equal(step(-1), `t:${doneTask.id}:r1:a0`, "up walks the settled agent row");
	assert.equal(step(-1), `t:${doneTask.id}:r1`, "up walks the settled round row");
	assert.equal(step(-1), `t:${doneTask.id}`, "up walks the settled task header");
	assert.equal(step(-1), "u:completed", "up from the settled task header lands back on the umbrella row");
	assert.equal(step(-1), "t:task-1:r1:a0", "up from the umbrella returns to the last live row");
	assert.equal(step(-1), "t:task-1:r1", "up walks the live round row");
	assert.equal(step(-1), "t:task-1", "up walks the live task header");
	assert.equal(step(-1), "t:task-1", "up from the first row stays clamped on it");
}
// <<< EXT-21 T1

// >>> EXT-24-1: the settled default shape under the expanded umbrella
{
	const shapeRegistry = createDispatchRegistry();
	const shapeTask = shapeRegistry.startTask({ mode: "single", prompt: "Task: EXT-24-1 shape probe", now: 1_000 });
	shapeRegistry.startRound(shapeTask.id, [{ agent: "early" }], 1_000);
	shapeRegistry.updateAgent(shapeTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const shapeJob = {
		id: "job-shape",
		mode: "parallel",
		status: "done",
		agents: [
			{ agent: "left", status: "done", startedAt: 1_000, finishedAt: 2_000 },
			{ agent: "right", status: "done", startedAt: 1_000, finishedAt: 3_000 },
		],
		agentNames: ["left", "right"],
		taskPreview: "Task: EXT-24-1 shape job",
		startedAt: 1_000,
		finishedAt: 3_000,
	};
	const shapeViews = buildNavigatorTasks(shapeRegistry, [shapeJob], 4_000);
	const shapeState = createExpansionState();
	toggleNavigatorRow(shapeState, flattenNavigatorTree(shapeViews, shapeState).find((row) => row.kind === "umbrella"), true);
	const foldedRows = flattenNavigatorTree(shapeViews, shapeState);
	assert.deepEqual(
		foldedRows.filter((row) => row.taskId === shapeTask.id).map((row) => row.id),
		[`t:${shapeTask.id}`],
		"a settled registry task renders its task row alone under the expanded umbrella",
	);
	assert.deepEqual(
		foldedRows.filter((row) => row.taskId === "job-shape").map((row) => row.id),
		["t:job-shape"],
		"a settled detached job renders its task row alone under the expanded umbrella",
	);
	assert.ok(
		foldedRows.filter((row) => !row.live && row.kind === "task").every((row) => row.depth === 1),
		"the folded settled task rows sit at the umbrella's child depth",
	);

	// Right reveals the rounds through the existing defaults: the settled
	// round renders its summary line, its agents still gated by the round
	// default; a settled detached job reveals its agents directly.
	toggleNavigatorRow(shapeState, foldedRows.find((row) => row.id === `t:${shapeTask.id}`), true);
	const revealedTaskRows = flattenNavigatorTree(shapeViews, shapeState);
	assert.deepEqual(
		revealedTaskRows.filter((row) => row.taskId === shapeTask.id).map((row) => row.id),
		[`t:${shapeTask.id}`, `t:${shapeTask.id}:r1`],
		"expanding the settled task reveals its round summary line alone",
	);
	toggleNavigatorRow(shapeState, revealedTaskRows.find((row) => row.id === `t:${shapeTask.id}:r1`), true);
	assert.deepEqual(
		flattenNavigatorTree(shapeViews, shapeState).filter((row) => row.taskId === shapeTask.id).map((row) => row.id),
		[`t:${shapeTask.id}`, `t:${shapeTask.id}:r1`, `t:${shapeTask.id}:r1:a0`],
		"the round override still gates the settled agent rows behind the revealed round",
	);
	toggleNavigatorRow(shapeState, revealedTaskRows.find((row) => row.id === "t:job-shape"), true);
	assert.deepEqual(
		flattenNavigatorTree(shapeViews, shapeState).filter((row) => row.taskId === "job-shape").map((row) => row.id),
		["t:job-shape", "t:job-shape:a0", "t:job-shape:a1"],
		"expanding the settled detached job reveals its agent rows",
	);

	// Left re-folds both.
	const expandedShapes = flattenNavigatorTree(shapeViews, shapeState);
	toggleNavigatorRow(shapeState, expandedShapes.find((row) => row.id === `t:${shapeTask.id}`), false);
	toggleNavigatorRow(shapeState, expandedShapes.find((row) => row.id === "t:job-shape"), false);
	const refoldedRows = flattenNavigatorTree(shapeViews, shapeState);
	assert.deepEqual(
		refoldedRows.filter((row) => row.taskId === shapeTask.id).map((row) => row.id),
		[`t:${shapeTask.id}`],
		"left re-folds the expanded settled task",
	);
	assert.deepEqual(
		refoldedRows.filter((row) => row.taskId === "job-shape").map((row) => row.id),
		["t:job-shape"],
		"left re-folds the expanded settled job",
	);
}
// <<< EXT-24-1 (default shape)

// >>> EXT-24-1: partition flips carry the user's latest intent
{
	const flipRegistry = createDispatchRegistry();
	const flipTask = flipRegistry.startTask({ mode: "single", prompt: "Task: EXT-24-1 flip probe", now: 1_000 });
	flipRegistry.startRound(flipTask.id, [{ agent: "early" }], 1_000);
	flipRegistry.updateAgent(flipTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const settledViews = buildNavigatorTasks(flipRegistry, [], 3_000);
	const flipState = createExpansionState();
	toggleNavigatorRow(flipState, flattenNavigatorTree(settledViews, flipState).find((row) => row.kind === "umbrella"), true);
	toggleNavigatorRow(flipState, flattenNavigatorTree(settledViews, flipState).find((row) => row.id === `t:${flipTask.id}`), true);
	assert.ok(
		flattenNavigatorTree(settledViews, flipState).some((row) => row.id === `t:${flipTask.id}:r1`),
		"an explicitly expanded settled task renders its round rows",
	);

	// Re-livening through a new round flips the partition: the live rule
	// governs again and the task renders expanded because the expand-while-
	// settled toggle cleared the live set (the user's latest intent was
	// expanded).
	flipRegistry.startRound(flipTask.id, [{ agent: "again" }], 4_000);
	const relivenedViews = buildNavigatorTasks(flipRegistry, [], 5_000);
	assert.equal(relivenedViews[0].live, true, "the new round re-livens the task");
	assert.deepEqual(
		flattenNavigatorTree(relivenedViews, flipState).filter((row) => row.taskId === flipTask.id).map((row) => row.kind),
		["task", "round", "round", "agent"],
		"a task expanded while settled renders expanded once it re-livens",
	);

	// Collapse while live, then settle: the task stays folded under the
	// expanded umbrella (guard: the live collapse carries over and the
	// settled default folds regardless).
	const liveCollapseRows = flattenNavigatorTree(relivenedViews, flipState);
	toggleNavigatorRow(flipState, liveCollapseRows.find((row) => row.id === `t:${flipTask.id}`), false);
	assert.deepEqual(
		flattenNavigatorTree(relivenedViews, flipState).filter((row) => row.taskId === flipTask.id).map((row) => row.id),
		[`t:${flipTask.id}`],
		"collapsing the re-livened task folds its subtree again",
	);
	flipRegistry.updateAgent(flipTask.id, 2, 0, { status: "done", finishedAt: 6_000 });
	const resettledViews = buildNavigatorTasks(flipRegistry, [], 7_000);
	assert.deepEqual(
		flattenNavigatorTree(resettledViews, flipState).filter((row) => row.taskId === flipTask.id).map((row) => row.id),
		[`t:${flipTask.id}`],
		"a task collapsed while live stays folded once it settles",
	);
}
// <<< EXT-24-1 (partition flips)

// >>> EXT-24-1: ruled intent carry for an explicit expand while live
{
	// The Decision Log's ruled outcome for the unit review's advisory
	// design challenge 1 (asymmetric intent carry): an explicit expand
	// while live does NOT carry into settledExpandedTasks, so the task
	// folds on settle. The fold serves the compact-index purpose of the
	// collapse-by-default request and re-expansion is one keypress; the
	// mirrored collapse direction persists via collapsedTasks surviving
	// the flip (pinned in the partition-flips block above).
	const intentRegistry = createDispatchRegistry();
	const intentTask = intentRegistry.startTask({ mode: "single", prompt: "Task: EXT-24-1 intent-carry probe", now: 1_000 });
	intentRegistry.startRound(intentTask.id, [{ agent: "runner" }], 1_000);
	const intentState = createExpansionState();
	const liveIntentRows = flattenNavigatorTree(buildNavigatorTasks(intentRegistry, [], 2_000), intentState);
	toggleNavigatorRow(intentState, liveIntentRows.find((row) => row.id === `t:${intentTask.id}`), false);
	toggleNavigatorRow(intentState, liveIntentRows.find((row) => row.id === `t:${intentTask.id}`), true);
	assert.deepEqual(
		flattenNavigatorTree(buildNavigatorTasks(intentRegistry, [], 2_000), intentState).filter((row) => row.taskId === intentTask.id).map((row) => row.kind),
		["task", "round", "agent"],
		"the explicit expand while live renders the task expanded again",
	);
	intentRegistry.updateAgent(intentTask.id, 1, 0, { status: "done", finishedAt: 3_000 });
	const settledIntentViews = buildNavigatorTasks(intentRegistry, [], 4_000);
	assert.equal(settledIntentViews[0].live, false, "the task settles once its last agent finishes");
	assert.ok(!intentState.settledExpandedTasks.has(intentTask.id), "the explicit expand while live writes no settledExpandedTasks entry");
	toggleNavigatorRow(intentState, flattenNavigatorTree(settledIntentViews, intentState).find((row) => row.kind === "umbrella"), true);
	assert.deepEqual(
		flattenNavigatorTree(settledIntentViews, intentState).filter((row) => row.taskId === intentTask.id).map((row) => row.id),
		[`t:${intentTask.id}`],
		"a task explicitly expanded while live renders folded (its task row alone) once it settles",
	);
}
// <<< EXT-24-1 (ruled intent carry)

// >>> EXT-24-1: the task toggle writes by the row's partition and clears the non-governing set
{
	const writeSettledRegistry = createDispatchRegistry();
	const writeSettledTask = writeSettledRegistry.startTask({ mode: "single", prompt: "Task: EXT-24-1 write probe", now: 1_000 });
	writeSettledRegistry.startRound(writeSettledTask.id, [{ agent: "early" }], 1_000);
	writeSettledRegistry.updateAgent(writeSettledTask.id, 1, 0, { status: "done", finishedAt: 2_000 });
	const writeLiveRegistry = createDispatchRegistry();
	const writeLiveTask = writeLiveRegistry.startTask({ mode: "single", prompt: "Task: EXT-24-1 live write probe", now: 3_000 });
	writeLiveRegistry.startRound(writeLiveTask.id, [{ agent: "runner" }], 3_000);
	const settledDiscovery = createExpansionState();
	toggleNavigatorRow(settledDiscovery, flattenNavigatorTree(buildNavigatorTasks(writeSettledRegistry, [], 4_000), settledDiscovery).find((row) => row.kind === "umbrella"), true);
	const settledRow = flattenNavigatorTree(buildNavigatorTasks(writeSettledRegistry, [], 4_000), settledDiscovery).find((row) => row.kind === "task");
	const liveRow = flattenNavigatorTree(buildNavigatorTasks(writeLiveRegistry, [], 4_000), createExpansionState()).find((row) => row.kind === "task");
	const writeState = createExpansionState();

	toggleNavigatorRow(writeState, settledRow, true);
	assert.ok(writeState.settledExpandedTasks.has(writeSettledTask.id), "expanding a settled task writes settledExpandedTasks");
	assert.ok(!writeState.collapsedTasks.has(writeSettledTask.id), "expanding a settled task leaves collapsedTasks alone");
	toggleNavigatorRow(writeState, settledRow, false);
	assert.ok(!writeState.settledExpandedTasks.has(writeSettledTask.id), "collapsing a settled task clears its settledExpandedTasks entry");

	toggleNavigatorRow(writeState, liveRow, false);
	assert.ok(writeState.collapsedTasks.has(writeLiveTask.id), "collapsing a live task writes collapsedTasks");
	assert.ok(!writeState.settledExpandedTasks.has(writeLiveTask.id), "collapsing a live task leaves settledExpandedTasks alone");
	toggleNavigatorRow(writeState, liveRow, true);
	assert.ok(!writeState.collapsedTasks.has(writeLiveTask.id), "expanding a live task clears its collapsedTasks entry");

	// A stale entry in the non-governing set never survives a toggle: the
	// partition flip would otherwise invert the user's latest intent.
	writeState.collapsedTasks.add(writeSettledTask.id);
	toggleNavigatorRow(writeState, settledRow, true);
	assert.ok(writeState.settledExpandedTasks.has(writeSettledTask.id), "the settled expansion carries the latest intent");
	assert.ok(!writeState.collapsedTasks.has(writeSettledTask.id), "expanding a settled task clears a stale collapsedTasks entry");
	writeState.settledExpandedTasks.add(writeLiveTask.id);
	toggleNavigatorRow(writeState, liveRow, false);
	assert.ok(writeState.collapsedTasks.has(writeLiveTask.id), "the live collapse carries the latest intent");
	assert.ok(!writeState.settledExpandedTasks.has(writeLiveTask.id), "collapsing a live task clears a stale settledExpandedTasks entry");
}
// <<< EXT-24-1 (toggle writes)

console.log("periscope-navigator-tree: all assertions passed");
