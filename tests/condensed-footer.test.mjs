#!/usr/bin/env node
/**
 * Unit suite for the condensed footer's pure layer
 * (extensions/condensed-footer.ts). Plain node, no test framework:
 *
 *   node tests/condensed-footer.test.mjs
 *
 * Covers the one-line contract: exactly one render line, the right segment
 * flush at the terminal width with a minimum two-space gap, the drop order
 * statuses -> model -> cost -> output -> branch as width shrinks, the
 * percent color thresholds (>70 warning, >90 error), zero-usage and
 * missing-branch shapes, the whole-session usage scan memoization keyed on
 * (session, leaf, entry count, model), and the /footer toggle reinstalling
 * or restoring the built-in footer with the choice persisting across session
 * starts. Also pins the shared formatters
 * (formatTokens, shortenCwd, sanitizeStatusText).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// pi resolves extensions with jiti from its own install tree, so the
// @earendil-works/pi-tui specifier never resolves under plain node from this
// repo (no node_modules up-tree). Provision a symlink to pi's scope dir so
// the extension's runtime import loads the same package pi itself uses.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const shim = join(repoRoot, "node_modules", "@earendil-works");
if (!existsSync(shim)) {
	let piRoot = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
	while (piRoot !== dirname(piRoot) && !existsSync(join(piRoot, "node_modules", "@earendil-works", "pi-tui"))) {
		piRoot = dirname(piRoot);
	}
	if (!existsSync(join(piRoot, "node_modules", "@earendil-works", "pi-tui"))) {
		throw new Error("pi installation with @earendil-works/pi-tui not found; cannot provision test shim");
	}
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	symlinkSync(join(piRoot, "node_modules", "@earendil-works"), shim, "dir");
}

const { default: condensedFooter, collectFooterStats, createFooterStatsCache, formatTokens, layoutFooterLine, sanitizeStatusText, shortenCwd } = await import("../extensions/condensed-footer.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const identityFg = (_color, text) => text;
// Real ANSI codes: pi-tui measures them as zero width, like real theme output.
const ANSI = { error: "\u001b[31m", warning: "\u001b[33m" };
const tagged = (color, text) => `${ANSI[color]}${text}\u001b[0m`;
const taggingFg = (color, text) => (color === "dim" ? text : tagged(color, text));
const MIN_GAP = 2;

const richInput = {
	cwd: "~/proj",
	branch: "main",
	statuses: ["Ⓜ manager"],
	inputTokens: 1500,
	outputTokens: 23000,
	cost: 1.2345,
	contextPercent: 45.3,
	modelId: "kimi-k2",
	thinkingLevel: "high",
};

/** First width (scanning down from `from`) where `marker` is gone from the line. */
function dropWidth(input, marker, from = 200) {
	for (let width = from; width >= 1; width--) {
		if (!layoutFooterLine(input, width, identityFg).includes(marker)) return width;
	}
	return 0;
}

const cases = [];
const test = (label, fn) => cases.push([label, fn]);

// --- one-line contract and flush right alignment ----------------------

