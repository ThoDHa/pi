#!/usr/bin/env node
/**
 * Unit suite for the navigator's session-transcript thinking reader
 * (extensions/agent-viewer/navigator.ts, extractTranscriptThinking).
 * Plain node, no test framework:
 *
 *   node tests/agent-viewer-transcript-thinking.test.mjs
 *
 * The reader backs the navigator's t keybinding: on a finished agent
 * it scans the parent session .jsonl for the latest subagent
 * toolResult whose details.results[].agent matches the selected agent
 * and extracts that result's full thinking, uncapped. The reader
 * pre-filters on the serialized tool name, skipping lines without the
 * substring "subagent" before JSON.parse. It returns a tri-state
 * lookup: found=false when no record matches, found=true with empty
 * entries when the matching record holds no thinking parts. Pins:
 * agent matching across a toolResult's result slots, latest-match-wins
 * when one agent was dispatched more than once, no cross-match against
 * other agents or other tools' results, full untruncated text with
 * message timestamps, tolerance of a torn (partial) trailing line
 * from the live-appending file, and the tri-state: not-found for
 * absent agents or sessionless input, found-but-empty for a record
 * holding no thinking parts. Fixture shapes mirror the real transcript:
 * session entries of type "message" whose toolResult message carries
 * details.results[], and results[].messages holding bare assistant
 * messages with thinking parts.
 */

import assert from "node:assert/strict";
import { TRANSCRIPT_WINDOW_TOLERANCE_MS, extractTranscriptThinking } from "../extensions/agent-viewer/navigator.ts";

const thinkingMessage = (timestamp, thoughts) => ({
	role: "assistant",
	timestamp,
	content: thoughts.map((thinking) => ({ type: "thinking", thinking, thinkingSignature: "sig" })),
});

const subagentToolResult = (results, timestamp = 9_000) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolName: "subagent",
		toolCallId: "call_test",
		timestamp,
		isError: false,
		content: [{ type: "text", text: "final output" }],
		details: { mode: "parallel", agentScope: {}, projectAgentsDir: null, results },
	},
});

const result = (agent, messages) => ({
	agent,
	agentSource: "user",
	task: "probe",
	exitCode: 0,
	messages,
	model: "probe-model",
	stderr: "",
	step: undefined,
	stopReason: "end",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
});

// --- the latest matching subagent toolResult wins, from the matching result slot ---

const jsonl = [
	JSON.stringify({ type: "session", version: 3, id: "s1" }),
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
	JSON.stringify(thinkingMessage(1_000, ["parent thought"])),
	JSON.stringify(
		subagentToolResult([
			result("scout", [thinkingMessage(2_000, ["scout old\nmulti line"]), { role: "assistant", timestamp: 2_100, content: [{ type: "text", text: "answer" }] }]),
			result("planner", [thinkingMessage(2_050, ["planner thought"])]),
		]),
	),
	JSON.stringify(
		subagentToolResult([result("scout", [thinkingMessage(3_000, ["scout newest"]), thinkingMessage(3_100, ["scout second block"])])]),
	),
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
	'{"type":"message","message":{"role":"toolRes',
].join("\n");

assert.deepEqual(
	extractTranscriptThinking(jsonl, "scout"),
	{
		found: true,
		entries: [
			{ at: 3_000, text: "scout newest" },
			{ at: 3_100, text: "scout second block" },
		],
	},
	"the latest matching toolResult's thinking wins and earlier matches are discarded",
);

assert.deepEqual(
	extractTranscriptThinking(jsonl, "planner"),
	{ found: true, entries: [{ at: 2_050, text: "planner thought" }] },
	"a non-latest agent still matches its own slot's latest toolResult",
);

assert.deepEqual(
	extractTranscriptThinking(jsonl, "reviewer"),
	{ found: false, entries: [] },
	"an agent with no subagent result is not found, distinct from a found thinkingless record",
);

// --- the later matching record wins the assignment even when it holds no thinking ---

