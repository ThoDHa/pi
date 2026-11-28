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
 *   command stream feeds a script consumer (any stdin-script identity
 *   among the stream's tokens: a shell, su, ssh, eval, an interpreter,
 *   or a bare-redirect exec; wrappers and their arguments looked
 *   through; the statement pipeline's last stage owning the
 *   statement's stdin, and every stage of a post-heredoc continuation
 *   pipeline consulted because each receives body-derived bytes), the
 *   body is that script's text, so its words extract and gate exactly
 *   as executor payload words do; a data consumer's heredoc stays
 *   data, and a here-string value under an active seam rides the same
 *   rule - including a pipeline-wide seam, because a here-string on
 *   any pipeline stage puts value-derived bytes on every later
 *   stage's stdin and a script consumer anywhere in the pipeline
 *   executes them (cat forwards its stdin; the posture reads
 *   presence, so an upstream stage that ignores stdin over-asks).
 *   The posture is position-independent, so a statement that merely
 *   mentions a shell word over-asks, the disclosed tradeoff.
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
	/** An executor invocation anywhere in one command node's token stream: a shell/su token with a -c or su long --command flag, ssh, eval, or a payload-carrying interpreter (python, node, perl, ruby, php, Rscript, osascript, lua) with its payload flag. Detection is position-independent over the stream, so a prefixed payload (sudo bash -c, watch bash -c, env python3 -c) re-splits exactly as a bare one does. */
	executor: boolean;
	/** The wrapper spelling when an executor shape rides behind command/env/nohup/nice/timeout/exec in one command node: the walk cannot see through it, so the call floors to ask. */
	interposed: string | null;
	/** The parse carries an ERROR or missing token (broken quoting, malformed syntax): the bail class is parse health, not a syntax vocabulary. */
	bail: boolean;
	/** The assigned variable name when the walk met an assignment in any posture (lone, command prefix, declaration, append, subscript) or an env spelling carrying a hijackable execution vector: the pinned floor (PROMPT_COMMAND, BASH_ENV, ZDOTDIR, ENV, LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, PS4, PATH, CDPATH, FPATH, HISTFILE) plus every LD_ loader-family name outside the inert allowlist. The shell or its loader consumes the value for deferred or indirect execution regardless of its shape, so the assignment itself floors the call to ask. */
	envVector: string | null;
	/** Set when a cd/pushd names no lexically resolvable target (bare cd, -, option-only). */
	cdAsk: string | null;
	/** Path-like operands in walk order, deduped; empty under substitution or bail. */
	operands: string[];
	/**
	 * Extraction-position provenance per operand text, keyed by operand, the
	 * first extraction winning on dedup (EXT-37): the ask reason names it so
	 * the prompt says exactly which role the path played in the command.
	 * Optional so suite scan injections stay valid; an absent entry reads as
	 * the plain argument posture at the consumer.
	 */
	operandPositions?: Record<string, string>;
	/**
	 * The expansion kinds behind the substitution flag, in first-seen order,
	 * so the bias ask names what it saw. Optional like operandPositions for
	 * the same injection tolerance; an absent or empty list reads as the
	 * generic expansion ask.
	 */
	substitutionKinds?: string[];
	/**
	 * Which posture fired the env-vector floor: a variable assignment or an
	 * env spelling. Optional like the other provenance fields; an absent
	 * value reads as the assignment posture.
	 */
	envVectorPosture?: "assignment" | "env spelling";
}

/**
 * The reason-facing kind name per expansion node type (EXT-37): the
 * substitution bias ask names the expansion kinds it saw instead of a
 * generic expansion. Backtick substitution parses as command_substitution,
 * the grammar's single node for both spellings.
 */
const EXPANSION_KIND_NAMES: Readonly<Record<string, string>> = {
	simple_expansion: "a parameter expansion ($var)",
	expansion: "a brace parameter expansion (${var})",
	command_substitution: "a command substitution",
	process_substitution: "a process substitution",
	arithmetic_expansion: "an arithmetic expansion",
	ansi_c_string: "an ANSI-C quoted string",
};

/** The kind the substitution bias reports for an unmodeled redirect destination shape. */
const UNMODELED_REDIRECT_KIND = "an unmodeled redirect destination shape";

/** The kind for a raw $ or backtick the grammar cannot see in an executor payload. */
const EXECUTOR_PAYLOAD_DOLLAR_KIND =
	"a raw $ or backtick in an executor payload (the child shell re-evaluates it)";

/** The kind for a raw $ or backtick the grammar cannot see in a stdin-script body. */
const STDIN_SCRIPT_DOLLAR_KIND =
	"a raw $ or backtick in a stdin-script body (the consumer shell re-evaluates it)";

/** Node types whose presence is substitution: any form bash would expand. Exported for the grammar-vocabulary completeness check (extensions/fence-ast/grammar-vocabulary.ts) and the re-pin gate. */
export const EXPANSION_NODE_TYPES: ReadonlySet<string> = new Set([
	"simple_expansion",
	"expansion",
	"command_substitution",
	"process_substitution",
	"arithmetic_expansion",
	"ansi_c_string",
]);

/** Argument-shape node types whose resolved text feeds extraction. A translated string ($"...") resolves exactly as its plain double-quoted twin when no translation is installed, so its text strips the marker and reads as string content. Exported for the grammar-vocabulary completeness check. */
export const ARG_NODE_TYPES: ReadonlySet<string> = new Set(["word", "string", "raw_string", "concatenation", "translated_string"]);