test("render output is exactly one line with no newline", () => {
	for (const width of [200, 120, 100, 80, 60, 40, 20, 10, 4]) {
		const line = layoutFooterLine(richInput, width, identityFg);
		assert.equal(typeof line, "string");
		assert.ok(!line.includes("\n"), `width ${width}`);
		assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
});

test("wide terminal flushes right segment at the exact width with minimum 2-space gap", () => {
	const width = 120;
	const line = layoutFooterLine(richInput, width, identityFg);
	const left = "~/proj (main) Ⓜ manager";
	const right = "↑1.5k ↓23k $1.234 45.3% kimi-k2:high";
	const gap = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
	assert.ok(gap.length >= 2);
	assert.equal(line, left + gap + right);
	assert.equal(visibleWidth(line), width);
	assert.ok(line.endsWith(right));
});

test("exactly-fitting terminal leaves the minimum 2-space gap", () => {
	const left = "~/proj (main) Ⓜ manager";
	const right = "↑1.5k ↓23k $1.234 45.3% kimi-k2:high";
	const width = visibleWidth(left) + visibleWidth(right) + 2;
	const line = layoutFooterLine(richInput, width, identityFg);
	assert.equal(line, `${left}  ${right}`);
	assert.equal(visibleWidth(line), width);
});

// --- drop order: statuses, model, cost, output, branch ------------------

test("everything fits at 100 columns", () => {
	const line = layoutFooterLine(richInput, 100, identityFg);
	for (const marker of ["Ⓜ manager", "kimi-k2:high", "$1.234", "↓23k", "(main)", "↑1.5k", "45.3%"]) {
		assert.ok(line.includes(marker), `missing ${marker}`);
	}
});

test("60 columns drops statuses first and keeps the rest", () => {
	const line = layoutFooterLine(richInput, 60, identityFg);
	assert.ok(!line.includes("manager"), "statuses should drop");
	assert.ok(line.includes("kimi-k2:high"), "model should stay");
	assert.ok(line.includes("$1.234"));
	assert.ok(line.includes("↓23k"));
	assert.ok(line.includes("(main)"));
});

test("40 columns drops statuses and model, keeps cost, output, branch", () => {
	const line = layoutFooterLine(richInput, 40, identityFg);
	assert.ok(!line.includes("manager"));
	assert.ok(!line.includes("kimi-k2"), "model should drop");
	assert.ok(line.includes("$1.234"), "cost should stay");
	assert.ok(line.includes("↓23k"));
	assert.ok(line.includes("(main)"));
});

test("drop order statuses, model, cost, output, branch holds across widths", () => {
	const statuses = dropWidth(richInput, "manager");
	const model = dropWidth(richInput, "kimi-k2");
	const cost = dropWidth(richInput, "$1.234");
	const output = dropWidth(richInput, "↓23k");
	const branch = dropWidth(richInput, "(main)");
	assert.ok(statuses > model, `statuses ${statuses} must drop before model ${model}`);
	assert.ok(model > cost, `model ${model} must drop before cost ${cost}`);
	assert.ok(cost > output, `cost ${cost} must drop before output ${output}`);
	assert.ok(output > branch, `output ${output} must drop before branch ${branch}`);
	assert.equal(layoutFooterLine(richInput, branch, identityFg).includes("(main)"), false);
});

test("percent and input tokens never drop before the final truncation floor", () => {
	const noTruncationWidth = visibleWidth("~/proj") + MIN_GAP + visibleWidth("↑1.5k 45.3%");
	for (let width = 40; width >= noTruncationWidth; width--) {
		const line = layoutFooterLine(richInput, width, identityFg);
		assert.ok(line.includes("45.3%"), `width ${width}`);
		assert.ok(line.includes("↑1.5k"), `width ${width}`);
		assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
	for (let width = noTruncationWidth - 1; width >= 5; width--) {
		const line = layoutFooterLine(richInput, width, identityFg);
		assert.ok(!line.includes("\n"), `width ${width}`);
		assert.ok(visibleWidth(line) <= width, `width ${width}`);
	}
});

test("below the last droppable piece the line truncates to exactly the width", () => {
	const line = layoutFooterLine(richInput, 10, identityFg);
	assert.equal(visibleWidth(line), 10);
	assert.ok(!line.includes("\n"));
});

// --- percent color thresholds -------------------------------------------

test("context percent colors error above 90 and warning above 70 only", () => {
	const colored = (percent) => layoutFooterLine({ ...richInput, contextPercent: percent }, 120, taggingFg);
	assert.ok(colored(95.5).includes(tagged("error", "95.5%")));
	assert.ok(colored(90.1).includes(tagged("error", "90.1%")));
	assert.ok(colored(90).includes(tagged("warning", "90.0%")));
	assert.ok(colored(75).includes(tagged("warning", "75.0%")));
	assert.ok(!colored(70).includes(ANSI.warning));
	assert.ok(colored(70).includes("70.0%"));
	assert.ok(!colored(45.3).includes(ANSI.error));
	assert.ok(!colored(45.3).includes(ANSI.warning));
	assert.equal(visibleWidth(colored(95.5)), 120);
});

test("unknown context percent renders ? uncolored", () => {
	const line = layoutFooterLine({ ...richInput, contextPercent: null }, 120, taggingFg);
	assert.ok(line.includes("?"));
	assert.ok(!line.includes(ANSI.error));
	assert.ok(!line.includes(ANSI.warning));
});

// --- base dim styling -----------------------------------------------------

test("non-percent segments render through the dim color", () => {
	const dimmed = [];
	layoutFooterLine(richInput, 120, (color, text) => {
		if (color === "dim") dimmed.push(text);
		return text;
	});
	assert.ok(dimmed.includes("~/proj (main) Ⓜ manager"));
	assert.ok(dimmed.some((text) => text.includes("kimi-k2:high")));
	assert.ok(dimmed.some((text) => text.includes("$1.234")));
});

// --- zero-usage, missing branch, empty statuses ---------------------------

test("fresh session renders only cwd, percent, and model", () => {
	const line = layoutFooterLine(
		{ cwd: "~", branch: null, statuses: [], inputTokens: 0, outputTokens: 0, cost: 0, contextPercent: 0, modelId: null, thinkingLevel: "high" },
		80,
		identityFg,
	);
	assert.ok(line.startsWith("~"));
	assert.ok(line.includes("0.0%"));
	assert.ok(line.includes("no-model"));
	assert.ok(!line.includes("↑"));
	assert.ok(!line.includes("↓"));
	assert.ok(!line.includes("$"));
	assert.ok(!line.includes("()"));
	assert.equal(visibleWidth(line), 80);
});

test("thinking level appends only when provided", () => {
	const line = layoutFooterLine({ ...richInput, thinkingLevel: null }, 120, identityFg);
	assert.ok(line.endsWith("kimi-k2"));
	assert.ok(!line.includes("kimi-k2:"));
});

// --- whole-session usage scan memoization ---------------------------------

function statsSource(entries, { percent = 42.7, modelId = "m1" } = {}) {
	let scans = 0;
	return {
		source: {
			sessionManager: {
				getEntries: () => {
					scans++;
					return entries;
				},
				getSessionId: () => "session-1",
				getLeafId: () => "leaf-1",
				getEntryCount: () => entries.length,
			},
			getContextUsage: () => ({ percent }),
			model: { id: modelId },
		},
		scanCount: () => scans,
	};
}

const usageEntries = [
	{ type: "usage", usage: { input: 10, output: 11, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } },
	{ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 6, cost: { total: 0.25 } } } },
	{ type: "message", message: { role: "toolResult", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } } },
	{ type: "message", message: { role: "user" } },
	{ type: "branch_summary", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } },
	{ type: "compaction", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
	{ type: "message", message: { role: "assistant", stopReason: "aborted" } },
];

