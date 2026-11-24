#!/usr/bin/env node
/**
 * Writer-discipline invariant suite for the cooldown extension's
 * per-entryName newest-decides restart scan (extensions/cooldown.ts).
 * Plain node, no test framework:
 *
 *   node tests/cooldown-invariant.test.mjs
 *
 * The restart scan (collectPendingWaits) decides each entryName from its
 * newest persisted cooldown record. That decode is exact only under a
 * writer discipline no single call site can assert, so this suite pins it
 * across every transition site with one shared checkpoint:
 *
 *   1. every state transition lands a superseding record for that name,
 *   2. every arm persists a real waiting record,
 *   3. no terminal record lands while the wait stays live.
 *
 * The seven sites (arm fresh, arm extend, fire, cap, retire, cancel,
 * restart drop, restart re-arm) are each driven end to end through the
 * real event wiring, then the checkpoint replays the whole persisted
 * stream through the exact scan the next session will run and requires
 * it to reproduce, per name, precisely the live waits the session holds:
 * a live name's newest record is a real waiting record matching the scan
 * on deadline and attempts; a non-live name's newest record is terminal.
 * Site tests additionally prove waits behind terminal records are dead
 * (no late fire) and that a gated drop tombstone keeps later starts
 * quiet. Multi-entry interleaving pins the per-name independence of the
 * discipline.
 *
 * Red-proof affordance: pass a module path as argv[2] to run the suite
 * against a deliberately violating writer (see the EXT-32 report for the
 * three injected violations, one per clause); the default import is the
 * real extension.
 *
 *   node tests/cooldown-invariant.test.mjs <path-to-violating-module.ts>
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const moduleOverride = process.argv[2];
const { default: createCooldownExtension, ENTRY_TYPE, statusKeyFor, collectPendingWaits } = await import(moduleOverride ?? "../extensions/cooldown.ts");

const MINUTES = 60_000;
const now = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Provider stamps carry no sub-second precision; align test bases so parsed epochs compare exactly. */
const wholeSecond = (ms) => ms - (ms % 1000);

const ZAI_OFFSET_MINUTES = 480;

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

/** A minimal valid config object (raw, pre-validation), optionally carrying the acme entry too. */
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
			...(overrides.withAcme ? [ACME_ENTRY] : []),
		],
		...overrides.fields,
	};
}

function assistantError(errorMessage, provider = "zai", model = "glm-5.3") {
	return { role: "assistant", stopReason: "error", errorMessage, provider, model };
}

function acmeError(errorMessage, model = "acme-max") {
	return { role: "assistant", stopReason: "error", errorMessage, provider: "acme", model };
}

function success(provider, model) {
	return { role: "assistant", stopReason: "stop", errorMessage: undefined, provider, model };
}

/** Persisted custom-entry shape as pi stores appendEntry data on the branch. */
function persistedEntry(data) {
	return { type: "custom", customType: ENTRY_TYPE, data };
}

// --- mock pi/ctx runtime for the invariant checkpoints -----------------

const tempDirs = [];

function createRuntime({ config } = {}) {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const appended = [];
	const statuses = new Map();
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
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => branchEntries,
			getEntries: () => branchEntries,
		},
		ui: {
			setStatus(key, text) {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			notify() {},
		},
	};
	let configPath;
	if (config !== undefined) {
		configPath = path.join(mkdtempSync(path.join(tmpdir(), "cooldown-invariant-")), "cooldown.json");
		writeFileSync(configPath, JSON.stringify(config));
		tempDirs.push(path.dirname(configPath));
	}
	const factoryOptions = {};
	if (configPath !== undefined) factoryOptions.configPath = configPath;
	createCooldownExtension(pi, factoryOptions);
	return { handlers, commands, sent, appended, statuses, branchEntries, ctx };
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

// --- the invariant checkpoint -------------------------------------------

/** Newest cooldown record for an entryName: the record the scan's newest-decides rule would let decide that name. */
function newestRecordFor(runtime, entryName) {
	for (let index = runtime.branchEntries.length - 1; index >= 0; index--) {
		const record = runtime.branchEntries[index].data;
		if (record.entryName === entryName) return record;
	}
	return undefined;
}

/**
 * The writer-discipline checkpoint. Replays the whole persisted stream
 * through the exact restart scan the next session will run and requires
 * it to reproduce, per name, precisely the live waits the session holds
 * (read from the observable footer statuses): every live name's newest
 * record is a real waiting record matching the scan on deadline and
 * attempts (arms persist and supersede); every non-live name's newest
 * record is terminal (no terminal record under a live wait). Returns
 * the live names so site tests can branch on them.
 */
