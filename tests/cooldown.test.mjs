#!/usr/bin/env node
/**
 * Unit suite for the cooldown extension's pure layer and event wiring
 * (extensions/cooldown.ts). Plain node, no test framework:
 *
 *   node tests/cooldown.test.mjs
 *
 * Covers the config loader and validation (defaults, per-entry overrides,
 * uncompilable regexes, offset bounds ±840, negative buffers, duplicate
 * names, capture-group requirement, fail-safe problems), detection and
 * parsing (provider/model entry matching, verbatim z.ai 1308 fixture under
 * offset 480, offset sign, malformed calendar stamps, the 1308-vs-13081
 * lookahead, bare-429 rejection), the arm decisions (fresh arm, later-reset
 * extension, never-shorten-below-now, stale replacement, attempt cap and its
 * boundary, fire-at-once past deadlines), the restart decision table (rearm,
 * resume-now carrying attempts, drop under resumeOnRestart: false), and the
 * event wiring through a mock pi/ctx runtime (arm -> timer -> resume send,
 * followUp when busy, repeat-1308 re-arm, cap -> disable -> success re-enable,
 * parse-failure fallback, retire on success, shutdown cleanup, restart re-arm
 * and resume-now from persisted branch entries, /cooldown and
 * /cooldown-simulate commands).
 *
 * Fix round F1 adds: two-digit-year stamp rejection, per-entry stale-attempt
 * isolation, the reason-aware restart table (fork re-arms future deadlines
 * only; reload bypasses both directions; startup/new/resume stay gated),
 * simulated waits not surviving runtime replacement, the tui|rpc arming
 * guard, delay-0 resume-now routing, the entry-name-mismatch tombstone, an
 * info notify for real 1308s while capped, and the chained-timer wiring test.
 *
 * Fix round F2 adds: durable gated drops (a startup/new/resume or fork
 * past-deadline drop supersedes the waiting entry with a cancelled record,
 * so a later /reload cannot re-adjudicate and fire what the gate withheld),
 * the unknown-entry-name tombstone reachable under the default gate (the
 * mismatch warning fires exactly once, then the tombstone keeps starts
 * quiet), and the tui|rpc guard extended to the restart arm/fire path so an
 * opted-in headless run stays inert while the drop path stays unguarded.
 *
 * The live-countdown round adds: formatCountdown pure cases (hours and
 * minutes above the hour, minutes below, <1m inside the final minute and
 * past the deadline), the live footer string at arm time, the tick
 * interval arming with the wait and refreshing the footer every tick (the
 * tickMs seam), tick clearing on cancel, shutdown, and fire (the retained
 * fired entry must not tick the status back), and the non-assistant
 * message_end early return leaving states and entries untouched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { default: createCooldownExtension, ENTRY_TYPE, statusKeyFor, collectPendingWaits, loadCooldownConfig, loadCooldownConfigWithLocalOverride, validateCooldownConfig, findCooldownEntry, matchesEntryModel, parseResetEpochMs, planCooldownArm, planRestartResume, formatResumeClock, formatCountdown } = await import("../extensions/cooldown.ts");

const ZAI_OFFSET_MINUTES = 480;
const VERBATIM_1308 = 'Error: 429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-11-23 06:58:41"}';
const VERBATIM_RESET_EPOCH = Date.UTC(2026, 10, 23, 6, 58, 41) - ZAI_OFFSET_MINUTES * 60_000;

/** Render an epoch as a z.ai wall-clock stamp (UTC+8, the only format the provider sends). */
function zaiStamp(epochMs) {
	const shifted = new Date(epochMs + ZAI_OFFSET_MINUTES * 60_000);
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** A verbatim-shaped 1308 error whose reset time is `resetMs`. */
function fixture1308(resetMs) {
	return `Error: 429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at ${zaiStamp(resetMs)}"}`;
}

const MINUTES = 60_000;
const now = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Recording setInterval/clearInterval spies for the duration of run; originals restored even when run throws. */
async function withIntervalSpy(run) {
	const realSetInterval = global.setInterval;
	const realClearInterval = global.clearInterval;
	const created = [];
	const cleared = [];
	global.setInterval = (callback, ms) => {
		const handle = realSetInterval(callback, ms);
		created.push({ handle, ms });
		return handle;
	};
	global.clearInterval = (handle) => {
		cleared.push(handle);
		return realClearInterval(handle);
	};
	try {
		return await run({ created, cleared });
	} finally {
		global.setInterval = realSetInterval;
		global.clearInterval = realClearInterval;
	}
}

/** Provider stamps carry no sub-second precision; align test bases so parsed epochs compare exactly. */
const wholeSecond = (ms) => ms - (ms % 1000);

/** A minimal valid config object (raw, pre-validation). */
function rawConfig(overrides = {}) {
	return {
		defaultBufferMinutes: 2,
		maxResumeAttempts: 5,
		resumeOnRestart: false,
		providers: [
			{
				name: "zai-glm",
				match: { provider: "zai" },
				errorPattern: '"code"\\s*:\\s*"?1308(?![0-9])',
				resetTimePattern: "your limit will reset at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})",
				utcOffsetMinutes: 480,
				bufferMinutes: 2,
			},
		],
		...overrides,
	};
}

/** A resolved zai entry for direct pure-layer calls. */
function zaiEntry(overrides = {}) {
	const { ok, config } = validateCooldownConfig(rawConfig(overrides.entry ? { providers: [overrides.entry] } : {}));
	assert.equal(ok, true, "zaiEntry fixture must validate");
	return config.providers[0];
}

/** The zai entry verbatim plus the synthetic acme entry, for two-entry wiring scenarios. */
function twoProviderConfig(overrides = {}) {
	return rawConfig({ providers: [rawConfig().providers[0], ACME_ENTRY], ...overrides });
}

function assistantError(errorMessage, provider = "zai", model = "glm-5.3") {
	return { role: "assistant", stopReason: "error", errorMessage, provider, model };
}

const ACME_OFFSET_MINUTES = -300;

/** A second synthetic provider entry: distinct provider string, distinct error code, same stamp format. */
const ACME_ENTRY = {
	name: "acme-pro",
	match: { provider: "acme" },
	errorPattern: '"code"\\s*:\\s*"?4290(?![0-9])',
	resetTimePattern: "your window ends at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})",
	utcOffsetMinutes: -300,
	bufferMinutes: 2,
};

/** Render an epoch as an acme wall-clock stamp (UTC-5, the only format the provider sends). */
function acmeStamp(epochMs) {
	const shifted = new Date(epochMs + ACME_OFFSET_MINUTES * 60_000);
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** A verbatim-shaped acme 4290 error whose reset time is `resetMs`. */
function acmeFixture(resetMs) {
	return `Error: 429: {"code":"4290","message":"Acme usage limit reached. Your window ends at ${acmeStamp(resetMs)}"}`;
}

function acmeError(errorMessage, model = "acme-max") {
	return { role: "assistant", stopReason: "error", errorMessage, provider: "acme", model };
}

function waitingState(fireAtMs, attempts = 0, entryName = "zai-glm") {
	return { entryName, resetAtMs: fireAtMs - 2 * MINUTES, fireAtMs, attempts };
}

/** Persisted custom-entry shape as pi stores appendEntry data on the branch. */
function persistedEntry(data) {
	return { type: "custom", customType: ENTRY_TYPE, data };
}

// --- mock pi/ctx runtime for wiring tests ------------------------------

function createRuntime({ config, configPath: explicitConfigPath, mode = "tui", hasUI = true, tickMs } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const appended = [];
	const notifies = [];
	const statuses = new Map();
	const statusCalls = [];
	const branchEntries = [];
	let idle = true;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		sendUserMessage(content, options) {
			sent.push({ content, options });
		},
		appendEntry(customType, data) {
			appended.push({ customType, data });
			if (customType === ENTRY_TYPE) branchEntries.push(persistedEntry(data));
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
	const ctx = {
		mode,
		hasUI,
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => branchEntries,
			getEntries: () => branchEntries,
		},
		ui: {
			setStatus(key, text) {
				statusCalls.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify(message, level) {
				notifies.push({ message, level });
			},
		},
	};
	let configPath;
	if (explicitConfigPath !== undefined) configPath = explicitConfigPath;
	else if (config !== undefined) {
		configPath = path.join(mkdtempSync(path.join(tmpdir(), "cooldown-test-")), "cooldown.json");
		writeFileSync(configPath, JSON.stringify(config));
	}
	const factoryOptions = {};
	if (configPath !== undefined) factoryOptions.configPath = configPath;
	if (tickMs !== undefined) factoryOptions.tickMs = tickMs;
	createCooldownExtension(pi, factoryOptions);
	return { handlers, commands, sent, appended, notifies, statuses, statusCalls, ctx, branchEntries, setIdle: (value) => (idle = value) };
}

async function startRuntime(runtime, reason = "startup") {
	await runtime.handlers.get("session_start")({ reason }, runtime.ctx);
}

function messageEnd(runtime, message) {
	return runtime.handlers.get("message_end")({ message }, runtime.ctx);
}

async function shutdownRuntime(runtime) {
	await runtime.handlers.get("session_shutdown")({ reason: "quit" }, runtime.ctx);
}

const lastAppend = (runtime) => runtime.appended[runtime.appended.length - 1];

const cases = [];
const test = (label, fn) => cases.push([label, fn]);

// --- config loader ------------------------------------------------------

test("the shipped sidecar loads: zai entry with offset 480, defaults resolved", () => {
	const result = loadCooldownConfig(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "extensions", "cooldown.json"));
	assert.equal(result.ok, true);
	const config = result.config;
	assert.equal(config.defaultBufferMinutes, 2);
	assert.equal(config.maxResumeAttempts, 5);
	assert.equal(config.resumeOnRestart, false);
	assert.equal(config.providers.length, 1);
	const entry = config.providers[0];
	assert.equal(entry.name, "zai-glm");
	assert.deepEqual(entry.match, { provider: "zai" });
	assert.equal(entry.utcOffsetMinutes, 480);
	assert.equal(entry.bufferMinutes, 2);
	assert.ok(entry.errorPattern instanceof RegExp);
	assert.ok(entry.resetTimePattern instanceof RegExp);
	assert.ok(typeof entry.resumePrompt === "string" && entry.resumePrompt.length > 0);
});

test("the shipped sidecar matches and parses the verbatim 1308 error", () => {
	const { ok, config } = loadCooldownConfig(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "extensions", "cooldown.json"));
	assert.equal(ok, true);
	const entry = findCooldownEntry(config, "zai", "glm-5.3");
	assert.ok(entry, "zai entry must match provider zai");
	assert.ok(entry.errorPattern.test(VERBATIM_1308), "errorPattern must match the verbatim 1308 body");
	assert.equal(parseResetEpochMs(entry, VERBATIM_1308), VERBATIM_RESET_EPOCH);
});

test("validation applies top-level defaults for absent optional fields", () => {
	const result = validateCooldownConfig({
		providers: [{ name: "p", match: { provider: "x" }, errorPattern: "1308", resetTimePattern: "reset (\\d{4}-\\d{2}-\\d{2})", utcOffsetMinutes: 0 }],
	});
	assert.equal(result.ok, true);
	assert.equal(result.config.defaultBufferMinutes, 2);
	assert.equal(result.config.maxResumeAttempts, 5);
	assert.equal(result.config.resumeOnRestart, false);
	assert.ok(result.config.resumePrompt.length > 0);
	assert.equal(result.config.providers[0].bufferMinutes, 2, "entry buffer resolves to the top-level default");
});

test("per-entry bufferMinutes and resumePrompt override top-level defaults", () => {
	const result2 = validateCooldownConfig({
		defaultBufferMinutes: 5,
		resumePrompt: "top prompt",
		providers: [
			{
				name: "p",
				match: { provider: "x" },
				errorPattern: "limit",
				resetTimePattern: "at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})",
				utcOffsetMinutes: 0,
				bufferMinutes: 0,
				resumePrompt: "entry prompt",
			},
		],
	});
	assert.equal(result2.ok, true);
	const entry = result2.config.providers[0];
	assert.equal(entry.bufferMinutes, 0);
	assert.equal(entry.resumePrompt, "entry prompt");
	assert.equal(result2.config.resumePrompt, "top prompt");
});

test("an uncompilable errorPattern fails validation naming the entry", () => {
	const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], errorPattern: "(unclosed" }] }));
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((problem) => problem.includes("zai-glm")));
});