// Record one carries thinking, record two (same agent, later) carries none:
// the later record displaces the earlier one and `found` stays true, so the
// viewer names the record's emptiness instead of showing a stale run's text.
const overwrittenByThinkingless = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(2_000, ["run one thought"])])], 2_000)),
	JSON.stringify(subagentToolResult([result("scout", [{ role: "assistant", timestamp: 3_000, content: [{ type: "text", text: "run two words" }] }])], 3_000)),
].join("\n");
assert.deepEqual(
	extractTranscriptThinking(overwrittenByThinkingless, "scout"),
	{ found: true, entries: [] },
	"a later thinkingless record displaces an earlier thinking-bearing one and found stays true",
);

const overwriteMirror = [
	JSON.stringify(subagentToolResult([result("scout", [{ role: "assistant", timestamp: 2_000, content: [{ type: "text", text: "run one words" }] }])], 2_000)),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(3_000, ["run two thought"])])], 3_000)),
].join("\n");
assert.deepEqual(
	extractTranscriptThinking(overwriteMirror, "scout"),
	{ found: true, entries: [{ at: 3_000, text: "run two thought" }] },
	"the mirrored pair resolves to the later record's thinking the same way",
);

// --- the run window: with one, the latest record inside the window wins; without a qualifier, session-latest fallback ---

const windowedJsonl = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(2_000, ["early run thought"])])], 2_000)),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(8_000, ["late run thought"])])], 8_000)),
].join("\n");

assert.deepEqual(
	extractTranscriptThinking(windowedJsonl, "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{ found: true, entries: [{ at: 2_000, text: "early run thought" }] },
	"a window selects the record inside it over the session-latest one",
);

assert.deepEqual(
	extractTranscriptThinking(windowedJsonl, "scout", { startedAt: 10_000, finishedAt: 12_000 }),
	{ found: true, entries: [{ at: 8_000, text: "late run thought" }] },
	"a window past both records still resolves to the session-latest one",
);

const boundaryWindow = { startedAt: 1_000, finishedAt: 5_000 };
const startEdge = boundaryWindow.startedAt - TRANSCRIPT_WINDOW_TOLERANCE_MS;
const endEdge = boundaryWindow.finishedAt + TRANSCRIPT_WINDOW_TOLERANCE_MS;
const boundaryJsonl = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(startEdge, ["boundary start thought"])])], startEdge)),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(endEdge, ["boundary end thought"])])], endEdge)),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(endEdge + 1, ["outside thought"])])], endEdge + 1)),
].join("\n");
assert.deepEqual(
	extractTranscriptThinking(boundaryJsonl, "scout", boundaryWindow),
	{ found: true, entries: [{ at: endEdge, text: "boundary end thought" }] },
	"records exactly at the tolerance edges are windowed in and the record past the edge stays out",
);

// Two same-name records inside one window, the later thinkingless: the
// windowed assignment follows the same later-record-wins rule as the
// no-window pair above, so the viewer names the newer run's emptiness
// instead of showing the older run's text.
const windowedOverwrite = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(2_000, ["run one thought"])])], 2_000)),
	JSON.stringify(subagentToolResult([result("scout", [{ role: "assistant", timestamp: 3_000, content: [{ type: "text", text: "run two words" }] }])], 3_000)),
].join("\n");
assert.deepEqual(
	extractTranscriptThinking(windowedOverwrite, "scout", { startedAt: 1_000, finishedAt: 4_000 }),
	{ found: true, entries: [] },
	"a later thinkingless record inside the window displaces an earlier thinking-bearing one and found stays true",
);

assert.deepEqual(
	extractTranscriptThinking(windowedJsonl, "scout", { startedAt: 20_000, finishedAt: 22_000 }),
	{ found: true, entries: [{ at: 8_000, text: "late run thought" }] },
	"a window strictly clear of both records and the tolerance edges falls back to the session-latest one",
);

const timestamplessRecord = JSON.parse(JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(4_000, ["timestampless thought"])])])));
delete timestamplessRecord.message.timestamp;
assert.deepEqual(
	extractTranscriptThinking(JSON.stringify(timestamplessRecord), "scout", { startedAt: 3_000, finishedAt: 5_000 }),
	{ found: true, entries: [{ at: 4_000, text: "timestampless thought" }] },
	"a matching record without message.timestamp falls back to a win even with a window passed",
);

