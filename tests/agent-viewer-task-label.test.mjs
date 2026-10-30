#!/usr/bin/env node
/**
 * Unit suite for the dispatch task-label heuristic
 * (extensions/agent-viewer/labels.ts). Plain node, no test framework:
 *
 *   node tests/agent-viewer-task-label.test.mjs
 *
 * Covers the fleet-reference match (EXT-N and EXT-N-M, case-insensitive,
 * first reference wins on multi-reference prompts, no match inside
 * longer words), the first-words fallback for unmatched prompts
 * (whitespace collapse, word-boundary fill up to the fixed width,
 * ellipsis suffix, hard slice when a single word exceeds the width),
 * and the empty-prompt edge.
 */

import assert from "node:assert/strict";
import { findFleetTaskReference, resolveTaskLabel, TASK_LABEL_MAX_WIDTH } from "../extensions/agent-viewer/labels.ts";

/** Assert the label is a fleet reference with the expected value. */
function assertFleetLabel(prompt, expected) {
	const label = resolveTaskLabel(prompt);
	assert.equal(label, expected, `resolveTaskLabel(${JSON.stringify(prompt)}) -> ${JSON.stringify(label)}`);
}

// --- findFleetTaskReference: matched prompts ---

assert.equal(findFleetTaskReference("Task: EXT-1-2 checkpoint 1 of the revived EXT-1"), "EXT-1-2");
assert.equal(findFleetTaskReference("coordinate with EXT-3 and EXT-1-3"), "EXT-3");
assert.equal(findFleetTaskReference("plain task, no reference"), null);
assert.equal(findFleetTaskReference("lowercase ext-4-1 works too"), "EXT-4-1");
assert.equal(findFleetTaskReference("do not match TEXT-1 or SECT-2"), null);
assert.equal(findFleetTaskReference("EXT-12 multi-digit"), "EXT-12");

// --- resolveTaskLabel: matched prompts (first reference wins) ---

assertFleetLabel("Task: EXT-1-2 checkpoint 1; see also EXT-1-3", "EXT-1-2");
assertFleetLabel("EXT-2 execution dispatch for the parser", "EXT-2");
assertFleetLabel("multi\nline EXT-5-1\nreference", "EXT-5-1");

// --- resolveTaskLabel: unmatched prompts (first-words fallback) ---

assertFleetLabel("Reply ready", "Reply ready");
assertFleetLabel("  spaces   and\ttabs collapse  ", "spaces and tabs collapse");

const longPrompt =
	"Summarize the reconciliation report for the fourth quarter and list every mismatch found by the auditor";
const longLabel = resolveTaskLabel(longPrompt);
assert.ok(longLabel.length <= TASK_LABEL_MAX_WIDTH, `label ${JSON.stringify(longLabel)} exceeds ${TASK_LABEL_MAX_WIDTH}`);
assert.ok(longLabel.endsWith("…"), `truncated label ${JSON.stringify(longLabel)} lacks an ellipsis`);
assert.ok(longPrompt.startsWith(longLabel.slice(0, -1)), "truncated label must be a prefix of the prompt");

// A single word longer than the width is hard-sliced instead of dropped.
const singleWord = "x".repeat(TASK_LABEL_MAX_WIDTH + 10);
const sliced = resolveTaskLabel(singleWord);
assert.equal(sliced.length, TASK_LABEL_MAX_WIDTH);
assert.ok(sliced.endsWith("…"));

// --- resolveTaskLabel: empty edge ---

assertFleetLabel("", "");
assertFleetLabel("   \n\t  ", "");

// >>> EXT-19 L1: a task-file path's date segment does not survive into the label
// A prompt citing its task file by path (…/EXT-19-20261030-0918-….md) made the
// greedy reference match capture the filename's date segment (EXT-19-20261030),
// a span mimicking the EXT-N-M child-id shape that identifies nothing.
assertFleetLabel(
	"Read the task file /home/x/.pi/.tasks/current/EXT-19-20261030-0918-show-what-each-job-is-working-on.md; your contract is the Work Log entry",
	"EXT-19",
);
assert.equal(
	findFleetTaskReference("see /home/x/.pi/.tasks/current/EXT-19-20261030-0918-show-what-each-job-is-working-on.md"),
	"EXT-19",
	"the reference primitive strips the date segment too",
);
// <<< EXT-19 L1

// >>> EXT-19 L2: a path-cited child keeps its id (green by design: the capture
// already ends at the child number, so the date-segment strip is a no-op here)
assertFleetLabel(
	"Read /home/x/.pi/.tasks/current/EXT-19-1-20261030-0918-collapse-completed-jobs-under-a-completed-umbrella.md and follow it",
	"EXT-19-1",
);
// <<< EXT-19 L2

// >>> EXT-19 L3: plain references and the fallback are untouched by the strip
assertFleetLabel("Task: EXT-19 execution dispatch for the readability fix", "EXT-19");
assertFleetLabel("Task: EXT-4-2 checkpoint for the parser", "EXT-4-2");
// Seven digits is not a filename date: a capture ending in a seven-digit
// segment keeps its full shape (the normalization's lower boundary).
assertFleetLabel("sync EXT-5-1234567 with the ledger", "EXT-5-1234567");
// A bare date-shaped number with no EXT prefix takes the first-words fallback.
assertFleetLabel("run the 20261030 reconciliation sweep", "run the 20261030 reconciliation sweep");
// <<< EXT-19 L3

console.log(`agent-viewer-task-label: all assertions passed`);
