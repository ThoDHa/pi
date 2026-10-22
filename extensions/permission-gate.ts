/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 *
 * Matching is quote-aware, with two conservative-by-design exceptions:
 * quoted mentions containing $( or a backtick stay in the scanned text
 * because they may carry substitutions, and executor commands
 * (bash/zsh/sh/dash/ksh with a -c flag, eval, su -c, ssh) are additionally
 * matched against the raw text, so dangerous words inside their quoted
 * payloads gate even when merely mentioned.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const quotedSubstring = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];
const executorShape = /\b(?:bash|zsh|sh|dash|ksh)\b[^;&|]*\s-[a-zA-Z]*c\b|\beval\b|\bsu\s+-c\b|\bssh\b/;

/**
 * Decide whether a bash command is dangerous. Matching runs against the
 * command with quoted spans removed so quoted mentions (report writing,
 * grep recipes) do not trip the gate, except that spans containing $( or
 * a backtick stay in the scanned text because they may carry
 * substitutions. When the stripped text carries an executor shape, the
 * raw command is also matched, so payloads nested in executors gate even
 * inside quotes. Non-string input is inert.
 *
 * @param command raw bash command text
 * @returns true when the command matches a dangerous pattern
 */
export function isDangerousCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	const unquoted = command.replace(quotedSubstring, (span) => (/\$\(|`/.test(span) ? span : " "));
	if (dangerousPatterns.some((pattern) => pattern.test(unquoted))) return true;
	return executorShape.test(unquoted) && dangerousPatterns.some((pattern) => pattern.test(command));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		if (isDangerousCommand(command)) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