assert.deepEqual(
	extractTranscriptThinking(JSON.stringify(subagentToolResult([result("other", [thinkingMessage(2_000, ["other thought"])])])), "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{ found: false, entries: [] },
	"a window over a transcript with no matching record still finds nothing",
);

// --- full text: no truncation, no collapsing, no caps ---

const bigThought = "y".repeat(100_000);
const bigJsonl = JSON.stringify(subagentToolResult([result("worker", [{ role: "assistant", timestamp: 5, content: [{ type: "thinking", thinking: bigThought }] }])]));
const bigEntries = extractTranscriptThinking(bigJsonl, "worker");
assert.equal(bigEntries.found, true);
assert.equal(bigEntries.entries.length, 1);
assert.equal(bigEntries.entries[0].text.length, 100_000, "the transcript reader loads thinking uncapped, unlike the live buffer");

const manyBlocks = extractTranscriptThinking(
	JSON.stringify(
		subagentToolResult([
			result(
				"worker",
				Array.from({ length: 30 }, (_, i) => thinkingMessage(i, [`block ${i}`])),
			),
		]),
	),
	"worker",
);
assert.equal(manyBlocks.entries.length, 30, "the block-count cap does not apply to the transcript reader");

// --- tolerance of the live-appending file: torn trailing lines are skipped ---

const tornTail = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(1_000, ["safe thought"])])])),
	'{"type":"message","message":{"role":"toolResult","details":{"results":[{"agent":"scout"',
].join("\n");
assert.deepEqual(
	extractTranscriptThinking(tornTail, "scout"),
	{ found: true, entries: [{ at: 1_000, text: "safe thought" }] },
	"a partial trailing line never blocks the completed results before it",
);

// --- malformed and non-message lines are skipped, non-subagent toolResults never match ---

assert.deepEqual(
	extractTranscriptThinking(
		[
			"not json at all",
			JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: [], details: { results: [result("scout", [thinkingMessage(1, ["bash thought"])]) ] } } }),
			JSON.stringify({ type: "compaction", id: "c1" }),
			JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", content: [] } }),
			"",
		].join("\n"),
		"scout",
	),
	{ found: false, entries: [] },
	"non-subagent results, malformed lines, and results without details contribute nothing",
);

assert.deepEqual(extractTranscriptThinking("", "scout"), { found: false, entries: [] }, "an empty file finds no record");
assert.deepEqual(
	extractTranscriptThinking(
		JSON.stringify(subagentToolResult([result("scout", [{ role: "assistant", timestamp: 1, content: [{ type: "text", text: "words" }] }])])),
		"scout",
	),
	{ found: true, entries: [] },
	"a matching record with no thinking parts is found with empty entries, not confused with no record",
);

// --- the substring pre-filter: lines lacking "subagent" are skipped unparsed, matching outcomes unchanged ---

// Filler message lines carry no subagent substring, so the reader skips
// them before JSON.parse; the matching toolResult still wins unchanged.
const fillerLines = Array.from({ length: 50 }, (_, i) =>
	JSON.stringify({ type: "message", message: { role: "assistant", timestamp: i, content: [{ type: "text", text: `filler ${i} ${"x".repeat(500)}` }] } }),
);
assert.deepEqual(
	extractTranscriptThinking(
		[...fillerLines, JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(1_000, ["filtered-in thought"])])]))].join("\n"),
		"scout",
	),
	{ found: true, entries: [{ at: 1_000, text: "filtered-in thought" }] },
	"lines without the subagent substring are skipped without disturbing the matching toolResult",
);

// A line merely mentioning subagent passes the filter, then falls
// through the parse and shape checks: the filter may only skip, never match.
assert.deepEqual(
	extractTranscriptThinking(
		[
			JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "dispatched a subagent earlier" }] } }),
			JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(1_000, ["matched thought"])])])),
		].join("\n"),
		"scout",
	),
	{ found: true, entries: [{ at: 1_000, text: "matched thought" }] },
	"a non-toolResult line mentioning subagent falls through the filter and never matches",
);

console.log("agent-viewer-transcript-thinking: all assertions passed");
