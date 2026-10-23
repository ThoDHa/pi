#!/usr/bin/env node
/**
 * Unit suite for the active-dispatch registry
 * (extensions/subagent/registry.ts). Plain node, no test framework:
 *
 *   node tests/subagent-dispatch-registry.test.mjs
 *
 * Covers the task -> dispatch round -> agent node shape the strip
 * consumes now and the navigator consumes in EXT-1-3: task creation
 * with sequential ids, round creation per dispatch round (one for
 * single/parallel, one per chain step), agent status transitions
 * running -> done/failed with usage/result snapshots, unknown-id
 * updates ignored, failRunningAgents marking only running agents
 * (the abort-cleanup path), reset for session replacement, the
 * extractLastActivity helper over streaming message lists, the
 * replace-by-id detached-snapshot upsert (array identity preserved),
 * and the globalThis-converged shared dispatch state the viewer
 * extension reads (one state object across module instances,
 * in-place clears).
 */

import assert from "node:assert/strict";
import {
	createDispatchRegistry,
	extractLastActivity,
	getSharedDispatchState,
	upsertDetachedJobSnapshot,
} from "../extensions/subagent/registry.ts";

const NOW = 1_000_000;

// --- startTask / startRound: shape and sequential ids ---

const registry = createDispatchRegistry();
const single = registry.startTask({ mode: "single", prompt: "Task: EXT-1-2 checkpoint 1", now: NOW });
assert.equal(single.id, "task-1");
assert.equal("label" in single, false, "task nodes carry the prompt, not a publication-time label");
assert.equal(single.mode, "single");
assert.equal(single.prompt, "Task: EXT-1-2 checkpoint 1");
assert.equal(single.startedAt, NOW);
assert.deepEqual(single.rounds, []);

const round = registry.startRound(single.id, [{ agent: "worker" }], NOW);
assert.equal(round.index, 1);
assert.equal(round.agents.length, 1);
assert.equal(round.agents[0].agent, "worker");
assert.equal(round.agents[0].status, "running");
assert.equal(round.agents[0].startedAt, NOW);

const second = registry.startTask({ mode: "parallel", prompt: "fan out", now: NOW });
assert.equal(second.id, "task-2", "task ids increment sequentially");

// --- updateAgent: running -> done with usage/result snapshots ---

registry.updateAgent(single.id, 1, 0, {
	lastActivity: "$ rg pattern",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 100, turns: 2 },
});
assert.equal(registry.getTask(single.id)?.rounds[0]?.agents[0]?.lastActivity, "$ rg pattern");
assert.equal(registry.getTask(single.id)?.rounds[0]?.agents[0]?.status, "running", "activity update alone keeps the agent running");

registry.updateAgent(single.id, 1, 0, {
	status: "done",
	finishedAt: NOW + 5_000,
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 100, turns: 3 },
	result: { exitCode: 0 },
});
const finishedAgent = registry.getTask(single.id)?.rounds[0]?.agents[0];
assert.equal(finishedAgent?.status, "done");
assert.equal(finishedAgent?.finishedAt, NOW + 5_000);
assert.deepEqual(finishedAgent?.result, { exitCode: 0 });
assert.equal(finishedAgent?.usage?.turns, 3);

// --- chain shape: one round per step, failed step keeps its status ---

const chain = registry.startTask({ mode: "chain", prompt: "step one", now: NOW });
const chainRound1 = registry.startRound(chain.id, [{ agent: "scout", step: 1 }], NOW);
const chainRound2 = registry.startRound(chain.id, [{ agent: "planner", step: 2 }], NOW + 1_000);
assert.equal(chainRound1.index, 1);
assert.equal(chainRound2.index, 2);
registry.updateAgent(chain.id, 1, 0, { status: "done", finishedAt: NOW + 2_000 });
registry.updateAgent(chain.id, 2, 0, {
	status: "failed",
	finishedAt: NOW + 3_000,
	result: { exitCode: 1, stopReason: "error" },
});
const chainNode = registry.getTask(chain.id);
assert.equal(chainNode?.rounds.length, 2);
assert.equal(chainNode?.rounds[0]?.agents[0]?.status, "done");
assert.equal(chainNode?.rounds[1]?.agents[0]?.status, "failed");
assert.equal(chainNode?.rounds[1]?.agents[0]?.result?.stopReason, "error");
assert.deepEqual(registry.tasks().map((task) => task.id), ["task-1", "task-2", chain.id]);

// --- parallel shape: several agent slots in one round ---

const parallel = registry.startTask({ mode: "parallel", prompt: "fan out", now: NOW });
registry.startRound(parallel.id, [{ agent: "a" }, { agent: "b" }, { agent: "a" }], NOW);
registry.updateAgent(parallel.id, 1, 1, { status: "done", finishedAt: NOW + 1_000 });
assert.equal(registry.getTask(parallel.id)?.rounds[0]?.agents.length, 3);
assert.equal(registry.getTask(parallel.id)?.rounds[0]?.agents[1]?.status, "done");
assert.equal(registry.getTask(parallel.id)?.rounds[0]?.agents[0]?.status, "running");

// --- updateAgent with unknown ids is a no-op, not a throw ---

registry.updateAgent("task-999", 1, 0, { status: "done" });
registry.updateAgent(single.id, 99, 0, { status: "done" });
registry.updateAgent(single.id, 1, 42, { status: "done" });
assert.equal(registry.getTask(single.id)?.rounds.length, 1);

// --- failRunningAgents marks only running agents (abort cleanup) ---

