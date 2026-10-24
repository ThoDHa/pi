/**
 * Shared provisioning for the suites that load @earendil-works/pi-tui,
 * directly or through an extension under test. Plain node, no test
 * framework. A suite calls, before its first extension import:
 *
 *   const { visibleWidth } = await importPiTui();
 *
 * and takes the specifier's bindings from the returned namespace
 * instead of importing the specifier itself (a static import would
 * resolve before any provisioning runs).
 *
 * pi resolves extensions with jiti from its own install tree, so the
 * @earendil-works/pi-tui specifier never resolves under plain node from this
 * repo (no node_modules up-tree). Provision a symlink to pi's scope dir so
 * the extension's runtime import loads the same package pi itself uses. A
 * link left dangling by a pi upgrade fails statSync and is recreated.
 */

import { mkdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const shim = join(repoRoot, "node_modules", "@earendil-works");

function existsFollow(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function provisionShim() {
	let shimUsable = false;
	try {
		shimUsable = statSync(shim).isDirectory();
	} catch {
		// Missing or dangling: (re)provision below.
	}
	if (shimUsable) return;
	try {
		unlinkSync(shim);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	let piRoot = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
	while (piRoot !== dirname(piRoot) && !existsFollow(join(piRoot, "node_modules", "@earendil-works", "pi-tui"))) {
		piRoot = dirname(piRoot);
	}
	if (!existsFollow(join(piRoot, "node_modules", "@earendil-works", "pi-tui"))) {
		throw new Error("pi installation with @earendil-works/pi-tui not found; cannot provision test shim");
	}
	mkdirSync(join(repoRoot, "node_modules"), { recursive: true });
	symlinkSync(join(piRoot, "node_modules", "@earendil-works"), shim, "dir");
}

/**
 * Provision the repo-local @earendil-works shim if it is missing, dangling,
 * or not a directory, then return the dynamically imported
 * @earendil-works/pi-tui module namespace.
 *
 * Returns: the pi-tui module namespace object, with the package's exports as
 * properties (e.g. `visibleWidth`, `truncateToWidth`).
 *
 * Exceptions: throws if no pi installation carrying @earendil-works/pi-tui
 * can be located up-tree from the `pi` executable, or if unlink/mkdir/symlink
 * on the shim path fails for a reason other than a missing link.
 */
export async function importPiTui() {
	provisionShim();
	return import("@earendil-works/pi-tui");
}
