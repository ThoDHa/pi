#!/usr/bin/env node
/**
 * Unit suite for the navigator's pure tool-noise filter
 * (extensions/agent-viewer/activity-filter.ts). Plain node, no test
 * framework:
 *
 *   node tests/agent-viewer-activity-filter.test.mjs
 *
 * Covers the default-hidden noise set (read/grep/find/ls tool calls),
 * everything else staying visible (write/edit/bash/powershell, unknown
 * third-party tool names, unnamed tool calls), thinking and text
 * entries always shown in both toggle states, order and input-array
 * preservation, the showToolNoise default, and the empty-log edge.
 */

import assert from "node:assert/strict";
import { filterActivityEntries, isNoisyToolCall } from "../extensions/agent-viewer/activity-filter.ts";

const toolCall = (name, text = `${name} target`) => ({ at: 1_000, kind: "toolCall", name, text });
const textEntry = (text) => ({ at: 1_100, kind: "text", text });
const thinkingEntry = (text) => ({ at: 1_200, kind: "thinking", text });

// --- the noise set: read/grep/find/ls tool calls hide by default ---

{
	const noisyNames = ["read", "grep", "find", "ls"];
	for (const name of noisyNames) {
		const entry = toolCall(name);
		assert.ok(isNoisyToolCall(entry), `${name} classifies as noisy`);
		assert.deepEqual(filterActivityEntries([entry]), [], `${name} hides under the default filter`);
	}
}

// --- everything outside the noise set stays visible by default ---

{
	const shown = filterActivityEntries([toolCall("write"), toolCall("edit"), toolCall("bash"), toolCall("powershell"), toolCall("mcp__archive_lookup")]);
	assert.deepEqual(
		shown.map((entry) => entry.name),
		["write", "edit", "bash", "powershell", "mcp__archive_lookup"],
		"write/edit/bash/powershell and unknown tool names stay visible",
	);
	assert.equal(isNoisyToolCall(toolCall("mcp__archive_lookup")), false, "an unknown tool name never classifies as noisy");
}

// --- unnamed tool calls and non-toolCall entries never classify as noisy ---

{
	assert.equal(isNoisyToolCall({ at: 1, kind: "toolCall", text: "mystery tool" }), false, "a tool call without a name stays visible");
	assert.equal(isNoisyToolCall({ at: 1, kind: "text", text: "read the file" }), false, "a text entry stays visible whatever it says");
	assert.equal(isNoisyToolCall({ at: 1, kind: "thinking", text: "considering read" }), false, "a thinking entry stays visible whatever it says");
}

// --- thinking and text entries survive both toggle states, in stream order ---

{
	const log = [textEntry("starting"), thinkingEntry("plan the sweep"), toolCall("read", "read a.ts"), toolCall("write", "write b.ts")];
	const filtered = filterActivityEntries(log);
	assert.deepEqual(
		filtered.map((entry) => entry.text),
		["starting", "plan the sweep", "write b.ts"],
		"the default filter keeps text and thinking and drops only the noisy tool call",
	);
	const everything = filterActivityEntries(log, true);
	assert.deepEqual(
		everything.map((entry) => entry.text),
		["starting", "plan the sweep", "read a.ts", "write b.ts"],
		"showing tool noise keeps the full log in stream order",
	);
	assert.ok(everything.every((entry, index) => entry === log[index]), "showing tool noise preserves entry identity");
}

// --- the toggle default is noise hidden; the input array is never mutated ---

{
	const log = [toolCall("read"), textEntry("note")];
	assert.deepEqual(filterActivityEntries(log), filterActivityEntries(log, false), "the omitted flag defaults to noise hidden");
	const before = JSON.stringify(log);
	filterActivityEntries(log);
	filterActivityEntries(log, true);
	assert.equal(JSON.stringify(log), before, "filtering never mutates the input log");
}

// --- empty log: both states yield an empty list ---

{
	assert.deepEqual(filterActivityEntries([]), []);
	assert.deepEqual(filterActivityEntries([], true), []);
}

console.log("agent-viewer-activity-filter: all assertions passed");
