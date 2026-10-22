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
 *
 * One exemption: a command whose entire danger is rm recursive deletion
 * runs without confirmation (in UI and headless sessions alike) when
 * EVERY segment of the command parses as a plain recursive rm whose
 * path operands are all absolute, lexically /tmp-confined paths with a
 * non-empty component after tmp. Glob operands are allowed when their
 * literal prefix is confined (e.g. /tmp/foo-*); operands with a
 * trailing slash are refused because the slash makes rm dereference a
 * symlink instead of unlinking the link. Companion segments of any
 * other shape (echo, a rm flag order the gate regexes cannot see, dd,
 * anything) fall back to the normal gate: pattern silence in the gate
 * regexes proves nothing about a segment, so only parsed confined rms
 * ride the exemption. So do any substitution, relative operand,
 * traversal out of /tmp, bare /tmp target, redirect, grouping or other
 * unmodeled syntax, sudo, or chmod/chown 777.
 *
 * Residual, accepted knowingly: confinement is purely lexical and
 * cannot see planted symlinks. `rm -rf /tmp/link` unlinks only the
 * link itself, but a subpath through a planted symlink
 * (/tmp/link/sub) dereferences outside /tmp and deletes there.
 * Runtime lstat would close it only by adding TOCTOU races and
 * filesystem dependence, so the residual is documented rather than
 * chased.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const quotedSubstring = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
