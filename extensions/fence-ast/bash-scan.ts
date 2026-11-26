/**
 * The AST-backed detection layer for the workspace-fence bash pass
 * (unit PISCOPE-2-2, task PISCOPE-2). The lexical walker this module
 * replaces (scanBashWords and its segment/word model) retired with the
 * swap. Substitution is position-blind: ONE traversal collects every
 * expansion node wherever the grammar allows one (command names,
 * arguments, assignment and array values, redirect destinations,
 * interpolating heredoc bodies, case patterns, arithmetic, any
 * position), because bash's expansion is not tied to a syntactic
 * position and a position-enumerated check re-opens a silent-allow
 * hole at every position it fails to name. Operand extraction is
 * deliberately position-aware (the grammar's word positions only):
 * operands are argument pieces, whole file_redirect destinations,
 * assignment and declaration values including array elements, and
 * cd/pushd arguments, while a command_name reads for executor
 * identity, not as an operand (the pinned historical posture), and an
 * expansion-shaped name asks through the substitution traversal. Quoting is
 * grammar structure, not a modeled
 * guess: a quoted operand extracts exactly as a bare one does, while a
 * quoted prose mention is argument data whose pieces still gate.
 *
 * Tree corrections the walk applies (the GPS quirk class, GPS parser
 * corrections for tree-sitter-bash issues #977/#979):
 *
 * - A redirect attached to a heredoc statement hangs inside the
 *   heredoc_redirect node rather than beside the command; the walk
 *   descends heredoc_redirect so the target still extracts, while
 *   heredoc tags, bodies, and content contribute no operands.
 * - A heredoc body is prose bash never parses as commands, but an
 *   interpolating body still runs its expansions; the walk scans
 *   bodies for expansion nodes (which ask). When the statement's
 *   head consumer reads stdin as a script (a shell, su, ssh, eval,
 *   or bare-redirect exec identity, wrappers and their arguments
 *   stripped), the body is that script's text, so its words
 *   extract and gate exactly as executor payload words do; a
 *   non-shell consumer's heredoc stays data, and a here-string
 *   value under such a head rides the same rule.
 * - The grammar splits a mid-word backslash-newline continuation into
 *   two word nodes where bash glues them into one; bash removes the
 *   pair and splits the rest on whitespace, so the walk re-joins the
 *   words only when the source gap between them is exactly the pair:
 *   `cat foo\<newline>/etc/passwd` is one operand, while an indented
 *   or spaced continuation leaves two words, each gated on its own
 *   text.
 *
 * Deliberate semantic narrowing over the lexical scan, sanctioned by
 * the Decision Log answer to Blocks Q3 (2026-11-25 09:40): heredocs,
 * comments, grouping, and braces now parse to verdicts instead of
 * bailing; the bail class is the parse-health class (rootNode.hasError,
 * ERROR and missing tokens), the GPS parse-health precedent. An
 * ERROR-bearing parse bails to ask, and parser unavailability (load
 * failure, digest mismatch, expired init budget) rejects so the
 * consumer boundary asks fail-safe.
 *
 * The sed pattern-first skip (the EXT-34 closure): for a command whose
 * head identity is sed, the first positional argument and the value of
 * an expression flag are the edit script, an argument bash never opens,
 * so the walk skips them structurally instead of surfacing a sed range
 * as a garbage absolute path (the EXT-34 field incident). The
 * mechanism is position- and role-based, adapted from GPS's
 * PATTERN_FIRST_COMMANDS (src/access-intent/bash/token-collection.ts)
 * and scoped to sed, the class the driver record names; a script named
 * through -f/--file is a real file read and stays an operand, and file
 * operands after the script keep gating, so the narrowing carries no
 * silent direction. Grep/rg/awk patterns with slashes are the
 * remaining over-ask class, stated in the header residual.
 */

import { withBashParse, type BashSyntaxNode } from "./bash-parser.ts";

/** The bash scope pass's extraction stage for one command, as pure data. */
export interface BashScanResult {
	/** The walk met an expansion node (any form bash would expand: $, ${}, $(), $(( )), backticks, process substitution, ANSI-C quoting) anywhere in the parsed tree: one position-blind traversal flags every expansion node the grammar produces (escapes honored by the grammar; single-quoted text exempt except under executor shapes and seam-active heredoc or here-string text carrying a raw $ or backtick). */
	substitution: boolean;
	/** An executor invocation (a shell/su/ssh token under lexical path-stripped identity with a -c-carrying flag, glued forms included, or eval) anywhere in one command node's token stream, name or arguments: detection is position-independent over the stream, so a prefixed payload (sudo bash -c, watch bash -c) re-splits exactly as a bare one does. */
	executor: boolean;
	/** The wrapper spelling when an executor shape rides behind command/env/nohup/nice/timeout/exec in one command node: the walk cannot see through it, so the call floors to ask. */
	interposed: string | null;
	/** The parse carries an ERROR or missing token (broken quoting, malformed syntax): the bail class is parse health, not a syntax vocabulary. */
	bail: boolean;
	/** The assigned variable name when the walk met an assignment in any posture (lone, command prefix, declaration, append, subscript) or an env spelling carrying a hijackable execution vector (PROMPT_COMMAND, BASH_ENV, ZDOTDIR, ENV, LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, PS4, PATH): the shell or its loader consumes the value for deferred or indirect execution regardless of its shape, so the assignment itself floors the call to ask. */
	envVector: string | null;
	/** Set when a cd/pushd names no lexically resolvable target (bare cd, -, option-only). */
	cdAsk: string | null;
	/** Path-like operands in walk order, deduped; empty under substitution or bail. */
	operands: string[];
}