registry.failRunningAgents(parallel.id, NOW + 9_000);
const parallelAgents = registry.getTask(parallel.id)?.rounds[0]?.agents ?? [];
assert.deepEqual(
	parallelAgents.map((agent) => agent.status),
	["failed", "done", "failed"],
	"only running agents are marked failed",
);
assert.equal(parallelAgents[0]?.finishedAt, NOW + 9_000);
assert.equal(parallelAgents[1]?.finishedAt, NOW + 1_000, "already-finished agents keep their finish time");

// --- reset clears everything (session replacement) ---

registry.reset();
assert.deepEqual(registry.tasks(), []);
assert.equal(registry.getTask(single.id), undefined);
const afterReset = registry.startTask({ mode: "single", prompt: "fresh", now: NOW });
assert.equal(afterReset.id, "task-1", "id counter restarts after reset");

// --- extractLastActivity over streaming messages ---

assert.equal(extractLastActivity([]), undefined);

const toolCallLast = [
	{ role: "assistant", content: [{ type: "text", text: "looking" }] },
	{ role: "user", content: [{ type: "toolResult", text: "out" }] },
	{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "rg pattern in files" } }] },
];
assert.equal(extractLastActivity(toolCallLast), "$ rg pattern in files");

const textLast = [{ role: "assistant", content: [{ type: "text", text: "first line\nsecond line" }] }];
assert.equal(extractLastActivity(textLast), "first line second line", "multi-line activity collapses to one strip line");

const thinkingThenTool = [
	{ role: "assistant", content: [{ type: "thinking", text: "hmm" }, { type: "toolCall", name: "read", arguments: { file_path: "/tmp/x.ts" } }] },
];
assert.equal(extractLastActivity(thinkingThenTool), "read /tmp/x.ts");

const onlyThinking = [{ role: "assistant", content: [{ type: "thinking", text: "hmm" }] }];
assert.equal(extractLastActivity(onlyThinking), undefined);

const longText = "y".repeat(200);
const activity = extractLastActivity([{ role: "assistant", content: [{ type: "text", text: longText }] }]);
assert.ok(activity !== undefined && activity.length < 200, "long text activity is truncated");

// --- getSharedDispatchState: one globalThis-converged state ---

const shared = getSharedDispatchState();
assert.equal(getSharedDispatchState(), shared, "repeated calls return the same state object");
assert.ok(shared.registry, "state carries the dispatch registry");
assert.deepEqual(shared.detachedJobs, [], "state starts with no detached-job snapshots");

shared.detachedJobs.push({
	id: "job-1",
	mode: "single",
	status: "running",
	agentNames: ["scout"],
	taskPreview: "map the auth module",
	startedAt: NOW,
});
assert.equal(getSharedDispatchState().detachedJobs.length, 1, "publication is visible through every reference");
shared.detachedJobs.length = 0;
assert.equal(getSharedDispatchState().detachedJobs.length, 0, "in-place clear empties the shared state");
assert.equal(getSharedDispatchState().detachedJobs, shared.detachedJobs, "clear keeps the array identity");

// --- upsertDetachedJobSnapshot: replace-by-id publication mechanic ---

const upsertJobs = [
	{ id: "job-1", mode: "single", status: "running", agentNames: ["scout"], taskPreview: "map the auth module", startedAt: NOW },
];
upsertDetachedJobSnapshot(upsertJobs, {
	id: "job-2",
	mode: "parallel",
	status: "running",
	agentNames: ["worker", "reviewer"],
	taskPreview: "fan out the reconciliation",
	startedAt: NOW,
});
assert.equal(upsertJobs.length, 2, "an unseen id is appended");
assert.equal(upsertJobs[1].id, "job-2");

upsertDetachedJobSnapshot(upsertJobs, {
	id: "job-1",
	mode: "single",
	status: "done",
	agentNames: ["scout"],
	taskPreview: "map the auth module",
	startedAt: NOW,
	finishedAt: NOW + 30_000,
});
assert.equal(upsertJobs.length, 2, "replace-by-id does not grow the array");
assert.equal(upsertJobs[0].status, "done", "the existing snapshot is replaced by id");
assert.equal(upsertJobs[0].id, "job-1", "replacement keeps the snapshot's position");
assert.equal(upsertJobs[1].id, "job-2", "later snapshots are untouched by the replace");
// An alias comparison of one local binding cannot fail, so the identity
// property is pinned on the real contract surface instead: an upsert into
// the array obtained via getSharedDispatchState() must mutate that array
// in place, keeping the accessor's reference valid.
const sharedJobs = getSharedDispatchState().detachedJobs;
upsertDetachedJobSnapshot(sharedJobs, {
	id: "job-3",
	mode: "single",
	status: "running",
	agentNames: ["scout"],
	taskPreview: "map the auth module",
	startedAt: NOW,
});
assert.equal(getSharedDispatchState().detachedJobs.length, 1, "an upsert into the shared array publishes through the accessor");
assert.equal(getSharedDispatchState().detachedJobs, sharedJobs, "an upsert into the shared array keeps its identity (in-place mutation)");
shared.detachedJobs.length = 0;

// pi evaluates the contract module once per extension entrypoint, so
// convergence must hold across module instances, not just calls: a
// second evaluation (distinct module URL via query string) must
// observe the same globalThis state object.
const secondInstance = await import("../extensions/subagent/registry.ts?second-instance");
assert.equal(secondInstance.getSharedDispatchState(), shared, "a fresh module evaluation converges on the same globalThis state");

console.log("subagent-dispatch-registry: all assertions passed");
