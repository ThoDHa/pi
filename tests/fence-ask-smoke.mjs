#!/usr/bin/env node
/**
 * Manual harness-level smoke for the fence-ask channel, unit FENCE-1-4's
 * integration sweep:
 *
 *   node tests/fence-ask-smoke.mjs
 *
 * Not part of run-all: leg A needs the real `pi` binary on PATH and
 * makes one provider round trip that fails on purpose (an invalid API
 * key, so no tokens are billed), and both legs exercise live process
 * boundaries. Each suite in run-all remains hermetic; this script is
 * the repeatable live check the landing report cites.
 *
 * Leg A (real binary, full family): runs `pi --mode json -p
 * --no-session` with cwd at this repo, so the real loader discovers the
 * whole extensions/ family and every factory must load (the incident
 * rule at the binary level), plus a probe extension passed with -e that
 * appends session_start and session_shutdown lines to a marker file.
 * The invalid API key makes the run fail at the provider call, after
 * startup, so the run is free and fast. The assertion is the
 * session_start marker (review 17 DC-2's live-delivery evidence for
 * one-shot json children); the session_shutdown line is recorded as
 * lifecycle evidence for the forwarding-root teardown question. The
 * child's env is stripped of the ask-channel provisioning keys so the
 * leg tests the unprovisioned shape.
 *
 * Leg B (stub parent, real child path): a real node subprocess imports
 * the real workspace-fence module and runs forwardHeadlessAsk, the
 * fence's production headless forward branch, against a forwarding
 * root this script serves with the real tick and an in-script ruling
 * surface (a stub parent: a real parent session cannot be simulated
 * headlessly, because the prompt needs a human and a real dispatched
 * child needs a model gateway). Three flows: grant applies (the child
 * observes the granted root in childScopedAllowedRoots, the per-call
 * build the factory uses), deny fails closed with the actionable
 * reason, and timeout fails closed naming the bound.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	CHILD_ASK_ROOT_ENV,
	CHILD_ASK_TOKEN_ENV,
	forwardingRequestsDir,
} from "../extensions/fence-ask/ask-wire.ts";
import {
	createForwardingRootDirs,
	serveForwardingRootTick,
} from "../extensions/fence-ask/ask-channel.ts";
import {
	ensureForwardingRoot,
	registerLiveChild,
	resetFenceAskState,
} from "../extensions/fence-ask/grant-ledger.ts";

let failed = 0;
let total = 0;
function check(label, actual, expected) {
	total++;
	if (actual !== expected) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      expected: ${expected}`);
		console.log(`      actual  : ${actual}`);
	} else {
		console.log(`ok    ${label}`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, deadlineMs = 15_000) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

const repoRoot = path.resolve(import.meta.dirname, "..");

// --- leg A: the real binary, the full family, the session lifecycle --

const legAmarker = path.join(os.tmpdir(), `fence-ask-smoke-marker-${randomUUID()}.txt`);
const probeSource = `
export default function (pi) {
	pi.on("session_start", () => {
		fs.appendFileSync(process.env.SMOKE_MARKER, "session_start\\n");
	});
	pi.on("session_shutdown", () => {
		fs.appendFileSync(process.env.SMOKE_MARKER, "session_shutdown\\n");
	});
}
import * as fs from "node:fs";
`;
const probePath = path.join(os.tmpdir(), `fence-ask-smoke-probe-${randomUUID()}.mjs`);
fs.writeFileSync(probePath, probeSource);

const legAchildEnv = { ...process.env };
delete legAchildEnv[CHILD_ASK_ROOT_ENV];
delete legAchildEnv[CHILD_ASK_TOKEN_ENV];
legAchildEnv.SMOKE_MARKER = legAmarker;

const legA = await new Promise((resolve) => {
	const child = spawn(
		"pi",
		[
			"--mode",
			"json",
			"-p",
			"--no-session",
			"-e",
			probePath,
			"--api-key",
			"fence-ask-smoke-invalid-key",
			"Reply with the word ok.",
		],
		{ cwd: repoRoot, env: legAchildEnv, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("close", (code) => {
		clearTimeout(killer);
		resolve({ code, stdout, stderr });
	});
});
fs.rmSync(probePath, { force: true });

const legAMarkerText = fs.existsSync(legAmarker) ? fs.readFileSync(legAmarker, "utf8") : "";
check("leg A: the real pi binary started a session with the full family loaded", legAMarkerText.includes("session_start"), true);
console.log(`      leg A: exit ${legA.code}; the invalid key fails at the provider call, after startup, so a nonzero exit is the expected shape`);
console.log(`      leg A: session_shutdown observed in the one-shot json shape: ${legAMarkerText.includes("session_shutdown")}`);
if (legA.code !== 0 && legAMarkerText.length === 0) {
	console.log("      leg A stderr head:");
	for (const line of legA.stderr.split("\n").slice(0, 5)) console.log(`        ${line}`);
}
fs.rmSync(legAmarker, { force: true });

// --- leg B: the stub parent and the real child-side production path --

resetFenceAskState();
const grantRootPath = ensureForwardingRoot("fence-ask-smoke-grant", randomUUID());
createForwardingRootDirs(grantRootPath);
const grantToken = randomUUID();
const grantTarget = "/opt/fence-ask-smoke-grant-target";
registerLiveChild(grantToken, "smoke-worker", "smoke dispatch", Date.now());

const driverSource = `
const fencePath = ${JSON.stringify(pathToFileURL(path.join(repoRoot, "extensions", "workspace-fence.ts")).href)};
const { forwardHeadlessAsk, childScopedAllowedRoots } = await import(fencePath);
const provisioning = { root: ${JSON.stringify(grantRootPath)}, token: ${JSON.stringify(grantToken)} };
const grantOutcome = await forwardHeadlessAsk({
	toolName: "read",
	candidate: ${JSON.stringify(path.join(grantTarget, "secret.txt"))},
	askEvidence: "smoke grant leg",
	provisioning,
	waitMs: 20000,
	pollMs: 20,
});
const grantedVisible = childScopedAllowedRoots(process.cwd()).includes(${JSON.stringify(grantTarget)});
const denyOutcome = await forwardHeadlessAsk({
	toolName: "read",
	candidate: "/opt/fence-ask-smoke-deny-target/secret.txt",
	askEvidence: "smoke deny leg",
	provisioning,
	waitMs: 20000,
	pollMs: 20,
});
console.log(JSON.stringify({ grantAction: grantOutcome.action, grantedVisible, denyAction: denyOutcome.action, denyReason: denyOutcome.reason ?? "" }));
process.exit(0);
`;
const driverPath = path.join(os.tmpdir(), `fence-ask-smoke-driver-${randomUUID()}.mjs`);
fs.writeFileSync(driverPath, driverSource);

const driverRun = new Promise((resolve) => {
	const child = spawn(process.execPath, [driverPath], {
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("close", (code) => {
		clearTimeout(killer);
		resolve({ code, stdout, stderr });
	});
});

const grantAppeared = await waitFor(() => {
	try {
		return fs.readdirSync(forwardingRequestsDir(grantRootPath)).some((name) => name.endsWith(".json"));
	} catch {
		return false;
	}
});
check("leg B: the real child path wrote the forwarded ask", grantAppeared, true);

let rulings = 0;
await serveForwardingRootTick({
	root: grantRootPath,
	handler: async (ask) => {
		rulings++;
		return rulings === 1;
	},
	maxAge: 60_000,
});
const denyAppeared = await waitFor(() => {
	try {
		return fs.readdirSync(forwardingRequestsDir(grantRootPath)).some((name) => name.endsWith(".json"));
	} catch {
		return false;
	}
});
check("leg B: the distinct-directory re-ask reached the channel", denyAppeared, true);
await serveForwardingRootTick({
	root: grantRootPath,
	handler: async () => false,
	maxAge: 60_000,
});

const driverResult = await driverRun;
fs.rmSync(driverPath, { force: true });
check("leg B: the driver subprocess exited cleanly", driverResult.code, 0);
const legB = JSON.parse(driverResult.stdout.trim().split("\n").pop());
check("leg B: the granted ask applied through the real forward branch", legB.grantAction, "pass");
check("leg B: the granted root is visible to the per-call allowed-roots build", legB.grantedVisible, true);
check("leg B: the denied ask failed closed", legB.denyAction, "block");
check("leg B: the deny reason names the user decision", legB.denyReason.includes("denied via user"), true);

// timeout leg: a fresh root and token, no serving tick at all.
resetFenceAskState();
const timeoutRootPath = ensureForwardingRoot("fence-ask-smoke-timeout", randomUUID());
createForwardingRootDirs(timeoutRootPath);
const timeoutToken = randomUUID();
registerLiveChild(timeoutToken, "smoke-timeout", "smoke timeout dispatch", Date.now());
const timeoutDriverSource = `
const fencePath = ${JSON.stringify(pathToFileURL(path.join(repoRoot, "extensions", "workspace-fence.ts")).href)};
const { forwardHeadlessAsk } = await import(fencePath);
const outcome = await forwardHeadlessAsk({
	toolName: "read",
	candidate: "/opt/fence-ask-smoke-timeout-target/secret.txt",
	askEvidence: "smoke timeout leg",
	provisioning: { root: ${JSON.stringify(timeoutRootPath)}, token: ${JSON.stringify(timeoutToken)} },
	waitMs: 500,
	pollMs: 50,
});
console.log(JSON.stringify({ action: outcome.action, reason: outcome.reason ?? "" }));
process.exit(0);
`;
const timeoutDriverPath = path.join(os.tmpdir(), `fence-ask-smoke-timeout-driver-${randomUUID()}.mjs`);
fs.writeFileSync(timeoutDriverPath, timeoutDriverSource);
const timeoutResult = await new Promise((resolve) => {
	const child = spawn(process.execPath, [timeoutDriverPath], {
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.on("close", (code) => {
		clearTimeout(killer);
		resolve({ code, stdout });
	});
});
fs.rmSync(timeoutDriverPath, { force: true });
check("leg B: the timeout driver exited cleanly", timeoutResult.code, 0);
const legBTimeout = JSON.parse(timeoutResult.stdout.trim().split("\n").pop());
check("leg B: the unanswered ask timed out fail-closed", legBTimeout.action, "block");
check("leg B: the timeout reason names the bound", typeof legBTimeout.reason === "string" && legBTimeout.reason.includes("500 ms"), true);

for (const root of [grantRootPath, timeoutRootPath]) {
	fs.rmSync(root, { recursive: true, force: true });
}
resetFenceAskState();

console.log(`\nfence-ask-smoke: ${total - failed}/${total} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