/** Subtrees the extraction walk reads nothing from: comments are inert to bash, heredoc tags and bodies are not operands, and a command_name is identity, not an operand. Expansion PRESENCE is independent of this list - the generic traversal reads the full tree - so no skip here can hide an expansion. Exported for the grammar-vocabulary completeness check. */
export const SKIP_SUBTREE_TYPES: ReadonlySet<string> = new Set([
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
 * must not read as an unmodeled destination shape. The set is
 * deliberately not staleness-checked against the grammar's declared
 * surface (grammar-vocabulary.ts): these are anonymous defensive
 * spellings, operator drift degrades to the unmodeled-shape
 * substitution bias (fail-safe), and one spelling here (`<>`) is not
 * declared by the grammar at all - every real `<>` shape carries an
 * ERROR node and bails to ask before this set is ever consulted.
 * Exported for the grammar-vocabulary completeness check.
 */
export const REDIRECT_OPERATOR_TYPES: ReadonlySet<string> = new Set([
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
 * execution rather than as data, the pinned floor of the hijackable
 * family (advisor confirmation memos 19 and 23, review 22, unit 2-3's
 * routed siblings): PROMPT_COMMAND runs at every interactive prompt,
 * BASH_ENV is sourced by every non-interactive shell, ZDOTDIR and ENV
 * point the shell family at startup files, LD_PRELOAD loads into the
 * next exec of any dynamically linked binary, LD_AUDIT is dlopened by
 * the same loader on the next exec and its constructor runs,
 * LD_LIBRARY_PATH redirects the loader's library search on the next
 * exec (a planted matching-soname library executes), PS4 executes its
 * expansion at the first xtrace line, PATH redirects executable
 * lookup on every subsequent command, CDPATH redirects cd's directory
 * lookup the same way (a pre-planted out-of-scope directory receives
 * the cd), FPATH redirects zsh's function autoload lookup (a planted
 * function file executes on the next call), and HISTFILE receives the
 * shell's recorded command lines on exit (an out-of-scope file write
 * whose content re-executes through history expansion). A value's
 * shape proves nothing about what will run, so an assignment in any
 * posture or an env spelling carrying one of these names floors the
 * call to ask regardless of the value.
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
	"CDPATH",
	"FPATH",
	"HISTFILE",
]);

/** The loader-family prefix rule (review 25 DC-2): every LD_ name joins the floor automatically, so the next loader-consumed name needs no pin cycle. The inert allowlist carries the names that only toggle loader diagnostics or binding mode and execute no code. */
const LD_LOADER_NAME_PREFIX = "LD_";
const LD_INERT_LOADER_NAMES: ReadonlySet<string> = new Set(["LD_DEBUG", "LD_BIND_NOW", "LD_TRACE_LOADED_OBJECTS", "LD_SHOW_AUXV"]);

/**
 * The deferred-execution vector test: the pinned name floor plus the
 * loader-family prefix rule. The enumerated set stays the pinned
 * surface every posture pin names; the prefix rule admits the loader
 * family's unnamed siblings without ending the floor's precision.
 */
function isDeferredExecutionVectorName(name: string): boolean {
	if (BASH_DEFERRED_EXECUTION_VARS.has(name)) return true;
	if (!name.startsWith(LD_LOADER_NAME_PREFIX)) return false;
	return !LD_INERT_LOADER_NAMES.has(name);
}

/**
 * A combined-flag token carrying -c, glued-value forms included:
 * bash takes a short option's cluster remainder as the value, so
 * -cpayload, -c'payload', and -c"payload" all arrive as one argument
 * token whose text continues past the flag (bash -lc matches; so does
 * -cu, an inert-junk over-ask accepted fail-safe).
 */
const bashExecutorFlag = /^-[a-zA-Z]*c/;

/** su's long-form command flag spellings: --command VALUE and --command=VALUE carry the payload exactly as the short -c does. */
const bashSuLongCommandFlag = /^(--command|--command=.+)$/;

/** Short-cluster payload-flag test for one interpreter identity's flag characters: the cluster form -xflag matches glued spellings (-c'code') exactly as bashExecutorFlag does for the shells. */
function interpreterPayloadFlagTests(chars: string, longForms: RegExp[] = []): readonly RegExp[] {
	return [new RegExp(`^-[a-zA-Z]*[${chars}]`), ...longForms];
}

/**
 * The payload-carrying interpreters (unit PISCOPE-2-3's routed
 * closure): each carries executable strings through a flag whose
 * argument the interpreter evaluates in its own language, so the
 * payload gates through the same executor machinery as the shells.
 * python -c, node -e/-p and --eval, perl -e, ruby -e, php -r,
 * Rscript -e, osascript -e, lua -e.
 */
const INTERPRETER_PAYLOAD_FLAG_TESTS: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
	python: interpreterPayloadFlagTests("c"),
	python2: interpreterPayloadFlagTests("c"),
	python3: interpreterPayloadFlagTests("c"),
	node: interpreterPayloadFlagTests("ep", [/^(--eval|--eval=.+)$/]),
	nodejs: interpreterPayloadFlagTests("ep", [/^(--eval|--eval=.+)$/]),
	perl: interpreterPayloadFlagTests("e"),
	ruby: interpreterPayloadFlagTests("e"),
	php: interpreterPayloadFlagTests("r"),
	Rscript: interpreterPayloadFlagTests("e"),
	osascript: interpreterPayloadFlagTests("e"),
	lua: interpreterPayloadFlagTests("e"),
});