/** Node types whose presence is substitution: any form bash would expand. */
const EXPANSION_NODE_TYPES: ReadonlySet<string> = new Set([
	"simple_expansion",
	"expansion",
	"command_substitution",
	"process_substitution",
	"arithmetic_expansion",
	"ansi_c_string",
]);

/** Argument-shape node types whose resolved text feeds extraction. */
const ARG_NODE_TYPES: ReadonlySet<string> = new Set(["word", "string", "raw_string", "concatenation"]);

/** Subtrees the extraction walk reads nothing from: comments are inert to bash, heredoc tags and bodies are not operands, and a command_name is identity, not an operand. Expansion PRESENCE is independent of this list - the generic traversal reads the full tree - so no skip here can hide an expansion. */
const SKIP_SUBTREE_TYPES: ReadonlySet<string> = new Set([
	"comment",
	"heredoc_start",
	"heredoc_end",
	"heredoc_content",
	"command_name",
]);

/** Shell executables whose -c payload a child shell re-evaluates. */
const BASH_EXECUTOR_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

/**
 * Redirect operator tokens: anonymous grammar tokens whose node type
 * is the operator text itself. file_redirect children iterate in
 * source order as optional fd, operator, destination, so the operator
 * must not read as an unmodeled destination shape.
 */
const REDIRECT_OPERATOR_TYPES: ReadonlySet<string> = new Set([
	">",
	">>",
	">&",
	"<",
	"<<",
	"<<-",
	"<>",
	"<&",
	"<&-",
	">&-",
	">|",
	"&>",
	"&>>",
]);

/**
 * Wrappers whose arguments the walk cannot see through: command and
 * env re-execute their arguments through PATH lookup, nohup, nice,
 * and timeout exec their program directly, and exec replaces the
 * process with its argument outright; when one of them precedes an
 * executor shape in a command node the scan floors to ask instead of
 * modeling what the wrapper will run. The stdin-script head read
 * strips through these wrappers AND their arguments (flags,
 * assignments, durations) to find the program the wrapper runs.
 */
const BASH_INTERPOSER_WORDS: ReadonlySet<string> = new Set(["command", "env", "nohup", "nice", "timeout", "exec"]);

/**
 * Variables the shell or its loader consumes for deferred or indirect
 * execution rather than as data, the full hijackable family (advisor
 * confirmation memos 19 and 23, review 22): PROMPT_COMMAND runs at
 * every interactive prompt, BASH_ENV is sourced by every
 * non-interactive shell, ZDOTDIR and ENV point the shell family at
 * startup files, LD_PRELOAD loads into the next exec of any
 * dynamically linked binary, LD_AUDIT is dlopened by the same loader
 * on the next exec and its constructor runs, LD_LIBRARY_PATH
 * redirects the loader's library search on the next exec (a planted
 * matching-soname library executes), PS4 executes its expansion at
 * the first xtrace line, and PATH redirects executable lookup on
 * every subsequent command. A value's shape proves nothing about what
 * will run, so an assignment in any posture or an env spelling
 * carrying one of these names floors the call to ask regardless of
 * the value.
 */
const BASH_DEFERRED_EXECUTION_VARS: ReadonlySet<string> = new Set([
	"PROMPT_COMMAND",
	"BASH_ENV",
	"ZDOTDIR",
	"ENV",
	"LD_PRELOAD",
	"LD_AUDIT",
	"LD_LIBRARY_PATH",
	"PS4",
	"PATH",
]);

/**
 * A combined-flag token carrying -c, glued-value forms included:
 * bash takes a short option's cluster remainder as the value, so
 * -cpayload, -c'payload', and -c"payload" all arrive as one argument
 * token whose text continues past the flag (bash -lc matches; so does
 * -cu, an inert-junk over-ask accepted fail-safe).
 */
const bashExecutorFlag = /^-[a-zA-Z]*c/;