test("usage scan accumulates usage, assistant, toolResult, summary, and compaction entries", () => {
	const { source } = statsSource(usageEntries);
	const stats = collectFooterStats(source, createFooterStatsCache());
	assert.equal(stats.inputTokens, 114);
	assert.equal(stats.outputTokens, 37);
	assert.equal(stats.cost, 2);
	assert.equal(stats.contextPercent, 42.7);
});

test("repeat renders reuse the memoized scan until session key inputs move", () => {
	const entries = [...usageEntries];
	const { source, scanCount } = statsSource(entries);
	const cache = createFooterStatsCache();
	collectFooterStats(source, cache);
	collectFooterStats(source, cache);
	assert.equal(scanCount(), 1, "same key must not rescan");

	entries.push({ type: "message", message: { role: "assistant", usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } });
	const grown = collectFooterStats(source, cache);
	assert.equal(scanCount(), 2, "entry count change must rescan");
	assert.equal(grown.inputTokens, 121);

	const switched = collectFooterStats({ ...source, model: { id: "m2" } }, cache);
	assert.equal(switched.inputTokens, 121, "model change must rescan");
	assert.equal(scanCount(), 3);
});

// --- /footer toggle and session_start install ------------------------------

function mockPi() {
	const handlers = {};
	const commands = {};
	const pi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		registerCommand: (name, options) => {
			commands[name] = options;
		},
	};
	return { pi, handlers, commands };
}

function mockCtx(overrides = {}) {
	const setFooterCalls = [];
	const notes = [];
	const ctx = {
		mode: "tui",
		ui: {
			setFooter: (factory) => setFooterCalls.push(factory),
			notify: (message, level) => notes.push({ message, level }),
		},
		...overrides,
	};
	return { ctx, setFooterCalls, notes };
}

test("session_start installs the footer only in tui mode", async () => {
	const { pi, handlers } = mockPi();
	condensedFooter(pi);
	assert.ok(handlers.session_start, "session_start handler must be registered");
	const tui = mockCtx();
	await handlers.session_start({}, tui.ctx);
	assert.equal(tui.setFooterCalls.length, 1);
	assert.equal(typeof tui.setFooterCalls[0], "function");
	const rpc = mockCtx({ mode: "rpc" });
	await handlers.session_start({}, rpc.ctx);
	const json = mockCtx({ mode: "json" });
	await handlers.session_start({}, json.ctx);
	assert.equal(rpc.setFooterCalls.length, 0);
	assert.equal(json.setFooterCalls.length, 0);
});

test("/footer toggles built-in footer back and the condensed one in again", async () => {
	const { pi, commands, handlers } = mockPi();
	condensedFooter(pi);
	const { ctx, setFooterCalls, notes } = mockCtx();
	await handlers.session_start({}, ctx);
	assert.equal(typeof setFooterCalls[0], "function", "startup installs the condensed footer");
	const command = commands.footer;
	assert.equal(command.description, "Toggle condensed one-line footer");
	await command.handler("", ctx);
	assert.equal(setFooterCalls.length, 2);
	assert.equal(setFooterCalls[1], undefined, "first toggle restores the built-in footer");
	await command.handler("", ctx);
	assert.equal(setFooterCalls.length, 3);
	assert.equal(typeof setFooterCalls[2], "function", "second toggle reinstalls the condensed footer");
	assert.equal(notes.length, 2);
	assert.deepEqual(notes.map((note) => note.level), ["info", "info"]);
});