test("an uncompilable resetTimePattern fails validation", () => {
	const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], resetTimePattern: "a)b" }] }));
	assert.equal(result.ok, false);
});

test("a resetTimePattern without a capture group fails validation", () => {
	const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], resetTimePattern: "\\d{4}-\\d{2}-\\d{2}" }] }));
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((problem) => problem.includes("capture")));
});

test("utcOffsetMinutes outside ±840 fails; ±840 boundaries pass", () => {
	for (const offset of [841, -841, Number.NaN, Infinity, "480"]) {
		const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], utcOffsetMinutes: offset }] }));
		assert.equal(result.ok, false, `offset ${offset} must fail`);
	}
	for (const offset of [840, -840, 0]) {
		const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], utcOffsetMinutes: offset }] }));
		assert.equal(result.ok, true, `offset ${offset} must pass`);
	}
});

test("negative bufferMinutes fails; zero passes", () => {
	const negative = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], bufferMinutes: -1 }] }));
	assert.equal(negative.ok, false);
	const negativeTop = validateCooldownConfig(rawConfig({ defaultBufferMinutes: -2 }));
	assert.equal(negativeTop.ok, false);
	const zero = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], bufferMinutes: 0 }] }));
	assert.equal(zero.ok, true);
});

test("missing or empty providers fail validation", () => {
	assert.equal(validateCooldownConfig({}).ok, false);
	assert.equal(validateCooldownConfig({ providers: [] }).ok, false);
	assert.equal(validateCooldownConfig({ providers: "nope" }).ok, false);
});

test("duplicate provider entry names fail validation", () => {
	const entry = rawConfig().providers[0];
	const result = validateCooldownConfig(rawConfig({ providers: [entry, { ...entry, match: { provider: "other" } }] }));
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((problem) => problem.includes("zai-glm")));
});

test("an entry missing match.provider fails validation", () => {
	const result = validateCooldownConfig(rawConfig({ providers: [{ ...rawConfig().providers[0], match: {} }] }));
	assert.equal(result.ok, false);
});

test("a non-object config root fails validation with one problem", () => {
	for (const root of [null, [], "config", 42]) {
		const result = validateCooldownConfig(root);
		assert.equal(result.ok, false, `${typeof root} root must fail`);
		assert.ok(result.problems.length >= 1);
	}
});

test("problems collect across fields instead of stopping at the first", () => {
	const result = validateCooldownConfig({
		defaultBufferMinutes: -5,
		maxResumeAttempts: 0,
		providers: [{ name: "", match: {}, errorPattern: "(bad", resetTimePattern: "x", utcOffsetMinutes: 9999 }],
	});
	assert.equal(result.ok, false);
	assert.ok(result.problems.length >= 4, `expected several problems, got ${result.problems.length}`);
});

test("loadCooldownConfig on a missing file fails safe with a problem", () => {
	const result = loadCooldownConfig("/nonexistent/cooldown.json");
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((problem) => problem.includes("/nonexistent/cooldown.json")));
});

test("loadCooldownConfig on invalid JSON fails safe with a problem", () => {
	const file = path.join(mkdtempSync(path.join(tmpdir(), "cooldown-test-")), "broken.json");
	writeFileSync(file, "{ not json");
	const result = loadCooldownConfig(file);
	assert.equal(result.ok, false);
	assert.ok(result.problems.length >= 1);
});

// --- local config override -----------------------------------------------

/** A tempdir with a tracked default and, when given, a cooldown.local.json (object serializes, string lands verbatim); returns the default path. */
function tempConfigDir(tracked, local) {
	const dir = mkdtempSync(path.join(tmpdir(), "cooldown-local-"));
	const defaultPath = path.join(dir, "cooldown.json");
	writeFileSync(defaultPath, JSON.stringify(tracked));
	if (local !== undefined) writeFileSync(path.join(dir, "cooldown.local.json"), typeof local === "string" ? local : JSON.stringify(local));
	return defaultPath;
}

const LOCAL_ONLY_CONFIG = {
	maxResumeAttempts: 2,
	resumeOnRestart: true,
	resumePrompt: "local prompt",
	providers: [{ name: "local-only", match: { provider: "local" }, errorPattern: "limit", resetTimePattern: "at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})", utcOffsetMinutes: 0, bufferMinutes: 3 }],
};

test("a valid local config wholly replaces the tracked default", () => {
	const defaultPath = tempConfigDir(rawConfig({ defaultBufferMinutes: 7 }), LOCAL_ONLY_CONFIG);
	const result = loadCooldownConfigWithLocalOverride(defaultPath);
	assert.equal(result.ok, true);
	assert.deepEqual(result.config.providers.map((entry) => entry.name), ["local-only"]);
	assert.equal(result.config.maxResumeAttempts, 2);
	assert.equal(result.config.resumeOnRestart, true);
	assert.equal(result.config.resumePrompt, "local prompt");
	assert.equal(result.config.defaultBufferMinutes, 2, "document-level replacement: the tracked file's 7-minute override must not merge through");
});

test("an invalid local config leaves the lookup inert naming the local path", () => {
	const brokenJson = loadCooldownConfigWithLocalOverride(tempConfigDir(rawConfig(), "{ not json"));
	assert.equal(brokenJson.ok, false);
	assert.ok(brokenJson.problems.some((problem) => problem.includes("cooldown.local.json")));
	const schemaInvalid = loadCooldownConfigWithLocalOverride(tempConfigDir(rawConfig(), { providers: [] }));
	assert.equal(schemaInvalid.ok, false);
	assert.ok(schemaInvalid.problems.every((problem) => problem.includes("cooldown.local.json")), "schema problems name the local path, not silently the tracked one");
});

test("an absent local config loads the tracked default exactly as before", () => {
	const defaultPath = tempConfigDir(rawConfig({ defaultBufferMinutes: 7 }));
	const result = loadCooldownConfigWithLocalOverride(defaultPath);
	assert.equal(result.ok, true);
	assert.equal(result.config.providers[0].name, "zai-glm");
	assert.equal(result.config.defaultBufferMinutes, 7);
});