/**
 * Raw-text carriers of expansion the SHELL-flavored executor shapes
 * re-evaluate: $ forms and backticks anywhere in the raw command. An
 * interpreter payload is code in the interpreter's language, not
 * shell text, so its dollars and backticks re-evaluate as code, not
 * as shell expansion; the bias stays keyed to the shell flavor.
 */
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

/**
 * Interpreter identities whose script-flag payload text the interpreter
 * itself re-evaluates (EXT-37 provenance): the payload's path-like words
 * label as interpreter payload so the ask reason says the path came from
 * node -e / python -c / perl -e script text. Label-only recognition: the
 * payload pieces extract through the generic argument-piece posture
 * unchanged, so the recognized shape changes no verdict, only the
 * reason's wording.
 */
const INTERPRETER_PAYLOAD_HEADS: ReadonlySet<string> = new Set(["node", "python", "python3", "perl"]);

/** Sed's script-carrying flags provenance phrase (the -f/--file value is a real file reference). */
const SED_SCRIPT_FILE_POSITION = "a sed script-file flag value";

interface ScanAccumulator {
	substitution: boolean;
	executor: boolean;
	/** True when an executor shape of the SHELL flavor fired: its payload is shell text and joins the raw-dollar bias. Interpreter-flavored payloads are code, not shell text. */
	executorShellText: boolean;
	interposed: string | null;
	bail: boolean;
	envVector: string | null;
	envVectorPosture: "assignment" | "env spelling" | null;
	cdAsk: string | null;
	operands: string[];
	operandPositions: Record<string, string>;
	substitutionKinds: string[];
	seen: Set<string>;
}

interface ArgumentToken {
	node: BashSyntaxNode;
	text: string;
	pieces: string[];
}

function pushOperand(acc: ScanAccumulator, operand: string, position: string): void {
	if (!acc.seen.has(operand)) {
		acc.seen.add(operand);
		acc.operands.push(operand);
		acc.operandPositions[operand] = position;
	}
}

/** Record one substitution kind for the bias ask, deduped in first-seen order. */
function recordSubstitutionKind(acc: ScanAccumulator, kind: string): void {
	if (!acc.substitutionKinds.includes(kind)) acc.substitutionKinds.push(kind);
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
 * there), a string strips its double quotes, a translated string
 * strips its $" marker and reads as its plain double-quoted twin (no
 * translation installed means the text passes through unchanged),
 * and a concatenation joins its parts. This text drives identity,
 * flag, and cd matching.
 */
