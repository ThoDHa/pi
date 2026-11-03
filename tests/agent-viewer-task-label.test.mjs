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
 * the task-file summary composition (resolveTaskSummary: id plus slug
 * from the first task-file citation, hyphens read as words, width-capped
 * with the same ellipsis contract), the empty-prompt edge, the
 * display-label chain both surfaces share (resolveTaskDisplayLabel:
 * citation summary, then label, then the "(detached)" wording), and
 * the shared presentation helpers (dispatch-count wording,
 * settled-glyph aggregation).
 */

import assert from "node:assert/strict";
import {
	aggregateSettledGlyph,
	dispatchCountText,
	findFleetTaskReference,
	resolveTaskDisplayLabel,
	resolveTaskLabel,
	resolveTaskSummary,
	TASK_LABEL_MAX_WIDTH,
} from "../extensions/agent-viewer/labels.ts";

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

// >>> EXT-22 L1: resolveTaskSummary composes id plus slug from a task-file citation
// A prompt citing its task file by path (the fleet's dispatch convention,
// .tasks/current/EXT-N[-M]-YYYYMMDD-HHMM-slug.md) resolves the id plus the
// filename's slug read as words, hyphens as spaces, first citation winning,
// width-capped at TASK_LABEL_MAX_WIDTH. A report-dir citation matches the same
// way: the basename still terminates at .md before the following slash.
assert.equal(
	resolveTaskSummary("Your contract is /home/x/.pi/.tasks/current/EXT-24-20261102-2037-fix-the-strip-label-truncation.md; read it fully first"),
	"EXT-24 · fix the strip label truncation",
);
assert.equal(
	resolveTaskSummary("deposit per .tasks/reports/EXT-24-20261102-2037-fix-the-strip-label-truncation.md/01-plan.md"),
	"EXT-24 · fix the strip label truncation",
	"a report-dir citation matches the same basename shape",
);
// Child ids keep their second segment; a slug that would overflow the cap
// truncates on a word boundary like any summary.
assert.equal(
	resolveTaskSummary("Read /home/x/.pi/.tasks/current/EXT-19-1-20261030-0918-collapse-completed-jobs-under-a-completed-umbrella.md and follow it"),
	"EXT-19-1 · collapse completed jobs under a completed…",
);
// First citation wins on multi-citation prompts (the id primitive's convention).
assert.equal(
	resolveTaskSummary("Contract EXT-2-20261101-0900-first-task-file.md; coordinate with EXT-3-20261101-1000-second-task-file.md"),
	"EXT-2 · first task file",
);
// Case-insensitive id, normalized uppercase like the reference primitive.
assert.equal(
	resolveTaskSummary("see ext-7-20261030-0918-lowercase-citation.md for the contract"),
	"EXT-7 · lowercase citation",
);
// No citation resolves null; callers fall back to resolveTaskLabel. A bare
// fleet reference composes no slug and is not a citation.
assert.equal(resolveTaskSummary("Task: EXT-9-2 parser fixes"), null, "a bare fleet reference is not a citation");
assert.equal(resolveTaskSummary("Reply ready for the fleet"), null);
assert.equal(resolveTaskSummary(""), null);

// Width cap: the summary truncates on a word boundary with the trailing
// ellipsis, capped at TASK_LABEL_MAX_WIDTH; a single over-long slug word is
// hard-sliced.
{
	const longSlug = "EXT-24-20261102-2037-" + "word-".repeat(20).slice(0, -1) + ".md";
	const summary = resolveTaskSummary(`read .tasks/current/${longSlug} now`);
	assert.ok(summary.startsWith("EXT-24 · "), `the capped summary keeps its id prefix, got ${JSON.stringify(summary)}`);
	assert.ok(summary.length <= TASK_LABEL_MAX_WIDTH, `summary ${JSON.stringify(summary)} exceeds ${TASK_LABEL_MAX_WIDTH}`);
	assert.ok(summary.endsWith("…"), `the truncated summary ${JSON.stringify(summary)} lacks an ellipsis`);

	const wordSlug = "EXT-24-20261102-2037-" + "x".repeat(TASK_LABEL_MAX_WIDTH + 10) + ".md";
	const sliced = resolveTaskSummary(`read .tasks/current/${wordSlug} now`);
	assert.equal(sliced.length, TASK_LABEL_MAX_WIDTH, `the hard-sliced summary is width-capped, got ${JSON.stringify(sliced)}`);
	assert.ok(sliced.endsWith("…"));
}
// <<< EXT-22 L1

// >>> EXT-22 F1: resolveTaskDisplayLabel owns the surfaces' label chain
// The strip and the navigator label every dispatch through one chain:
// the task-file citation summary wins, the fleet-reference/first-words
// label is the second fallback, and an empty resolution renders the
// "(detached)" wording. The resolver owns the chain and the wording so
// the fallback order is pinned directly instead of incidentally
// through surface fixtures.
assert.equal(
	resolveTaskDisplayLabel("Your contract is /home/x/.pi/.tasks/current/EXT-24-20261102-2037-fix-the-strip-label-truncation.md; read it fully first"),
	"EXT-24 · fix the strip label truncation",
	"the citation summary wins over the bare reference the same filename yields",
);
assert.equal(resolveTaskDisplayLabel("Task: EXT-9-2 parser fixes"), "EXT-9-2", "the fleet-reference label wins over (detached)");
assert.equal(resolveTaskDisplayLabel(""), "(detached)", "an empty resolution renders the (detached) wording");
// <<< EXT-22 F1

// >>> EXT-18 L1: dispatchCountText, the Completed surfaces' dispatch-count wording
// The singular/plural boundary is what the navigator's Completed umbrella detail
// and the strip's Completed line render.
assert.equal(dispatchCountText(1), "1 dispatch");
assert.equal(dispatchCountText(2), "2 dispatches");
assert.equal(dispatchCountText(0), "0 dispatches");
// <<< EXT-18 L1

// >>> EXT-18 L2: aggregateSettledGlyph, the settled views' aggregated glyph:
// done when every view is done, failed when every one is failed, mixed otherwise.
assert.equal(aggregateSettledGlyph([{ glyph: "done" }, { glyph: "done" }]), "done");
assert.equal(aggregateSettledGlyph([{ glyph: "failed" }, { glyph: "failed" }]), "failed");
assert.equal(aggregateSettledGlyph([{ glyph: "done" }, { glyph: "failed" }]), "mixed");
// The empty input yields "done" through vacuous every truth; unreachable in
// production (both call sites guard settled.length > 0), pinned as the
// actual behavior.
assert.equal(aggregateSettledGlyph([]), "done");
// <<< EXT-18 L2

console.log(`agent-viewer-task-label: all assertions passed`);
