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
 * when one agent was dispatched more than once, windowed slot-span
 * matching with its byte-identical session-latest fallback, no
 * cross-match against other agents or other tools' results, full
 * untruncated text with message timestamps, tolerance of a torn
 * (partial) trailing line from the live-appending file, and the
 * tri-state: not-found for absent agents or sessionless input,
 * found-but-empty for a record holding no thinking parts. The
 * whole-string lookup is a thin wrapper over an incremental
 * feed/finish scanner (createTranscriptThinkingScanner) so the streamed
 * t read can feed readline's lines into the same logic: a parity
 * corpus drives both entry points with identical strings across the
 * fixture shapes, boundary variants pin the line-boundary differences
 * (trailing newline, no trailing newline, blank lines, CRLF), and the
 * scanner's own tri-state is pinned directly. Fixture shapes mirror the real transcript:
 * session entries of type "message" whose toolResult message carries
 * details.results[], and results[].messages holding bare assistant
 * messages with thinking parts.
 */

import assert from "node:assert/strict";
import { TRANSCRIPT_WINDOW_TOLERANCE_MS, createTranscriptThinkingScanner, extractTranscriptThinking } from "../extensions/agent-viewer/navigator.ts";

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

// --- the run window: a slot competes by its own message-timestamp span inside the window; without a qualifier or a competing slot, session-latest fallback ---

const windowedJsonl = [
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(2_000, ["early run thought"])])], 2_000)),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(8_000, ["late run thought"])])], 8_000)),
].join("\n");

assert.deepEqual(
	extractTranscriptThinking(windowedJsonl, "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{ found: true, entries: [{ at: 2_000, text: "early run thought" }] },
	"a window selects the record whose slot's span sits inside it over the session-latest one",
);

assert.deepEqual(
	extractTranscriptThinking(windowedJsonl, "scout", { startedAt: 10_000, finishedAt: 12_000 }),
	{ found: true, entries: [{ at: 8_000, text: "late run thought" }] },
	"a window past both records' spans still resolves to the session-latest one",
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
	"spans exactly at the tolerance edges are windowed in and the span past the edge stays out",
);

// Two same-name records inside one window, the later thinkingless: both
// records' slots' spans sit inside the window, so the last record in file
// order holds the winning slot, the same later-record-wins outcome as the
// no-window pair above, and the viewer names the newer run's emptiness
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
	"a window strictly clear of both spans and the tolerance edges falls back to the session-latest one",
);

const timestamplessRecord = JSON.parse(JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(4_000, ["timestampless thought"])])])));
delete timestamplessRecord.message.timestamp;
assert.deepEqual(
	extractTranscriptThinking(JSON.stringify(timestamplessRecord), "scout", { startedAt: 3_000, finishedAt: 5_000 }),
	{ found: true, entries: [{ at: 4_000, text: "timestampless thought" }] },
	"a record whose own timestamp is missing still wins through its slot's span inside the window",
);

