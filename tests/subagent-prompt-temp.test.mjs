#!/usr/bin/env node
/**
 * Unit suite for the subagent prompt temp-file helper
 * (extensions/subagent/prompt-temp.ts). Plain node, no test framework:
 *
 *   node tests/subagent-prompt-temp.test.mjs
 *
 * Covers the contract runSingleAgent depends on: the success shape
 * (fresh 0700 dir, 0600 prompt file, sanitized file name, exact
 * content) and the failure path (a failed write after mkdtemp removes
 * the created dir before rethrowing the original write error, and a
 * failing cleanup never masks the write error). It also covers the
 * live-dir registry: release removes and deregisters, the process-exit
 * sweep removes still-registered dirs with per-dir error isolation
 * (a failed removal leaves exactly one stderr trace line naming the
 * dir and its error code),
 * and unregistered dirs are left alone. Exit-sweep behavior runs in
 * spawned node children (an exit handler cannot be exercised twice in
 * one process); each child reports through a verdict file written
 * synchronously before process.exit, read back by this parent.
 *
 * Failure injection works because the helper imports the live
 * CommonJS fs exports object: the test swaps fs.promises.mkdtemp to
 * chmod each created dir to 0o500 so the real writeFile fails with
 * EACCES, and swaps fs.rmSync to force a cleanup failure. Both swaps
 * are restored in finally blocks and any dir left over on a failing
 * path is removed before the case ends.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releasePromptDir, writePromptToTempFile } from "../extensions/subagent/prompt-temp.ts";

const MODULE_PATH = fileURLToPath(new URL("../extensions/subagent/prompt-temp.ts", import.meta.url));

/** Swap fs.promises.mkdtemp for a wrapper passing each created dir to `intercept` (synchronously) before returning it. Returns a restore function. */
function interceptCreatedDirs(intercept) {
	const original = fs.promises.mkdtemp.bind(fs.promises);
	fs.promises.mkdtemp = async (...args) => {
		const dir = await original(...args);
		intercept(dir);
		return dir;
	};
	return () => {
		fs.promises.mkdtemp = original;
	};
}