test("an explicit configPath bypasses the local lookup entirely", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cooldown-local-"));
	const trackedPath = path.join(dir, "cooldown.json");
	writeFileSync(trackedPath, JSON.stringify(rawConfig()));
	writeFileSync(path.join(dir, "cooldown.local.json"), JSON.stringify(LOCAL_ONLY_CONFIG));
	const runtime = createRuntime({ configPath: trackedPath });
	await startRuntime(runtime);
	await messageEnd(runtime, { role: "assistant", stopReason: "error", errorMessage: "limit at 2026-01-02 03:04:05", provider: "local", model: "local-model" });
	assert.equal(runtime.appended.length, 0, "the local file's provider is invisible under an explicit configPath");
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(lastAppend(runtime).data.state, "waiting", "the tracked file's provider armed");
	await shutdownRuntime(runtime);
});

// --- entry matching -----------------------------------------------------

test("findCooldownEntry matches provider exactly and first entry wins", () => {
	const { config } = validateCooldownConfig({
		providers: [
			{ name: "first", match: { provider: "zai" }, errorPattern: "a", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
			{ name: "second", match: { provider: "zai" }, errorPattern: "b", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
			{ name: "other", match: { provider: "anthropic" }, errorPattern: "c", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
		],
	});
	assert.equal(findCooldownEntry(config, "zai", "glm-5.3").name, "first");
	assert.equal(findCooldownEntry(config, "anthropic", "claude").name, "other");
	assert.equal(findCooldownEntry(config, "openai", "gpt"), undefined);
});

test("matchesEntryModel: glob star, exact match, and absent patterns", () => {
	assert.equal(matchesEntryModel(undefined, "any-model"), true);
	assert.equal(matchesEntryModel(undefined, undefined), true);
	assert.equal(matchesEntryModel("glm-5.3", "glm-5.3"), true);
	assert.equal(matchesEntryModel("glm-5.3", "glm-5.3-flash"), false);
	assert.equal(matchesEntryModel("glm-5.3*", "glm-5.3-flash"), true);
	assert.equal(matchesEntryModel("glm-5.3*", "xglm-5.3"), false);
	assert.equal(matchesEntryModel("glm-*", undefined), false);
	assert.equal(matchesEntryModel("*", "anything"), true);
});

test("findCooldownEntry applies the model pattern", () => {
	const { config } = validateCooldownConfig({
		providers: [{ name: "glm-only", match: { provider: "zai", model: "glm-*" }, errorPattern: "a", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 }],
	});
	assert.equal(findCooldownEntry(config, "zai", "glm-5.3").name, "glm-only");
	assert.equal(findCooldownEntry(config, "zai", "other-model"), undefined);
});

test("validateCooldownConfig compiles the model matcher once onto the resolved entry", () => {
	const { config } = validateCooldownConfig({
		providers: [
			{ name: "glob", match: { provider: "zai", model: "glm-*" }, errorPattern: "a", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
			{ name: "exact", match: { provider: "acme", model: "sonnet-4" }, errorPattern: "a", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
			{ name: "absent", match: { provider: "openai" }, errorPattern: "a", resetTimePattern: "(\\d{4})", utcOffsetMinutes: 0 },
		],
	});
	assert.ok(config.providers[0].modelMatcher instanceof RegExp, "the glob pattern compiles at validation time");
	assert.equal(config.providers[0].modelMatcher.test("glm-5.3-flash"), true);
	assert.equal(config.providers[0].modelMatcher.test("xglm-5.3"), false);
	assert.ok(config.providers[1].modelMatcher instanceof RegExp, "the exact pattern compiles to its anchored literal");
	assert.equal(config.providers[1].modelMatcher.test("sonnet-4"), true);
	assert.equal(config.providers[1].modelMatcher.test("sonnet-4.5"), false);
	assert.equal(config.providers[2].modelMatcher, undefined, "an absent model pattern needs no matcher");
});

// --- reset time parsing -------------------------------------------------

test("the verbatim 1308 message parses to the correct epoch under offset 480", () => {
	const entry = zaiEntry();
	assert.equal(parseResetEpochMs(entry, VERBATIM_1308), VERBATIM_RESET_EPOCH);
	assert.equal(new Date(VERBATIM_RESET_EPOCH).toISOString(), "2026-11-22T22:58:41.000Z");
});

test("offset conversion signs correctly: -300 reads the stamp five hours later than UTC", () => {
	const entry = zaiEntry({ entry: { name: "p", match: { provider: "x" }, errorPattern: "limit", resetTimePattern: "at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})", utcOffsetMinutes: -300, bufferMinutes: 0 } });
	const stamp = "2026-11-23 06:58:41";
	assert.equal(parseResetEpochMs(entry, `limit at ${stamp}`), Date.UTC(2026, 10, 23, 6, 58, 41) + 300 * MINUTES);
});

test("a timestamp that is already UTC parses under offset 0", () => {
	const entry = zaiEntry({ entry: { name: "p", match: { provider: "x" }, errorPattern: "limit", resetTimePattern: "at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})", utcOffsetMinutes: 0, bufferMinutes: 0 } });
	assert.equal(parseResetEpochMs(entry, "limit at 2026-01-02 03:04:05"), Date.UTC(2026, 0, 2, 3, 4, 5));
});

test("malformed or missing reset times return undefined", () => {
	const entry = zaiEntry();
	for (const text of [
		"",
		"no timestamp here",
		'{"code":"1308","message":"Your limit will reset at not-a-time"}',
		'{"code":"1308","message":"Your limit will reset at 2026-13-40 99:99:99"}',
		'{"code":"1308","message":"Your limit will reset at 2026-02-30 10:00:00"}',
		'{"code":"1308","message":"Your limit will reset at 2026-11-23 24:00:00"}',
		'{"code":"1308","message":"Your limit will reset at 06:58:41"}',
		'{"code":"1308","message":"Your limit will reset at 2026-11-23 06:58"}',
	]) {
		assert.equal(parseResetEpochMs(entry, text), undefined, `must reject: ${text}`);
	}
});

test("a four-digit year below 0100 is rejected instead of mapping into 1900+", () => {
	const entry = zaiEntry();
	assert.equal(parseResetEpochMs(entry, '{"code":"1308","message":"Your limit will reset at 0099-05-06 07:08:09"}'), undefined);
	assert.notEqual(parseResetEpochMs(entry, '{"code":"1308","message":"Your limit will reset at 0100-05-06 07:08:09"}'), undefined, "0100 itself is a real year and still parses");
});

test("the reset pattern is case-insensitive and reads the timestamp from capture group 1", () => {
	const entry = zaiEntry();
	assert.ok(entry.resetTimePattern.test("YOUR LIMIT WILL RESET AT 2026-11-23 06:58:41"));
	const twoGroup = zaiEntry({ entry: { name: "p", match: { provider: "x" }, errorPattern: "limit", resetTimePattern: "at (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}) (limit)", utcOffsetMinutes: 0, bufferMinutes: 0 } });
	assert.equal(parseResetEpochMs(twoGroup, "at 2026-01-02 03:04:05 limit"), Date.UTC(2026, 0, 2, 3, 4, 5), "group 1 carries the timestamp; later groups are ignored");
});

// --- error pattern matching --------------------------------------------

test("the zai errorPattern matches the 1308 body but not 13081, bare 429, or unrelated text", () => {
	const entry = zaiEntry();
	assert.ok(entry.errorPattern.test(VERBATIM_1308));
	assert.ok(entry.errorPattern.test('{"code": 1308, "message": "x"}'), "unquoted numeric code must match");
	assert.equal(entry.errorPattern.test('{"code":"13081"}'), false);
	assert.equal(entry.errorPattern.test("Error: 429: too many requests"), false);
	assert.equal(entry.errorPattern.test("Error: 500: internal server error"), false);
	assert.equal(entry.errorPattern.test("insufficient_quota: you exceeded your quota"), false);
});

// --- planCooldownArm (arm/extend/cap decisions) --------------------------

test("fresh arm computes fireAt = reset + buffer with attempts 0", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const resetAt = VERBATIM_RESET_EPOCH;
	const decision = planCooldownArm(config, assistantError(VERBATIM_1308), undefined, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.entry.name, "zai-glm");
	assert.equal(decision.state.resetAtMs, resetAt);
	assert.equal(decision.state.fireAtMs, resetAt + 2 * MINUTES);
	assert.equal(decision.state.attempts, 0);
	assert.equal(decision.extended, false);
});

test("per-entry buffer 0 puts fireAt exactly at the reset time", () => {
	const { config } = validateCooldownConfig({ providers: [{ ...rawConfig().providers[0], bufferMinutes: 0 }] });
	const decision = planCooldownArm(config, assistantError(VERBATIM_1308), undefined, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.state.fireAtMs, decision.state.resetAtMs);
});

test("a second 1308 with a later reset extends the timer and keeps attempts", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const current = waitingState(wholeSecond(now) + 10 * MINUTES, 3);
	const laterReset = wholeSecond(now) + 30 * MINUTES;
	const decision = planCooldownArm(config, assistantError(fixture1308(laterReset)), current, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.extended, true);
	assert.equal(decision.state.fireAtMs, laterReset + 2 * MINUTES);
	assert.equal(decision.state.attempts, 3);
});

test("a second 1308 with an earlier reset never shortens a pending deadline", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const current = waitingState(now + 30 * MINUTES, 1);
	const earlierReset = now + 5 * MINUTES;
	const decision = planCooldownArm(config, assistantError(fixture1308(earlierReset)), current, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.extended, false);
	assert.deepEqual(decision.state, current);
});

test("a stale (already fired) deadline is replaced by the fresh plan", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const stale = waitingState(wholeSecond(now) - 5 * MINUTES, 2);
	const freshReset = wholeSecond(now) + 5 * MINUTES;
	const decision = planCooldownArm(config, assistantError(fixture1308(freshReset)), stale, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.state.fireAtMs, freshReset + 2 * MINUTES);
	assert.equal(decision.state.attempts, 2, "attempts carry across the replacement");
});

test("a shorter fresh reset replaces a stale deadline even when still earlier", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const stale = waitingState(wholeSecond(now) - MINUTES, 0);
	const freshReset = wholeSecond(now) - 30_000;
	const decision = planCooldownArm(config, assistantError(fixture1308(freshReset)), stale, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.state.fireAtMs, freshReset + 2 * MINUTES);
});

