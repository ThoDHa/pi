#!/usr/bin/env node
/**
 * Unit suite for the navigator overlay's pure detail-pane model
 * (extensions/agent-viewer/navigator.ts). Plain node, no test
 * framework:
 *
 *   node tests/agent-viewer-navigator-detail.test.mjs
 *
 * Covers resolveDetailModel, which turns the selected tree row plus
 * the current task views into the model the overlay's right pane
 * renders: agent targets resolve through their tree ref (registry and
 * detached alike) and carry the status header fields (model, cwd,
 * tokens, step, duration), the timestamped activity log, the shared
 * usage summary, and the final result text; task and round targets
 * carry summary fields plus one member line per child; a missing or
 * absent selection resolves to the empty model.
 */

import assert from "node:assert/strict";
import { createDispatchRegistry } from "../extensions/subagent/registry.ts";
import { buildNavigatorTasks, createExpansionState, flattenNavigatorTree, resolveDetailModel } from "../extensions/agent-viewer/navigator.ts";

const NOW = 1_000_000;

const registry = createDispatchRegistry();
const single = registry.startTask({ mode: "single", prompt: "Task: EXT-9-8 detail probe", now: 1_000 });
registry.startRound(single.id, [{ agent: "scout" }], 1_000);
registry.updateAgent(single.id, 1, 0, {
	lastActivity: "sweep done",
	usage: { input: 12_000, output: 800, cacheRead: 340_000, cacheWrite: 0, cost: 0.0123, contextTokens: 45_000, turns: 3 },
	model: "openai/gpt-5",
	cwd: "/repo",
	activity: [
		{ at: 2_000, kind: "text", text: "starting the sweep" },
		{ at: 3_000, kind: "toolCall", name: "bash", args: { command: "rg alpha" }, text: "$ rg alpha" },
	],
});
registry.updateAgent(single.id, 1, 0, { status: "done", finishedAt: 26_000, result: { exitCode: 0 } });

const chain = registry.startTask({ mode: "chain", prompt: "broken chain probe", now: 1_000 });
registry.startRound(chain.id, [{ agent: "planner", step: 1 }], 1_000);
registry.updateAgent(chain.id, 1, 0, {
	status: "failed",
	finishedAt: 6_000,
	result: { exitCode: 1, stopReason: "error", errorMessage: "model unavailable" },
});

const detached = {
	id: "job-1",
	mode: "single",
	status: "running",
	agentNames: ["observer"],
	taskPreview: "watch the probe",
	startedAt: 30_000,
	agents: [
		{
			agent: "observer",
			status: "running",
			startedAt: 30_000,
			lastActivity: "read nav.log",
			activity: [{ at: 30_500, kind: "text", text: "read nav.log" }],
			usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 700, turns: 1 },
		},
	],
};

const tasks = buildNavigatorTasks(registry, [detached], NOW);
// The fixture's settled rounds default to collapsed (completed rounds
// collapse to their glyph line); expand them so the agent rows are
// visible for the agent-target assertions.
const expandedState = createExpansionState();
expandedState.roundOverrides.set("t:task-1:r1", true);
expandedState.roundOverrides.set("t:task-2:r1", true);
const rows = flattenNavigatorTree(tasks, expandedState);

// --- agent target: registry agent resolves with header, activity, usage, result ---

const scoutRow = rows.find((row) => row.kind === "agent" && row.agentRef?.source === "registry");
assert.ok(scoutRow, "the fixture exposes a registry agent row");
const scoutModel = resolveDetailModel(scoutRow, tasks);
assert.equal(scoutModel.kind, "agent");
assert.equal(scoutModel.title, "scout");
assert.equal(scoutModel.statusText, "done");
assert.equal(scoutModel.activity.length, 2, "the activity log streams through untouched");
assert.deepEqual(scoutModel.activity[1], { at: 3_000, kind: "toolCall", name: "bash", args: { command: "rg alpha" }, text: "$ rg alpha" });
const scoutFields = Object.fromEntries(scoutModel.fields.map((field) => [field.label, field.value]));
assert.equal(scoutFields.model, "openai/gpt-5");
assert.equal(scoutFields.cwd, "/repo");
assert.equal(scoutFields.tokens, "45k", "the header carries the context-token count");
assert.equal(scoutFields.duration, "25s");
assert.equal(scoutModel.usageText, "3 turns ↑12k ↓800 R340k $0.0123 ctx:45k");
assert.equal(scoutModel.resultText, "completed");
assert.equal(scoutModel.members.length, 0, "agent targets have no member lines");