function assertScanDiscipline(runtime, names) {
	const live = names.filter((name) => runtime.statuses.has(statusKeyFor(name)));
	const waits = collectPendingWaits(runtime.branchEntries);
	const scanned = new Map(waits.map((state) => [state.entryName, state]));
	assert.deepEqual(
		[...scanned.keys()].sort(),
		[...live].sort(),
		`the restart scan must reproduce exactly the live waits (${live.join(", ") || "none"}) from the persisted stream`,
	);
	for (const name of names) {
		const record = newestRecordFor(runtime, name);
		if (record === undefined) continue;
		if (live.includes(name)) {
			assert.equal(record.state, "waiting", `${name} holds a live wait, so its newest record must be waiting`);
			assert.notEqual(record.simulated, true, `${name}'s live record must be a real (non-simulated) arm`);
			const scannedState = scanned.get(name);
			assert.equal(record.fireAtMs, scannedState.fireAtMs, `${name}'s newest record and the scan must agree on the deadline`);
			assert.equal(record.attempts, scannedState.attempts, `${name}'s newest record and the scan must agree on the attempt count`);
		} else {
			assert.notEqual(record.state, "waiting", `${name} holds no live wait, so its newest record must be terminal`);
		}
	}
	return live;
}

const cases = [];
const test = (label, fn) => cases.push([label, fn]);

// --- site: arm (fresh) ---------------------------------------------------

test("a fresh arm persists a superseding waiting record and the scan reproduces the live wait", async () => {
	const runtime = createRuntime({ config: rawConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, ["zai-glm"]);
	const record = newestRecordFor(runtime, "zai-glm");
	assert.equal(record.state, "waiting");
	assert.equal(record.entryName, "zai-glm");
	assert.equal(record.attempts, 0);
	assert.ok(record.fireAtMs > Date.now(), "the deadline carries the buffer into the future");
	await shutdownRuntime(runtime);
});

test("an extending arm lands a superseding waiting record whose deadline the scan reproduces", async () => {
	const runtime = createRuntime({ config: rawConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 30 * MINUTES)));
	const firstDeadline = newestRecordFor(runtime, "zai-glm").fireAtMs;
	const waitingRecordsBefore = runtime.appended.filter((append) => append.data.state === "waiting").length;
	await messageEnd(runtime, assistantError(fixture1308(wholeSecond(now) + 50 * MINUTES)));
	const moved = newestRecordFor(runtime, "zai-glm");
	assert.ok(moved.fireAtMs > firstDeadline, "the later reset must have moved the deadline");
	assert.equal(runtime.appended.filter((append) => append.data.state === "waiting").length, waitingRecordsBefore + 1, "the extend must land a superseding record, not mutate or skip the stream");
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, ["zai-glm"]);
	await shutdownRuntime(runtime);
});

// --- site: fire ----------------------------------------------------------

test("fire lands the terminal fired record and the scan stops deciding the name as waiting", async () => {
	const runtime = createRuntime({ config: rawConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	assert.equal(runtime.sent.length, 1, "the deadline fired the resume");
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, [], "a fired wait is no longer live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "fired");
	await sleep(150);
	assert.equal(runtime.sent.length, 1, "no late fire may survive behind the fired record");
	await shutdownRuntime(runtime);
});

// --- site: cap -----------------------------------------------------------

test("cap lands the terminal capped record and the scan stops deciding the name as waiting", async () => {
	const runtime = createRuntime({ config: rawConfig({ fields: { maxResumeAttempts: 1 } }) });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await sleep(120);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, [], "a capped wait is no longer live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "capped");
	await sleep(150);
	assert.equal(runtime.sent.length, 1, "no late fire may survive behind the capped record");
	await shutdownRuntime(runtime);
});

// --- site: retire --------------------------------------------------------

test("retire lands the terminal resolved record only after the wait stopped being live", async () => {
	const runtime = createRuntime({ config: rawConfig() });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	assertScanDiscipline(runtime, ["zai-glm"]);
	await messageEnd(runtime, success("zai", "glm-5.3"));
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, [], "a retired wait is no longer live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "resolved");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "no late fire may survive behind the resolved record");
	await shutdownRuntime(runtime);
});

// --- site: cancel --------------------------------------------------------

test("cancel persists one terminal tombstone per pending entry and the scan holds no wait for either name", async () => {
	const runtime = createRuntime({ config: rawConfig({ withAcme: true }) });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(now + 60 - 120 * MINUTES)));
	assertScanDiscipline(runtime, ["zai-glm", "acme-pro"]);
	await runtime.commands.get("cooldown").handler("cancel", runtime.ctx);
	const live = assertScanDiscipline(runtime, ["zai-glm", "acme-pro"]);
	assert.deepEqual(live, [], "cancelled waits are no longer live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "cancelled");
	assert.equal(newestRecordFor(runtime, "acme-pro").state, "cancelled");
	assert.equal(runtime.appended.filter((append) => append.data.state === "cancelled").length, 2, "exactly one tombstone per pending entry");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "no late fire may survive behind the cancelled records");
	await shutdownRuntime(runtime);
});