function processedTextOf(node: BashSyntaxNode): string {
	switch (node.type) {
		case "word":
			return unescapeBashText(node.text);
		case "raw_string":
			return node.text.slice(1, -1);
		case "string":
			return node.text.slice(1, -1);
		case "translated_string":
			return node.text.slice(2, -1);
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
		case "translated_string": {
			const inner = node.text.slice(2, -1);
			return inner
				.split(bashWhitespaceSplit)
				.filter((piece) => piece.length > 0)
				.map(unescapeBashText);
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

/**
 * Match one token text as an interpreter's script-carrying flag: -e for
 * node and perl, -c for python and python3, --eval for node. Returns the
 * flag spelling for the provenance phrase plus the glued payload
 * remainder when the script rides the flag token itself (bash's
 * short-option cluster rule: letters after the value-taking letter are
 * its value, and --eval= glues the same way); null when the flag is
 * separated from its payload, and null overall when the text is not that
 * identity's flag at all.
 */
function interpreterScriptFlag(identity: string, text: string): { spelling: string; gluedRemainder: string | null } | null {
	if (text.startsWith("--")) {
		if (identity !== "node") return null;
		const match = /^--eval(?:=(.*))?$/.exec(text);
		return match === null ? null : { spelling: "--eval", gluedRemainder: match[1] ?? null };
	}
	const flagLetter =
		identity === "python" || identity === "python3"
			? "c"
			: identity === "node" || identity === "perl"
				? "e"
				: null;
	if (flagLetter === null) return null;
	const match = /^-([a-z]*?)([ec])([\s\S]*)$/.exec(text);
	if (match === null || match[2] !== flagLetter) return null;
	return {
		spelling: `-${match[2]}`,
		gluedRemainder: match[3].length > 0 ? match[3] : null,
	};
}

/**
 * The interpreter-payload provenance per argument-token index: for each
 * interpreter identity in the token stream, the first script flag after
 * it locates the payload argument (the flag's own token when glued, the
 * next token when separated), and that argument's pieces label as the
 * interpreter payload. Position-independent over the stream, the same
 * posture executor detection uses, so a prefixed spelling labels exactly
 * as the bare one does. Interpreter labels take precedence over the
 * executor phrase: the interpreter posture relabels its payload
 * argument more precisely than the executor floor's generic phrase,
 * which covers the command's remaining arguments only when no
 * interpreter label exists.
 */
function interpreterPayloadLabels(tokenTexts: string[]): Map<number, string> {
	const labels = new Map<number, string>();
	for (let i = 0; i < tokenTexts.length; i++) {
		const identity = bashExecutorTokenIdentity(tokenTexts[i]);
		if (!INTERPRETER_PAYLOAD_HEADS.has(identity)) continue;
		for (let j = i + 1; j < tokenTexts.length; j++) {
			const match = interpreterScriptFlag(identity, tokenTexts[j]);
			if (match === null) continue;
			// tokenTexts[0] is the command name, so argument-token index is
			// token index minus one: a glued payload labels the flag's own
			// argument token, a separated payload labels the next one. A
			// separated flag with no following token labels nothing.
			const payloadArgIndex = match.gluedRemainder !== null ? j - 1 : j;
			if (payloadArgIndex >= 0 && payloadArgIndex < tokenTexts.length - 1) {
				labels.set(payloadArgIndex, `the ${identity} ${match.spelling} script payload`);
			}
			return labels;
		}
	}
	return labels;
}

/**
 * The executor-payload provenance phrase: the first executor shape in
 * the token stream, spelled as the invocation it is (a shell or su with
 * its -c flag, bare ssh, or eval), mirroring
 * tokensCarryExecutorShape's scan order. The trailing fallback is
 * reachable for executor postures the named shapes do not spell (a
 * su --command payload); it keeps the phrase total there.
 */
function executorPayloadLabel(tokenTexts: string[]): string {
	for (let index = 0; index < tokenTexts.length; index++) {
		const identity = bashExecutorTokenIdentity(tokenTexts[index]);
		if (identity === "eval") return "the eval payload";
		if (identity === "ssh") return "the ssh payload";
		if (BASH_EXECUTOR_SHELLS.has(identity) || identity === "su") {
			for (let next = index + 1; next < tokenTexts.length; next++) {
				if (bashExecutorFlag.test(tokenTexts[next])) return `the ${identity} -c payload`;
			}
		}
	}
	return "the executor payload";
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
 * command line its arguments join, and the interpreters read stdin as
 * their script when given no script argument. exec is not carried
 * here: its membership is argument-sensitive and lives in
 * commandCarriesStdinScriptIdentity.
 */
const STDIN_SCRIPT_IDENTITIES: ReadonlySet<string> = new Set([
	...BASH_EXECUTOR_SHELLS,
	"su",
	"ssh",
	"eval",
	...Object.keys(INTERPRETER_PAYLOAD_FLAG_TESTS),
]);

/**
 * The default provenance phrase: an operand whose extraction position no
 * caller named (the generic argument-shape fallback and scan injections
 * without provenance) reads as the plain argument posture.
 */
const ARGUMENT_POSITION = "a command argument";

/**
 * Push the path-like words of one stdin-script text (a heredoc body
 * or a here-string value handed to such a consumer) as operands,
 * deduped in walk order, naming the seam's activating consumer (the
 * position-independent seam's first stdin-script identity, head or
 * not; EXT-37: the seam source is the trigger provenance).
 */
function pushStdinScriptPieces(text: string, acc: ScanAccumulator, position: string): void {
	for (const piece of executorPayloadPieces(text)) {
		if (isPathLikeBashWord(piece)) pushOperand(acc, piece, position);
	}
}

/**
 * Consume one seam-active stdin-script text (a heredoc body or a
 * here-string value): raw dollars or backticks bias to substitution
 * (the executor corner's backstop, the kind named for the ask's
 * expansion kinds), otherwise the path-like words extract as operands
 * named by the position string (EXT-37: the seam source is the
 * trigger provenance). Already-flagged substitution short-circuits so
 * extraction never runs behind an ask the walk has already raised.
 */
function consumeStdinScriptText(text: string, acc: ScanAccumulator, position: string): void {
	if (acc.substitution) return;
	if (bashSubstitutionChars.test(text)) {
		acc.substitution = true;
		recordSubstitutionKind(acc, STDIN_SCRIPT_DOLLAR_KIND);
	} else {
		pushStdinScriptPieces(text, acc, position);
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
		const kind = EXPANSION_KIND_NAMES[node.type];
		if (kind !== undefined) recordSubstitutionKind(acc, kind);
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
	if (name !== null && isDeferredExecutionVectorName(name)) {
		acc.envVector = name;
		acc.envVectorPosture = "assignment";
	}
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
		if (isPathLikeBashWord(value)) pushOperand(acc, value, "a variable-assignment value");
		const eq = value.indexOf("=");
		if (eq > 0) {
			const tail = value.slice(eq + 1);
			if (isPathLikeBashWord(tail)) pushOperand(acc, tail, "a variable-assignment value");
		}
	}
}

/**
 * Whether a token text carries an executor shape, mirroring the
 * lexical scanner's segment rule over one command node's tokens: an
 * eval or ssh identity anywhere, a shell/su identity followed
 * anywhere later by a -c-carrying flag (su's long --command forms
 * included), or an interpreter identity followed anywhere later by
 * its payload flag. The shell boolean distinguishes the flavors: a
 * shell-flavored payload is shell text whose raw dollars and
 * backticks re-evaluate, while an interpreter payload is code in the
 * interpreter's language and does not join the raw-text bias.
 */
function executorShapeInTokens(tokens: string[]): { any: boolean; shell: boolean } {
	let any = false;
	let shell = false;
	for (let index = 0; index < tokens.length; index++) {
		const identity = bashExecutorTokenIdentity(tokens[index]);
		if (identity === "eval" || identity === "ssh") {
			any = true;
			shell = true;
			continue;
		}
		const shellLike = BASH_EXECUTOR_SHELLS.has(identity) || identity === "su";
		const interpreterFlags = INTERPRETER_PAYLOAD_FLAG_TESTS[identity];
		if (!shellLike && !interpreterFlags) continue;
		let flagged = false;
		for (let next = index + 1; next < tokens.length; next++) {
			if (shellLike && (bashExecutorFlag.test(tokens[next]) || (identity === "su" && bashSuLongCommandFlag.test(tokens[next])))) {
				flagged = true;
				break;
			}
			if (interpreterFlags && interpreterFlags.some((test) => test.test(tokens[next]))) {
				flagged = true;
				break;
			}
		}
		if (flagged) {
			any = true;
			if (shellLike) shell = true;
		}
	}
	return { any, shell };
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
function sedArgRoles(argTokens: ArgumentToken[]): { extract: boolean; extraPieces: string[]; position: string | null }[] {
	const roles = argTokens.map(() => ({ extract: true, extraPieces: [] as string[], position: null as string | null }));
	let explicitScript = false;
	let scriptPositionalSkipped = false;
	let endOfFlags = false;
	let pending: "script" | "script-file" | null = null;
	for (let i = 0; i < argTokens.length; i++) {
		const text = argTokens[i].text;
		if (pending !== null) {
			roles[i].extract = pending === "script-file";
			if (pending === "script-file") roles[i].position = SED_SCRIPT_FILE_POSITION;
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
			pushOperand(acc, target, "the cd/pushd target");
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
 * condition is the name, not the value. The stdin-script seam state
 * joins the command's own identity with the pipeline-level seam the
 * walk passes in (seamFeeds): a here-string attached to this command
 * feeds a script consumer elsewhere in the pipeline, so its value is
 * script text wherever it actually lands, and extracts with the
 * raw-dollar backstop exactly as an own-identity value does.
 */
function handleCommand(node: BashSyntaxNode, acc: ScanAccumulator, source: string, seamFeeds: string | null = null): void {
	const nameText = commandNameText(node);
	const identity = bashExecutorTokenIdentity(nameText);
	const argTokens: ArgumentToken[] = [];
	const assignments: BashSyntaxNode[] = [];
	const herestrings: BashSyntaxNode[] = [];
	const seamIdentity = seamFeeds ?? commandCarriesStdinScriptIdentity(node);
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
			if (seamIdentity !== null) herestrings.push(child);
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
			if (name !== null && isDeferredExecutionVectorName(name)) {
				if (acc.envVector === null) {
					acc.envVector = name;
					acc.envVectorPosture = "env spelling";
				}
				break;
			}
		}
	}

	// Executor detection is position-independent over the command's
	// full token stream, the same look the interposed check uses: an
	// eval/ssh identity, a shell/su identity followed by a -c or su
	// long --command flag, or an interpreter identity followed by its
	// payload flag anywhere in the stream sets the executor flag, so a
	// payload under a non-vocabulary prefix (sudo bash -c, watch bash
	// -c, exec sh -c, env python3 -c) re-splits and gates exactly as
	// the bare spelling does. The shell flavor rides separately: only
	// a shell-flavored payload is shell text whose raw dollars join
	// the substitution bias.
	const executorShape = executorShapeInTokens(tokenTexts);
	if (executorShape.any) acc.executor = true;
	if (executorShape.shell) acc.executorShellText = true;

	for (let index = 0; index < tokenTexts.length; index++) {
		if (!BASH_INTERPOSER_WORDS.has(bashExecutorTokenIdentity(tokenTexts[index]))) continue;
		if (executorShapeInTokens(tokenTexts.slice(index + 1)).any) {
			if (acc.interposed === null) acc.interposed = tokenTexts[index];
			break;
		}
	}

	if (acc.substitution) return;

	if (acc.executor) {
		for (const token of argTokens) token.pieces = executorPayloadPieces(token.node.text);
	}
	const interpreterLabels = interpreterPayloadLabels(tokenTexts);
	const executorLabel = acc.executor && interpreterLabels.size === 0 ? executorPayloadLabel(tokenTexts) : null;
	for (const herestring of herestrings) {
		for (let i = 0; i < herestring.childCount; i++) {
			const value = herestring.child(i);
			if (value && ARG_NODE_TYPES.has(value.type)) {
				consumeStdinScriptText(value.text, acc, `a here-string fed to ${seamIdentity} as its stdin script`);
			}
		}
	}

	const cdPieces = [nameText, ...argTokens.flatMap((token) => token.pieces)];
	detectCdTarget(cdPieces, acc);

	const roles = identity === "sed" ? sedArgRoles(argTokens) : null;
	for (let i = 0; i < argTokens.length; i++) {
		if (roles && !roles[i].extract) {
			for (const piece of roles[i].extraPieces) pushOperand(acc, piece, SED_SCRIPT_FILE_POSITION);
			continue;
		}
		const position =
			(roles !== null && roles[i].position !== null ? roles[i].position : null)
			?? (interpreterLabels.has(i) ? interpreterLabels.get(i) : null)
			?? executorLabel
			?? ARGUMENT_POSITION;
		for (const piece of argTokens[i].pieces) {
			if (isPathLikeBashWord(piece)) pushOperand(acc, piece, position);
			const eq = piece.indexOf("=");
			if (eq > 0) {
				const value = piece.slice(eq + 1);
				if (isPathLikeBashWord(value)) pushOperand(acc, value, position);
			}
		}
	}
	for (const assignment of assignments) scanAssignment(assignment, acc, true);
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
			recordSubstitutionKind(acc, UNMODELED_REDIRECT_KIND);
			continue;
		}
		pushOperand(acc, processedTextOf(child), "a redirect destination");
	}
}

/**
 * The structured walk of one pipeline node: stages feed each other in
 * order, so a here-string attached to any stage puts value-derived
 * bytes on every later stage's stdin, and a script consumer anywhere
 * in the pipeline executes those bytes as its stdin script (review
 * 29: `cat <<< 'open("/etc/passwd")' | python3` passed while the
 * per-command seam check saw only cat's data posture). The pipeline
 * pre-scans its stages with the position-independent stream looks
 * (streamFindCarrier over commandCarriesHerestring and
 * commandCarriesStdinScriptIdentityGuarded, the identity look reading
 * the consumer's name off the found command): a
 * here-string on any stage plus a script identity on any stage
 * makes every here-string under the pipeline ride the seam, so the
 * value extracts as script pieces with the raw-dollar backstop
 * wherever it actually lands, and the ask reasons name the pipeline's
 * script consumer. A pipeline carrying no here-string
 * walks exactly as the generic descent did, and a heredoc never
 * appears inside a pipeline stage (the grammar hangs heredocs under
 * redirected_statement), so heredoc postures are unaffected here.
 */
function handlePipeline(node: BashSyntaxNode, acc: ScanAccumulator, source: string, seamFeeds: string | null): void {
	let herestringSeen = false;
	let consumerIdentity: string | null = null;
	for (let i = 0; i < node.childCount; i++) {
		const stage = node.child(i);
		if (!stage) continue;
		if (streamFindCarrier(stage, commandCarriesHerestring) !== null) herestringSeen = true;
		if (consumerIdentity === null) {
			const bearer = streamFindCarrier(stage, commandCarriesStdinScriptIdentityGuarded);
			if (bearer !== null) consumerIdentity = commandCarriesStdinScriptIdentity(bearer);
		}
	}
	const pipelineSeam = seamFeeds ?? (herestringSeen && consumerIdentity !== null ? consumerIdentity : null);
	for (let i = 0; i < node.childCount; i++) {
		const stage = node.child(i);
		if (!stage) continue;
		if (stage.type === "command") handleCommand(stage, acc, source, pipelineSeam);
		else walkNode(stage, acc, source, pipelineSeam);
	}
}

/**
 * The stdin-script identity one command node's token stream carries,
 * or null when none: the shell family, su, ssh, eval, or an
 * interpreter identity anywhere among the name and argument tokens (a
 * quoted or path-qualified spelling strips to its identity first),
 * the same position-independent posture executor detection uses. The
 * first identity found is the seam's activating consumer, the name the
 * ask reasons carry. exec is argument-sensitive: it counts only when
 * no argument names a program (every non-flag, non-interposer argument
 * would be the program exec replaces the process with), so `exec <<
 * EOF` with a trailing shell activates the seam while `exec ls << EOF`
 * keeps the heredoc as data. A statement that merely mentions a shell
 * word among its arguments therefore over-asks (fail-safe), the
 * disclosed tradeoff of the position-independent posture.
 */
function commandCarriesStdinScriptIdentity(command: BashSyntaxNode): string | null {
	const tokens = [commandNameText(command)];
	for (let i = 0; i < command.childCount; i++) {
		const child = command.child(i);
		if (child && ARG_NODE_TYPES.has(child.type)) tokens.push(processedTextOf(child));
	}
	let execSeen = false;
	for (const token of tokens) {
		const identity = bashExecutorTokenIdentity(token);
		if (STDIN_SCRIPT_IDENTITIES.has(identity)) return identity;
		if (identity === "exec") execSeen = true;
		if (BASH_INTERPOSER_WORDS.has(identity) || token.startsWith("-")) continue;
		if (execSeen) return null;
	}
	return execSeen ? "exec" : null;
}

/**
 * Whether one stream node attaches a here-string redirect. The
 * child-type loop stays total over node types on purpose: command
 * attachment is the only spelling the vendored grammar emits today (a
 * here-string beside a compound parses as ERROR plus a file_redirect,
 * live-confirmed), a redirected_statement-level attachment is declared
 * in node-types but not emitted, and the predicate must still see the
 * declared shape the day a grammar upgrade starts producing it so the
 * pipeline seam arms for the redirected_statement branch that consumes
 * it; guarding the loop to commands would silence that detection.
 */
function commandCarriesHerestring(node: BashSyntaxNode): boolean {
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child && child.type === "herestring_redirect") return true;
	}
	return false;
}

function commandCarriesStdinScriptIdentityGuarded(node: BashSyntaxNode): boolean {
	return node.type === "command" && commandCarriesStdinScriptIdentity(node) !== null;
}

/**
 * The first stream node (a pipeline stage, compound heads included)
 * whose subtree carries the predicate, or null when none: the shared
 * descent behind the pipeline seam's two position-independent looks, a
 * here-string attachment and a stdin-script identity. The identity
 * look reads the consumer's name off the found command node.
 */
function streamFindCarrier(node: BashSyntaxNode, carries: (node: BashSyntaxNode) => boolean): BashSyntaxNode | null {
	if (carries(node)) return node;
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) {
			const found = streamFindCarrier(child, carries);
			if (found !== null) return found;
		}
	}
	return null;
}

