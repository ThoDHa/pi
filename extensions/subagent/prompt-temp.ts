/**
 * Temp-file staging for subagent prompts
 */

// Default import on purpose: tests inject failures by patching fs.rmSync on
// the live CommonJS exports object, which the namespace import does not
// reflect.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const livePromptDirs = new Set<string>();

/**
 * Best-effort recursive removal with `force: true` (ENOENT suppressed).
 * Returns whether the removal succeeded; on failure the error is
 * swallowed and handed to `onFailure` when given. Removal itself never
 * throws; an `onFailure` callback runs outside that guarantee, so an
 * exception it throws propagates to the caller. The one remover for
 * both release and the exit sweep, so the rmSync flags cannot drift
 * apart.
 *
 * @param dir - Directory to remove.
 * @param onFailure - Receives the swallowed removal error, when given.
 * @returns Whether the removal succeeded.
 */
function removeDirBestEffort(dir: string, onFailure?: (error: unknown) => void): boolean {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch (error) {
		onFailure?.(error);
		return false;
	}
}

// The per-run cleanup is an async finally that cannot run on a
// non-draining exit (process.exit with a child in flight), so dirs
// still registered here are removed synchronously in this exit handler.
process.on("exit", () => {
	for (const dir of livePromptDirs) {
		removeDirBestEffort(dir, (error) => {
			try {
				const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error";
				process.stderr.write(`pi-subagent: exit sweep failed to remove prompt dir ${dir}: ${code}\n`);
			} catch {
				/* the trace must never throw out of the exit handler */
			}
		});
	}
});

/**
 * Remove a prompt dir created by `writePromptToTempFile` and deregister
 * it from the process-exit sweep.
 *
 * Best-effort and idempotent: a dir that is already removed or was never
 * registered is a no-op, and `force: true` suppresses ENOENT. If the
 * removal itself fails, the error is swallowed and the dir stays
 * registered so the exit sweep retries. Never throws.
 *
 * @param dir - The `dir` value returned by `writePromptToTempFile`.
 */
export function releasePromptDir(dir: string): void {
	if (!livePromptDirs.has(dir)) return;
	if (removeDirBestEffort(dir)) livePromptDirs.delete(dir);
}

/**
 * Write an agent's prompt to a new temp directory and return both paths.
 *
 * Creates a 0700 `pi-subagent-*` directory under the OS temp dir and writes
 * the prompt to `prompt-<sanitized agent name>.md` with mode 0600. The
 * directory is registered with the module's live-dir registry at creation;
 * callers release it via `releasePromptDir` when the run settles, and any
 * dir still registered at process exit is removed by the module's exit
 * sweep. When the write fails after the directory was created, the
 * directory is released best-effort and the original write error is
 * rethrown, so a failed call leaves no temp dir behind.
 *
 * @param agentName - Agent name, sanitized into the prompt file name.
 * @param prompt - Prompt text written as UTF-8.
 * @returns The created directory and the prompt file path inside it.
 * @throws The `fs.promises.writeFile` error unchanged, also when the
 *   best-effort release itself fails.
 */
export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	livePromptDirs.add(tmpDir);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (error) {
		releasePromptDir(tmpDir);
		throw error;
	}
}
