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
 * (the abort-cleanup path), the startAgent lazy publication path
 * (empty-roster rounds filling at worker pickup, pickup-time
 * startedAt, loud throws on unknown ids and out-of-order slots),
 * reset for session replacement, the
 * extractLastActivity helper over streaming message lists (thinking
 * parts never become the last activity), the extractActivityLog and
 * mergeAgentUpdate helpers the per-agent activity wiring shares
 * (thinking entries interleaved in stream order, empty and redacted
 * thinking skipped, the shared ACTIVITY_LOG_MAX cap), the
 * formatUsageSummary usage formatter,
 * per-slot agent nodes on the detached-job snapshot, the
 * replace-by-id detached-snapshot upsert (array identity preserved),
 * and the globalThis-converged shared dispatch state the viewer
 * extension reads (one state object across module instances,
 * in-place clears).
 */

import assert from "node:assert/strict";
import {
	ACTIVITY_LOG_MAX,
	createDispatchRegistry,
	extractActivityLog,
	extractLastActivity,
	extractThinkingEntries,
	extractThinkingLog,
	formatUsageSummary,
	getSharedDispatchState,
	mergeAgentUpdate,
	THINKING_LOG_MAX_BLOCKS,
	THINKING_LOG_MAX_BYTES,
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

// --- startAgent: lazy node publication at worker pickup (the blocking parallel path) ---

const lazy = createDispatchRegistry();
const lazyTask = lazy.startTask({ mode: "parallel", prompt: "fan out", now: NOW });
const lazyRound = lazy.startRound(lazyTask.id, [], NOW);
assert.equal(lazyRound.index, 1);
assert.deepEqual(lazyRound.agents, [], "an empty-roster round starts with no nodes");

const pickedFirst = lazy.startAgent(lazyTask.id, 1, 0, { agent: "scout" }, NOW + 1_000);
assert.equal(pickedFirst.status, "running");
assert.equal(pickedFirst.startedAt, NOW + 1_000, "a lazily started node stamps its own pickup time, not the round's");
assert.equal(lazy.getTask(lazyTask.id)?.rounds[0]?.agents.length, 1);

lazy.startAgent(lazyTask.id, 1, 1, { agent: "worker" }, NOW + 2_000);
lazy.updateAgent(lazyTask.id, 1, 1, { status: "done", finishedAt: NOW + 3_000 });
const pickedSecond = lazy.getTask(lazyTask.id)?.rounds[0]?.agents[1];
assert.equal(pickedSecond?.status, "done", "updateAgent merges into lazily created nodes");
assert.equal(pickedSecond?.finishedAt, NOW + 3_000);

assert.throws(() => lazy.startAgent("task-999", 1, 2, { agent: "scout" }), /unknown task id/);
assert.throws(() => lazy.startAgent(lazyTask.id, 99, 2, { agent: "scout" }), /unknown round/);
assert.throws(() => lazy.startAgent(lazyTask.id, 1, 0, { agent: "late" }), /out-of-order slot/, "a slot below the node count would misattribute a started node");
assert.equal(lazy.getTask(lazyTask.id)?.rounds[0]?.agents.length, 2, "a rejected append leaves the round untouched");

lazy.updateAgent(lazyTask.id, 1, 2, { status: "done" });
assert.equal(lazy.getTask(lazyTask.id)?.rounds[0]?.agents.length, 2, "updates for never-created slots stay no-ops");

lazy.failRunningAgents(lazyTask.id, NOW + 4_000);
const lazyNodes = lazy.getTask(lazyTask.id)?.rounds[0]?.agents ?? [];
assert.equal(lazyNodes.length, 2, "the abort cleanup creates no nodes for never-picked-up slots");
assert.equal(lazyNodes[0]?.status, "failed");
assert.equal(lazyNodes[0]?.finishedAt, NOW + 4_000);
assert.equal(lazyNodes[1]?.status, "done", "already-settled lazy nodes keep their status");

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
	{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", name: "read", arguments: { file_path: "/tmp/x.ts" } }] },
];
assert.equal(extractLastActivity(thinkingThenTool), "read /tmp/x.ts");

const onlyThinking = [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }];
assert.equal(extractLastActivity(onlyThinking), undefined);