/**
 * The compound statement containers a redirected statement's body can
 * spell: descending into one from the direct consultation flips the
 * visit to every-statement-head mode, because the compound's stdin is
 * the statement's redirect input and its inner stream delivers that
 * input from its head.
 */
const COMPOUND_BEARER_TYPES: ReadonlySet<string> = new Set([
	"subshell",
	"compound_statement",
	"list",
]);

/**
 * The stdin-script identity a redirected statement's stdin feeds, or
 * null when none: any command in the statement (compound and grouped
 * heads included, wrappers and their arguments looked through)
 * carrying a stdin-script identity, or the pipeline rule naming one.
 * The direct pipeline rule reads a pipeline child's LAST stage because
 * a statement's stdin feeds the redirect-bearing stage (`cat x | bash
 * << EOF` runs bash on the body, `bash | cat << EOF` feeds the body
 * to cat as data). A compound bearer inverts that rule: the grammar
 * hangs the redirect beside a subshell or brace group
 * (redirected_statement with a compound body), the compound's stdin
 * is the body, and its inner
 * pipeline delivers the body to its FIRST stage, whose output feeds
 * the later stages. Descending into a compound bearer therefore
 * flips the consultation to every statement-head inside it,
 * recursively through nesting and through AND-lists, and to every
 * stage of any pipeline inside (`(python3 | cat) << 'EOF'` executes
 * the body in python3, the review 32 finding; the direct read alone
 * consulted only cat). Sequential statements after the body's first
 * consumer over-ask under the flip (they never see the body), the
 * same disclosed tradeoff as the mention over-ask. A pipeline hanging
 * INSIDE a heredoc_redirect is the opposite posture: every stage
 * after the heredoc-bearing one receives bytes derived from the body
 * (the bearing stage forwards or transforms it), so the embedded walk
 * consults EVERY stage of the hung pipeline, and any script-consumer
 * stage means the body executes there (`cat << EOF | python3 | cat`
 * runs the body in python3, the review 29 finding). The grammar
 * nests the hung continuation as a pipeline inside a pipeline, and
 * the walk descends both levels stage by stage. Activation is the
 * position-independent posture (review 25 DC-1, advisor memo 27
 * condition 1): the seam no longer depends on which command name the
 * statement head names, so sudo, doas, and every other non-vocabulary
 * prefix before a shell gates the body.
 */