test("a stale deadline from another entry does not lend its attempts to the fresh arm", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const staleOther = waitingState(wholeSecond(now) - 5 * MINUTES, 4, "other-entry");
	const freshReset = wholeSecond(now) + 5 * MINUTES;
	const decision = planCooldownArm(config, assistantError(fixture1308(freshReset)), staleOther, now);
	assert.equal(decision.action, "arm");
	assert.equal(decision.state.attempts, 0, "attempts carry only within the same entry");
});

test("reaching maxResumeAttempts reports cap_reached; one below arms", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const capped = planCooldownArm(config, assistantError(VERBATIM_1308), waitingState(now + MINUTES, 5), now);
	assert.equal(capped.action, "cap_reached");
	assert.equal(capped.attempts, 5);
	const belowCap = planCooldownArm(config, assistantError(VERBATIM_1308), waitingState(now + MINUTES, 4), now);
	assert.equal(belowCap.action, "arm");
	assert.equal(belowCap.state.attempts, 4);
});

test("a reset time already in the past arms a fire-at-once deadline", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const pastReset = now - 10 * MINUTES;
	const decision = planCooldownArm(config, assistantError(fixture1308(pastReset)), undefined, now);
	assert.equal(decision.action, "arm");
	assert.ok(decision.state.fireAtMs < now);
});

test("non-matching messages are ignored without arming", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const ignored = [
		{ role: "user", stopReason: "error", errorMessage: VERBATIM_1308, provider: "zai", model: "glm-5.3" },
		{ role: "assistant", stopReason: "aborted", errorMessage: VERBATIM_1308, provider: "zai", model: "glm-5.3" },
		{ role: "assistant", stopReason: "error", provider: "zai", model: "glm-5.3" },
		{ role: "assistant", stopReason: "error", errorMessage: "Error: 429: too many requests", provider: "zai", model: "glm-5.3" },
		assistantError(VERBATIM_1308, "anthropic", "claude-opus"),
	];
	for (const message of ignored) {
		assert.equal(planCooldownArm(config, message, undefined, now).action, "ignore", JSON.stringify(message));
	}
});

test("an entry with a model pattern ignores other models from the same provider", () => {
	const { config } = validateCooldownConfig({
		providers: [{ name: "glm-only", match: { provider: "zai", model: "glm-*" }, errorPattern: "1308", resetTimePattern: "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})", utcOffsetMinutes: 480, bufferMinutes: 0 }],
	});
	assert.equal(planCooldownArm(config, assistantError(VERBATIM_1308, "zai", "non-matching-model"), undefined, now).action, "ignore");
	assert.equal(planCooldownArm(config, assistantError(VERBATIM_1308, "zai", "glm-5.3"), undefined, now).action, "arm");
});

test("a 1308 whose reset time fails to parse reports parse_failed with the entry", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const decision = planCooldownArm(config, assistantError('Error: 429: {"code":"1308","message":"Usage limit reached"}'), undefined, now);
	assert.equal(decision.action, "parse_failed");
	assert.equal(decision.entry.name, "zai-glm");
});

test("a fresh arm pins the errored model and a re-arm re-pins to the newest error", () => {
	const { config } = validateCooldownConfig(rawConfig());
	const fresh = planCooldownArm(config, assistantError(VERBATIM_1308, "zai", "glm-5.3"), undefined, now);
	assert.equal(fresh.action, "arm");
	assert.equal(fresh.state.model, "glm-5.3");
	const rearm = planCooldownArm(config, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES), "zai", "glm-5.3-flash"), fresh.state, now);
	assert.equal(rearm.action, "arm");
	assert.equal(rearm.state.model, "glm-5.3-flash", "the newest errored model owns the pin");
	const bare = planCooldownArm(config, { role: "assistant", stopReason: "error", errorMessage: VERBATIM_1308, provider: "zai" }, undefined, now);
	assert.equal(bare.action, "arm");
	assert.equal(bare.state.model, undefined, "a message without a model id arms without a pin");
});

// --- planRestartResume (restart decision table) --------------------------

test("no persisted state means no restart action", () => {
	assert.deepEqual(planRestartResume(undefined, true, now), { action: "none" });
});

test("resumeOnRestart true with a future deadline re-arms carrying attempts", () => {
	const state = waitingState(now + 60 * MINUTES, 2);
	const decision = planRestartResume(state, true, now);
	assert.equal(decision.action, "rearm");
	assert.deepEqual(decision.state, state);
});

test("resumeOnRestart true with a past deadline resumes now carrying attempts", () => {
	const state = waitingState(now - MINUTES, 3);
	const decision = planRestartResume(state, true, now);
	assert.equal(decision.action, "resume_now");
	assert.deepEqual(decision.state, state);
});

test("restart with resumeOnRestart false drops both future and past deadlines", () => {
	assert.equal(planRestartResume(waitingState(now + 60 * MINUTES, 0), false, now).action, "drop");
	assert.equal(planRestartResume(waitingState(now - MINUTES, 2), false, now).action, "drop");
});

test("fork re-arms a future deadline without resumeOnRestart", () => {
	const state = waitingState(now + 60 * MINUTES, 1);
	const decision = planRestartResume(state, false, now, "fork");
	assert.equal(decision.action, "rearm");
	assert.deepEqual(decision.state, state);
});

test("fork never resumes past deadlines, even with resumeOnRestart true", () => {
	const decision = planRestartResume(waitingState(now - MINUTES, 2), true, now, "fork");
	assert.equal(decision.action, "drop");
	assert.equal(decision.gate, "fork");
});

test("reload bypasses the gate in both directions regardless of resumeOnRestart", () => {
	assert.equal(planRestartResume(waitingState(now + 60 * MINUTES, 0), false, now, "reload").action, "rearm");
	assert.equal(planRestartResume(waitingState(now - MINUTES, 1), false, now, "reload").action, "resume_now");
});

test("startup and resume stay gated by resumeOnRestart and name that gate when dropping", () => {
	const dropped = planRestartResume(waitingState(now + MINUTES, 0), false, now, "startup");
	assert.equal(dropped.action, "drop");
	assert.equal(dropped.gate, "resumeOnRestart");
});

// --- collectPendingWaits (restart scan) ----------------------------------

test("collectPendingWaits collects a newest real waiting entry", () => {
	const state = { entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 1 };
	assert.deepEqual(collectPendingWaits([persistedEntry({ state: "waiting", ...state })]), [state]);
});

test("collectPendingWaits: a newest terminal entry hides only its own name", () => {
	const waiting = { state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 };
	const terminals = [
		{ state: "fired", entryName: "zai-glm", attempts: 2 },
		{ state: "cancelled", entryName: "zai-glm", gate: "resumeOnRestart" },
		{ state: "cancelled", entryName: "zai-glm", gate: "fork" },
		{ state: "capped", entryName: "zai-glm", attempts: 5 },
		{ state: "resolved", entryName: "zai-glm" },
	];
	for (const terminal of terminals) {
		assert.deepEqual(collectPendingWaits([persistedEntry(waiting), persistedEntry(terminal)]), [], `a newest ${terminal.state} record must decide its name as no-wait`);
	}
});

test("collectPendingWaits decides per entry name: one name's tombstone hides only that name", () => {
	const zaiWait = { entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 0 };
	assert.deepEqual(
		collectPendingWaits([
			persistedEntry({ state: "waiting", ...zaiWait }),
			persistedEntry({ state: "waiting", entryName: "acme-pro", resetAtMs: now + 10 * MINUTES, fireAtMs: now + 12 * MINUTES, attempts: 0 }),
			persistedEntry({ state: "resolved", entryName: "acme-pro" }),
		]),
		[zaiWait],
	);
});

test("collectPendingWaits: a malformed newest entry with a readable name decides it as no-wait", () => {
	const waiting = persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 0 });
	const malformed = persistedEntry({ state: "waiting", entryName: "zai-glm", fireAtMs: "not-a-number", attempts: 0 });
	assert.deepEqual(collectPendingWaits([waiting, malformed]), []);
});

test("collectPendingWaits: a cooldown record with no readable entryName is unattributable and decides nothing", () => {
	const state = { entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 0 };
	assert.deepEqual(collectPendingWaits([{ type: "custom", customType: ENTRY_TYPE, data: { state: "waiting" } }, persistedEntry({ state: "waiting", ...state })]), [state]);
});