/** Best-effort removal of an intercepted dir still at 0o500, for cleanup on failing paths. */
function removeInterceptedDir(dir) {
	if (!dir || !fs.existsSync(dir)) return;
	fs.chmodSync(dir, 0o700);
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run `script` in a fresh node child that imports the module under test
 * (path passed as argv[2]) and reports through a verdict file
 * (argv[3], written synchronously by the child before process.exit).
 * Returns the spawnSync result with `verdict` holding the parsed
 * verdict JSON (undefined when the child wrote none). The probe dir,
 * including the verdict file, is removed before returning.
 */
function runProbe(script) {
	const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-"));
	const probePath = path.join(probeDir, "probe.mjs");
	const verdictPath = path.join(probeDir, "verdict.json");
	fs.writeFileSync(probePath, script);
	try {
		const result = spawnSync(process.execPath, [probePath, MODULE_PATH, verdictPath], {
			encoding: "utf-8",
			timeout: 30000,
		});
		result.verdict = fs.existsSync(verdictPath) ? JSON.parse(fs.readFileSync(verdictPath, "utf-8")) : undefined;
		return result;
	} finally {
		fs.rmSync(probeDir, { recursive: true, force: true });
	}
}

const cases = [
	[
		"success: fresh 0700 dir, 0600 prompt file with sanitized name and exact content",
		async () => {
			const prompt = "# Task\n\nDelegate this exact text.";
			const { dir, filePath } = await writePromptToTempFile("name with spaces", prompt);
			try {
				assert.ok(dir.startsWith(path.join(os.tmpdir(), "pi-subagent-")), `dir under tmp, got: ${dir}`);
				assert.equal(path.dirname(filePath), dir);
				assert.equal(path.basename(filePath), "prompt-name_with_spaces.md");
				assert.equal(fs.readFileSync(filePath, "utf-8"), prompt);
				assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
				assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	],
	[
		"write failure after mkdtemp: dir removed and original EACCES rethrown",
		async () => {
			let recordedDir = null;
			const restore = interceptCreatedDirs((dir) => {
				recordedDir = dir;
				fs.chmodSync(dir, 0o500);
			});
			try {
				await assert.rejects(
					writePromptToTempFile("blocked writer", "prompt that must fail"),
					(error) => error?.code === "EACCES",
				);
				assert.ok(recordedDir, "intercept did not record the created dir");
				assert.equal(fs.existsSync(recordedDir), false, "failed call must leave no temp dir behind");
			} finally {
				restore();
				removeInterceptedDir(recordedDir);
			}
		},
	],
	[
		"cleanup failure: original write error rethrown, not the cleanup error",
		async () => {
			let recordedDir = null;
			const restoreMkdtemp = interceptCreatedDirs((dir) => {
				recordedDir = dir;
				fs.chmodSync(dir, 0o500);
			});
			const originalRmSync = fs.rmSync.bind(fs);
			const cleanupError = new Error("cleanup boom");
			fs.rmSync = () => {
				throw cleanupError;
			};
			try {
				await assert.rejects(
					writePromptToTempFile("blocked cleanup", "prompt that must fail"),
					(error) => error?.code === "EACCES" && error !== cleanupError,
				);
			} finally {
				restoreMkdtemp();
				fs.rmSync = originalRmSync;
				removeInterceptedDir(recordedDir);
			}
		},
	],
	[
		"release: removes the registered dir and a repeated release is a no-op",
		async () => {
			const { dir } = await writePromptToTempFile("release-target", "released by the caller");
			assert.ok(fs.existsSync(dir), "dir must exist before release");
			releasePromptDir(dir);
			assert.equal(fs.existsSync(dir), false, "release must remove the dir");
			assert.doesNotThrow(() => releasePromptDir(dir), "a repeated release must be a harmless no-op");
		},
	],
	[
		"exit sweep: unreleased helper dir removed at child exit, plain mkdtemp control survives",
		() => {
			const res = runProbe(`
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const { dir } = await mod.writePromptToTempFile("sweep-probe", "never released");
const control = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ctl-"));
fs.writeFileSync(process.argv[3], JSON.stringify({ dir, control }));
process.exit(0);
`);
			assert.equal(res.status, 0, `probe child failed: ${res.stderr}`);
			const { dir, control } = res.verdict;
			try {
				assert.equal(fs.existsSync(dir), false, "exit sweep must remove the still-registered dir");
				assert.ok(fs.existsSync(control), "an unregistered plain-mkdtemp dir must survive the sweep");
			} finally {
				fs.rmSync(control, { recursive: true, force: true });
			}
		},
	],
	[
		"deregistration: a released dir is not swept again at child exit",
		() => {
			const res = runProbe(`
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const calls = [];
const realRmSync = fs.rmSync.bind(fs);
fs.rmSync = (p, opts) => {
	calls.push(String(p));
	return realRmSync(p, opts);
};
const mod = await import(pathToFileURL(process.argv[2]).href);
const { dir } = await mod.writePromptToTempFile("dereg-probe", "released before exit");
mod.releasePromptDir(dir);
mod.releasePromptDir(dir);
process.on("exit", () => {
	fs.writeFileSync(process.argv[3], JSON.stringify({
		rmCallsForDir: calls.filter((c) => c === dir).length,
		gone: !fs.existsSync(dir),
	}));
});
process.exit(0);
`);
			assert.equal(res.status, 0, `probe child failed: ${res.stderr}`);
			const { rmCallsForDir, gone } = res.verdict;
			assert.equal(rmCallsForDir, 1, "release removes once; the exit sweep must not touch a deregistered dir");
			assert.equal(gone, true, "the released dir must be gone");
		},
	],
	[
		"sweep isolation: failing rmSync on one dir neither blocks the rest nor throws out of the handler",
		() => {
			const res = runProbe(`
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const doomed = await mod.writePromptToTempFile("iso-doomed", "rmSync fails for this one");
const swept = await mod.writePromptToTempFile("iso-swept", "must still be swept");
const realRmSync = fs.rmSync.bind(fs);
fs.rmSync = (p, opts) => {
	if (p === doomed.dir) throw Object.assign(new Error("simulated EBUSY"), { code: "EBUSY" });
	return realRmSync(p, opts);
};
fs.writeFileSync(process.argv[3], JSON.stringify({ doomed: doomed.dir, swept: swept.dir }));
process.exit(0);
`);
			assert.equal(res.status, 0, `probe child failed: ${res.stderr}`);
			assert.ok(!res.stderr.includes("simulated EBUSY"), "the isolation failure must not throw out of the exit handler");
			const { doomed, swept } = res.verdict;
			const traceLines = res.stderr.split("\n").filter((line) => line.trim() !== "");
			assert.equal(traceLines.length, 1, `stderr must carry exactly the one trace line for the doomed dir and nothing else, got: ${JSON.stringify(traceLines)}`);
			assert.ok(traceLines[0].includes(doomed), `the trace line must name the failed dir: ${traceLines[0]}`);
			assert.ok(traceLines[0].includes("EBUSY"), `the trace line must include the error code: ${traceLines[0]}`);
			try {
				assert.equal(fs.existsSync(swept), false, "the sweep must continue past the failing dir");
				assert.ok(fs.existsSync(doomed), "the failing dir must survive the isolated failure");
			} finally {
				fs.rmSync(doomed, { recursive: true, force: true });
			}
		},
	],
];

let failed = 0;
for (const [label, run] of cases) {
	try {
		await run();
	} catch (error) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      ${error?.stack ?? error}`);
	}
}

const passed = cases.length - failed;
console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

// This process still holds registered dirs (cases that clean up via
// plain rmSync skip deregistration), so the module's exit sweep fires
// after this line and must stay silent; it is exercised for real in
// the spawned probe children above.