const rmRecursivePattern = /\brm\s+(-rf?|--recursive)/i;
const sudoPattern = /\bsudo\b/i;
const chmodChownPattern = /\b(chmod|chown)\b.*777/i;
const dangerousPatterns = [rmRecursivePattern, sudoPattern, chmodChownPattern];
const executorShape = /\b(?:bash|zsh|sh|dash|ksh)\b[^;&|]*\s-[a-zA-Z]*c\b|\beval\b|\bsu\s+-c\b|\bssh\b/;
const tmpRootComponent = "tmp";
const leadingGlobChar = /^[*?\[]/;
const substitutionChars = /[$`]/;
const wordSeparator = /[ \t]/;
// Bash command separators: `;` ends a command, `&` backgrounds one, `|` pipes, `\n` ends a command line; CR is absent on purpose because bash treats it as an ordinary word character.
const segmentSeparator = /[;&|\n]/;
// Bash syntax the /tmp analysis refuses to model: `<`/`>` redirects, `#` comments, `(` `)` grouping and subshells, `{` `}` brace expansion.
const unmodeledChars = /[<>#(){}]/;

function stripQuotedSpans(command: string): string {
	return command.replace(quotedSubstring, (span) => (/\$\(|`/.test(span) ? span : " "));
}

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
	const unquoted = stripQuotedSpans(command);
	if (dangerousPatterns.some((pattern) => pattern.test(unquoted))) return true;
	return executorShape.test(unquoted) && dangerousPatterns.some((pattern) => pattern.test(command));
}

interface Word {
	text: string;
	/** Any part of the word came from quotes or backslash escapes. */
	quoted: boolean;
}

interface CommandScan {
	segments: Word[][];
	/** The command uses syntax the /tmp analysis does not model. */
	bail: boolean;
}

/**
 * Split a command into top-level segments on `;`, `&`, `|`, and newlines,
 * tokenizing each segment into words the way bash word-splits on
 * whitespace, honoring single quotes, double quotes, and backslash
 * escapes. Runs into `bail` on redirects, comments, grouping, unterminated
 * quotes, or trailing escapes: the /tmp exemption refuses such commands
 * instead of misreading them.
 *
 * @param command raw bash command text
 * @returns segments of words plus whether the syntax was unmodelable
 */
function scanCommand(command: string): CommandScan {
	const segments: Word[][] = [];
	let words: Word[] = [];
	let word: Word = { text: "", quoted: false };
	let bail = false;
	let quote: "none" | "single" | "double" = "none";

	const endWord = (): void => {
		if (word.text.length > 0 || word.quoted) words.push(word);
		word = { text: "", quoted: false };
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) {
			segments.push(words);
			words = [];
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = "none";
			else word.text += ch;
		} else if (quote === "double") {
			if (ch === '"') quote = "none";
			else if (ch === "\\" && i + 1 < command.length) {
				word.text += command[++i];
				word.quoted = true;
			} else word.text += ch;
		} else if (ch === "'" || ch === '"') {
			word.quoted = true;
			quote = ch === "'" ? "single" : "double";
		} else if (ch === "\\") {
			if (i + 1 >= command.length) {
				bail = true;
				break;
			}
			word.text += command[++i];
			word.quoted = true;
		} else if (wordSeparator.test(ch)) {
			endWord();
		} else if (segmentSeparator.test(ch)) {
			endSegment();
		} else if (unmodeledChars.test(ch)) {
			bail = true;
			break;
		} else {
			word.text += ch;
		}
	}
	if (quote !== "none") bail = true;
	endSegment();
	return { segments, bail };
}

/**
 * Decide whether one rm path operand stays inside /tmp by lexical
 * normalization alone. The operand must be absolute and must not end
 * with a slash: a trailing slash makes rm dereference a symlink
 * operand instead of unlinking the link (see the header's symlink
 * residual), so /tmp/link/ fails while /tmp/link passes. `.` and `..`
 * components are resolved and a `..` escaping above the root fails;
 * the component after tmp must exist and must not begin with a glob
 * metacharacter, so bare /tmp, /tmp/*, and /tmp/? fail while /tmp/foo-*
 * passes. Later components may glob: the literal prefix is confined
 * already.
 *
 * @param operand one rm path operand after quote and escape removal
 * @returns true when the operand is confined under /tmp
 */
function isConfinedTmpOperand(operand: string): boolean {
	if (!operand.startsWith("/")) return false;
	if (operand.endsWith("/")) return false;
	const components: string[] = [];
	for (const part of operand.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (components.length === 0) return false;
			components.pop();
			continue;
		}
		components.push(part);
	}
	if (components.length < 2 || components[0] !== tmpRootComponent) return false;
	return !leadingGlobChar.test(components[1]);
}

/**
 * Decide whether one top-level command segment is a plain recursive
 * `rm` invocation (unquoted name, no assignment or command prefix, no
 * quoted operands) with every path operand /tmp-confined. This is the
 * only shape the /tmp exemption accounts for. There is no benign
 * classification: the gate patterns are a recall-limited prompt
 * heuristic, so pattern silence proves nothing about a segment and any
 * segment that does not parse as a confined recursive rm refuses the
 * exemption.
 *
 * @param words the segment's words from scanCommand
 * @returns true when the segment is a confined recursive rm
 */
function isConfinedTmpRmSegment(words: Word[]): boolean {
	const name = words[0];
	if (name.text !== "rm" || name.quoted || words.length < 2) return false;
	let recursive = false;
	const operands: string[] = [];
	let optionsEnded = false;
	for (const word of words.slice(1)) {
		if (!optionsEnded && !word.quoted && word.text.startsWith("-") && word.text !== "-") {
			if (word.text === "--") optionsEnded = true;
			else if (word.text === "--recursive") recursive = true;
			else if (!word.text.startsWith("--") && /r/i.test(word.text)) recursive = true;
			continue;
		}
		if (word.quoted) return false;
		operands.push(word.text);
	}
	return recursive && operands.length > 0 && operands.every(isConfinedTmpOperand);
}

/**
 * Decide whether a dangerous command qualifies for the no-confirmation
 * /tmp cleanup exemption: EVERY segment of the command is a plain
 * recursive `rm` whose path operands are all absolute /tmp-confined
 * paths, with no sudo or chmod/chown 777 anywhere, no executor shape,
 * no variable or command substitution, and no redirects, grouping,
 * comments, or other syntax the analysis does not model. Companion
 * segments of any other shape (echo, cd, dd, a gate-blind rm flag
 * order, anything) refuse the exemption, because per-segment pattern
 * silence proves nothing. Anything uncertain returns false so the
 * normal gate applies.
 *
 * @param command raw bash command text
 * @returns true when the command is a /tmp-confined rm cleanup
 */
export function isTmpConfinedRmOnlyCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	if (substitutionChars.test(command)) return false;
	const unquoted = stripQuotedSpans(command);
	if (sudoPattern.test(unquoted) || chmodChownPattern.test(unquoted)) return false;
	if (executorShape.test(unquoted)) return false;
	const { segments, bail } = scanCommand(command);
	if (bail || segments.length === 0) return false;
	return segments.every(isConfinedTmpRmSegment);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;

		if (isDangerousCommand(command) && !isTmpConfinedRmOnlyCommand(command)) {
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