test("condensed footer stays off after /footer restore followed by another session_start", async () => {
	const { pi, commands, handlers } = mockPi();
	condensedFooter(pi);
	const { ctx, setFooterCalls } = mockCtx();
	await handlers.session_start({}, ctx);
	await commands.footer.handler("", ctx);
	assert.equal(setFooterCalls[1], undefined, "/footer restores the built-in footer");
	await handlers.session_start({}, ctx);
	assert.equal(setFooterCalls.length, 2, "session_start must not resurrect the disabled footer");
	assert.equal(setFooterCalls[1], undefined, "the built-in footer stays restored");
});

test("session_start keeps auto-installing the condensed footer when no /footer ran", async () => {
	const { pi, handlers } = mockPi();
	condensedFooter(pi);
	const { ctx, setFooterCalls } = mockCtx();
	await handlers.session_start({}, ctx);
	await handlers.session_start({}, ctx);
	assert.equal(setFooterCalls.length, 2, "every session start installs while no preference is set");
	assert.ok(setFooterCalls.every((factory) => typeof factory === "function"));
});

test("/footer handler ignores non-tui contexts without flipping state", async () => {
	const { pi, commands, handlers } = mockPi();
	condensedFooter(pi);
	const rpc = mockCtx({ mode: "rpc" });
	await commands.footer.handler("", rpc.ctx);
	const json = mockCtx({ mode: "json" });
	await commands.footer.handler("", json.ctx);
	assert.equal(rpc.setFooterCalls.length, 0, "non-tui must not reach setFooter");
	assert.equal(json.setFooterCalls.length, 0, "non-tui must not reach setFooter");
	assert.equal(rpc.notes.length, 0, "non-tui must not notify");
	assert.equal(json.notes.length, 0, "non-tui must not notify");
	const tui = mockCtx();
	await handlers.session_start({}, tui.ctx);
	assert.equal(typeof tui.setFooterCalls[0], "function", "ignored toggles must not flip the preference");
});

test("footer component renders one line and disposes its branch subscription", async () => {
	const { pi, handlers } = mockPi();
	condensedFooter(pi);
	let factory;
	const { ctx } = mockCtx({
		sessionManager: {
			getCwd: () => "/home/dev/proj",
			getEntries: () => [],
			getSessionId: () => "s",
			getLeafId: () => null,
			getEntryCount: () => 0,
		},
		getContextUsage: () => ({ percent: 12.3 }),
		model: { id: "kimi-k2", reasoning: true },
		thinkingLevel: "medium",
	});
	ctx.ui.setFooter = (captured) => {
		factory = captured;
	};
	await handlers.session_start({}, ctx);
	assert.equal(typeof factory, "function");
	let unsubscribed = false;
	const footerData = {
		getGitBranch: () => "feat/x",
		getExtensionStatuses: () => new Map([["manager-mode", "Ⓜ manager"]]),
		onBranchChange: () => () => {
			unsubscribed = true;
		},
	};
	const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, footerData);
	const lines = component.render(100);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("(feat/x)"));
	assert.ok(lines[0].includes("Ⓜ manager"));
	assert.ok(lines[0].includes("12.3%"));
	assert.ok(lines[0].includes("kimi-k2:medium"));
	component.dispose();
	assert.ok(unsubscribed, "dispose must unsubscribe from branch changes");
});

// --- shared formatters ------------------------------------------------------

test("formatTokens matches the built-in compact scale", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1.0k");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(23000), "23k");
	assert.equal(formatTokens(999999), "1000k");
	assert.equal(formatTokens(1500000), "1.5M");
	assert.equal(formatTokens(12000000), "12M");
	assert.equal(formatTokens(250000000), "250M");
});

test("shortenCwd tilde-collapses home-internal paths only", () => {
	const home = "/home/dev";
	assert.equal(shortenCwd("/home/dev", home), "~");
	assert.equal(shortenCwd("/home/dev/proj/sub", home), "~/proj/sub");
	assert.equal(shortenCwd("/home/developer", home), "/home/developer");
	assert.equal(shortenCwd("/etc", home), "/etc");
	// Same parity with the built-in: paths escaping home come back unresolved.
	assert.equal(shortenCwd("/home/dev/../evil", home), "/home/dev/../evil");
	assert.equal(shortenCwd("/tmp/x", undefined), "/tmp/x");
});

test("sanitizeStatusText strips control characters and collapses spaces", () => {
	assert.equal(sanitizeStatusText("Ⓜ manager"), "Ⓜ manager");
	assert.equal(sanitizeStatusText("a\nb\tc  d"), "a b c d");
	assert.equal(sanitizeStatusText("  padded  "), "padded");
});

// --- runner -----------------------------------------------------------------

let failed = 0;
for (const [label, fn] of cases) {
	try {
		await fn();
	} catch (error) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      ${error.message}`);
	}
}

const passed = cases.length - failed;
console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
