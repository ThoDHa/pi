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
 * failing cleanup never masks the write error).
 *
 * Failure injection works because the helper imports the live
 * CommonJS fs exports object: the test swaps fs.promises.mkdtemp to
 * chmod each created dir to 0o500 so the real writeFile fails with
 * EACCES, and swaps fs.rmSync to force a cleanup failure. Both swaps
 * are restored in finally blocks and any dir left over on a failing
 * path is removed before the case ends.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePromptToTempFile } from "../extensions/subagent/prompt-temp.ts";

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