const thinkingAfterText = [
	{ role: "assistant", content: [{ type: "text", text: "final answer" }, { type: "thinking", thinking: "hmm" }] },
];
assert.equal(
	extractLastActivity(thinkingAfterText),
	"final answer",
	"a trailing thinking part does not become the last activity",
);

const longText = "y".repeat(200);
const activity = extractLastActivity([{ role: "assistant", content: [{ type: "text", text: longText }] }]);
assert.ok(activity !== undefined && activity.length < 200, "long text activity is truncated");

// --- extractActivityLog: ordered activity entries for the navigator detail pane ---

assert.deepEqual(extractActivityLog([]), []);
assert.deepEqual(
	extractActivityLog([
		{
			role: "assistant",
			timestamp: 500,
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinkingSignature: "redacted" },
				{ type: "thinking" },
				{ type: "text", text: "visible" },
			],
		},
	]),
	[{ at: 500, kind: "text", text: "visible" }],
	"empty and redacted thinking blocks carry no entries",
);

const logged = extractActivityLog([
	{ role: "user", content: [{ type: "text", text: "prompt" }] },
	{
		role: "assistant",
		timestamp: 1_000,
		content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "starting the sweep" },
			{ type: "toolCall", name: "bash", arguments: { command: "rg alpha in files" } },
		],
	},
	{ role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "sweep done" }] },
]);
assert.equal(logged.length, 4, "one entry per activity-bearing content part, in stream order");
assert.deepEqual(logged[0], { at: 1_000, kind: "thinking", text: "hmm" }, "a thinking part emits exactly the contract's entry shape");
assert.deepEqual(logged[1], { at: 1_000, kind: "text", text: "starting the sweep" });
assert.equal(logged[2].kind, "toolCall");
assert.equal(logged[2].at, 1_000);
assert.equal(logged[2].name, "bash");
assert.deepEqual(logged[2].args, { command: "rg alpha in files" });
assert.equal(logged[2].text, "$ rg alpha in files", "toolCall entries carry the shared one-line description");
assert.equal(logged[3].at, 2_000);
assert.equal(logged[3].text, "sweep done");

const untimed = extractActivityLog([{ role: "assistant", content: [{ type: "text", text: "no timestamp" }] }]);
assert.equal(untimed[0].at, 0, "a message without a timestamp stamps its entry 0");

const flooded = Array.from({ length: 60 }, (_, i) => ({
	role: "assistant",
	timestamp: i,
	content: [{ type: "text", text: `line ${i}` }],
}));
const capped = extractActivityLog(flooded);
assert.equal(capped.length, ACTIVITY_LOG_MAX, "the activity log is capped");
assert.equal(capped[0].text, `line ${flooded.length - ACTIVITY_LOG_MAX}`, "the cap keeps the most recent entries");
assert.equal(capped[capped.length - 1].text, `line ${flooded.length - 1}`);

const thinkingFlood = Array.from({ length: 30 }, (_, i) => ({
	role: "assistant",
	timestamp: i,
	content: [{ type: "thinking", thinking: `thought ${i}` }, { type: "text", text: `line ${i}` }],
}));
const thinkingCapped = extractActivityLog(thinkingFlood);
assert.equal(thinkingCapped.length, ACTIVITY_LOG_MAX, "thinking entries count against the activity cap");
assert.deepEqual(
	thinkingCapped[0],
	{ at: 5, kind: "thinking", text: "thought 5" },
	"the cap walk includes thinking when deciding what survives",
);
assert.deepEqual(thinkingCapped[1], { at: 5, kind: "text", text: "line 5" });
assert.equal(thinkingCapped[ACTIVITY_LOG_MAX - 1].kind, "text");

// --- extractActivityLog: tail-scan output identity with the forward-walk reference ---