test("collectPendingWaits: a newest simulated waiting entry decides its own name as no-re-arm", () => {
	const real = { state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 };
	const simulated = { state: "waiting", entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 0, simulated: true };
	assert.deepEqual(collectPendingWaits([persistedEntry(real), persistedEntry(simulated)]), []);
	assert.deepEqual(collectPendingWaits([persistedEntry(simulated), persistedEntry(real)]).length, 1, "a newer real entry decides its name");
});

test("collectPendingWaits returns waits in branch order for deterministic adjudication", () => {
	const acmeWait = { entryName: "acme-pro", resetAtMs: now + 10 * MINUTES, fireAtMs: now + 12 * MINUTES, attempts: 0 };
	const zaiWait = { entryName: "zai-glm", resetAtMs: now + 5 * MINUTES, fireAtMs: now + 7 * MINUTES, attempts: 0 };
	assert.deepEqual(collectPendingWaits([persistedEntry({ state: "waiting", ...acmeWait }), persistedEntry({ state: "waiting", ...zaiWait })]), [acmeWait, zaiWait]);
});

// --- wiring: registration and fail-safe ---------------------------------

test("the factory registers the cooldown handlers and both commands", () => {
	const runtime = createRuntime();
	for (const event of ["session_start", "message_end", "session_shutdown"]) {
		assert.equal(typeof runtime.handlers.get(event), "function", `missing handler: ${event}`);
	}
	assert.ok(runtime.commands.get("cooldown"));
	assert.ok(runtime.commands.get("cooldown-simulate"));
	assert.match(runtime.commands.get("cooldown").description, /cooldown/i);
});

test("a valid config at session_start produces no error notify", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	assert.equal(runtime.notifies.some((notification) => notification.level === "error"), false);
});

test("an invalid config notifies error at session_start and the extension stays inert", async () => {
	const runtime = createRuntime({ config: { providers: [{ name: "bad", match: {}, errorPattern: "(bad", resetTimePattern: "(\\d)", utcOffsetMinutes: 0 }] } });
	await startRuntime(runtime);
	assert.ok(runtime.notifies.some((notification) => notification.level === "error" && notification.message.includes("cooldown")));
	await messageEnd(runtime, assistantError(VERBATIM_1308));
	await sleep(30);
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.appended.length, 0);
	assert.equal(runtime.statuses.size, 0);
});

test("commands on an invalid config report disabled instead of acting", async () => {
	const runtime = createRuntime({ config: { providers: [] } });
	await startRuntime(runtime);
	await runtime.commands.get("cooldown").handler("", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("disabled")));
});

test("arming is guarded to tui and rpc modes: print-mode 1308s stay inert", async () => {
	const runtime = createRuntime({ mode: "print" });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 5 * MINUTES)));
	assert.equal(runtime.appended.length, 0, "print mode must not persist a waiting entry");
	assert.equal(runtime.statuses.size, 0);
	await sleep(30);
	assert.equal(runtime.sent.length, 0, "print mode must not arm or fire");
	await shutdownRuntime(runtime);
});

test("rpc mode still arms through the guard", async () => {
	const runtime = createRuntime({ mode: "rpc" });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 5 * MINUTES)));
	assert.equal(lastAppend(runtime).data.state, "waiting");
	await shutdownRuntime(runtime);
});

// --- wiring: arm, wait, fire ---------------------------------------------

test("a 1308 on message_end arms: status set, waiting entry persisted, warning notified", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now))));
	const status = runtime.statuses.get(statusKeyFor("zai-glm"));
	assert.ok(status, "footer status must be set");
	assert.ok(status.includes("zai-glm"));
	const append = lastAppend(runtime);
	assert.equal(append.customType, ENTRY_TYPE);
	assert.equal(append.data.state, "waiting");
	assert.equal(append.data.entryName, "zai-glm");
	assert.equal(append.data.attempts, 0);
	assert.ok(append.data.fireAtMs > Date.now(), "default buffer puts the deadline ~2 minutes out");
	assert.ok(runtime.notifies.some((notification) => notification.level === "warning" && notification.message.includes("zai-glm")));
});

test("the armed timer fires and resumes with the entry resume prompt", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
	assert.match(runtime.sent[0].content, /z\.ai usage-limit window has reset/);
	assert.equal(runtime.sent[0].options, undefined, "idle resume sends without delivery options");
	const append = lastAppend(runtime);
	assert.equal(append.data.state, "fired");
	assert.equal(append.data.attempts, 1);
	assert.ok(runtime.notifies.some((notification) => notification.level === "info" && /attempt 1\/5/.test(notification.message)));
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "status clears at fire time");
});

test("a busy session at fire time resumes as a followUp", async () => {
	const runtime = createRuntime();
	runtime.setIdle(false);
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
	assert.deepEqual(runtime.sent[0].options, { deliverAs: "followUp" });
});

test("a repeat 1308 on the resumed turn re-arms with carried attempts and fires again", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	const append = lastAppend(runtime);
	assert.equal(append.data.state, "waiting");
	assert.equal(append.data.attempts, 1, "attempts carry into the re-arm");
	await sleep(120);
	assert.equal(runtime.sent.length, 2);
	assert.equal(lastAppend(runtime).data.attempts, 2);
	assert.ok(runtime.notifies.some((notification) => /attempt 2\/5/.test(notification.message)));
});

test("a non-error reset timestamp on a matched error warns and does not arm", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError('Error: 429: {"code":"1308","message":"Usage limit reached for 5 hour."}'));
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.appended.length, 0);
	assert.equal(runtime.statuses.size, 0);
	assert.ok(runtime.notifies.some((notification) => notification.level === "warning" && notification.message.includes("parse")));
});

test("a successful assistant message from the same provider retires the pending wait", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", errorMessage: undefined, provider: "zai", model: "glm-5.3" });
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	assert.equal(lastAppend(runtime).data.state, "resolved");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "the pending timer must not fire after retirement");
});

test("a deadline beyond the timeout cap chains instead of firing early", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 30 * 24 * 60 * MINUTES)));
	assert.equal(lastAppend(runtime).data.state, "waiting");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await sleep(120);
	assert.equal(runtime.sent.length, 0, "node fires over-cap delays immediately; the chained timer must not");
	await shutdownRuntime(runtime);
});

test("an aborted or foreign-provider success does not retire the pending wait", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await messageEnd(runtime, { role: "assistant", stopReason: "aborted", provider: "zai", model: "glm-5.3" });
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "anthropic", model: "claude-opus" });
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), true, "pending wait survives unrelated successes");
	await shutdownRuntime(runtime);
});

test("session_shutdown clears the pending timer so nothing fires afterwards", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await shutdownRuntime(runtime);
	await sleep(150);
	assert.equal(runtime.sent.length, 0);
});

// --- wiring: cap -> disabled -> re-enabled -------------------------------

test("hitting maxResumeAttempts notifies error, persists capped, and stops retrying until a success re-enables", async () => {
	const runtime = createRuntime({ config: rawConfig({ maxResumeAttempts: 1 }) });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.ok(runtime.notifies.some((notification) => notification.level === "error" && notification.message.includes("zai-glm")));
	assert.equal(lastAppend(runtime).data.state, "capped");
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	await sleep(150);
	assert.equal(runtime.sent.length, 1, "the capped wait must not re-arm or re-send");
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.equal(runtime.appended.filter((append) => append.data.state === "waiting").length, 1, "disabled entries ignore new 1308s");
	assert.ok(runtime.notifies.some((notification) => notification.level === "info" && notification.message.includes("disabled")), "a real 1308 while capped notifies info instead of staying silent");
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3" });
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.equal(runtime.appended.filter((append) => append.data.state === "waiting").length, 2, "a successful turn re-enables auto-recovery");
	await shutdownRuntime(runtime);
});

// --- wiring: multi-entry status keys -------------------------------------

test("two concurrently armed entries render under their own per-entry status keys", async () => {
	const runtime = createRuntime({ config: twoProviderConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 40 * MINUTES)));
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "the zai wait renders under its own key");
	assert.ok(runtime.statuses.has(statusKeyFor("acme-pro")), "the acme wait renders under its own key");
	await shutdownRuntime(runtime);
});

test("each entry's tick writes only its own key with its own countdown", async () => {
	const runtime = createRuntime({ config: twoProviderConfig(), tickMs: 20 });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 40 * MINUTES)));
	await sleep(70);
	const ticked = new Set();
	for (const call of runtime.statusCalls) {
		const entryName = call.key === statusKeyFor("zai-glm") ? "zai-glm" : call.key === statusKeyFor("acme-pro") ? "acme-pro" : undefined;
		assert.ok(entryName !== undefined, `every status write targets a per-entry key, got ${JSON.stringify(call.key)}`);
		assert.ok(call.text.includes(entryName), "the write's text belongs to the key's entry");
		ticked.add(entryName);
	}
	assert.ok(ticked.has("zai-glm") && ticked.has("acme-pro"), "both entries tick their own keys");
	await shutdownRuntime(runtime);
});

test("firing one entry clears only its own key and leaves the survivor's segment intact", async () => {
	const runtime = createRuntime({ config: twoProviderConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 60 * MINUTES)));
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(150);
	assert.equal(runtime.sent.length, 1, "the near-deadline zai wait fired");
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "the fired entry's key cleared");
	assert.ok(runtime.statuses.has(statusKeyFor("acme-pro")), "the survivor's segment is intact");
	await shutdownRuntime(runtime);
});