function statementActivatesStdinScriptSeam(node: BashSyntaxNode, heredocRedirects: BashSyntaxNode[]): string | null {
	let found: string | null = null;
	const visit = (current: BashSyntaxNode, embedded: boolean): void => {
		if (found !== null) return;
		if (current.type === "command") {
			const identity = commandCarriesStdinScriptIdentity(current);
			if (identity !== null) found = identity;
			return;
		}
		if (current.type === "pipeline") {
			if (embedded) {
				for (let i = 0; i < current.childCount; i++) {
					const stage = current.child(i);
					if (stage) visit(stage, true);
				}
			} else {
				const last = current.child(current.childCount - 1);
				if (last) visit(last, COMPOUND_BEARER_TYPES.has(last.type));
			}
			return;
		}
		for (let i = 0; i < current.childCount; i++) {
			const child = current.child(i);
			if (child && child.type !== "heredoc_redirect") {
				visit(child, embedded || COMPOUND_BEARER_TYPES.has(child.type));
			}
		}
	};
	visit(node, false);
	if (found !== null) return found;
	for (const redirect of heredocRedirects) {
		for (let i = 0; i < redirect.childCount && found === null; i++) {
			const child = redirect.child(i);
			if (child) visit(child, true);
		}
	}
	return found;
}