/** Raw-text carriers of expansion the executor shapes re-evaluate: $ forms and backticks anywhere in the raw command. */
const bashSubstitutionChars = /[$`]/;

/** sed's script-carrying flags: their value is the edit script, an argument bash never opens. */
const SED_SCRIPT_FLAGS: ReadonlySet<string> = new Set(["-e", "--expression"]);
/** sed's script-file flags: their value names a real file read, so it stays an operand. */
const SED_SCRIPT_FILE_FLAGS: ReadonlySet<string> = new Set(["-f", "--file"]);
/** sed's inline long-form spellings: --expression=SCRIPT and --file=SCRIPTFILE. */
const SED_INLINE_EXPRESSION = /^--expression=(.+)$/;
const SED_INLINE_FILE = /^--file=(.+)$/;

/**
 * Lexically strip a token's directory prefix (the tail after the
 * last slash) so executor and wrapper identity matches across
 * path-qualified spellings (/bin/bash, ./sh, ~/bin/su). Deliberately
 * no filesystem resolution: a missing /bin/bash still gates, because
 * the ask posture keys on the invocation shape, not executable
 * existence.
 */
function bashExecutorTokenIdentity(token: string): string {
	const slash = token.lastIndexOf("/");
	return slash === -1 ? token : token.slice(slash + 1);
}

function isPathLikeBashWord(text: string): boolean {
	if (text.startsWith("/")) return true;
	if (text.startsWith("~")) return true;
	if (text === "..") return true;
	return text.includes("/");
}

const cdOldpwdAskDetail =
	"cd/pushd to - targets $OLDPWD, which the scanner cannot resolve; approve interactively or spell the absolute path";
const cdUnresolvableAskDetail =
	"the cd/pushd target is the shell's home directory or directory stack, which the scanner cannot resolve; approve interactively or spell the absolute path";

const bashWhitespaceSplit = /\s+/;

interface ScanAccumulator {
	substitution: boolean;
	executor: boolean;
	interposed: string | null;
	bail: boolean;
	envVector: string | null;
	cdAsk: string | null;
	operands: string[];
	seen: Set<string>;
}

interface ArgumentToken {
	node: BashSyntaxNode;
	text: string;
	pieces: string[];
}

function pushOperand(acc: ScanAccumulator, operand: string): void {
	if (!acc.seen.has(operand)) {
		acc.seen.add(operand);
		acc.operands.push(operand);
	}
}

/**
 * Bash's outside-quote escape rule: a backslash escapes the character
 * after it, so the pair collapses to the escaped character. The
 * grammar keeps escape_sequence nodes in word and string text, so the
 * processed text removes them exactly as bash hands the word to exec.
 */
function unescapeBashText(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

/**
 * The quote-stripped, escape-processed text of one argument-shape
 * node: a word unescapes as bash does, a raw_string strips its single
 * quotes and keeps backslashes literally (bash cannot process escapes
 * there), a string strips its double quotes, and a concatenation
 * joins its parts. This text drives identity, flag, and cd matching.
 */
function processedTextOf(node: BashSyntaxNode): string {
	switch (node.type) {
		case "word":
			return unescapeBashText(node.text);
		case "raw_string":
			return node.text.slice(1, -1);
		case "string":
			return node.text.slice(1, -1);
		case "concatenation": {
			let joined = "";
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child && ARG_NODE_TYPES.has(child.type)) joined += processedTextOf(child);
			}
			return joined;
		}
		default:
			return node.text;
	}
}

/**
 * The operand pieces of one argument-shape node, in extraction order.
 * A word is one piece (its whitespace arrives from escapes, which
 * never split a bash word). Quoted and concatenated text splits on
 * whitespace into pieces, the user-settled R2 remedy: a path named
 * inside quoted prose gates, while the prose around it stays inert.
 * String pieces unescape (double quotes process escapes); raw_string
 * pieces keep backslashes literally.
 */
function piecesOfNode(node: BashSyntaxNode): string[] {
	switch (node.type) {
		case "word":
			return [processedTextOf(node)];
		case "raw_string": {
			const inner = node.text.slice(1, -1);
			return inner.split(bashWhitespaceSplit).filter((piece) => piece.length > 0);
		}
		case "string": {
			const inner = node.text.slice(1, -1);
			return inner
				.split(bashWhitespaceSplit)
				.filter((piece) => piece.length > 0)
				.map(unescapeBashText);
		}
		case "concatenation": {
			const parts: string[] = [];
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child && ARG_NODE_TYPES.has(child.type)) parts.push(...piecesOfNode(child));
			}
			return parts.flatMap((piece) => piece.split(bashWhitespaceSplit)).filter((piece) => piece.length > 0);
		}
		default:
			return [];
	}
}

function makeArgumentToken(node: BashSyntaxNode): ArgumentToken {
	return { node, text: processedTextOf(node), pieces: piecesOfNode(node) };
}

/**
 * The processed text of one command node's name child: the identity
 * read shared by the command handler and the redirected-statement
 * seam.
 */
function commandNameText(node: BashSyntaxNode): string {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child || child.type !== "command_name") continue;
		for (let j = 0; j < child.childCount; j++) {
			const nameChild = child.child(j);
			if (nameChild && ARG_NODE_TYPES.has(nameChild.type)) return processedTextOf(nameChild);
		}
	}
	return "";
}

/**
 * The child shell's word split of an executor payload (the lexical
 * splitQuotes posture this walk carries over): quote characters are
 * word boundaries and are dropped, and an outside-quote escape
 * consumes the escaped character, so `cat "/etc/passwd"` inside a
 * payload splits to the same words the child shell executes. Applied
 * to argument tokens at executor shapes and, through the seam below,
 * to stdin-script heredoc body and here-string text, whose consumer
 * word-splits it the same way.
 */
function executorPayloadPieces(text: string): string[] {
	return text
		.split(/[\s'"]+/)
		.filter((piece) => piece.length > 0)
		.map(unescapeBashText);
}

/**
 * Whether an identity consumes stdin as a script: the shell family
 * reads its script from stdin when run without arguments, su spawns a
 * shell, ssh runs the remote shell on stdin, eval executes the
 * command line its arguments join with stdin inherited by whatever
 * runs, and a bare exec (redirect-only, no argument) applies its
 * redirections to the current shell so a later command reads the
 * attached text as stdin. Executor detection uses the same identity
 * family.
 */
function isStdinScriptIdentity(identity: string): boolean {
	return (
		BASH_EXECUTOR_SHELLS.has(identity) || identity === "su" || identity === "ssh" || identity === "eval" || identity === "exec"
	);
}

/**
 * Push the path-like words of one stdin-script text (a heredoc body
 * or a here-string value handed to such a consumer) as operands,
 * deduped in walk order.
 */
function pushStdinScriptPieces(text: string, acc: ScanAccumulator): void {
	for (const piece of executorPayloadPieces(text)) {
		if (isPathLikeBashWord(piece)) pushOperand(acc, piece);
	}
}

/**
 * The generic expansion traversal: one full-tree walk that flags
 * substitution for every expansion node wherever the grammar allows
 * one. Bash expands in every syntactic position it can spell, so
 * expansion PRESENCE must not depend on which positions the extraction
 * walk knows how to read; the position-enumerated substitution checks
 * this traversal replaces missed every position they did not name. The
 * walk visits every node including skip-listed subtrees (a command
 * name, a comment's neighborhood, a heredoc body): comments and quoted
 * heredoc bodies are leaves carrying no expansion children, and an
 * expansion node anywhere else means bash will expand there.
 */
function flagEveryExpansion(node: BashSyntaxNode, acc: ScanAccumulator): void {
	if (EXPANSION_NODE_TYPES.has(node.type)) {
		acc.substitution = true;
		return;
	}
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) flagEveryExpansion(child, acc);
	}
}

/**
 * The value-side pieces of one variable_assignment: the scalar value's
 * pieces, or an array value's element pieces (the grammar allows an
 * array directly in value position, and each element is one of the
 * argument-shape nodes). The name and `=` siblings are not values.
 */
function assignmentValuePieces(node: BashSyntaxNode): string[] {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (ARG_NODE_TYPES.has(child.type)) return piecesOfNode(child);
		if (child.type === "array") {
			const pieces: string[] = [];
			for (let j = 0; j < child.childCount; j++) {
				const element = child.child(j);
				if (element && ARG_NODE_TYPES.has(element.type)) pieces.push(...piecesOfNode(element));
			}
			return pieces;
		}
	}
	return [];
}

/**
 * The name of one variable_assignment: the grammar folds the plain
 * name, the append operator, and the subscript form under the same
 * variable_name read, either as a direct child or inside a subscript
 * node.
 */
function assignmentName(node: BashSyntaxNode): string | null {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "variable_name") return child.text;
		if (child.type === "subscript") {
			for (let j = 0; j < child.childCount; j++) {
				const inner = child.child(j);
				if (inner && inner.type === "variable_name") return inner.text;
			}
		}
	}
	return null;
}

/**
 * The env-var-carried execution-vector floor: an assignment node
 * carrying a deferred-execution variable name flags the vector
 * regardless of the value's shape. Runs in every assignment posture
 * (lone statement-level, command prefix, declaration), before any
 * extraction gating, because the name alone is the ask condition.
 */
function flagDeferredExecutionVector(node: BashSyntaxNode, acc: ScanAccumulator): void {
	if (acc.envVector !== null) return;
	const name = assignmentName(node);
	if (name !== null && BASH_DEFERRED_EXECUTION_VARS.has(name)) acc.envVector = name;
}

/**
 * One variable_assignment in walk order: a deferred-execution variable
 * name flags the vector in every posture, and substitution rides the
 * generic expansion traversal (an expansion anywhere in the assignment
 * - value, array element, subscript - asks), so the rest of this
 * handler only extracts. When extraction is on and no substitution
 * fired, the value's path-like pieces push as operands, the prefix-form
 * posture: an assignment riding a command or a declaration command
 * (export/declare/readonly/typeset) carries the environment value the
 * command's child processes see, array elements included. A leading
 * `=` on a piece is the subscript assignment separator the grammar
 * folds into the element word, not part of the value (the scalar path
 * sees the same separator as a sibling node). A lone statement-level
 * assignment extracts nothing (bash only sets the variable), so the
 * caller turns extraction off there while the vector flag still runs.
 */
function scanAssignment(node: BashSyntaxNode, acc: ScanAccumulator, extractOperands: boolean): void {
	flagDeferredExecutionVector(node, acc);
	if (!extractOperands || acc.substitution) return;
	for (const piece of assignmentValuePieces(node)) {
		const value = piece.startsWith("=") ? piece.slice(1) : piece;
		if (isPathLikeBashWord(value)) pushOperand(acc, value);
		const eq = value.indexOf("=");
		if (eq > 0) {
			const tail = value.slice(eq + 1);
			if (isPathLikeBashWord(tail)) pushOperand(acc, tail);
		}
	}
}

/**
 * Whether a token text carries an executor shape, mirroring the
 * lexical scanner's segment rule over one command node's tokens: an
 * eval or ssh identity anywhere, or a shell/su identity followed
 * anywhere later by a -c-carrying flag.
 */
function tokensCarryExecutorShape(tokens: string[]): boolean {
	for (let index = 0; index < tokens.length; index++) {
		const identity = bashExecutorTokenIdentity(tokens[index]);
		if (identity === "eval") return true;
		if (identity === "ssh") return true;
		if (BASH_EXECUTOR_SHELLS.has(identity) || identity === "su") {
			for (let next = index + 1; next < tokens.length; next++) {
				if (bashExecutorFlag.test(tokens[next])) return true;
			}
		}
	}
	return false;
}

/**
 * Per-argument extraction roles for a sed command (the EXT-34
 * closure). Returns one entry per argument token: whether the token
 * extracts as an operand, plus pieces to push unconditionally (the
 * inline and glued script-file values, which are proven file
 * references by role). Position- and role-based, adapted from GPS's
 * pattern-first walker: the first positional is the edit script (an
 * argument bash never opens), an expression flag consumes its value
 * as script, a script-file flag consumes its value as a real file
 * operand, and once a script exists (from -e/--expression/-f/--file
 * or the first positional) every remaining positional is a file
 * operand. Deviation from GPS, deliberate: GPS consumes a separated
 * `-i`'s next argument as an in-place suffix, but GNU sed's suffix
 * attaches only in glued or =-form, so consuming a separated argument
 * would drop a real file operand, which in this fence is the silent
 * direction (GPS leans on an existence probe this fence does not
 * have), so -i consumes nothing here.
 */
function sedArgRoles(argTokens: ArgumentToken[]): { extract: boolean; extraPieces: string[] }[] {
	const roles = argTokens.map(() => ({ extract: true, extraPieces: [] as string[] }));
	let explicitScript = false;
	let scriptPositionalSkipped = false;
	let endOfFlags = false;
	let pending: "script" | "script-file" | null = null;
	for (let i = 0; i < argTokens.length; i++) {
		const text = argTokens[i].text;
		if (pending !== null) {
			roles[i].extract = pending === "script-file";
			pending = null;
			continue;
		}
		if (!endOfFlags && text.length > 1 && text.startsWith("-")) {
			if (text === "--") {
				endOfFlags = true;
				roles[i].extract = false;
				continue;
			}
			if (SED_SCRIPT_FLAGS.has(text)) {
				roles[i].extract = false;
				explicitScript = true;
				pending = "script";
				continue;
			}
			if (SED_SCRIPT_FILE_FLAGS.has(text)) {
				roles[i].extract = false;
				explicitScript = true;
				pending = "script-file";
				continue;
			}
			if (SED_INLINE_EXPRESSION.test(text) || SED_INLINE_FILE.test(text)) {
				roles[i].extract = false;
				explicitScript = true;
				if (SED_INLINE_FILE.test(text)) roles[i].extraPieces.push(text.slice("--file=".length));
				continue;
			}
			if (!text.startsWith("--") && text.length > 2) {
				const first2 = text.slice(0, 2);
				if (first2 === "-e") {
					roles[i].extract = false;
					explicitScript = true;
					continue;
				}
				if (first2 === "-f") {
					roles[i].extract = false;
					explicitScript = true;
					roles[i].extraPieces.push(unescapeBashText(text.slice(2)));
					continue;
				}
			}
			roles[i].extract = false;
			continue;
		}
		if (explicitScript) continue;
		if (!scriptPositionalSkipped) {
			roles[i].extract = false;
			scriptPositionalSkipped = true;
			continue;
		}
	}
	return roles;
}

/**
 * cd/pushd target detection over one command node's piece stream (the
 * command's name piece plus every argument's pieces), ported from the
 * lexical scanner's segment rule: a cd or pushd piece followed by the
 * first non-option piece pushes that target as an operand (bare and
 * symlinked names route through the verdict core); a lone `-` names
 * OLDPWD and an exhausted stream names home or the directory stack,
 * both shell state the walk cannot resolve, so the call asks.
 */
function detectCdTarget(pieces: string[], acc: ScanAccumulator): void {
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index];
		if (piece !== "cd" && piece !== "pushd") continue;
		let resolved = false;
		for (let next = index + 1; next < pieces.length; next++) {
			const target = pieces[next];
			if (target === "cd" || target === "pushd") break;
			if (target === "-") {
				if (acc.cdAsk === null) acc.cdAsk = cdOldpwdAskDetail;
				resolved = true;
				break;
			}
			if (target.startsWith("-")) continue;
			pushOperand(acc, target);
			resolved = true;
			break;
		}
		if (!resolved && acc.cdAsk === null) acc.cdAsk = cdUnresolvableAskDetail;
	}
}

/**
 * The structured walk of one command node: identity reads, executor
 * and wrapper shapes, then operand extraction (argument pieces with
 * per-piece assignment RHS, prefix assignment values, cd targets).
 * Substitution needs no handling here: the generic expansion traversal
 * has already flagged any expansion anywhere in the tree, including
 * this command's name, arguments, and assignment prefixes, and the
 * extraction phases stay gated on it. The extraction phases run only
 * when no substitution fired, matching the lexical scanner's early
 * return: expansion results are invisible to the walk, so extracted
 * operands would be guesses. The vector flag runs before that gate in
 * every posture (assignment name, env spelling), because the ask
 * condition is the name, not the value.
 */
function handleCommand(node: BashSyntaxNode, acc: ScanAccumulator, source: string): void {
	const nameText = commandNameText(node);
	const identity = bashExecutorTokenIdentity(nameText);
	const argTokens: ArgumentToken[] = [];
	const assignments: BashSyntaxNode[] = [];
	const herestrings: BashSyntaxNode[] = [];
	const seamIdentity = headIdentityThroughWrappers(node);
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "variable_assignment") {
			assignments.push(child);
		} else if (ARG_NODE_TYPES.has(child.type)) {
			const previous = argTokens[argTokens.length - 1];
			if (previous && joinWordsAcrossContinuation(previous.node, child, source)) {
				previous.text += processedTextOf(child);
				previous.pieces = [previous.pieces.join("") + piecesOfNode(child).join("")];
			} else {
				argTokens.push(makeArgumentToken(child));
			}
		} else if (child.type === "file_redirect") {
			handleFileRedirect(child, acc);
		} else if (child.type === "herestring_redirect") {
			if (isStdinScriptIdentity(seamIdentity)) herestrings.push(child);
			else walkNode(child, acc, source);
		} else {
			walkNode(child, acc, source);
		}
	}
	const tokenTexts = [nameText, ...argTokens.map((token) => token.text)];

	for (const assignment of assignments) scanAssignment(assignment, acc, false);

	if (identity === "env") {
		for (const token of argTokens) {
			const eq = token.text.indexOf("=");
			const name = eq > 0 ? token.text.slice(0, eq) : null;
			if (name !== null && BASH_DEFERRED_EXECUTION_VARS.has(name)) {
				if (acc.envVector === null) acc.envVector = name;
				break;
			}
		}
	}

	// Executor detection is position-independent over the command's
	// full token stream, the same look the interposed check uses: an
	// eval/ssh identity or a shell/su identity followed by a -c flag
	// anywhere in the stream sets the executor flag, so a payload under
	// a non-vocabulary prefix (sudo bash -c, watch bash -c, exec sh -c)
	// re-splits and gates exactly as the bare spelling does.
	if (tokensCarryExecutorShape(tokenTexts)) acc.executor = true;

	for (let index = 0; index < tokenTexts.length; index++) {
		if (!BASH_INTERPOSER_WORDS.has(bashExecutorTokenIdentity(tokenTexts[index]))) continue;
		if (tokensCarryExecutorShape(tokenTexts.slice(index + 1))) {
			if (acc.interposed === null) acc.interposed = tokenTexts[index];
			break;
		}
	}

	if (acc.substitution) return;

	if (acc.executor) {
		for (const token of argTokens) token.pieces = executorPayloadPieces(token.node.text);
	}
	for (const herestring of herestrings) {
		for (let i = 0; i < herestring.childCount; i++) {
			const value = herestring.child(i);
			if (value && ARG_NODE_TYPES.has(value.type)) {
				if (bashSubstitutionChars.test(value.text)) {
					acc.substitution = true;
				} else {
					pushStdinScriptPieces(value.text, acc);
				}
			}
		}
	}

	const roles = identity === "sed" ? sedArgRoles(argTokens) : null;
	for (let i = 0; i < argTokens.length; i++) {
		if (roles && !roles[i].extract) {
			for (const piece of roles[i].extraPieces) pushOperand(acc, piece);
			continue;
		}
		for (const piece of argTokens[i].pieces) {
			if (isPathLikeBashWord(piece)) pushOperand(acc, piece);
			const eq = piece.indexOf("=");
			if (eq > 0) {
				const value = piece.slice(eq + 1);
				if (isPathLikeBashWord(value)) pushOperand(acc, value);
			}
		}
	}
	for (const assignment of assignments) scanAssignment(assignment, acc, true);
	const cdPieces = [nameText, ...argTokens.flatMap((token) => token.pieces)];
	detectCdTarget(cdPieces, acc);
}

/**
 * One file_redirect: the syntax proves its destination names a file,
 * so a literal destination extracts wherever it sits (a segment-head
 * one would otherwise read as the executable) regardless of
 * path-likedness, whole, as the one shell word bash hands to exec, not
 * split into prose pieces. An fd-duplication destination (`2>&1`, a
 * bare number) and the fd-close spellings (`2>&-`) carry no path and
 * extract nothing; any other destination shape the table does not
 * model biases to substitution, while an ERROR child stays with the
 * parse-health bail the whole tree already carries. Expansion
 * destinations (process or command substitution, a parameter) are
 * unmodeled shapes here and already ask through the generic traversal.
 * Destinations hung under a heredoc_redirect reach here through the
 * generic descent, the GPS quirk correction.
 */
function handleFileRedirect(node: BashSyntaxNode, acc: ScanAccumulator): void {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "file_descriptor" || REDIRECT_OPERATOR_TYPES.has(child.type)) continue;
		if (child.type === "ERROR") continue;
		if (child.type === "number") continue;
		if (!ARG_NODE_TYPES.has(child.type)) {
			acc.substitution = true;
			continue;
		}
		pushOperand(acc, processedTextOf(child));
	}
}

/**
 * The head consumer's identity of one statement child: the first
 * command node in document order (compound and grouped heads
 * included, so `{ bash; }` reads bash), except a pipeline child reads
 * its LAST stage because a statement's stdin feeds the pipeline's end
 * (`cat x | bash << EOF` runs bash on the body, `bash | cat << EOF`
 * feeds the body to cat as data); or null when the child carries no
 * command. A wrapper identity strips through the interposer words AND
 * their arguments (flags, assignments, durations) so `command bash <<
 * EOF` and `env -i bash << EOF` read bash, the same full-stream
 * look-past posture executor detection uses.
 */
function statementHeadIdentity(node: BashSyntaxNode): string | null {
	let found: string | null = null;
	const visit = (current: BashSyntaxNode): void => {
		if (found !== null) return;
		if (current.type === "command") {
			found = headIdentityThroughWrappers(current);
			return;
		}
		if (current.type === "pipeline") {
			for (let i = current.childCount - 1; i >= 0; i--) {
				const child = current.child(i);
				if (child) visit(child);
			}
			return;
		}
		for (let i = 0; i < current.childCount; i++) {
			const child = current.child(i);
			if (child) visit(child);
		}
	};
	visit(node);
	return found;
}

/**
 * One command node's stdin-script identity with wrapper identities
 * and wrapper ARGUMENTS stripped: the command name if it already
 * consumes stdin as a script, otherwise every argument token scanned
 * for the first stdin-script identity (the program the wrapper will
 * run after its flags, assignments, and durations), so `command
 * bash`, `env zsh`, `nohup nice -n 5 sh`, and `env -i bash` all read
 * the shell they will run; with no stdin-script identity among the
 * arguments the first non-interposer token is the wrapper's actual
 * program and the seam stays inactive for it.
 */
function headIdentityThroughWrappers(command: BashSyntaxNode): string {
	let identity = bashExecutorTokenIdentity(commandNameText(command));
	if (!BASH_INTERPOSER_WORDS.has(identity)) return identity;
	let stripped: string | null = null;
	for (let i = 0; i < command.childCount; i++) {
		const child = command.child(i);
		if (!child || !ARG_NODE_TYPES.has(child.type)) continue;
		identity = bashExecutorTokenIdentity(processedTextOf(child));
		if (isStdinScriptIdentity(identity)) return identity;
		if (stripped === null && !BASH_INTERPOSER_WORDS.has(identity)) stripped = identity;
	}
	return stripped ?? identity;
}

/**
 * One redirected_statement: the grammar hangs the command, the
 * attached redirect operators, and the heredoc under this wrapper, so
 * this handler walks every child in grammar order (the file_redirect
 * targets still extract per the GPS quirk correction) and adds the
 * stdin-script seam: when the head consumer is a shell, su, ssh,
 * eval, or a bare-redirect exec (no argument), every heredoc body
 * under the statement is that consumer's
 * script text and its path-like words extract as operands, exactly as
 * executor payload words do, and a body whose raw text carries a $
 * or backtick biases to substitution (the executor corner's backstop:
 * a quoted delimiter makes the body literal to the grammar while the
 * child shell still expands it); a non-shell consumer's body
 * contributes nothing (it is data), and an interpolating body under
 * substitution stays behind the substitution ask with operands empty.
 */
function handleRedirectedStatement(node: BashSyntaxNode, acc: ScanAccumulator, source: string): void {
	const heredocRedirects: BashSyntaxNode[] = [];
	let headIdentity: string | null = null;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "heredoc_redirect") {
			heredocRedirects.push(child);
			continue;
		}
		if (headIdentity === null) headIdentity = statementHeadIdentity(child);
		walkNode(child, acc, source);
	}
	if (headIdentity === null || !isStdinScriptIdentity(headIdentity)) {
		for (const redirect of heredocRedirects) walkNode(redirect, acc, source);
		return;
	}
	for (const redirect of heredocRedirects) {
		for (let i = 0; i < redirect.childCount; i++) {
			const child = redirect.child(i);
			if (!child) continue;
			if (child.type === "heredoc_body") {
				if (!acc.substitution) {
					if (bashSubstitutionChars.test(child.text)) acc.substitution = true;
					else pushStdinScriptPieces(child.text, acc);
				}
			} else {
				walkNode(child, acc, source);
			}
		}
	}
}

function walkNode(node: BashSyntaxNode, acc: ScanAccumulator, source: string): void {
	if (SKIP_SUBTREE_TYPES.has(node.type)) return;
	if (node.type === "heredoc_body") return;
	if (node.type === "redirected_statement") {
		handleRedirectedStatement(node, acc, source);
		return;
	}
	if (node.type === "file_redirect") {
		handleFileRedirect(node, acc);
		return;
	}
	if (node.type === "command") {
		handleCommand(node, acc, source);
		return;
	}
	if (node.type === "variable_assignment") {
		scanAssignment(node, acc, false);
		return;
	}
	if (node.type === "declaration_command") {
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child && child.type === "variable_assignment") scanAssignment(child, acc, true);
		}
		return;
	}
	if (EXPANSION_NODE_TYPES.has(node.type)) {
		return;
	}
	if (ARG_NODE_TYPES.has(node.type)) {
		for (const piece of piecesOfNode(node)) {
			if (isPathLikeBashWord(piece)) pushOperand(acc, piece);
		}
		return;
	}
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walkNode(child, acc, source);
	}
}

/**
 * Re-join the words bash glues across a backslash-newline
 * continuation: bash removes the pair from the input stream and then
 * splits the remainder on whitespace, so two adjacent word nodes are
 * one exec-time word only when the source span between them is exactly
 * the pair. Whitespace after the newline (an indented continuation) or
 * before the backslash leaves two words, and a `\r` spelling is not
 * the pair (bash escapes the carriage return and the newline still
 * separates), so each shape stays split and gates on its own text.
 * Known simplification, deliberate: with two consecutive continuations
 * only the first pair joins (the merged token keeps the first node's
 * endIndex for the next gap check); every traced shape lands
 * verdict-equivalent or over-ask.
 */
function joinWordsAcrossContinuation(
	previous: BashSyntaxNode,
	current: BashSyntaxNode,
	source: string,
): boolean {
	if (previous.type !== "word" || current.type !== "word") return false;
	return source.slice(previous.endIndex, current.startIndex) === "\\\n";
}

/**
 * Extract one command's scan from its parsed tree: the walk collects
 * substitution, executor, interposition, the execution-vector name,
 * operands, and cdAsk, then the assembly mirrors the lexical scanner's
 * decision order: interposition first; then the substitution flag,
 * authoritative in every corner (the position-blind traversal flagged
 * the tree, and no assembly branch may erase what it saw - the
 * executor carve-out this ordering once carried silently allowed an
 * executor command with a dollar-free process substitution while the
 * substitution's inner command ran); then the executor raw-text
 * dollar test for the node-invisible payload dollars a quoted string
 * carries (the raw text is not an expansion node, but a child shell
 * re-evaluates its payload), with the seam's own backstop already
 * folded into the walk: a seam-active heredoc body or here-string
 * value whose raw text carries a $ or backtick flags substitution
 * where the grammar cannot see it; then the deferred-execution vector floor.
 * The bail flag is the parse's own health: any ERROR or missing token
 * in the tree.
 */
export async function runBashScan(command: string): Promise<BashScanResult> {
	return withBashParse(command, (rootNode) => {
		const acc: ScanAccumulator = {
			substitution: false,
			executor: false,
			interposed: null,
			bail: rootNode.hasError,
			envVector: null,
			cdAsk: null,
			operands: [],
			seen: new Set<string>(),
		};
		flagEveryExpansion(rootNode, acc);
		walkNode(rootNode, acc, command);
		if (acc.interposed !== null) {
			return { substitution: acc.substitution, executor: acc.executor, bail: acc.bail, envVector: acc.envVector, cdAsk: null, operands: [], interposed: acc.interposed };
		}
		if (acc.substitution) {
			return { substitution: true, executor: false, bail: true, envVector: acc.envVector, cdAsk: null, operands: [], interposed: null };
		}
		if (acc.executor && bashSubstitutionChars.test(command)) {
			return { substitution: true, executor: false, bail: true, envVector: acc.envVector, cdAsk: null, operands: [], interposed: null };
		}
		return { substitution: false, executor: acc.executor, bail: acc.bail, envVector: acc.envVector, cdAsk: acc.cdAsk, operands: acc.operands, interposed: null };
	});
}