test("a success from one provider retires only its entry's wait and key", async () => {
	const runtime = createRuntime({ config: twoProviderConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 40 * MINUTES)));
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3" });
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "the retired entry's key cleared");
	assert.ok(runtime.statuses.has(statusKeyFor("acme-pro")), "the other provider's segment is intact");
	const resolved = runtime.appended.filter((append) => append.data.state === "resolved");
	assert.equal(resolved.length, 1, "exactly one entry resolved");
	assert.equal(resolved[0].data.entryName, "zai-glm");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "the retired timer must not fire");
	await shutdownRuntime(runtime);
});

test("capping one entry clears only its key and leaves the other segment armed", async () => {
	const runtime = createRuntime({ config: twoProviderConfig({ maxResumeAttempts: 1 }) });
	await startRuntime(runtime);
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 60 * MINUTES)));
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(150);
	assert.equal(runtime.sent.length, 1);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.equal(lastAppend(runtime).data.state, "capped");
	assert.equal(lastAppend(runtime).data.entryName, "zai-glm");
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "the capped entry's key cleared");
	assert.ok(runtime.statuses.has(statusKeyFor("acme-pro")), "the capped entry's cap does not erase the other segment");
	await shutdownRuntime(runtime);
});

test("cancelling clears both per-entry keys and persists one tombstone per pending entry", async () => {
	const runtime = createRuntime({ config: twoProviderConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 40 * MINUTES)));
	await runtime.commands.get("cooldown").handler("cancel", runtime.ctx);
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	assert.equal(runtime.statuses.has(statusKeyFor("acme-pro")), false);
	const cancelled = runtime.appended.filter((append) => append.data.state === "cancelled");
	assert.equal(cancelled.length, 2, "cancel persists one tombstone per pending entry");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "cancelled timers must not fire");
});

test("a success from a different model leaves a model-pinned wait armed with its timer intact", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3-flash" });
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "the pinned wait survives a different model's success");
	assert.equal(lastAppend(runtime).data.state, "waiting", "no resolved record landed");
	await sleep(150);
	assert.equal(runtime.sent.length, 1, "the armed timer kept its deadline and fired");
});

test("a success from the pinned model retires the wait", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3" });
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	assert.equal(lastAppend(runtime).data.state, "resolved");
	await sleep(150);
	assert.equal(runtime.sent.length, 0);
});

test("a persisted pinned wait keeps its pin across reload", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 30 * MINUTES, fireAtMs: now + 32 * MINUTES, attempts: 1, model: "glm-5.3" }));
	await startRuntime(runtime, "startup");
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3-flash" });
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "the reloaded pin still filters retirements");
	await shutdownRuntime(runtime);
});

test("a wait armed without a model id retires on any matching-entry success", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 30 * MINUTES, fireAtMs: now + 32 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "startup");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await messageEnd(runtime, { role: "assistant", stopReason: "stop", provider: "zai", model: "glm-5.3-flash" });
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "the unpinned wait retires entry-scoped");
	assert.equal(lastAppend(runtime).data.state, "resolved");
	await shutdownRuntime(runtime);
});

// --- wiring: restart re-arm ----------------------------------------------

test("restart with a future deadline and resumeOnRestart re-arms and fires later", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	const base = wholeSecond(Date.now());
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 2 }));
	await startRuntime(runtime, "resume");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "re-arm restores the footer status");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed")));
	await sleep(1600);
	assert.equal(runtime.sent.length, 1);
	assert.equal(lastAppend(runtime).data.attempts, 3);
});

test("restart with a past deadline and resumeOnRestart resumes immediately carrying attempts", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "resume");
	assert.equal(runtime.sent.length, 0, "resume-now is routed through the delay-0 timer seam, not sent inside the handler");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("resuming now")));
	await sleep(20);
	assert.equal(runtime.sent.length, 1);
	assert.equal(lastAppend(runtime).data.state, "fired");
	assert.equal(lastAppend(runtime).data.attempts, 2, "the immediate resume counts as the next attempt");
});

test("restart with resumeOnRestart false drops the status and waits for the user", async () => {
	const runtime = createRuntime();
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 60 * MINUTES, fireAtMs: now + 62 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "resume");
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	assert.ok(runtime.notifies.some((notification) => notification.level === "info" && notification.message.includes("resumeOnRestart")));
	await sleep(60);
	assert.equal(runtime.sent.length, 0);
});

test("a gated drop under hasUI false lands the tombstone and notifies nothing", async () => {
	const runtime = createRuntime({ hasUI: false });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 60 * MINUTES, fireAtMs: now + 62 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "resume");
	assert.equal(runtime.notifies.length, 0, "a headless run records the drop without notifies");
	assert.equal(lastAppend(runtime).data.state, "cancelled", "the gate's tombstone still lands");
	assert.equal(lastAppend(runtime).data.gate, "resumeOnRestart");
	await shutdownRuntime(runtime);
});

test("restart scans only waiting entries: a newest fired entry means no resume", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "fired", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 2 }));
	await startRuntime(runtime, "resume");
	assert.equal(runtime.sent.length, 0, "an already-fired resume must not fire twice");
	await shutdownRuntime(runtime);
});

test("restart ignores cooldown entries with malformed data", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	runtime.branchEntries.push({ type: "custom", customType: ENTRY_TYPE, data: { state: "waiting" } });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", fireAtMs: "not-a-number", attempts: 0 }));
	await startRuntime(runtime, "resume");
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.statuses.size, 0);
	await shutdownRuntime(runtime);
});

test("a mid-session reload re-arms from the persisted entry even with resumeOnRestart false", async () => {
	const runtime = createRuntime();
	const base = wholeSecond(Date.now());
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 1 }));
	await startRuntime(runtime, "reload");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "reload re-arm restores the footer status");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed")));
	await sleep(1700);
	assert.equal(runtime.sent.length, 1, "the re-armed wait fires after the reload");
	assert.equal(lastAppend(runtime).data.attempts, 2);
});

test("a mid-session reload past the deadline resumes immediately even with resumeOnRestart false", async () => {
	const runtime = createRuntime();
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 2 }));
	await startRuntime(runtime, "reload");
	assert.equal(runtime.sent.length, 0, "resume-now is routed through the delay-0 timer seam, not sent inside the handler");
	await sleep(20);
	assert.equal(runtime.sent.length, 1);
	assert.equal(lastAppend(runtime).data.state, "fired");
	assert.equal(lastAppend(runtime).data.attempts, 3);
});

test("a simulated wait does not survive runtime replacement: reload arms nothing", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${fixture1308(wholeSecond(now) + 3 * 60 * MINUTES)}`, runtime.ctx);
	assert.ok(runtime.branchEntries.some((entry) => entry.data.state === "waiting" && entry.data.simulated === true), "the simulated wait is persisted as before");
	runtime.statuses.clear();
	await startRuntime(runtime, "reload");
	assert.equal(runtime.statuses.size, 0, "the simulated wait must not re-arm after runtime replacement");
	assert.equal(runtime.notifies.some((notification) => notification.message.includes("re-armed")), false);
	await sleep(60);
	assert.equal(runtime.sent.length, 0);
});

test("a real wait persisted after a simulated one still re-arms on reload", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${fixture1308(wholeSecond(now) + 3 * 60 * MINUTES)}`, runtime.ctx);
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: wholeSecond(Date.now()) + 90_000 - 120 * MINUTES, fireAtMs: wholeSecond(Date.now()) + 90_000, attempts: 1 }));
	runtime.statuses.clear();
	await startRuntime(runtime, "reload");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed")), "the newest real waiting entry still re-arms");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await shutdownRuntime(runtime);
});

test("a persisted entry name that matches no configured entry warns once, then tombstones", async () => {
	const runtime = createRuntime({ config: rawConfig({ providers: [{ ...rawConfig().providers[0], name: "renamed-entry" }] }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "reload");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("matches no configured provider entry")));
	assert.equal(runtime.sent.length, 0);
	assert.equal(lastAppend(runtime).data.state, "cancelled", "a superseding tombstone stops the warning from recurring");
	runtime.notifies.length = 0;
	runtime.appended.length = 0;
	await startRuntime(runtime, "reload");
	assert.equal(runtime.notifies.length, 0, "the second start sees the tombstone and stays quiet");
	assert.equal(runtime.appended.length, 0);
	assert.equal(runtime.sent.length, 0);
});

test("fork re-arms a future deadline mid-session and drops a past one", async () => {
	const runtime = createRuntime();
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: wholeSecond(Date.now()) + 60_000 - 120 * MINUTES, fireAtMs: wholeSecond(Date.now()) + 60_000, attempts: 1 }));
	await startRuntime(runtime, "fork");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed")), "fork re-arms the future deadline without resumeOnRestart");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await shutdownRuntime(runtime);

	const pastRuntime = createRuntime({ config: rawConfig({ resumeOnRestart: true }) });
	pastRuntime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(pastRuntime, "fork");
	assert.equal(pastRuntime.sent.length, 0, "fork never fires a past deadline into the fresh branch");
	assert.ok(pastRuntime.notifies.some((notification) => notification.message.includes("forked")));
	await shutdownRuntime(pastRuntime);
});

// --- wiring: durable gated drops and the restart mode guard (fix round F2)