// --- site: restart drop --------------------------------------------------

test("a gated restart drop persists a superseding tombstone that keeps every later start quiet", async () => {
	const runtime = createRuntime({ config: rawConfig() });
	runtime.branchEntries.push(persistedEntry({ state: "waiting", entryName: "zai-glm", resetAtMs: now + 30 * MINUTES, fireAtMs: now + 32 * MINUTES, attempts: 1 }));
	await startRuntime(runtime, "resume");
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, [], "a gated drop leaves no live wait");
	const tombstone = newestRecordFor(runtime, "zai-glm");
	assert.equal(tombstone.state, "cancelled");
	assert.equal(tombstone.gate, "resumeOnRestart");
	await sleep(150);
	assert.equal(runtime.sent.length, 0, "no late fire may survive behind the drop tombstone");
	runtime.appended.length = 0;
	await startRuntime(runtime, "reload");
	assert.equal(runtime.appended.length, 0, "the tombstone decides: a later start must not re-adjudicate the dropped wait");
	assertScanDiscipline(runtime, ["zai-glm"]);
	await shutdownRuntime(runtime);
});

// --- site: restart re-arm ------------------------------------------------

test("a restart re-arm keeps the persisted waiting record as the live wait's record and the scan reproduces it", async () => {
	const runtime = createRuntime({ config: rawConfig({ fields: { resumeOnRestart: true } }) });
	const seeded = { state: "waiting", entryName: "zai-glm", resetAtMs: wholeSecond(Date.now()) + 1500 - 120 * MINUTES, fireAtMs: wholeSecond(Date.now()) + 1500, attempts: 2 };
	runtime.branchEntries.push(persistedEntry(seeded));
	await startRuntime(runtime, "reload");
	const live = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(live, ["zai-glm"], "the re-armed wait is live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "waiting", "the re-arm must keep the seeded waiting record as the live wait's persistence");
	assert.equal(runtime.branchEntries.length, 1, "re-arm lands no new record; the persisted arm already persists");
	await sleep(1700);
	assert.equal(runtime.sent.length, 1, "the re-armed wait fires at its persisted deadline");
	const liveAfterFire = assertScanDiscipline(runtime, ["zai-glm"]);
	assert.deepEqual(liveAfterFire, [], "the fired record supersedes the seeded arm");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "fired");
	assert.equal(newestRecordFor(runtime, "zai-glm").attempts, 3, "the fire counts the carried attempts");
	await shutdownRuntime(runtime);
});

// --- per-name independence under interleaving ----------------------------

test("interleaved transitions stay per-name: one entry's terminal record never decides a live sibling", async () => {
	const runtime = createRuntime({ config: rawConfig({ withAcme: true }) });
	await startRuntime(runtime);
	await messageEnd(runtime, assistantError(fixture1308(now + 60 - 120 * MINUTES)));
	await messageEnd(runtime, acmeError(acmeFixture(wholeSecond(now) + 40 * MINUTES)));
	assertScanDiscipline(runtime, ["zai-glm", "acme-pro"]);
	await sleep(120);
	const live = assertScanDiscipline(runtime, ["zai-glm", "acme-pro"]);
	assert.deepEqual(live, ["acme-pro"], "zai fired, acme stays live");
	assert.equal(newestRecordFor(runtime, "zai-glm").state, "fired");
	assert.equal(newestRecordFor(runtime, "acme-pro").state, "waiting");
	await shutdownRuntime(runtime);
});

// --- runner --------------------------------------------------------------

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

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
