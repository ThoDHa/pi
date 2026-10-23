/**
 * Temp-file staging for subagent prompts
 */

// Default import on purpose: tests inject failures by patching fs.rmSync on
// the live CommonJS exports object, which the namespace import does not
// reflect.
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Write an agent's prompt to a new temp directory and return both paths.
 *
 * Creates a 0700 `pi-subagent-*` directory under the OS temp dir and writes
 * the prompt to `prompt-<sanitized agent name>.md` with mode 0600. When the
 * write fails after the directory was created, the directory is removed
 * best-effort and the original write error is rethrown, so a failed call
 * leaves no temp dir behind.
 *
 * @param agentName - Agent name, sanitized into the prompt file name.
 * @param prompt - Prompt text written as UTF-8.
 * @returns The created directory and the prompt file path inside it.
 * @throws The `fs.promises.writeFile` error unchanged, also when the
 *   best-effort cleanup itself fails.
 */
export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		return { dir: tmpDir, filePath };
	} catch (error) {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore: the write error must not be masked */
		}
		throw error;
	}
}