test("a startup gated drop tombstones durably: a later /reload cannot re-adjudicate and fire", async () => {
	const runtime = createRuntime();
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "startup");
	assert.equal(runtime.sent.length, 0);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("resumeOnRestart")));
	assert.equal(lastAppend(runtime).data.state, "cancelled", "the gated drop supersedes the waiting entry");
	assert.equal(lastAppend(runtime).data.gate, "resumeOnRestart");
	runtime.notifies.length = 0;
	runtime.appended.length = 0;
	await startRuntime(runtime, "reload");
	await sleep(30);
	assert.equal(runtime.sent.length, 0, "reload must not fire what the startup gate withheld");
	assert.equal(runtime.notifies.some((notification) => notification.message.includes("re-armed") || notification.message.includes("resuming now")), false);
	assert.equal(runtime.statuses.size, 0);
	assert.equal(runtime.appended.length, 0, "reload sees the tombstone and does nothing");
});

test("a fork gated drop holds across a later /reload", async () => {
	const runtime = createRuntime();
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "fork");
	assert.equal(runtime.sent.length, 0);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("forked")));
	assert.equal(lastAppend(runtime).data.state, "cancelled", "the fork gate's drop also supersedes durably");
	assert.equal(lastAppend(runtime).data.gate, "fork");
	runtime.notifies.length = 0;
	runtime.appended.length = 0;
	await startRuntime(runtime, "reload");
	await sleep(30);
	assert.equal(runtime.sent.length, 0, "the fork gate's decision survives reload");
	assert.equal(runtime.notifies.some((notification) => notification.message.includes("resuming now")), false);
	assert.equal(runtime.appended.length, 0);
});

test("a renamed entry under the default gate notifies exactly once, then tombstones on any reason", async () => {
	const runtime = createRuntime({ config: rawConfig({ providers: [{ ...rawConfig().providers[0], name: "renamed-entry" }] }) });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "startup");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("matches no configured provider entry")), "the mismatch warning reaches the gated path too");
	assert.equal(runtime.sent.length, 0);
	assert.equal(lastAppend(runtime).data.state, "cancelled", "the unknown entry name tombstones under the default gate");
	runtime.notifies.length = 0;
	runtime.appended.length = 0;
	await startRuntime(runtime, "startup");
	assert.equal(runtime.notifies.length, 0, "the second start sees the tombstone and stays quiet");
	assert.equal(runtime.appended.length, 0);
	assert.equal(runtime.sent.length, 0);
});

test("print mode restart stays inert for an opted-in past deadline: no resume fires", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }), mode: "print" });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "startup");
	await sleep(30);
	assert.equal(runtime.sent.length, 0, "an opted-in headless run must not fire the resume");
	assert.equal(runtime.appended.length, 0, "the wait stays pending: neither tombstoned nor fired");
	assert.equal(runtime.statuses.size, 0);
});

test("print mode restart stays inert for an opted-in future deadline: no timer arms", async () => {
	const runtime = createRuntime({ config: rawConfig({ resumeOnRestart: true }), mode: "print" });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: wholeSecond(Date.now()) + 60_000 - 120 * MINUTES, fireAtMs: wholeSecond(Date.now()) + 60_000, attempts: 0 }));
	await startRuntime(runtime, "startup");
	await sleep(70);
	assert.equal(runtime.sent.length, 0);
	assert.equal(runtime.appended.length, 0);
	assert.equal(runtime.statuses.size, 0);
});

test("the gated drop path is not mode-guarded: print mode still tombstones and notifies a UI", async () => {
	const runtime = createRuntime({ mode: "print" });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "startup");
	assert.equal(lastAppend(runtime).data.state, "cancelled", "the drop tombstones in print mode too");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("resumeOnRestart")), "the drop notify stays available outside tui/rpc");
	assert.equal(runtime.sent.length, 0);
});

// --- wiring: multi-entry restart scan ------------------------------------

test("a waiting entry behind another entry's resolved tombstone re-arms on restart", async () => {
	const runtime = createRuntime({ config: twoProviderConfig({ resumeOnRestart: true }) });
	const base = wholeSecond(Date.now());
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "acme-pro", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "resolved", entryName: "acme-pro" }));
	await startRuntime(runtime, "startup");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed") && notification.message.includes("zai-glm")), "the older zai wait re-arms behind acme's resolved tombstone");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	assert.equal(runtime.notifies.some((notification) => notification.message.includes("acme-pro")), false, "the resolved acme name stays dead");
	await sleep(1600);
	assert.equal(runtime.sent.length, 1, "the re-armed zai wait fires");
	assert.equal(lastAppend(runtime).data.entryName, "zai-glm");
	await shutdownRuntime(runtime);
});

test("a gated-drop tombstone for one name leaves another name's wait adjudicable", async () => {
	const runtime = createRuntime({ config: twoProviderConfig({ resumeOnRestart: true }) });
	const base = wholeSecond(Date.now());
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "acme-pro", resetAtMs: now - 5 * MINUTES, fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "cancelled", entryName: "acme-pro", gate: "fork", fireAtMs: now - 2 * MINUTES, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 0 }));
	await startRuntime(runtime, "startup");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed") && notification.message.includes("zai-glm")), "the zai wait re-arms beside the acme tombstone");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	assert.equal(runtime.notifies.some((notification) => notification.message.includes("forked")), false, "the fork tombstone is not re-adjudicated");
	assert.equal(runtime.appended.length, 0, "the tombstone name lands no new records");
	await shutdownRuntime(runtime);
});

test("a newest simulated waiting entry hides only its own name on reload", async () => {
	const runtime = createRuntime({ config: twoProviderConfig({ resumeOnRestart: true }) });
	const base = wholeSecond(Date.now());
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "acme-pro", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 1 }));
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: base + 1500 - 120 * MINUTES, fireAtMs: base + 1500, attempts: 0, simulated: true }));
	await startRuntime(runtime, "reload");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("re-armed") && notification.message.includes("acme-pro")), "the real acme wait re-arms behind the simulated zai entry");
	assert.ok(runtime.statuses.has(statusKeyFor("acme-pro")));
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "the simulated zai name does not re-arm");
	await sleep(1600);
	assert.equal(runtime.sent.length, 1, "the acme timer fires");
	assert.equal(lastAppend(runtime).data.entryName, "acme-pro");
	await shutdownRuntime(runtime);
});

// --- wiring: commands ------------------------------------------------------

test("/cooldown reports pending state, and cancel aborts it", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown").handler("", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("no pending")));
	await messageEnd(runtime, assistantError(fixture1308(now + 5 * MINUTES - 120 * MINUTES)));
	await runtime.commands.get("cooldown").handler("", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("zai-glm")));
	await runtime.commands.get("cooldown").handler("cancel", runtime.ctx);
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
	assert.equal(lastAppend(runtime).data.state, "cancelled");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "cancelled waits never fire");
	await runtime.commands.get("cooldown").handler("cancel", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("nothing")));
	await runtime.commands.get("cooldown").handler("bogus", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("/cooldown")));
});

test("/cooldown-simulate drives the real detection path end to end", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	const text = fixture1308(now + 60 - 120 * MINUTES);
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${text}`, runtime.ctx);
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "simulate arms through the real path");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("simulated")));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
});

test("/cooldown-simulate defaults to the first entry and explains non-matching text", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown-simulate").handler(fixture1308(wholeSecond(now) + 5 * MINUTES - 120 * MINUTES), runtime.ctx);
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await runtime.commands.get("cooldown-simulate").handler("Error: 429: too many requests", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("simulated") && notification.message.includes("no configured provider")));
	await shutdownRuntime(runtime);
});

test("/cooldown-simulate without arguments prints usage", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown-simulate").handler("", runtime.ctx);
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("cooldown-simulate")));
	assert.equal(runtime.statuses.size, 0);
});

test("simulate refuses against a live real wait and mutates nothing", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	const statusBefore = runtime.statuses.get(statusKeyFor("zai-glm"));
	const appendsBefore = runtime.appended.length;
	const notifiesBefore = runtime.notifies.length;
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${fixture1308(wholeSecond(now) + 90 * MINUTES)}`, runtime.ctx);
	assert.ok(runtime.notifies.length > notifiesBefore, "the refusal notifies");
	assert.ok(runtime.notifies.some((notification) => notification.message.includes("/cooldown cancel")), "the refusal names the cancel path");
	assert.equal(runtime.appended.length, appendsBefore, "no new persisted record");
	assert.equal(runtime.statuses.get(statusKeyFor("zai-glm")), statusBefore, "the real deadline is untouched");
	await sleep(150);
	assert.equal(runtime.sent.length, 0);
});

