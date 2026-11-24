#!/usr/bin/env node
/**
 * Manager-body self-pin suite (extensions/manager-body.md vs the digest
 * embedded in extensions/manager-mode.ts). Plain node, no test framework:
 *
 *   node tests/manager-body-pin.test.mjs
 *
 * After the consolidation the vendored body and its activation-time pin
 * both live in this repo, so the drift guard is self-contained: the suite
 * re-derives the sidecar's sha256 and requires it to equal PINNED_BODY_DIGEST
 * exactly as manager-mode.ts re-derives it at activation. It fails red on a
 * doctored body, on an edited digest literal, and on a missing sidecar.
 *
 * Regeneration flow (manual, cross-repo by design): edit the fleet
 * manager.md body in the dotfiles repo, run its pin-manager-body target,
 * then refresh extensions/manager-body.md and the PINNED_BODY_DIGEST
 * string here together so this suite and activation stay green.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"extensions",
);

const embeddedDigest = (() => {
	const modeSource = readFileSync(path.join(extensionDir, "manager-mode.ts"), "utf8");
	const match = modeSource.match(/PINNED_BODY_DIGEST = "([0-9a-f]{64})"/);
	return match === null ? undefined : match[1];
})();

const bodyDigest = (() => {
	try {
		const body = readFileSync(path.join(extensionDir, "manager-body.md"));
		return createHash("sha256").update(body).digest("hex");
	} catch {
		return undefined;
	}
})();

let failed = 0;
if (embeddedDigest === undefined) {
	failed++;
	console.log("FAIL  manager-mode.ts embeds a well-formed PINNED_BODY_DIGEST");
	console.log("      expected: a 64-hex digest literal assigned to PINNED_BODY_DIGEST");
	console.log("      actual  : no match in extensions/manager-mode.ts");
} else {
	console.log("ok    manager-mode.ts embeds a well-formed PINNED_BODY_DIGEST");
}
if (embeddedDigest === undefined || bodyDigest === undefined) {
	failed++;
	console.log("FAIL  extensions/manager-body.md is readable for the pin check");
	console.log("      expected: the sidecar readable beside manager-mode.ts");
} else if (bodyDigest !== embeddedDigest) {
	failed++;
	console.log("FAIL  manager-body.md digest matches the embedded pin");
	console.log(`      expected: ${embeddedDigest}`);
	console.log(`      actual  : ${bodyDigest}`);
	console.log("      refresh extensions/manager-body.md and PINNED_BODY_DIGEST together");
} else {
	console.log("ok    manager-body.md digest matches the embedded pin");
}

const passed = 2 - failed;
console.log(`\n${passed}/2 passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