/**
 * One redirected_statement: the grammar hangs the command (or the
 * compound bearer), the attached redirect operators, and the heredoc
 * under this wrapper, so this handler walks every child in grammar
 * order (the file_redirect targets still extract per the GPS quirk
 * correction) and adds the stdin-script seam: when the statement's
 * command stream feeds a script consumer (statementActivatesStdinScriptSeam:
 * any stdin-script identity in the stream, the statement pipeline's
 * last stage owning the statement's stdin, every statement-head
 * inside a compound bearer because the compound's stdin is the body,
 * every stage of a heredoc-embedded continuation pipeline consulted
 * because each receives body-derived bytes), every heredoc body under
 * the statement is that consumer's script text and its path-like
 * words extract as operands, exactly as executor payload words do,
 * and a body whose raw text carries a $ or backtick biases to
 * substitution (the executor corner's backstop: a quoted delimiter
 * makes the body literal to the grammar while the child shell still
 * expands it). Heredoc bodies gate on the statement's own seam only:
 * the heredoc replaces the statement's stdin, so pipeline-fed bytes
 * never reach it and an upstream seam never makes one script text.
 * A here-string attached at the redirected-statement level joins the
 * same vocabulary under the statement seam OR the pipeline seam the
 * walk passes in (seamFeeds): the value is script text wherever a
 * consumer executes it, and the compound-wrapped spellings that
 * forward it downstream are exactly the pipeline-seam case. The
 * vendored grammar currently errors on every compound-attached
 * here-string spelling (ERROR plus a file_redirect over the value,
 * which bails fail-safe), so the branch is drift defense for the
 * attachment the node-types declare; a data consumer's redirect
 * payloads contribute nothing (they are data), and an interpolating
 * payload under substitution stays behind the substitution ask with
 * operands empty.
 */