// The forward-walk reference of the module's current semantics: full
// walk building every entry, then a tail slice. The module's
// extractActivityLog must reproduce its output byte-for-byte on every
// fixture, including where the cap splits a message's parts.
function forwardActivityLog(messages) {
	const truncate = (text) => {
		const collapsed = text.replace(/\s+/g, " ").trim();
		return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
	};
	const describe = (name, args) => {
		const firstString = (value) => (typeof value === "string" ? value : undefined);
		switch (name) {
			case "bash": return `$ ${truncate(firstString(args.command) ?? "...")}`;
			case "read": return `read ${truncate(firstString(args.file_path ?? args.path) ?? "...")}`;
			case "write": return `write ${truncate(firstString(args.file_path ?? args.path) ?? "...")}`;
			case "edit": return `edit ${truncate(firstString(args.file_path ?? args.path) ?? "...")}`;
			case "grep": return `grep ${truncate(firstString(args.pattern) ?? "")}`;
			case "find": return `find ${truncate(firstString(args.pattern) ?? "")}`;
			default: return name;
		}
	};
	const entries = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const at = message.timestamp ?? 0;
		for (const part of message.content) {
			if (part.type === "text" && part.text?.trim()) {
				entries.push({ at, kind: "text", text: truncate(part.text) });
			} else if (part.type === "toolCall" && part.name) {
				entries.push({ at, kind: "toolCall", text: describe(part.name, part.arguments ?? {}), name: part.name, args: part.arguments });
			} else if (part.type === "thinking" && part.thinking?.trim()) {
				entries.push({ at, kind: "thinking", text: truncate(part.thinking) });
			}
		}
	}
	return entries.length > ACTIVITY_LOG_MAX ? entries.slice(entries.length - ACTIVITY_LOG_MAX) : entries;
}

const dense = Array.from({ length: 40 }, (_, i) => ({
	role: "assistant",
	timestamp: i,
	content: [
		{ type: "thinking", thinking: `thought ${i}` },
		{ type: "text", text: `alpha step ${i}` },
		{ type: "text", text: `beta step ${i}` },
		{ type: "text", text: `gamma step ${i}` },
	],
}));
assert.deepEqual(extractActivityLog(dense), forwardActivityLog(dense), "identity on an over-cap run whose cap splits a message's parts");

const toolStream = Array.from({ length: 30 }, (_, i) => ({
	role: "assistant",
	timestamp: 1_000 + i,
	content: [
		{ type: "text", text: `probe ${i}` },
		{ type: "toolCall", name: i % 2 ? "bash" : "grep", arguments: i % 2 ? { command: `rg case ${i}` } : { pattern: `pat-${i}` } },
	],
}));
assert.deepEqual(extractActivityLog(toolStream), forwardActivityLog(toolStream), "identity with tool-call entries across the cap");

const exactCap = Array.from({ length: ACTIVITY_LOG_MAX }, (_, i) => ({ role: "assistant", timestamp: i, content: [{ type: "text", text: `exact ${i}` }] }));
assert.deepEqual(extractActivityLog(exactCap), forwardActivityLog(exactCap), "identity at exactly the cap");

const sparseMixed = [
	{ role: "user", content: [{ type: "text", text: "prompt" }] },
	{ role: "assistant", content: [{ type: "thinking", thinking: "a  multi-line\nthought" }] },
	{ role: "assistant", timestamp: 5, content: [{ type: "text", text: "a  spaced\nout" }] },
	{ role: "assistant", content: [{ type: "text", text: "b" }, { type: "thinking", thinking: "weigh the edit" }, { type: "toolCall", name: "edit", arguments: { file_path: "/tmp/x.ts" } }] },
	{ role: "assistant", timestamp: 6, content: [{ type: "text", text: "tail" }] },
];
assert.deepEqual(extractActivityLog(sparseMixed), forwardActivityLog(sparseMixed), "identity under the cap with untimed and thinking-only messages");

// --- extractThinkingLog: full-text thinking entries for the navigator's thinking view ---

assert.deepEqual(extractThinkingLog([]), []);
assert.deepEqual(extractThinkingEntries([], Infinity, Infinity), []);

const mixedStream = [
	{ role: "user", content: [{ type: "text", text: "prompt" }] },
	{
		role: "assistant",
		timestamp: 1_000,
		content: [
			{ type: "thinking", thinking: "" },
			{ type: "thinking", thinkingSignature: "redacted" },
			{ type: "thinking" },
			{ type: "thinking", thinking: "first thought\nsecond line" },
			{ type: "toolCall", name: "bash", arguments: { command: "rg alpha" } },
			{ type: "text", text: "visible text" },
		],
	},
	{
		role: "assistant",
		content: [{ type: "thinking", thinking: "untimed thought" }],
	},
	{
		role: "assistant",
		timestamp: 2_000,
		content: [{ type: "thinking", thinking: "latest thought" }],
	},
];
assert.deepEqual(extractThinkingLog(mixedStream), [
	{ at: 1_000, text: "first thought\nsecond line" },
	{ at: 0, text: "untimed thought" },
	{ at: 2_000, text: "latest thought" },
], "one full-text entry per non-blank thinking part, in stream order, stamped with the message timestamp");
assert.deepEqual(
	extractThinkingLog([{ role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: "words" }] }]),
	[],
	"text and toolCall parts contribute no thinking entries",
);