assert.deepEqual(
	extractTranscriptThinking(JSON.stringify(subagentToolResult([result("other", [thinkingMessage(2_000, ["other thought"])])])), "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{ found: false, entries: [] },
	"a window over a transcript with no matching record still finds nothing",
);

// --- same-name parallel slots: each row resolves its own slot by span ---

// A blocking parallel dispatch writes ONE subagent toolResult at
// dispatch completion, so its same-name slots share a single
// record-level timestamp however far apart they finished, and that
// stamp never gates the match. Each slot competes by its own
// message-timestamp span: the earlier finisher's span sits inside its
// own row's window while the last finisher's span end falls outside
// it, and vice versa, so each row names its own slot's thinking
// instead of the record's last matching slot in file order.
const parallelJsonl = JSON.stringify(
	subagentToolResult(
		[
			result("scout", [thinkingMessage(11_000, ["scout early finisher thought"])]),
			result("scout", [thinkingMessage(49_000, ["scout last finisher thought"])]),
		],
		50_000,
	),
);

assert.deepEqual(
	extractTranscriptThinking(parallelJsonl, "scout", { startedAt: 48_000, finishedAt: 52_000 }),
	{ found: true, entries: [{ at: 49_000, text: "scout last finisher thought" }] },
	"the last finisher's window holds its own slot's span and resolves it",
);

assert.deepEqual(
	extractTranscriptThinking(parallelJsonl, "scout", { startedAt: 9_000, finishedAt: 13_000 }),
	{ found: true, entries: [{ at: 11_000, text: "scout early finisher thought" }] },
	"the earlier finisher's window holds its own slot's span and resolves it instead of the record's last matching slot",
);

// --- chain rounds: one record per chain, stamped at each chain's end, earlier steps reach their own run's slot ---

// A chain round writes one record per chain, stamped when the whole
// chain completes, so every step's record stamp sits after that
// step's window and the stamp can never gate the match. Each step's
// row resolves through its own slot's span inside its own window;
// the fallback alone would hand the earlier round's step the next
// round's slot instead.
const chainJsonl = [
	JSON.stringify(
		subagentToolResult(
			[
				result("worker", [thinkingMessage(10_000, ["round 1 worker thought"])]),
				result("verifier", [thinkingMessage(65_000, ["round 1 verifier thought"])]),
				result("reviewer", [thinkingMessage(115_000, ["round 1 reviewer thought"])]),
			],
			160_500,
		),
	),
	JSON.stringify(
		subagentToolResult(
			[
				result("worker", [thinkingMessage(310_000, ["round 2 worker thought"])]),
				result("verifier", [thinkingMessage(365_000, ["round 2 verifier thought"])]),
				result("reviewer", [thinkingMessage(415_000, ["round 2 reviewer thought"])]),
			],
			460_500,
		),
	),
].join("\n");

assert.deepEqual(
	extractTranscriptThinking(chainJsonl, "worker", { startedAt: 9_000, finishedAt: 61_000 }),
	{ found: true, entries: [{ at: 10_000, text: "round 1 worker thought" }] },
	"a chain round's earlier step resolves its own run's slot even though its record stamp sits at the chain's end",
);

assert.deepEqual(
	extractTranscriptThinking(chainJsonl, "worker", { startedAt: 309_000, finishedAt: 361_000 }),
	{ found: true, entries: [{ at: 310_000, text: "round 2 worker thought" }] },
	"the later chain round's worker row resolves its own run's slot, not the earlier round's",
);

// --- same-wave parallel slots: shared span starts, staggered ends, late finisher first in results order ---

// Mirrors the measured parallel record (call_96ad9c80): two scout
// dispatches in one wave start 21 ms apart, finish ~165 s apart, and
// the record lists the late finisher FIRST in results order. Both
// rows' windows hold both spans' starts, so only containment of the
// span end discriminates: the early row's window excludes the late
// span's end, and the late row's window holds both spans, where the
// latest span end is the row's own slot. File order alone would hand
// both rows the record's first-listed late slot.
const ambiguityJsonl = JSON.stringify(
	subagentToolResult(
		[
			result("scout", [thinkingMessage(530_536, ["scout late first block"]), thinkingMessage(964_196, ["scout late finisher thought"])]),
			result("scout", [thinkingMessage(530_557, ["scout early first block"]), thinkingMessage(799_007, ["scout early finisher thought"])]),
		],
		970_000,
	),
);

assert.deepEqual(
	extractTranscriptThinking(ambiguityJsonl, "scout", { startedAt: 530_000, finishedAt: 799_000 }),
	{
		found: true,
		entries: [
			{ at: 530_557, text: "scout early first block" },
			{ at: 799_007, text: "scout early finisher thought" },
		],
	},
	"the early finisher's row resolves its own slot: the late sibling's span end falls outside the window",
);

assert.deepEqual(
	extractTranscriptThinking(ambiguityJsonl, "scout", { startedAt: 530_000, finishedAt: 964_000 }),
	{
		found: true,
		entries: [
			{ at: 530_536, text: "scout late first block" },
			{ at: 964_196, text: "scout late finisher thought" },
		],
	},
	"the late finisher's row resolves its own slot: within one record the latest span end wins even though the late slot is listed first",
);

// --- span-less degradation: a window miss resolves exactly as the no-window lookup ---

// Two matching records, neither holding a competing slot: the earlier
// carries two same-name slots with no message timestamps anywhere (no
// usable span), the later carries a span clear of the window. No slot
// competes, so the lookup takes the fallback exactly: the session-latest
// matching record's last matching slot in file order. Pins the hard
// degradation bound: a slot without a usable span never competes, so the
// timestampless record cannot steal the resolution from the
// session-latest record.
const spanlessRecord = subagentToolResult([
	result("scout", [{ role: "assistant", content: [{ type: "thinking", thinking: "spanless slot one thought" }] }]),
	result("scout", [{ role: "assistant", content: [{ type: "thinking", thinking: "spanless slot two thought" }] }]),
]);
const degradationJsonl = [
	JSON.stringify(spanlessRecord),
	JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(50_000, ["window miss thought"]), thinkingMessage(60_000, ["window miss second block"])])], 70_000)),
].join("\n");

assert.deepEqual(
	extractTranscriptThinking(degradationJsonl, "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{
		found: true,
		entries: [
			{ at: 50_000, text: "window miss thought" },
			{ at: 60_000, text: "window miss second block" },
		],
	},
	"when no slot's span competes, a window miss resolves exactly as the no-window lookup: session-latest record, last matching slot in file order",
);