test("simulating over a simulated wait still arms and extends", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${fixture1308(wholeSecond(now) + 30 * MINUTES)}`, runtime.ctx);
	const appendsAfterFirst = runtime.appended.length;
	await runtime.commands.get("cooldown-simulate").handler(`zai-glm ${fixture1308(wholeSecond(now) + 90 * MINUTES)}`, runtime.ctx);
	assert.equal(runtime.appended.length, appendsAfterFirst + 1, "the simulated re-arm persists");
	assert.equal(lastAppend(runtime).data.simulated, true);
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
});

// --- wiring: live countdown -----------------------------------------------

test("the armed footer status shows the live countdown with the resume budget", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	const resetAt = wholeSecond(Date.now()) + 251 * MINUTES;
	await messageEnd(runtime, assistantError(fixture1308(resetAt)));
	const expected = formatCountdown(resetAt + 2 * MINUTES, Date.now());
	assert.equal(runtime.statuses.get(statusKeyFor("zai-glm")), `⏳ zai-glm in ${expected} · 0/5 resumes used`);
	await shutdownRuntime(runtime);
});

test("the countdown tick arms with the wait and refreshes the footer on every tick", async () => {
	const runtime = createRuntime({ tickMs: 20 });
	await startRuntime(runtime);
	await sleep(60);
	assert.equal(runtime.statusCalls.length, 0, "no wait, no tick writes");
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 5 * MINUTES)));
	assert.equal(runtime.statusCalls.length, 1, "the arm itself writes the status once");
	await sleep(80);
	assert.ok(runtime.statusCalls.length > 1, "ticks refresh the footer while the wait pends");
	for (const call of runtime.statusCalls) {
		assert.match(call.text, /^⏳ zai-glm in /);
	}
	await shutdownRuntime(runtime);
});

test("degenerate tickMs values fall back to the minute default instead of arming a busy loop", async () => {
	for (const degenerate of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
		await withIntervalSpy(async ({ created }) => {
			const runtime = createRuntime({ tickMs: degenerate });
			await startRuntime(runtime);
			await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 5 * MINUTES)));
			assert.equal(created.length, 1, `tickMs ${degenerate} arms exactly one tick interval`);
			assert.equal(created[0].ms, MINUTES, `tickMs ${degenerate} must fall back to the one-minute default`);
			await shutdownRuntime(runtime);
		});
	}
});

test("cancel clears the countdown tick interval", async () => {
	const runtime = createRuntime({ tickMs: 20 });
	await startRuntime(runtime);
	await withIntervalSpy(async ({ created, cleared }) => {
		await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 5 * MINUTES)));
		assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "wait armed");
		await runtime.commands.get("cooldown").handler("cancel", runtime.ctx);
		assert.equal(created.length, 1, "arming the wait created exactly one interval");
		assert.ok(cleared.includes(created[0].handle), "cancel cleared the armed tick interval");
		assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false);
		assert.equal(runtime.sent.length, 0);
	});
});

test("session_shutdown clears the countdown tick interval", async () => {
	const runtime = createRuntime({ tickMs: 20 });
	await startRuntime(runtime);
	await withIntervalSpy(async ({ created, cleared }) => {
		await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 5 * MINUTES)));
		await shutdownRuntime(runtime);
		assert.equal(created.length, 1, "arming the wait created exactly one interval");
		assert.ok(cleared.includes(created[0].handle), "shutdown cleared the armed tick interval");
		assert.equal(runtime.sent.length, 0);
	});
});

test("fire clears the countdown tick: the footer status is not resurrected after the resume", async () => {
	const runtime = createRuntime({ tickMs: 20 });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")));
	await sleep(120);
	assert.equal(runtime.sent.length, 1);
	assert.equal(runtime.statuses.has(statusKeyFor("zai-glm")), false, "status clears at fire time");
	const writesAtFire = runtime.statusCalls.length;
	await sleep(80);
	assert.equal(runtime.statusCalls.length, writesAtFire, "the fired entry must not tick the status back");
	await shutdownRuntime(runtime);
});

test("a non-assistant message_end takes the early return without touching states or entries", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 5 * MINUTES)));
	const appendsAfterArm = runtime.appended.length;
	const notifiesAfterArm = runtime.notifies.length;
	await messageEnd(runtime, { role: "user", stopReason: "stop", errorMessage: undefined, provider: "zai", model: "glm-5.3" });
	assert.equal(runtime.appended.length, appendsAfterArm, "no entry appended for a non-assistant message");
	assert.equal(runtime.notifies.length, notifiesAfterArm, "no notify fired for a non-assistant message");
	assert.equal(runtime.sent.length, 0);
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "the pending wait survives a non-assistant message");
	await shutdownRuntime(runtime);
});

// --- wiring: runtime auto-resume toggle -----------------------------------

test("cooldown off cancels every pending wait in memory without tombstones", async () => {
	const runtime = createRuntime({ config: twoProviderConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 40 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 50 * MINUTES)));
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")) && runtime.statuses.has(statusKeyFor("acme-pro")), "both waits armed");
	const appendsAtOff = runtime.appended.length;
	await runtime.commands.get("cooldown").handler("off", runtime.ctx);
	assert.equal(runtime.statuses.size, 0, "off clears every entry's footer segment");
	await sleep(40);
	assert.equal(runtime.sent.length, 0, "off cancels the timers, nothing fires");
	assert.equal(runtime.appended.length, appendsAtOff, "the off cancel stays in memory: no tombstones");
	await shutdownRuntime(runtime);
});

test("cooldown off blocks arming with one passive notify naming the reset time", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown").handler("off", runtime.ctx);
	const notifiesAtOff = runtime.notifies.length;
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(runtime.appended.length, 0, "no wait arms while off");
	assert.equal(runtime.statuses.size, 0, "no footer while off");
	const passives = runtime.notifies.slice(notifiesAtOff).filter((notification) => notification.level === "info" && notification.message.includes("off"));
	assert.equal(passives.length, 1, "exactly one passive notify per matching limit error");
	assert.ok(passives[0].message.includes("zai-glm"));
	assert.ok(/\d\d:\d\d/.test(passives[0].message), "the parsed reset time is named");
	await runtime.commands.get("cooldown").handler("", runtime.ctx);
	assert.ok(runtime.notifies.at(-1).message.includes("off"), "/cooldown reports the switch state while off");
	await shutdownRuntime(runtime);
});

test("cooldown on restores arming after off cancelled the pending wait", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 40 * MINUTES)));
	await runtime.commands.get("cooldown").handler("off", runtime.ctx);
	assert.equal(runtime.statuses.size, 0, "off cancels the pending wait");
	await runtime.commands.get("cooldown").handler("on", runtime.ctx);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 50 * MINUTES)));
	assert.equal(runtime.appended.length, 2, "the post-on 1308 arms a fresh wait");
	assert.ok(runtime.statuses.has(statusKeyFor("zai-glm")), "the restored wait renders its footer segment");
	await shutdownRuntime(runtime);
});

test("the runtime switch resets to the config default on reload and in a fresh factory", async () => {
	const runtime = createRuntime();
	await startRuntime(runtime);
	await runtime.commands.get("cooldown").handler("off", runtime.ctx);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(runtime.appended.length, 0, "off blocks arming");
	await startRuntime(runtime, "reload");
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(runtime.appended.length, 1, "reload resets the switch to the config default");
	const fresh = createRuntime();
	await startRuntime(fresh);
	await messageEnd(fresh, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(fresh.appended.length, 1, "a fresh factory starts from the config default");
	await shutdownRuntime(runtime);
	await shutdownRuntime(fresh);
});

test("autoResume false starts the session with the switch off", async () => {
	const resolved = validateCooldownConfig(rawConfig({ autoResume: false }));
	assert.equal(resolved.ok, true);
	assert.equal(resolved.config.autoResume, false);
	const runtime = createRuntime({ config: rawConfig({ autoResume: false }) });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(runtime.appended.length, 0, "autoResume false disables at start");
	assert.ok(runtime.notifies.some((notification) => notification.level === "info" && notification.message.includes("off")), "the passive notify fires");
	await runtime.commands.get("cooldown").handler("on", runtime.ctx);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	assert.equal(runtime.appended.length, 1, "runtime on re-enables per-session despite autoResume false");
	await shutdownRuntime(runtime);
});

test("an autoResume of the wrong type fails the existing config validation", () => {
	const result = validateCooldownConfig(rawConfig({ autoResume: "yes" }));
	assert.equal(result.ok, false);
	assert.ok(result.problems.some((problem) => problem.includes("autoResume")));
});

// --- formatting -------------------------------------------------------------

test("formatResumeClock renders a non-empty clock string", () => {
	const clock = formatResumeClock(VERBATIM_RESET_EPOCH);
	assert.equal(typeof clock, "string");
	assert.ok(clock.length >= 3);
	assert.ok(/\d/.test(clock));
});

test("formatCountdown renders hours and minutes from the injected now", () => {
	const base = VERBATIM_RESET_EPOCH;
	assert.equal(formatCountdown(base + (4 * 60 + 12) * MINUTES, base), "4h 12m");
	assert.equal(formatCountdown(base + 60 * MINUTES, base), "1h 0m");
	assert.equal(formatCountdown(base + 5 * 60 * MINUTES, base), "5h 0m");
});

test("formatCountdown renders minutes only below a full hour", () => {
	const base = VERBATIM_RESET_EPOCH;
	assert.equal(formatCountdown(base + 45 * MINUTES, base), "45m");
	assert.equal(formatCountdown(base + MINUTES, base), "1m");
	assert.equal(formatCountdown(base + 119_999, base), "1m", "just under two minutes still renders one full minute");
});

test("formatCountdown degrades to <1m inside the final minute and past the deadline", () => {
	const base = VERBATIM_RESET_EPOCH;
	assert.equal(formatCountdown(base + 59_000, base), "<1m");
	assert.equal(formatCountdown(base, base), "<1m");
	assert.equal(formatCountdown(base - 30_000, base), "<1m");
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