// Full text is the contract: no truncation, no whitespace collapsing.
const longThought = `\tponder  line one\n\n${"x".repeat(5_000)}`;
assert.deepEqual(
	extractThinkingLog([{ role: "assistant", timestamp: 5, content: [{ type: "thinking", thinking: longThought }] }]),
	[{ at: 5, text: longThought }],
);

// --- extractThinkingLog: the block-count and byte caps keep the most recent blocks ---

const block = (index) => ({
	role: "assistant",
	timestamp: index,
	content: [{ type: "thinking", thinking: `thought ${index}` }],
});
const floodedThoughts = extractThinkingLog(Array.from({ length: THINKING_LOG_MAX_BLOCKS + 5 }, (_, i) => block(i)));
assert.equal(floodedThoughts.length, THINKING_LOG_MAX_BLOCKS, "the thinking log is capped at the block count");
assert.equal(floodedThoughts[0].text, `thought ${5}`, "the cap keeps the most recent blocks");
assert.equal(floodedThoughts[THINKING_LOG_MAX_BLOCKS - 1].text, `thought ${THINKING_LOG_MAX_BLOCKS + 4}`);

const tenKb = "a".repeat(10_000);
const sized = (index) => ({
	role: "assistant",
	timestamp: index,
	content: [{ type: "thinking", thinking: tenKb }],
});
const byteCapped = extractThinkingLog(Array.from({ length: 8 }, (_, i) => sized(i)));
assert.equal(byteCapped.length, 6, "the byte cap drops the oldest whole blocks: 7 blocks would reach 70 KB over the 64 KB cap");
assert.deepEqual(byteCapped[0], { at: 2, text: tenKb });
assert.equal(byteCapped[5].at, 7);

const exactFit = extractThinkingLog(Array.from({ length: 4 }, (_, i) => ({
	role: "assistant",
	timestamp: i,
	content: [{ type: "thinking", thinking: "b".repeat(THINKING_LOG_MAX_BYTES / 4) }],
})));
assert.equal(exactFit.length, 4, "blocks summing to exactly the byte cap all survive");

const overFit = extractThinkingLog([
	{ role: "assistant", timestamp: 0, content: [{ type: "thinking", thinking: "c".repeat(THINKING_LOG_MAX_BYTES) }] },
	{ role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "d".repeat(THINKING_LOG_MAX_BYTES) }] },
]);
assert.equal(overFit.length, 1, "a block that would cross the byte cap is excluded whole");
assert.equal(overFit[0].at, 1, "the newest of the oversized pair survives");

const singleOversized = extractThinkingLog([
	{ role: "assistant", timestamp: 3, content: [{ type: "thinking", thinking: "e".repeat(THINKING_LOG_MAX_BYTES * 2) }] },
]);
assert.equal(singleOversized.length, 1, "the newest block is retained even when it alone exceeds the byte cap");

const uncapped = extractThinkingEntries(Array.from({ length: 30 }, (_, i) => block(i)), Infinity, Infinity);
assert.equal(uncapped.length, 30, "infinite caps disable both bounds for the transcript reader");
assert.equal(uncapped[0].text, "thought 0");

// --- mergeAgentUpdate: the defined-field merge both publishers share ---

const mergedNode = { agent: "worker", status: "running", startedAt: NOW };
mergeAgentUpdate(mergedNode, {
	lastActivity: "$ rg pattern",
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 100, turns: 2 },
	model: "openai/gpt-5",
	cwd: "/repo",
});
assert.equal(mergedNode.status, "running", "an update without a status keeps the node's status");
assert.equal(mergedNode.lastActivity, "$ rg pattern");
assert.equal(mergedNode.model, "openai/gpt-5");
assert.equal(mergedNode.cwd, "/repo");
mergeAgentUpdate(mergedNode, { status: "done", finishedAt: NOW + 5_000, lastActivity: undefined });
assert.equal(mergedNode.status, "done");
assert.equal(mergedNode.finishedAt, NOW + 5_000);
assert.equal(mergedNode.lastActivity, "$ rg pattern", "undefined update fields never clobber node fields");