// --- agent target: failed agent reports the stop reason and error ---

const failedRows = flattenNavigatorTree(buildNavigatorTasks(registry, [], NOW), expandedState);
const plannerRow = failedRows.find((row) => row.kind === "agent" && row.label === "planner");
assert.ok(plannerRow, "the fixture exposes a failed agent row");
const plannerModel = resolveDetailModel(plannerRow, buildNavigatorTasks(registry, [], NOW));
assert.equal(plannerModel.statusText, "failed");
assert.equal(plannerModel.resultText, "failed (error)");
const plannerFields = Object.fromEntries(plannerModel.fields.map((field) => [field.label, field.value]));
assert.equal(plannerFields.error, "model unavailable");
assert.equal(plannerFields.step, "1", "chain agents surface their step index");

// --- agent target: detached agent resolves through the snapshot ref ---

const observerRow = rows.find((row) => row.kind === "agent" && row.agentRef?.source === "detached");
assert.ok(observerRow, "the fixture exposes a detached agent row");
const observerModel = resolveDetailModel(observerRow, tasks);
assert.equal(observerModel.kind, "agent");
assert.equal(observerModel.title, "observer");
assert.equal(observerModel.statusText, "running");
assert.equal(observerModel.resultText, undefined, "a running agent has no result line yet");
assert.equal(observerModel.activity[0]?.text, "read nav.log");
assert.equal(observerModel.usageText, "1 turn ↑500 ↓200 ctx:700");

// --- task target: rounds as member lines ---

const taskRow = rows.find((row) => row.kind === "task" && row.taskId === single.id);
assert.ok(taskRow, "the fixture exposes a registry task row");
const taskModel = resolveDetailModel(taskRow, tasks);
assert.equal(taskModel.kind, "task");
assert.equal(taskModel.title, "EXT-9-8");
assert.equal(taskModel.statusText, "done");
assert.deepEqual(taskModel.activity, [], "task targets stream no activity of their own");
assert.equal(taskModel.members.length, 1);
assert.equal(taskModel.members[0].label, "round 1");
assert.equal(taskModel.members[0].glyph, "done");
assert.ok(taskModel.members[0].detail.includes("1/1 done"), "member lines summarize their children");

// --- round target: agents as member lines ---

const roundRow = rows.find((row) => row.kind === "round");
assert.ok(roundRow, "the fixture exposes a round row");
const roundModel = resolveDetailModel(roundRow, tasks);
assert.equal(roundModel.kind, "round");
assert.equal(roundModel.title, "round 1");
assert.equal(roundModel.members.length, 1);
assert.equal(roundModel.members[0].label, "scout");
assert.equal(roundModel.members[0].glyph, "done");

// --- task target: detached task members are its agents ---

const detachedTaskRow = rows.find((row) => row.kind === "task" && row.taskId === "job-1");
assert.ok(detachedTaskRow, "the fixture exposes a detached task row");
const detachedModel = resolveDetailModel(detachedTaskRow, tasks);
assert.equal(detachedModel.kind, "task");
assert.equal(detachedModel.title, "watch the probe");
assert.equal(detachedModel.members.length, 1);
assert.equal(detachedModel.members[0].label, "observer");
assert.equal(detachedModel.members[0].glyph, "running");

// --- missing and absent selections resolve to the empty model ---

const emptyModel = resolveDetailModel(null, tasks);
assert.equal(emptyModel.kind, "empty");
assert.deepEqual(emptyModel.fields, []);
assert.deepEqual(emptyModel.members, []);
const orphanRow = { ...taskRow, taskId: "task-999" };
assert.equal(resolveDetailModel(orphanRow, tasks).kind, "empty", "a row whose task vanished resolves empty");

console.log("agent-viewer-navigator-detail: all assertions passed");