// The span-less record alone resolves through the same fallback: found
// stays true and the record's last matching slot in file order wins, its
// entries stamped at: 0 for the timestamp-less messages.
assert.deepEqual(
	extractTranscriptThinking(JSON.stringify(spanlessRecord), "scout", { startedAt: 1_000, finishedAt: 5_000 }),
	{ found: true, entries: [{ at: 0, text: "spanless slot two thought" }] },
	"a window over a record whose slots carry no usable timestamps degrades to the last matching slot in file order, entries stamped at 0",
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

// --- the incremental scanner: feed/finish parity with the whole-string lookup ---

// The whole-string lookup is a thin wrapper over an incremental
// feed/finish scanner, so the streamed t read can feed readline's
// lines into the scanner and resolve byte-identically to the
// whole-string lookup on the same input. The corpus below reuses every
// fixture shape pinned above and drives both entry points across a
// matrix of agent/window arguments: the whole-string side keeps the
// wrapper's split("\n") shape while the line side splits the way
// node:readline yields for \r\n and \n endings (crlfDelay: Infinity;
// lone-\r and torn-tail fidelity still lives in the real-file view
// pins), so the loop compares the streamed feed's line semantics
// against the wrapper instead of the wrapper against itself. Tri-state,
// window spans with the session-latest fallback, per-slot matching,
// and torn-line tolerance must survive the incremental path exactly.
const lookupByLines = (jsonl, agentName, window) => {
	const scanner = createTranscriptThinkingScanner(agentName, window);
	for (const line of jsonl.split(/\r\n|\n/)) scanner.feed(line);
	return scanner.finish();
};

const parityCorpus = [
	["latest-match transcript", jsonl],
	["thinkingless overwrite", overwrittenByThinkingless],
	["thinking overwrite mirror", overwriteMirror],
	["window pair", windowedJsonl],
	["tolerance boundary", boundaryJsonl],
	["windowed overwrite", windowedOverwrite],
	["timestampless record", JSON.stringify(timestamplessRecord)],
	["parallel same-name slots", parallelJsonl],
	["chain rounds", chainJsonl],
	["shared-span ambiguity", ambiguityJsonl],
	["span-less degradation", degradationJsonl],
	["torn trailing line", tornTail],
	["uncapped large block", bigJsonl],
];

const parityArguments = [
	["scout", undefined],
	["scout", { startedAt: 1_000, finishedAt: 5_000 }],
	["scout", { startedAt: 48_000, finishedAt: 52_000 }],
	["worker", undefined],
	["planner", undefined],
	["reviewer", undefined],
];

for (const [fixtureName, fixture] of parityCorpus) {
	for (const [agentName, window] of parityArguments) {
		assert.deepEqual(
			extractTranscriptThinking(fixture, agentName, window),
			lookupByLines(fixture, agentName, window),
			`the whole-string lookup and the line-fed scanner resolve identically (${fixtureName}, ${agentName}${window ? ", windowed" : ""})`,
		);
	}
}

// The scanner's own tri-state contract, pinned directly on the API the
// streamed read consumes rather than only through the wrapper.
assert.deepEqual(createTranscriptThinkingScanner("scout").finish(), { found: false, entries: [] }, "a scanner fed nothing finds no record");
const scannerLatest = createTranscriptThinkingScanner("scout");
for (const line of jsonl.split("\n")) scannerLatest.feed(line);
assert.deepEqual(
	scannerLatest.finish(),
	{
		found: true,
		entries: [
			{ at: 3_000, text: "scout newest" },
			{ at: 3_100, text: "scout second block" },
		],
	},
	"the line-fed scanner resolves the session-latest match with its full entries",
);
const scannerWindowed = createTranscriptThinkingScanner("scout", { startedAt: 1_000, finishedAt: 5_000 });
for (const line of windowedJsonl.split("\n")) scannerWindowed.feed(line);
assert.deepEqual(
	scannerWindowed.finish(),
	{ found: true, entries: [{ at: 2_000, text: "early run thought" }] },
	"the line-fed scanner resolves a windowed match over the session-latest record",
);

// Line-boundary variants: the streamed read's line yields differ from
// the wrapper's split exactly at file edges and separators, so parity
// is pinned where those differences live. A trailing newline and blank
// lines add empty lines the scanner skips unparsed either way; CRLF
// endings are where the two feeds actually diverge: the whole-string
// side keeps a trailing \r on its lines (JSON.parse accepts it as
// whitespace) while the readline-shaped side strips it, so the pair
// pins that a \r-stripped feed resolves identically to the canonical
// fixture.
const variantRecord = JSON.stringify(subagentToolResult([result("scout", [thinkingMessage(1_000, ["boundary variant thought"])])]));
const boundaryVariants = [
	["no trailing newline", variantRecord],
	["trailing newline", `${variantRecord}\n`],
	["blank lines around the record", ["", variantRecord, "", ""].join("\n")],
	["crlf endings", [variantRecord, variantRecord].join("\r\n")],
];
for (const [variantName, variant] of boundaryVariants) {
	assert.deepEqual(
		extractTranscriptThinking(variant, "scout"),
		{ found: true, entries: [{ at: 1_000, text: "boundary variant thought" }] },
		`the whole-string lookup resolves the ${variantName} fixture to the canonical record`,
	);
	assert.deepEqual(
		lookupByLines(variant, "scout"),
		{ found: true, entries: [{ at: 1_000, text: "boundary variant thought" }] },
		`the readline-fed scanner resolves the ${variantName} fixture to the canonical record`,
	);
}

console.log("agent-viewer-transcript-thinking: all assertions passed");