mergeAgentUpdate(mergedNode, { thinkingLog: [{ at: NOW, text: "weighed the options" }] });
assert.deepEqual(mergedNode.thinkingLog, [{ at: NOW, text: "weighed the options" }], "the thinking log merges like every other defined field");
mergeAgentUpdate(mergedNode, { thinkingLog: [{ at: NOW + 1, text: "revised thought" }] });
assert.deepEqual(mergedNode.thinkingLog, [{ at: NOW + 1, text: "revised thought" }], "a fresh thinking log replaces the stale one");

// registry.updateAgent merges through the same helper: a thinking-log
// update lands on the registry node like every other defined field.
const thinkingRegistry = createDispatchRegistry();
const thinkingTask = thinkingRegistry.startTask({ mode: "single", prompt: "p", now: NOW });
thinkingRegistry.startRound(thinkingTask.id, [{ agent: "dreamer" }], NOW);
thinkingRegistry.updateAgent(thinkingTask.id, 1, 0, {
	thinkingLog: [{ at: NOW, text: "live thought" }],
});
assert.deepEqual(
	thinkingRegistry.getTask(thinkingTask.id)?.rounds[0]?.agents[0]?.thinkingLog,
	[{ at: NOW, text: "live thought" }],
);

// registry.updateAgent merges through the same helper: an activity-array
// update lands on the registry node like every other defined field.
const activityRegistry = createDispatchRegistry();
const activityTask = activityRegistry.startTask({ mode: "single", prompt: "p", now: NOW });
activityRegistry.startRound(activityTask.id, [{ agent: "scout" }], NOW);
activityRegistry.updateAgent(activityTask.id, 1, 0, {
	activity: [{ at: NOW, kind: "text", text: "hello" }],
	model: "openai/gpt-5",
	cwd: "/repo",
});
const activityNode = activityRegistry.getTask(activityTask.id)?.rounds[0]?.agents[0];
assert.deepEqual(activityNode?.activity, [{ at: NOW, kind: "text", text: "hello" }]);
assert.equal(activityNode?.model, "openai/gpt-5");
assert.equal(activityNode?.cwd, "/repo");

// --- formatUsageSummary: plain usage text shared with the detail pane ---

assert.equal(
	formatUsageSummary({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
	"",
	"silent usage renders empty, not a row of zeros",
);
assert.equal(
	formatUsageSummary({ input: 12_000, output: 800, cacheRead: 340_000, cacheWrite: 0, cost: 0.0123, contextTokens: 45_000, turns: 3 }),
	"3 turns ↑12k ↓800 R340k $0.0123 ctx:45k",
);
assert.equal(
	formatUsageSummary({ input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }),
	"1 turn ↑500 ↓200",
);

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

// Per-slot agent nodes join the snapshot additively (EXT-1-3 wiring): the
// strip keeps reading agentNames, the navigator reads agents.
upsertDetachedJobSnapshot(upsertJobs, {
	id: "job-4",
	mode: "parallel",
	status: "running",
	agentNames: ["worker", "reviewer"],
	taskPreview: "fan out the reconciliation",
	startedAt: NOW,
	agents: [
		{
			agent: "worker",
			status: "running",
			startedAt: NOW,
			lastActivity: "$ rg pattern",
			model: "openai/gpt-5",
			cwd: "/repo",
		},
		{ agent: "reviewer", status: "running", startedAt: NOW },
	],
});
assert.equal(upsertJobs[2].agents?.length, 2, "snapshots carry one node per dispatch slot");
assert.equal(upsertJobs[2].agents?.[0].agent, "worker");
assert.equal(upsertJobs[2].agents?.[0].lastActivity, "$ rg pattern");
assert.equal(upsertJobs[2].agents?.[0].model, "openai/gpt-5");
assert.equal(upsertJobs[2].agents?.[0].cwd, "/repo");
assert.equal(upsertJobs[2].agents?.[1].agent, "reviewer");
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