function handleRedirectedStatement(node: BashSyntaxNode, acc: ScanAccumulator, source: string, seamFeeds: string | null = null): void {
	const heredocRedirects: BashSyntaxNode[] = [];
	const herestringRedirects: BashSyntaxNode[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		if (child.type === "heredoc_redirect") {
			heredocRedirects.push(child);
			continue;
		}
		if (child.type === "herestring_redirect") {
			herestringRedirects.push(child);
			continue;
		}
		walkNode(child, acc, source, seamFeeds);
	}
	const statementSeam = statementActivatesStdinScriptSeam(node, heredocRedirects);
	if (statementSeam !== null) {
		for (const redirect of heredocRedirects) {
			for (let i = 0; i < redirect.childCount; i++) {
				const child = redirect.child(i);
				if (!child) continue;
				if (child.type === "heredoc_body") {
					consumeStdinScriptText(child.text, acc, `a heredoc body fed to ${statementSeam} as its stdin script`);
				} else {
					walkNode(child, acc, source);
				}
			}
		}
	} else {
		for (const redirect of heredocRedirects) walkNode(redirect, acc, source);
	}
	if (statementSeam !== null || seamFeeds !== null) {
		const origin = statementSeam ?? seamFeeds;
		for (const redirect of herestringRedirects) {
			for (let i = 0; i < redirect.childCount; i++) {
				const value = redirect.child(i);
				if (value && ARG_NODE_TYPES.has(value.type)) {
					consumeStdinScriptText(value.text, acc, `a here-string fed to ${origin} as its stdin script`);
				}
			}
		}
	} else {
		for (const redirect of herestringRedirects) walkNode(redirect, acc, source);
	}
}

function walkNode(node: BashSyntaxNode, acc: ScanAccumulator, source: string, seamFeeds: string | null = null): void {
	if (SKIP_SUBTREE_TYPES.has(node.type)) return;
	if (node.type === "heredoc_body") return;
	if (node.type === "redirected_statement") {
		handleRedirectedStatement(node, acc, source, seamFeeds);
		return;
	}
	if (node.type === "file_redirect") {
		handleFileRedirect(node, acc);
		return;
	}
	if (node.type === "command") {
		handleCommand(node, acc, source, seamFeeds);
		return;
	}
	if (node.type === "pipeline") {
		handlePipeline(node, acc, source, seamFeeds);
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
			if (isPathLikeBashWord(piece)) pushOperand(acc, piece, ARGUMENT_POSITION);
		}
		return;
	}
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) walkNode(child, acc, source, seamFeeds);
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
 * substitution (with the expansion kinds behind the flag), executor,
 * interposition, the execution-vector name and posture, operands with
 * their extraction-position provenance, and cdAsk, then the assembly
 * mirrors the lexical scanner's decision order: interposition first; then the substitution flag,
 * authoritative in every corner (the position-blind traversal flagged
 * the tree, and no assembly branch may erase what it saw - the
 * executor carve-out this ordering once carried silently allowed an
 * executor command with a dollar-free process substitution while the
 * substitution's inner command ran); then the executor raw-text
 * dollar test for the node-invisible payload dollars a quoted string
 * carries (the raw text is not an expansion node, but a child shell
 * re-evaluates its payload - the test is shell-flavored: an
 * interpreter payload is code, not shell text, and does not bias),
 * with the seam's own backstop already
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
			executorShellText: false,
			interposed: null,
			bail: rootNode.hasError,
			envVector: null,
			envVectorPosture: null,
			cdAsk: null,
			operands: [],
			operandPositions: {},
			substitutionKinds: [],
			seen: new Set<string>(),
		};
		flagEveryExpansion(rootNode, acc);
		walkNode(rootNode, acc, command);
		if (acc.interposed !== null) {
			return withProvenance(acc, { substitution: acc.substitution, executor: acc.executor, bail: acc.bail, envVector: acc.envVector, envVectorPosture: acc.envVectorPosture, cdAsk: null, operands: [], interposed: acc.interposed });
		}
		if (acc.substitution) {
			return withProvenance(acc, { substitution: true, executor: false, bail: true, envVector: acc.envVector, envVectorPosture: acc.envVectorPosture, cdAsk: null, operands: [], interposed: null });
		}
		if (acc.executor && acc.executorShellText && bashSubstitutionChars.test(command)) {
			recordSubstitutionKind(acc, EXECUTOR_PAYLOAD_DOLLAR_KIND);
			return withProvenance(acc, { substitution: true, executor: false, bail: true, envVector: acc.envVector, envVectorPosture: acc.envVectorPosture, cdAsk: null, operands: [], interposed: null });
		}
		return withProvenance(acc, { substitution: false, executor: acc.executor, bail: acc.bail, envVector: acc.envVector, envVectorPosture: acc.envVectorPosture, cdAsk: acc.cdAsk, operands: acc.operands, interposed: null });
	});
}

/**
 * Merge the provenance record into one return shape: every BashScanResult
 * the walk produces carries the operand provenance, the substitution
 * kinds, and the vector posture the accumulation saw, so the consumer's
 * reasons name the trigger class on every branch.
 */
function withProvenance(
	acc: ScanAccumulator,
	shape: Omit<BashScanResult, "operandPositions" | "substitutionKinds">,
): BashScanResult {
	return { ...shape, operandPositions: acc.operandPositions, substitutionKinds: acc.substitutionKinds };
}
