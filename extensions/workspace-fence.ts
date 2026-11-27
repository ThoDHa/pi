/**
 * workspace-fence extension
 *
 * The user's file-access policy as a pi extension: a session may touch
 * its working-directory subtree, the os.tmpdir() subtree, and the extra
 * roots unioned from the tracked workspace-fence.config.json, the
 * optional untracked workspace-fence.local.json overlay, and the
 * PISCOPE_EXTRA_ROOTS entries without prompting; every other directory
 * requires an interactive permission ASK, never a silent denial. The
 * module carries both halves: resolveScopeTarget and its helpers are
 * the pure decision core (resolving a raw tool-input path to an
 * allow/ask verdict, plus the load-time release seal deciding whether
 * those verdicts are trustworthy this session), and the default export
 * wires the verdict into pi's tool_call event.
 *
 * Wiring: the factory registers one tool_call handler over the six
 * path-bearing tools (read, write, edit, grep, find, ls), gating the
 * `path` input field. In-scope verdicts pass through untouched and
 * prompt nothing. An out-of-scope verdict in a UI session (ctx.hasUI)
 * asks via ctx.ui.select Yes/No, the permission-gate precedent; any
 * answer other than Yes blocks with a reason naming the tool, the
 * resolved path, and the policy, and every ask reason names its
 * trigger class (EXT-37): the bash pass renders each operand's
 * extraction position, the substitution bias's expansion kinds, and
 * the env-vector floor's posture into the detail the prompt, the
 * refusal, and the forwarded ask evidence carry. A headless session
 * (hasUI false)
 * blocks fail-closed with the same actionable reason plus the remedy
 * to run pi interactively, with one exception: a dispatched child
 * carrying ask-channel provisioning forwards the ask to its parent
 * session through the fence-ask channel instead (unit FENCE-1-3),
 * bounded by the locked wait bound, and applies a grant to its own
 * verdicts on approval while every other outcome blocks fail-closed.
 * A degraded seal rides the same path: every path-bearing verdict
 * asks or blocks per the core's degradation semantics, and a degraded
 * ask carries no escaping candidate, so a degraded headless child
 * blocks without forwarding (seal degradation must never manufacture
 * channel evidence). grep and find carry an optional search path that their
 * tools default to ".": the gate mirrors that default instead of
 * asking. The glob and pattern fields are in-scope metadata: ripgrep
 * roots --glob at the search directory and find globs within
 * searchPath, so that text filters inside the already-resolved
 * directory and cannot name an access point outside it. The handler
 * also covers bash through an AST-backed detection layer
 * (extensions/fence-ast/bash-scan.ts, unit PISCOPE-2-2 of PISCOPE-2):
 * the command parses through the vendored tree-sitter-bash grammar
 * (fence-ast, whose artifacts verify against their recorded digest
 * pins before any vendored byte loads, through a memoized loader with
 * a bounded init budget and reject-and-retry semantics), and the walk
 * reads the tree instead of modeling quote grammar. Substitution is
 * the presence of an expansion node ($, ${}, $(), $(( )), backticks,
 * process substitution, the ANSI-C $'...' form), so quoting stops
 * being a guess: cat "/etc/passwd" asks exactly as cat /etc/passwd
 * does, an escaped quote cannot hide a substitution
 * (echo \' && cat "$HOME/secrets" asks, while echo \' alone passes),
 * an escaped dollar is literal, and single quotes are inert because
 * bash provably cannot expand inside them. Operands extract from
 * argument pieces (a quoted multi-word payload splits into pieces, so
 * a path named inside quoted prose gates), from file_redirect
 * destinations wherever they sit (a segment-head redirect cannot pass
 * as a would-be executable; a redirect attached to a heredoc
 * statement still extracts, the tree-quirk correction), from a
 * prefix variable_assignment's value (a lone assignment only sets a
 * variable and opens nothing), and from cd/pushd targets regardless
 * of spelling, while a bare cd, cd -, or an option-only cd asks:
 * home, OLDPWD, and the directory stack are shell state. A mid-word
 * backslash-newline continuation joins exactly as bash joins it (the
 * grammar splits the word; the walk re-joins it when the backslash
 * abuts the word). Data-null and process-internal devices (/dev/null,
 * /dev/zero, /dev/stdin, /dev/stdout, /dev/stderr, /dev/fd/N) stay
 * exempt from bash operand verdicts only, never from the path tools,
 * and /dev/tty stays gated because it reads user input. Executor
 * shapes are command_name identity (a bash/zsh/sh/dash/ksh, su, or
 * ssh token whose directory prefix strips away lexically; no
 * filesystem resolution, so a missing path still gates) followed by
 * a -c-carrying flag, glued forms included, or the exact token eval;
 * a command/env/nohup/nice/timeout/exec wrapper preceding an executor
 * shape in one command floors the call to ask, because the wrapper
 * re-executes its arguments. A quoted prose mention of bash -c is
 * argument data, not the shell token, so it neither triggers nor
 * hides an executor shape, and an escaped quote cannot hide one
 * (echo \' ; bash -c 'cat "$HOME/secrets"' asks). Heredocs,
 * comments, grouping, and braces parse to verdicts (sanctioned
 * narrowing, Decision Log answer to Blocks Q3): a comment is inert,
 * a plain heredoc body names no operand, while an interpolating body
 * still asks (its expansion runs). The bail class is parse health: an
 * ERROR-bearing parse asks. Sed's script positional and expression-
 * flag values are structurally skipped (the pattern-first adaptation
 * of permission-gate's PATTERN_FIRST_COMMANDS, scoped to sed), which
 * closes the EXT-34 false-positive class: a sed range is an argument,
 * not a garbage absolute path, while real file operands after the
 * script keep gating. The bash decision is async at the handler seam
 * (the factory stays synchronous; the parser loads lazily on the
 * first gated bash call): parser unavailability, a digest mismatch,
 * or an expired init budget asks every bash call through the
 * decision boundary, never a silent allow and never a load failure of
 * the extension itself. Extracted operands resolve through
 * resolveScopeTarget with the same allowlist and the same degraded-
 * seal posture. In-scope and
 * relative-only commands run unprompted.
 * powershell stays ungated: the Windows twin is a deferred unit.
 *
 * Residuals inherited knowingly: the verdict inspects the filesystem
 * at interception time while the tool's own open happens after it, so
 * a rename or symlink swap racing inside that window is not covered
 * (closing it needs OS-level sandboxing, not interception); the input
 * transforms are replicas of pi's own, trusted only under a clean
 * digest seal; and in RPC mode the select dialog round-trips an
 * extension_ui_request to the client and waits, so an unresponsive
 * client stalls the call. A stall never approves: only an explicit
 * Yes passes, and any other answer (or none) is the fail-closed
 * refusal. Composition adds one more: a path-mutating extension
 * loaded after this gate could rewrite event.input.path after this
 * gate's allow, because pi's composition contract runs later handlers
 * on mutations with no re-validation; nothing inside this module can
 * prevent it, the mitigation is load position or an upstream
 * post-handler validation hook, and no installed sibling mutates
 * input today.
 *
 * The bash pass parses with tree-sitter-bash since PISCOPE-2-2, and
 * its residual is stated here because it is the extension's only
 * shell-facing layer: the walk visits the positions where bash
 * materializes paths (argument tokens, assignment and declaration
 * values including array elements, redirect destinations, cd and
 * pushd targets) and extracts operands from the path-like text those
 * positions carry, while substitution reads as the presence of an
 * expansion node anywhere in the parsed tree - one position-blind
 * traversal with no skip list - so every position bash expands in
 * (command names included) asks. Expansion results, runtime-assembled paths, and output feeding a
 * later command stay invisible, and their presence asks; alias-,
 * function-, and PATH-resolution outcomes are equally invisible (an
 * alias hiding an invocation spelling is shell state the parse cannot
 * see). Spellings the extraction does not treat as operands stay
 * ungated where bash treats them as data, and the pattern-first skip
 * covers sed only: slash-carrying grep/rg/awk pattern arguments still
 * surface as operands and ask (over-ask direction) until their own
 * rows join the skip table. Executor and wrapper recognition remains a
 * modeled-shape list, not a proof:
 * invocation spellings outside the pinned classes may pass, the
 * pinned classes are the contract, and no closure beyond them is
 * claimed. The command's own executable (the leading word, absolute
 * or PATH-resolved) is not treated as a file operand: binary lookup is
 * outside the model, as it already is for every ungated bare command
 * name.
 *
 * Resolution generalizes the task-storage guard's hardened machinery
 * (lexical, kernel-style symlink-plus-dotdot, realpath, write-ahead
 * ancestor resolution) with the verdict inverted: the guard denies when
 * ANY candidate lands inside a protected tree; this gate asks unless
 * EVERY candidate lands inside an allowed root. Both directions are
 * fail-closed: input the core cannot prove usable (non-string, empty)
 * asks, never allows. One extension beyond the guard: when the
 * target's realpath fails because its final component is a dangling
 * symlink, the link is chased and the resolved target joins the
 * candidates, because the write tool creates THROUGH the final
 * symlink (dist/core/tools/write.js default writeFile flags), so the
 * create location is what must be in scope.
 *
 * Input normalization mirrors the base-changing transforms of pi's
 * own tool-side resolver (dist/core/tools/path-utils.js resolveToCwd
 * over dist/utils/paths.js normalizePath), in pi's order: replace the
 * unicode-space class (U+00A0, U+2000-U+200A, U+202F, U+205F, U+3000)
 * with ascii space, strip one leading "@", expand bare "~" and "~/",
 * then convert "^file://" URLs to paths via node:url's fileURLToPath.
 * All run before path.resolve; without them "@/etc/passwd" or
 * "file:///etc/passwd" would resolve somewhere other than where the
 * tool opens, and the boundary-name variant (a root whose own name
 * contains a unicode space) would let input spelled in the unicode
 * form match a root the tool never opens.
 *
 * Because the transforms are replicated rather than imported (they are
 * not public API and every import route is an unsupported seam), the
 * A5 load-time seal keeps replication honest: resolveRunningRelease
 * locates the running release through the managed install's
 * current-version pointer (or an argv walk), evaluateSealState reads
 * the transform-bearing dist files, compares SHA-256 digests against
 * RELEASE_DIGEST_PINS, and reports a degraded SealState on drift, an
 * unreadable file, or an unresolvable release. A degraded seal turns
 * every path-bearing verdict into an ask (UI sessions) or an
 * actionable block (headless) instead of trusting the replicas; it
 * never throws and never exits the process. The suite's DC-1 canary
 * independently pins the same digests and re-proves parity against
 * the release's own normalizers on every run, so any pi upgrade that
 * touches the transform surface fails loud and forces a re-pin.
 *
 * Extra roots arrive from three sources, and the verdict's allowed set
 * is their pure union (plus the session cwd and tmpdir, which no source
 * can remove): the tracked workspace-fence.config.json beside this
 * module carries the portable defaults; the optional untracked
 * workspace-fence.local.json beside it carries machine-dependent roots
 * the user keeps out of version control; the overlay is machine-local
 * config that shares this module's own trust level: whoever can write
 * it can already rewrite the module, so its threat model is the user's
 * own machine and no additional integrity boundary is claimed between
 * them; and PISCOPE_EXTRA_ROOTS is a
 * delimiter-separated (":" on POSIX) list of absolute paths children
 * inherit through the normal spawn environment chain. Config and
 * overlay share one strict flat shape, an object whose only known key
 * is "extraRoots", an array of path strings; unknown keys warn and are
 * skipped, never fatal. Config and overlay entries expand a leading
 * tilde (bare "~" and "~/" against the home directory, expandTilde)
 * before the absolute check, so the portable defaults are spelled
 * "~/.agents/skills" and "~/.pi/agent/install" and resolve per machine.
 * Every source stores each well-formed entry in BOTH forms, its
 * literal string and its realpath, so a symlinked declaration sanctions
 * access by either name. Malformed entries (non-string, relative after
 * expansion, unresolvable) are ignored with a console warning, never
 * fatal: an entry the session cannot prove strict drops out, which only
 * ever narrows the allowlist. The union is read lazily once per
 * process at the first gated verdict, memoized beside the seal
 * (fenceExtraRoots, reset by resetFenceExtraRoots), so a config edit or
 * env change mid-session needs a restart to apply.
 *
 * Unit 1-2 adds the runtime-grant producer side: an approved
 * out-of-scope ask records a parent-own grant into the fence-ask
 * ledger (recordParentOwnGrant at the interactive Yes branch), keyed
 * from the ask's escaping candidate per the fence-ask grant-key
 * contract. The subagent extension's spawn site composes those grants
 * into every dispatched child's PISCOPE_EXTRA_ROOTS, so a child's
 * starting scope is the parent's current granted scope; sibling
 * child-ask grants dedup at ask time and never compose silently.
 *
 * Unit 1-3 adds the runtime-grant consumer side for the child itself:
 * a provisioned headless child's out-of-scope ask forwards through
 * forwardHeadlessAsk (the fence-ask channel flow, keyed from the
 * verdict's escaping candidate by classifyGrantCandidate and
 * grantScopeDirectory), the approval applies to this child's own
 * verdicts through applyGrantToSelf into appliedSelfGrants, and the
 * factory's per-call allowed-roots build consumes that set via
 * childScopedAllowedRoots, so the granted directory admits from the
 * next verdict on. Denials, timeouts, and channel failures block
 * fail-closed with the flow's actionable reason. Residual at this
 * honor site (unit 1-4 truthing, review 17 DC-3): the honor path is
 * same-user-forgeable. A provisioned child holds the forwarding root
 * and its token in its env, and the tmpdir subtree hosting the root is
 * an always-allowed root, so a child, or prompt-injected code inside
 * it, can write both a request and a matching wire-valid decision and
 * this module will honor it with no user round-trip. The echo check is
 * an accident guard, not integrity; no integrity wall is claimed at
 * this boundary (the same-user wall is stated in the fence-ask module
 * headers and docs/workspace-fence.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_WAIT_ENV,
	MAX_REASON_LENGTH,
	grantScopeDirectory,
	resolveAskWaitMs,
} from "./fence-ask/ask-wire.ts";
import type { AskCandidateForm } from "./fence-ask/ask-wire.ts";
import { appliedSelfGrants, applyGrantToSelf, recordParentGrant } from "./fence-ask/grant-ledger.ts";
import { runBashScan } from "./fence-ast/bash-scan.ts";
import type { BashScanResult } from "./fence-ast/bash-scan.ts";
import { childProvisioningFromEnv, forwardOutOfScopeAsk } from "./fence-ask/ask-channel.ts";

/**
 * Environment variable carrying extra allowed roots, colon-separated
 * absolute paths parsed by parseExtraRoots.
 */
export const EXTRA_ROOTS_ENV = "PISCOPE_EXTRA_ROOTS";

/**
 * The tracked config file carrying the portable default extra roots,
 * read from the directory this module itself sits in.
 */
export const FENCE_CONFIG_FILE = "workspace-fence.config.json";

/**
 * The optional untracked overlay carrying machine-dependent extra
 * roots; its absence is the normal case and is tolerated silently.
 */
export const FENCE_LOCAL_CONFIG_FILE = "workspace-fence.local.json";

/**
 * The unicode-space characters pi's normalizeUnicodeSpaces replaces
 * with ascii space before any other transform; mirroring keeps input
 * spelled in the unicode form from matching a root the tool never
 * opens.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Verdict for one raw tool-input path: the lexically resolved path for
 * reason strings, the scope class ("allow" or "ask"), and a detail
 * naming the evidence (the escaping candidate for asks, the containing
 * root for allows).
 */
export interface ScopeVerdict {
	path: string;
	scope: "allow" | "ask";
	detail: string;
	/**
	 * The escaping candidate exactly as resolution surfaced it, on ask
	 * verdicts where a candidate exists (unit 1-2: the recorder keys the
	 * parent-own grant from it per the fence-ask grant-key contract).
	 * Absent on allow verdicts, degraded-seal asks (which precede any
	 * resolution, so no trustworthy candidate exists), and unusable-input
	 * asks.
	 */
	escapingCandidate?: string;
}

/**
 * Result of the load-time release seal: degraded is the ask-mode
 * decision for every path-bearing verdict, reasons carries the
 * actionable evidence for prompts and headless block reasons.
 */
export interface SealState {
	degraded: boolean;
	reasons: string[];
}

/**
 * Expand a leading tilde the way pi's path tools do: bare "~" to the
 * home directory, "~/" prefix to a home-anchored path. Mid-word tildes
 * and "~user" forms stay literal; pi does not expand those either.
 */
export function expandTilde(raw: string, home: string = os.homedir()): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
	return raw;
}

/**
 * Normalize a raw tool-input path the way pi's tools do before
 * resolving: replace unicode spaces with ascii space, strip one
 * leading "@", expand bare "~" and "~/", convert "^file://" URLs via
 * fileURLToPath, in that order. Returns null only when the input is a
 * file URL node itself rejects (invalid host or path encoding);
 * callers treat null as unusable and fail closed. The suite's canary
 * pins this replication against the installed release's normalizePath
 * on every run.
 */
export function normalizeToolInputPath(raw: string, home: string = os.homedir()): string | null {
	let normalized = raw.replace(UNICODE_SPACES, " ");
	normalized = normalized.startsWith("@") ? normalized.slice(1) : normalized;
	const tildeExpanded = expandTilde(normalized, home);
	if (tildeExpanded !== normalized) return tildeExpanded;
	if (/^file:\/\//.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			return null;
		}
	}
	return normalized;
}

/**
 * Lexically resolve a raw tool-input path against the session cwd,
 * normalizing pi-style first. Returns null for non-string, empty, or
 * unnormalizable input so callers can fail closed.
 */
export function lexicalResolvePath(
	sessionCwd: string,
	raw: unknown,
	home: string = os.homedir(),
): string | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	const normalized = normalizeToolInputPath(raw, home);
	if (normalized === null) return null;
	return path.resolve(sessionCwd, normalized);
}

/**
 * Resolve a raw path the way the kernel resolves it at open time:
 * component by component, applying ".." to the symlink-RESOLVED target
 * rather than to the raw name, after input normalization. This is the
 * resolution lexical resolve cannot see: a symlink followed by a
 * dot-dot segment diverges from path.resolve exactly here. Non-existing
 * tails continue lexically from the deepest resolved prefix, which is
 * where an open of such a path would fail or create. Normalization
 * runs first, so "@", tilde, and file:// forms resolve identically to
 * the tool's own absolutePath.
 */
export function kernelStyleResolve(
	sessionCwd: string,
	raw: unknown,
	home: string = os.homedir(),
): string | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	const normalized = normalizeToolInputPath(raw, home);
	if (normalized === null) return null;
	let current = path.isAbsolute(normalized) ? path.sep : sessionCwd;
	for (const segment of normalized.split(path.sep)) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, segment);
		try {
			current = fs.realpathSync(next);
		} catch {
			current = next;
		}
	}
	return current;
}

/**
 * True when the candidate equals a root or lives underneath one. Pure
 * prefix arithmetic over absolute paths; roots arrive already absolute,
 * as literal or realpath-resolved forms from buildAllowedRoots and
 * parseExtraRoots. Empty entries are skipped: as prefixes they would
 * degrade to "/" and widen the allowlist to every path, the one
 * direction this gate must never widen.
 */
export function isInsideRoots(candidate: string, roots: string[]): boolean {
	for (const root of roots) {
		if (root.length === 0) continue;
		if (candidate === root || candidate.startsWith(root + path.sep)) return true;
	}
	return false;
}

/**
 * Resolve one declared root entry to its dual forms: the literal
 * absolute string plus its realpath, so a symlinked declaration
 * sanctions access by either name (a non-symlink yields one form).
 * Malformed entries (relative, unresolvable) return empty with a
 * console warning naming the declaring source, never fatal: an entry
 * the session cannot prove strict drops out, narrowing the allowlist
 * (fail-closed) instead of failing the session.
 */
function declaredRootForms(entry: string, origin: string): string[] {
	if (!path.isAbsolute(entry)) {
		console.warn(`workspace-fence: ignoring ${origin} entry "${entry}": path is not absolute`);
		return [];
	}
	let resolved: string;
	try {
		resolved = fs.realpathSync(entry);
	} catch {
		console.warn(`workspace-fence: ignoring ${origin} entry "${entry}": path does not resolve`);
		return [];
	}
	return resolved === entry ? [entry] : [entry, resolved];
}

/**
 * Merge incoming roots into existing as one order-stable, deduplicated
 * union: the only direction any extra-root source acts in.
 */
function mergeRoots(existing: string[], incoming: string[]): string[] {
	const seen = new Set(existing);
	for (const root of incoming) {
		if (!seen.has(root)) {
			seen.add(root);
			existing.push(root);
		}
	}
	return existing;
}

/**
 * Parse the PISCOPE_EXTRA_ROOTS value into allowed roots. Each
 * well-formed entry is stored in BOTH forms via declaredRootForms;
 * empty segments (for example from a trailing delimiter) are skipped
 * quietly, matching ordinary PATH-list tolerance.
 */
export function parseExtraRoots(value: string | undefined): string[] {
	if (typeof value !== "string" || value.trim().length === 0) return [];
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const entry of value.split(path.delimiter)) {
		if (entry.length === 0) continue;
		for (const form of declaredRootForms(entry, EXTRA_ROOTS_ENV)) {
			if (!seen.has(form)) {
				seen.add(form);
				roots.push(form);
			}
		}
	}
	return roots;
}

/**
 * Parse one fence config document (the tracked config or the local
 * overlay): a strict flat JSON object whose only known key is
 * "extraRoots", an array of path strings. Unknown keys warn and are
 * skipped, never fatal. Entries expand a leading tilde against home
 * before the absolute check, then resolve to dual forms like env
 * entries; empty strings skip quietly (PATH-list tolerance) and every
 * other malformed shape warns and contributes nothing. An undefined
 * text (the file was absent) parses to nothing without warning; the
 * file reader decides absence policy.
 */
export function parseFenceConfig(
	text: string | undefined,
	origin: string,
	home: string = os.homedir(),
): string[] {
	if (text === undefined) return [];
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		console.warn(`workspace-fence: ignoring ${origin}: not valid JSON`);
		return [];
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) {
		console.warn(`workspace-fence: ignoring ${origin}: top level is not a JSON object`);
		return [];
	}
	const roots: string[] = [];
	const seen = new Set<string>();
	const record = document as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "extraRoots") {
			console.warn(`workspace-fence: ignoring ${origin} key "${key}": unknown config key`);
		}
	}
	const entries = record["extraRoots"];
	if (entries === undefined) return roots;
	if (!Array.isArray(entries)) {
		console.warn(`workspace-fence: ignoring ${origin}: "extraRoots" is not a JSON array`);
		return roots;
	}
	for (const entry of entries) {
		if (typeof entry !== "string") {
			console.warn(`workspace-fence: ignoring ${origin} entry "${String(entry)}": entry is not a string`);
			continue;
		}
		if (entry.length === 0) continue;
		for (const form of declaredRootForms(expandTilde(entry, home), origin)) {
			if (!seen.has(form)) {
				seen.add(form);
				roots.push(form);
			}
		}
	}
	return roots;
}

/**
 * Read one fence config file and parse it. A missing optional file is
 * the normal overlay case and stays silent; a missing tracked config
 * warns because the portable defaults are expected to ship with the
 * module.
 */
function readFenceRootsFile(
	filePath: string,
	origin: string,
	optional: boolean,
	home: string,
): string[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf-8");
	} catch {
		if (!optional) {
			console.warn(`workspace-fence: ${origin} is missing or unreadable; no extra roots load from it`);
		}
		return [];
	}
	return parseFenceConfig(text, origin, home);
}

/**
 * Load the tracked config's roots plus the optional overlay's roots as
 * one order-stable union. Both files live beside this module in the
 * repo; the paths are parameters so suites pin against fixtures. Shape
 * and failure posture are documented in the module header.
 */
export function loadFenceConfigRoots(
	configPath: string,
	overlayPath: string,
	home: string = os.homedir(),
): string[] {
	return mergeRoots(
		readFenceRootsFile(configPath, FENCE_CONFIG_FILE, false, home),
		readFenceRootsFile(overlayPath, FENCE_LOCAL_CONFIG_FILE, true, home),
	);
}

/**
 * Build the allowed-root set the verdict compares against: the session
 * cwd and the temp directory, each realpath-resolved with a lexical
 * fallback when the path cannot be stat'ed, plus the extra roots
 * passed through verbatim (parseExtraRoots already resolves each
 * declaration to both its literal and realpath forms; re-resolving
 * here would collapse that synonym pair). Deduped. tmpRoot is
 * injectable so suites can pin scope against a custom temp root
 * instead of the real one.
 */
export function buildAllowedRoots(
	sessionCwd: string,
	extraRoots: string[] = [],
	tmpRoot: string = os.tmpdir(),
): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const candidate of [sessionCwd, tmpRoot]) {
		let resolved: string;
		try {
			resolved = fs.realpathSync(candidate);
		} catch {
			resolved = path.resolve(candidate);
		}
		if (!seen.has(resolved)) {
			seen.add(resolved);
			roots.push(resolved);
		}
	}
	for (const extra of extraRoots) {
		if (!seen.has(extra)) {
			seen.add(extra);
			roots.push(extra);
		}
	}
	return roots;
}

/**
 * The dist files whose contents define the tool-side path transforms
 * this gate replicates: the two normalizer modules plus the six path
 * tools' call sites, where a future option flip (trim, a new prefix
 * transform) would live. The seal pins all eight so any upstream
 * change to the transform surface is detected at load, not discovered
 * by a silent verdict change.
 */
export const SEAL_DIGEST_FILES = [
	"utils/paths.js",
	"core/tools/path-utils.js",
	"core/tools/write.js",
	"core/tools/edit.js",
	"core/tools/read.js",
	"core/tools/grep.js",
	"core/tools/find.js",
	"core/tools/ls.js",
] as const;

/**
 * SHA-256 digests of SEAL_DIGEST_FILES in the release the pins were
 * computed from, the managed install's current-version target when the
 * gate was written. A mismatch means the running release's transforms
 * no longer match the replicated ones: the seal degrades to ask-mode
 * rather than trusting stale replicas.
 */
export const RELEASE_DIGEST_PINS: Record<string, string> = {
	"utils/paths.js": "1ec599ce7dc000d4684d66dfe0a1a17159fd8fcf04261a1c8aab5c33cb856043",
	"core/tools/path-utils.js": "76acb2622a7f4f54c871a553501340829580f0f9caad627e7dafb8aee8b449af",
	"core/tools/write.js": "0e9daec15a5001cafe651db391aed63a463c346d29b60e6dc91ef09477fd22f5",
	"core/tools/edit.js": "6e7fa99a8ac15e8a42d56158f52bd49c68a977a530a143f162858f755af572c5",
	"core/tools/read.js": "0fa71ef3202dbb88ad002d14cc211ab12ed1a6d2336ff07441810016027122bb",
	"core/tools/grep.js": "99187a58f9aeae86c70889f7beeb0e8a516d831c87fe7068def84dc068ead922",
	"core/tools/find.js": "97dd507d15d0cb6b789ff1edfa792a672213015af3ebf56b9e7cc6fc39571190",
	"core/tools/ls.js": "77ea89d293116dd791d3f7e7259dd6c4e2f75aef05060a3eba96f3e1d6a8ef5a",
};

/**
 * SHA-256 hex digest of a file's bytes, or null when the file cannot
 * be read. Null is data, never an exception: callers fold it into a
 * degraded seal.
 */
export function computeFileDigest(filePath: string): string | null {
	try {
		return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
	} catch {
		return null;
	}
}

/**
 * Version-pointer file candidates inside a managed install root: the
 * launcher sets PI_MANAGED_INSTALL_ROOT to the install directory
 * itself, and the alternate form treats it as the agent directory.
 */
const VERSION_FILE_CANDIDATES = ["current-version", path.join("install", "current-version")];

/**
 * The character set the launcher itself accepts in a version string,
 * with the launcher's exact-name rejections (empty, ".", "..") applied
 * alongside; anything else (in particular separators and traversal)
 * degrades the seal instead of joining into a release path.
 */
const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9._+-]+$/;

/** Release-relative location of the pi package's transform-bearing dist tree. */
const RELEASE_PACKAGE_DIST = path.join("node_modules", "@earendil-works", "pi-coding-agent", "dist");

/** Bound for the argv[1] upward walk, keeping a broken layout from scanning unbounded. */
const RELEASE_WALK_LIMIT = 32;

/**
 * Locate the dist tree of the release this process is actually
 * running: the managed install's current-version pointer when
 * PI_MANAGED_INSTALL_ROOT is set (the launcher's own resolution),
 * otherwise an upward walk from the entry script. The env route is
 * authoritative: when it cannot produce an existing dist tree the
 * result is null, never a walk that might name a different release.
 * Returns null instead of throwing whenever the layout cannot be
 * proven; callers treat null as a degraded seal.
 */
export function resolveRunningRelease(
	installRoot: string | undefined = process.env.PI_MANAGED_INSTALL_ROOT,
	entryFile: string | undefined = process.argv[1],
): string | null {
	if (typeof installRoot === "string" && installRoot.length > 0) {
		for (const candidate of VERSION_FILE_CANDIDATES) {
			const versionFile = path.join(installRoot, candidate);
			let content: string;
			try {
				content = fs.readFileSync(versionFile, "utf-8");
			} catch {
				continue;
			}
			const version = content.trim();
			if (version === "." || version === "..") return null;
			if (!RELEASE_VERSION_PATTERN.test(version)) return null;
			const dist = path.join(path.dirname(versionFile), "releases", version, RELEASE_PACKAGE_DIST);
			try {
				return fs.statSync(dist).isDirectory() ? dist : null;
			} catch {
				return null;
			}
		}
		return null;
	}
	if (typeof entryFile !== "string" || entryFile.length === 0) return null;
	let current = path.dirname(path.resolve(entryFile));
	for (let hop = 0; hop < RELEASE_WALK_LIMIT; hop++) {
		const candidate = path.join(current, RELEASE_PACKAGE_DIST);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// keep walking toward the filesystem root
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return null;
}

/**
 * Load-time parity seal over the running release: digest every
 * transform-bearing dist file and compare against the pins. Clean
 * means the replicated transforms were computed from exactly these
 * bytes; degraded (digest drift, a missing or unreadable file, an
 * unresolvable release, an unpinned entry) carries one actionable
 * reason per defect and must flip every path-bearing verdict to ask.
 * Read-only, never throws, never exits: a degraded seal keeps the
 * session alive in the policy's failure posture instead of bricking
 * startup.
 */
export function evaluateSealState(
	pins: Record<string, string> = RELEASE_DIGEST_PINS,
	releaseDist: string | null = resolveRunningRelease(),
): SealState {
	if (releaseDist === null) {
		return {
			degraded: true,
			reasons: ["running pi release could not be resolved; transform parity cannot be verified"],
		};
	}
	const reasons: string[] = [];
	for (const rel of SEAL_DIGEST_FILES) {
		const pinned = pins[rel];
		if (typeof pinned !== "string" || pinned.length === 0) {
			reasons.push(`${rel} has no pinned digest`);
			continue;
		}
		const actual = computeFileDigest(path.join(releaseDist, rel));
		if (actual === null) {
			reasons.push(`${rel} is unreadable in the running release`);
		} else if (actual !== pinned) {
			reasons.push(`${rel} changed since its digest was pinned (drift or upgrade)`);
		}
	}
	return reasons.length === 0 ? { degraded: false, reasons: [] } : { degraded: true, reasons };
}

/**
 * Memoized real session seal behind resolveScopeTarget's omitted seal
 * argument: the first omitted-seal call evaluates the running release
 * once, and every later omitted-seal call reuses that verdict for the
 * rest of the process (DC-R1). Suites inject explicit SealState values
 * and reach this accessor only where the omission semantics themselves
 * are under test; resetSessionSeal clears the memo so a later omitted
 * call re-evaluates under changed conditions.
 */
let cachedSessionSeal: SealState | undefined;

export function sessionSealState(): SealState {
	if (cachedSessionSeal === undefined) cachedSessionSeal = evaluateSealState();
	return cachedSessionSeal;
}

export function resetSessionSeal(): void {
	cachedSessionSeal = undefined;
}

/**
 * Memoized union of every extra-root source behind the factory's
 * allowed-root build: the tracked config and the optional local overlay
 * read from the directory this module sits in (the cooldown.json
 * precedent), plus PISCOPE_EXTRA_ROOTS. The first call evaluates once
 * per process and every later call reuses the union, so a config edit
 * or env change mid-session needs a restart to apply; suites call
 * resetFenceExtraRoots to re-evaluate under changed conditions.
 */
let cachedFenceExtraRoots: string[] | undefined;

export function fenceExtraRoots(): string[] {
	if (cachedFenceExtraRoots === undefined) {
		const moduleDir = path.dirname(fileURLToPath(import.meta.url));
		cachedFenceExtraRoots = mergeRoots(
			loadFenceConfigRoots(
				path.join(moduleDir, FENCE_CONFIG_FILE),
				path.join(moduleDir, FENCE_LOCAL_CONFIG_FILE),
			),
			parseExtraRoots(process.env[EXTRA_ROOTS_ENV]),
		);
	}
	return cachedFenceExtraRoots;
}

export function resetFenceExtraRoots(): void {
	cachedFenceExtraRoots = undefined;
}

/**
 * Bound on the symlink-chain walk in chaseDanglingFinalSymlink,
 * matching the kernel's ELOOP posture: a chain that keeps redirecting
 * past this many hops is a loop the kernel would refuse to traverse.
 */
const SYMLINK_CHASE_LIMIT = 40;

function isMissingPathError(err: unknown): boolean {
	return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isSymbolicLinkPath(candidate: string): boolean {
	try {
		return fs.lstatSync(candidate).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Resolve a path whose final component is a dangling symlink to where
 * an open(O_CREAT) would actually land: readlink the link, anchor
 * relative targets at the realpath'd parent directory, and keep
 * following symlinks in the target string (bounded by
 * SYMLINK_CHASE_LIMIT). The walk ends at the first non-symlink
 * component (existing or not) and returns that path; loops and
 * stat/link errors return null, leaving the verdict to the remaining
 * candidates (such inputs are unopenable for the kernel too).
 */
function chaseDanglingFinalSymlink(linkPath: string): string | null {
	let current = linkPath;
	for (let hop = 0; hop < SYMLINK_CHASE_LIMIT; hop++) {
		let info: fs.Stats;
		try {
			info = fs.lstatSync(current);
		} catch (err) {
			if (hop > 0 && isMissingPathError(err)) return current;
			return null;
		}
		if (!info.isSymbolicLink()) return current;
		let target: string;
		try {
			target = fs.readlinkSync(current);
		} catch {
			return null;
		}
		if (path.isAbsolute(target)) {
			current = target;
		} else {
			try {
				current = path.join(fs.realpathSync(path.dirname(current)), target);
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Full resolution verdict for one raw tool-input path. Candidates: the
 * lexical resolution, the kernel-style resolution (symlinks resolved
 * before dot-dots apply), the realpath when the target exists, and the
 * deepest-existing-ancestor realpath joined with the unresolved tail
 * for write-ahead targets; when that realpath fails on a dangling
 * FINAL symlink, the chased create location joins the candidates too
 * (the write tool creates through the final symlink). Allowed only
 * when EVERY candidate lands inside an allowed root; any candidate
 * outside, and any input the core cannot prove usable, asks. The ask
 * verdict names the escaping candidate so the handler can surface an
 * actionable reason. A degraded seal asks before any resolution runs:
 * parity with the running release is a precondition for trusting the
 * replicated transforms. The seal argument is suite injection: pass a
 * SealState to decide against it verbatim, or omit it to consume the
 * memoized real session seal (sessionSealState, evaluated once per
 * process). The optional extractionOrigin carries the bash scope
 * pass's operand provenance (EXT-37): when present it joins the
 * out-of-scope ask detail so the reason names the trigger position
 * the operand was extracted from; the path tools omit it and keep
 * their generic shape.
 */
export function resolveScopeTarget(
	sessionCwd: string,
	allowedRoots: string[],
	raw: unknown,
	home: string = os.homedir(),
	seal?: SealState,
	extractionOrigin?: string,
): ScopeVerdict {
	const effectiveSeal = seal ?? sessionSealState();
	if (effectiveSeal.degraded) {
		return {
			path: typeof raw === "string" ? raw : String(raw),
			scope: "ask",
			detail: `release seal degraded: ${effectiveSeal.reasons.join("; ")}; every path needs explicit approval until the gate is re-pinned to the running release`,
		};
	}
	const lexical = lexicalResolvePath(sessionCwd, raw, home);
	if (lexical === null) {
		return {
			path: String(raw),
			scope: "ask",
			detail: "path is not a usable string; refusing to guess",
		};
	}
	const candidates: string[] = [lexical];
	const originClause = extractionOrigin !== undefined ? `; the scope pass extracted it from ${extractionOrigin}` : "";
	const kernel = kernelStyleResolve(sessionCwd, raw, home);
	if (kernel !== null) candidates.push(kernel);
	try {
		candidates.push(fs.realpathSync(lexical));
	} catch {
		const parts = lexical.split(path.sep);
		for (let cut = parts.length - 1; cut > 1; cut--) {
			const head = parts.slice(0, cut).join(path.sep);
			const tail = parts.slice(cut).join(path.sep);
			try {
				const realHead = fs.realpathSync(head || path.sep);
				candidates.push(path.join(realHead, tail));
				break;
			} catch {
				continue;
			}
		}
		if (isSymbolicLinkPath(lexical)) {
			const chased = chaseDanglingFinalSymlink(lexical);
			if (chased !== null) candidates.push(chased);
		}
	}
	for (const candidate of candidates) {
		if (!isInsideRoots(candidate, allowedRoots)) {
			return {
				path: lexical,
				scope: "ask",
				detail: `${candidate} resolves outside the session cwd, the temp directory, and every extra allowed root${originClause}; approve interactively or widen the extra roots (${FENCE_CONFIG_FILE} or ${EXTRA_ROOTS_ENV})`,
				escapingCandidate: candidate,
			};
		}
	}
	const matched = allowedRoots.find((root) => isInsideRoots(lexical, [root]));
	return {
		path: lexical,
		scope: "allow",
		detail: `resolves inside ${matched ?? lexical}`,
	};
}

/**
 * The path-bearing tools this extension gates: exactly the six built-in
 * tools whose input schema carries a `path` field that resolves against
 * the session cwd. bash is gated separately through GATED_BASH_TOOLS
 * and the bash scope pass; powershell stays deliberately absent (the
 * Windows twin is a deferred unit); unknown tool names pass ungated.
 */
export const GATED_PATH_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
]);

/**
 * Gated tools whose `path` is optional and defaults to "." tool-side
 * (grep and find resolve `searchDir || "."`, ls resolves `path ||
 * "."`). For these an absent or empty path mirrors the tool's own
 * default instead of asking: the tool would search the session cwd,
 * which is inside the allowlist by construction.
 */
const TOOLS_DEFAULTING_TO_CWD: ReadonlySet<string> = new Set(["grep", "find", "ls"]);

/**
 * The path input a gated tool call carries: pi's six schemas all name
 * the field `path`. Everything else on the input (glob, pattern,
 * content, edits) is in-scope metadata and never consulted here.
 */
function gatedToolPath(toolName: string, input: Record<string, unknown>): unknown {
	const raw = input.path;
	if (TOOLS_DEFAULTING_TO_CWD.has(toolName) && (typeof raw !== "string" || raw.length === 0)) {
		return ".";
	}
	return raw;
}

/** One gated tool_call's decision as pure data; the path and bash gates share it. */
export type PathGateDecision =
	| { action: "pass" }
	| { action: "ask"; title: string; denyReason: string; grantCandidate?: string }
	| {
			action: "block";
			reason: string;
			/** The escaping candidate on a headless block of a candidate-bearing ask; the factory's forward branch keys from it. Absent on degraded-seal and unusable-input blocks, which must never forward. */
			grantCandidate?: string;
			/** The ask verdict's policy detail, the evidence the forwarded prompt body renders. */
			askEvidence?: string;
	};

/** Everything decidePathToolCall needs from one tool_call event. */
export interface PathGateCall {
	/** One of GATED_PATH_TOOLS; anything else passes ungated. */
	toolName: string;
	/** The tool_call event input; only input.path is consulted. */
	input: Record<string, unknown>;
	/** The session working directory the policy roots on. */
	sessionCwd: string;
	/** The allowed roots (buildAllowedRoots output). */
	allowedRoots: string[];
	/** Whether dialog UI is available; headless turns every ask into a block. */
	hasUI: boolean;
	/** The ctx.ui.select answer for post-prompt branches: true passes,
	 * false blocks; undefined means the prompt has not run yet. */
	approved?: boolean;
	/** Suite injection; omitted consumes the memoized real session seal. */
	seal?: SealState;
	/** Tilde-expansion home; defaults to the real home. */
	home?: string;
}

/**
 * The refusal reason a blocked call carries: it names the tool, the
 * resolved path, and the policy (the ask verdict's detail carries the
 * escaping candidate and the widening remedy: the tracked config or
 * PISCOPE_EXTRA_ROOTS).
 */
function scopeDenyReason(toolName: string, verdict: ScopeVerdict): string {
	return `${toolName} blocked by the workspace-fence: ${verdict.detail}`;
}

/** Suffix that turns the refusal reason into the headless block reason. */
const HEADLESS_REMEDY =
	"; this session has no interactive UI, so the call fails closed; run pi interactively to approve it";

/** The ctx.ui.select title for an out-of-scope call (permission-gate shape). */
function scopeAskTitle(toolName: string, verdict: ScopeVerdict): string {
	return `⚠️ ${toolName} outside the allowed scope:\n\n  ${verdict.path}\n\n${verdict.detail}\n\nAllow?`;
}

/**
 * Shared ask-class assembly for both gates: the ask verdict becomes the
 * select title under UI (the post-prompt branches driven by approved),
 * the refusal reason under a No answer, and the refusal reason plus the
 * headless remedy as a fail-closed block without UI. A headless block
 * of a candidate-bearing ask also carries the candidate and the ask
 * evidence, so the factory's forward branch can offer them to the
 * channel; degraded-seal and unusable-input verdicts carry no escaping
 * candidate, so their blocks cannot forward (the degraded-seal
 * invariant: degradation never manufactures channel evidence).
 */
function assembleGateDecision(
	toolName: string,
	verdict: ScopeVerdict,
	hasUI: boolean,
	approved?: boolean,
): PathGateDecision {
	const denyReason = scopeDenyReason(toolName, verdict);
	if (!hasUI) {
		return {
			action: "block",
			reason: `${denyReason}${HEADLESS_REMEDY}`,
			grantCandidate: verdict.escapingCandidate,
			askEvidence: verdict.detail,
		};
	}
	if (approved === undefined) {
		return {
			action: "ask",
			title: scopeAskTitle(toolName, verdict),
			denyReason,
			grantCandidate: verdict.escapingCandidate,
		};
	}
	if (approved) return { action: "pass" };
	return { action: "block", reason: denyReason };
}

/**
 * The whole tool_call decision for one gated call, as data, so the
 * suite exercises every branch without a live session: allow passes
 * untouched (zero prompts); an ask under UI returns the select title
 * and the refusal reason; an ask headless blocks fail-closed with the
 * refusal reason plus the remedy; an answered prompt passes on Yes and
 * blocks on refusal; a degraded seal follows the ask path. Omitting
 * `seal` consumes the memoized real session seal (DC-R1). A session
 * cwd that is not a usable string asks, never allows.
 */
export function decidePathToolCall(call: PathGateCall): PathGateDecision {
	if (!GATED_PATH_TOOLS.has(call.toolName)) return { action: "pass" };
	const verdict: ScopeVerdict =
		typeof call.sessionCwd !== "string" || call.sessionCwd.length === 0
			? {
					path: typeof call.input.path === "string" ? call.input.path : String(call.input.path),
					scope: "ask",
					detail: "session cwd is not a usable string; refusing to guess",
				}
			: resolveScopeTarget(
					call.sessionCwd,
					call.allowedRoots,
					gatedToolPath(call.toolName, call.input),
					call.home,
					call.seal,
				);
	if (verdict.scope === "allow") return { action: "pass" };
	return assembleGateDecision(call.toolName, verdict, call.hasUI, call.approved);
}

/**
 * The tools this extension gates with the bash scope pass: the bash
 * tool's `command` input is scanned lexically (recall-limited; the
 * header states the bypass residual) and every extracted path-like
 * operand resolves through the same verdict core as the path tools.
 */
export const GATED_BASH_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** The bash scope pass's extraction stage for one command, as pure data. */
export type { BashScanResult };

/**
 * Pure extraction stage of the bash scope pass, produced by the AST
 * walk in ./fence-ast/bash-scan.ts (the lexical walker this export
 * once carried retired with the PISCOPE-2-2 swap). The exported shape
 * is the consumer contract: substitution is expansion-node presence
 * anywhere in the tree (one position-blind traversal), operands are
 * argument pieces, executor payload words (the child shell's own word
 * split of a quoted payload at an executor shape), whole
 * file_redirect destinations, assignment and declaration values,
 * stdin-script heredoc body and here-string words under a
 * shell/su/ssh/eval head, and cd/pushd targets, executor detection reads
 * command_name identity plus the -c flag shape, interposition reads
 * wrapper identities, envVector names an env-var-carried execution
 * vector assigned in any posture or carried by an env spelling, and
 * the bail flag is the parse's own health (ERROR trees). EXT-37 adds
 * the provenance record: operandPositions keys each operand to the
 * extraction position the walk read it from (interpreter payloads
 * recognized by the node -e / python -c / perl -e script-flag shape
 * included), substitutionKinds lists the expansion kinds behind the
 * flag, and envVectorPosture names the vector's posture, so every ask
 * reason names its trigger class. The walk runs
 * on every call through the memoized parser (withBashParse releases
 * the tree on every path); a parser-unavailable load REJECTS rather
 * than returning a guess, so the consumer boundary decides the
 * fail-safe ask.
 */
export async function scanBashCommand(command: string): Promise<BashScanResult> {
	if (typeof command !== "string") {
		return { substitution: false, executor: false, bail: true, envVector: null, envVectorPosture: undefined, cdAsk: null, operands: [], operandPositions: {}, substitutionKinds: [], interposed: null };
	}
	return runBashScan(command);
}

/** Glob metacharacters whose expansion a lexical scan cannot enumerate. */
const bashGlobChars = /[*?[]/;

function hasDotDotComponent(text: string): boolean {
	return text.split("/").includes("..");
}

/**
 * Device files exempt from bash operand verdicts: writes to /dev/null
 * and /dev/zero discard and reads from them return null bytes or EOF,
 * and /dev/stdin, /dev/stdout, /dev/stderr, and /dev/fd/N are the
 * process's own streams re-exposed as paths, so none of them can carry
 * a scope boundary crossing. /dev/tty is deliberately absent: it reads
 * user input, an interaction channel rather than file data.
 */
const BASH_DEVICE_OPERANDS: ReadonlySet<string> = new Set([
	"/dev/null",
	"/dev/zero",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
]);

/** /dev/fd/N: the process's own numbered file descriptors. */
const bashDeviceFdOperand = /^\/dev\/fd\/[0-9]+$/;

/**
 * One bash operand's verdict: the device exemption first, bash-
 * specific overrides next, then the shared verdict core carrying the
 * operand's extraction-position provenance (EXT-37) into the ask
 * reason. Data-null and process-internal devices allow without
 * resolution, a bash-only carve-out the path tools do not share. A
 * ~user operand asks even though the core keeps it literal: bash
 * expands it to another user's home, which the core (mirroring pi's
 * tools, which do not expand ~user) would misplace inside the cwd. An
 * operand combining glob metacharacters with a .. component asks:
 * expansion could enumerate names that turn the traversal into an
 * escape the literal resolution hides. The override asks name their
 * own trigger class already, so only the core ask carries the
 * extraction origin.
 */
function bashOperandVerdict(
	operand: string,
	sessionCwd: string,
	allowedRoots: string[],
	home: string,
	seal: SealState,
	extractionOrigin: string,
): ScopeVerdict {
	if (BASH_DEVICE_OPERANDS.has(operand) || bashDeviceFdOperand.test(operand)) {
		return {
			path: operand,
			scope: "allow",
			detail: `${operand} is a data-null or process-internal device; exempt from the bash scope ask`,
		};
	}
	if (operand.startsWith("~") && operand !== "~" && !operand.startsWith("~/")) {
		return {
			path: operand,
			scope: "ask",
			detail: `bash expands ${operand} to another user's home directory, which the scanner cannot resolve; approve interactively or spell the absolute path`,
		};
	}
	if (bashGlobChars.test(operand) && hasDotDotComponent(operand)) {
		return {
			path: operand,
			scope: "ask",
			detail: "operand combines glob expansion with .. traversal, so the paths it reaches cannot be proven; approve interactively or narrow it",
		};
	}
	return resolveScopeTarget(sessionCwd, allowedRoots, operand, home, seal, extractionOrigin);
}

/** Everything decideBashToolCall needs from one tool_call event. */
export interface BashGateCall {
	/** Must be in GATED_BASH_TOOLS; anything else passes ungated. */
	toolName: string;
	/** The tool_call event input; only input.command is consulted. */
	input: Record<string, unknown>;
	/** The session working directory the policy roots on. */
	sessionCwd: string;
	/** The allowed roots (buildAllowedRoots output). */
	allowedRoots: string[];
	/** Whether dialog UI is available; headless turns every ask into a block. */
	hasUI: boolean;
	/** The ctx.ui.select answer for post-prompt branches: true passes,
	 * false blocks; undefined means the prompt has not run yet. */
	approved?: boolean;
	/** Suite injection; omitted consumes the memoized real session seal. */
	seal?: SealState;
	/** Tilde-expansion home; defaults to the real home. */
	home?: string;
	/** Suite injection of the AST scan; omitted runs the real scanBashCommand. The rejection path is the parser-unavailable fail-safe ask. */
	scan?: (command: string) => Promise<BashScanResult>;
}

/**
 * The whole tool_call decision for one bash call, as data, sharing the
 * path gate's ask/block machinery: a degraded seal asks every bash call
 * (a shell command is a potential path bearer and the resolution parity
 * its operands rely on is unproven); a non-string command or session
 * cwd asks fail-closed; an AST walk whose tree carries substitution
 * asks (the walk cannot see expansion results); an ERROR-bearing parse
 * asks (the bail class is parse health); parser unavailability (a
 * load failure, a digest mismatch, or an expired init budget) asks
 * through the boundary below, never a silent allow; a cd/pushd naming
 * no lexically resolvable target asks (home, OLDPWD, and the directory
 * stack are shell state); an assignment or env spelling carrying a
 * hijackable execution vector (PROMPT_COMMAND, BASH_ENV, ZDOTDIR,
 * ENV, LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, PS4, PATH) asks
 * regardless of the value's shape (the shell or its loader runs them
 * on a schedule the scanner cannot evaluate); an executor shape
 * riding behind a command/env/nohup/nice/timeout/exec wrapper asks
 * without scanning through (the wrapper re-executes its arguments);
 * otherwise every extracted operand resolves through the verdict core
 * carrying its extraction-position provenance and the first ask wins,
 * so the reason names the trigger class (EXT-37): the operand's
 * extraction position, the substitution ask's expansion kinds, and
 * the vector floor's posture all join the detail the prompt, the
 * refusal, and the forwarded ask evidence render. A command with no
 * asking operand passes untouched.
 */
export async function decideBashToolCall(call: BashGateCall): Promise<PathGateDecision> {
	if (!GATED_BASH_TOOLS.has(call.toolName)) return { action: "pass" };
	const effectiveSeal = call.seal ?? sessionSealState();
	const home = call.home ?? os.homedir();
	const commandText = typeof call.input.command === "string" ? call.input.command : String(call.input.command);
	const askBash = (detail: string): PathGateDecision =>
		assembleGateDecision(call.toolName, { path: commandText, scope: "ask", detail }, call.hasUI, call.approved);
	if (effectiveSeal.degraded) {
		return askBash(`release seal degraded: ${effectiveSeal.reasons.join("; ")}; every path needs explicit approval until the gate is re-pinned to the running release`);
	}
	if (typeof call.sessionCwd !== "string" || call.sessionCwd.length === 0) {
		return askBash("session cwd is not a usable string; refusing to guess");
	}
	if (typeof call.input.command !== "string" || call.input.command.length === 0) {
		return askBash("command is not a usable string; refusing to guess");
	}
	let scan: BashScanResult;
	try {
		scan = await (call.scan ?? scanBashCommand)(call.input.command);
	} catch (error) {
		return askBash(
			`the bash command parser is unavailable (${error instanceof Error ? error.message : String(error)}); the scope pass refuses to guess; approve interactively or retry the call`,
		);
	}
	if (scan.interposed !== null) {
		return askBash(`the command routes an executor invocation through ${scan.interposed}, which re-executes its arguments in ways the scan cannot see through; approve interactively or drop the wrapper`);
	}
	if (scan.substitution) {
		const kinds = scan.substitutionKinds ?? [];
		return askBash(
			kinds.length > 0
				? `command carries expansion the scanner cannot see through (${kinds.join(", ")}); the scope pass biases toward asking`
				: "command carries an expansion whose result the scanner cannot see; the scope pass biases toward asking",
		);
	}
	if (scan.bail) {
		return askBash("the command did not parse cleanly (a syntax error or broken quoting); the scope pass biases toward asking");
	}
	if (scan.envVector) {
		const vectorText =
			"a variable the shell or its loader consumes for deferred or indirect execution (prompt hook, startup file, startup directory, preloaded library, audit module, library search path, trace output, executable lookup), which the scanner cannot evaluate";
		return askBash(
			scan.envVectorPosture === "env spelling"
				? `command carries ${scan.envVector} in an env spelling, ${vectorText}; approve interactively or drop the spelling`
				: `command assigns ${scan.envVector}, ${vectorText}; approve interactively or drop the assignment`,
		);
	}
	if (scan.cdAsk) {
		return askBash(scan.cdAsk);
	}
	const operandPositions = scan.operandPositions ?? {};
	for (const operand of scan.operands) {
		const verdict = bashOperandVerdict(
			operand,
			call.sessionCwd,
			call.allowedRoots,
			home,
			effectiveSeal,
			operandPositions[operand] ?? "a command argument",
		);
		if (verdict.scope === "ask") {
			return assembleGateDecision(call.toolName, verdict, call.hasUI, call.approved);
		}
	}
	return { action: "pass" };
}

/**
 * Classify one escaping candidate for the grant-key derivation, per
 * the fence-ask caller contract: an existing node (stat follows
 * symlinks) is directory form with its own realpath, or file form
 * with its parent directory's realpath; a candidate that does not
 * resolve is the write-ahead class with the parent directory's
 * realpath when the parent resolves, else null so the derivation
 * falls back to the literal dirname.
 */
function classifyGrantCandidate(candidate: string): { form: AskCandidateForm; resolvedRealpath: string | null } {
	try {
		const stats = fs.statSync(candidate);
		if (stats.isDirectory()) {
			return { form: "directory", resolvedRealpath: fs.realpathSync(candidate) };
		}
		return { form: "file", resolvedRealpath: fs.realpathSync(path.dirname(candidate)) };
	} catch {
		const parent = path.dirname(candidate);
		try {
			return { form: "unresolved", resolvedRealpath: fs.realpathSync(parent) };
		} catch {
			return { form: "unresolved", resolvedRealpath: null };
		}
	}
}

/**
 * Record one parent-own grant from an approved ask's escaping
 * candidate (unit 1-2, property 1's producer): classify the candidate
 * against the real filesystem, derive the grant-scope directory per
 * the fence-ask grant-key contract, and record it into the shared
 * ledger, which feeds spawn-time inheritance composition and the
 * session's ask-dedup index. Returns the recorded directory, or null
 * when the candidate is unusable (degraded-seal and unusable-input
 * asks carry none, so a degraded Yes records nothing and cannot
 * launder untrusted-machinery evidence into an inherited grant).
 * Idempotent per directory in the ledger. The fence's own verdicts
 * never consult the ledger: a recorded grant changes what future
 * dispatched children inherit, never this session's decisions.
 */
export function recordParentOwnGrant(candidate: unknown, now: number = Date.now()): string | null {
	if (typeof candidate !== "string" || candidate.length === 0 || !path.isAbsolute(candidate)) return null;
	const classified = classifyGrantCandidate(candidate);
	const directory = grantScopeDirectory(candidate, classified.form, classified.resolvedRealpath);
	return recordParentGrant(directory, now).directory;
}

function realpathOrNull(candidate: string): string | null {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return null;
	}
}

/** The allowed roots the factory builds per call: the static union plus this child's own applied forward grants. */
export function childScopedAllowedRoots(sessionCwd: string): string[] {
	return buildAllowedRoots(sessionCwd, [...fenceExtraRoots(), ...appliedSelfGrants()]);
}

/** Everything forwardHeadlessAsk needs for one forwarded call. */
export interface HeadlessForwardCall {
	/** The gated tool whose call asked (display on the parent prompt). */
	toolName: string;
	/** The verdict's escaping candidate, keyed per the grant-key contract. */
	candidate: string;
	/** The ask verdict's policy detail, rendered in the forwarded prompt body. */
	askEvidence: string;
	/** The child provisioning the spawn env carried. */
	provisioning: { root: string; token: string };
	/** The bounded wait; defaults to resolveAskWaitMs over the env override. */
	waitMs?: number;
	/** Poll spacing; defaults to the channel's calibrated bound. */
	pollMs?: number;
	/** Injectable pause for suites; defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>;
}

/** The pass or fail-closed-block outcome of one forwarded call. */
export type HeadlessForwardDecision = { action: "pass" } | { action: "block"; reason: string };

/**
 * Run one provisioned headless child's forwarded ask (unit 1-3, the
 * child-side consumer): derive the grant key from the escaping
 * candidate per the form-aware grant-key contract, run the bounded
 * channel flow, apply an approval to this child's own verdicts via
 * applyGrantToSelf, and resolve into pass or a fail-closed block
 * carrying the flow's actionable reason. The parent's approval binds
 * this child only: the applied set feeds the per-call allowed-roots
 * build (childScopedAllowedRoots), never another process's scope.
 */
export async function forwardHeadlessAsk(call: HeadlessForwardCall): Promise<HeadlessForwardDecision> {
	const classified = classifyGrantCandidate(call.candidate);
	const directory = grantScopeDirectory(call.candidate, classified.form, classified.resolvedRealpath);
	const waitMs = call.waitMs ?? resolveAskWaitMs(process.env[ASK_WAIT_ENV]);
	const outcome = await forwardOutOfScopeAsk({
		root: call.provisioning.root,
		childToken: call.provisioning.token,
		toolName: call.toolName,
		directory,
		reason: `${call.candidate}: ${call.askEvidence}`.slice(0, MAX_REASON_LENGTH),
		identityAgentName: `pid-${process.pid}`,
		identityDispatchLabel: path.basename(process.cwd()),
		waitMs,
		pollMs: call.pollMs,
		sleep: call.sleep,
		onGrant: (grantedRoot) => applyGrantToSelf(grantedRoot, realpathOrNull(grantedRoot)),
	});
	if (outcome.status === "applied") return { action: "pass" };
	return { action: "block", reason: outcome.blockReason };
}

/**
 * The extension entry point pi's loader requires (the permission-gate
 * shape): register one tool_call handler that maps the decision data
 * onto the live session. Bash calls dispatch to the bash decider, every
 * other tool to the path decider. The extra-root union evaluates
 * lazily once per process at the first gated verdict (fenceExtraRoots:
 * tracked config, optional local overlay, PISCOPE_EXTRA_ROOTS), the
 * allowed roots rebuild per call so a moved session cwd is honored,
 * and the seal stays omitted so the real release seal evaluates
 * exactly once per session. Prompt answers other than Yes are
 * refusals: the user is never tricked into approval by a stale dialog.
 */
export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const shared = {
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			sessionCwd: ctx.cwd,
			allowedRoots: childScopedAllowedRoots(ctx.cwd),
			hasUI: ctx.hasUI,
		};
		const decision = GATED_BASH_TOOLS.has(event.toolName)
			? await decideBashToolCall(shared)
			: decidePathToolCall(shared);
		if (decision.action === "pass") return undefined;
		if (decision.action === "block") {
			if (decision.grantCandidate !== undefined && !ctx.hasUI) {
				const provisioning = childProvisioningFromEnv();
				if (provisioning !== null) {
					const forward = await forwardHeadlessAsk({
						toolName: event.toolName,
						candidate: decision.grantCandidate,
						askEvidence: decision.askEvidence ?? "",
						provisioning,
					});
					if (forward.action === "pass") return undefined;
					return { block: true, reason: forward.reason };
				}
			}
			return { block: true, reason: decision.reason };
		}
		const choice = await ctx.ui.select(decision.title, ["Yes", "No"]);
		if (choice !== "Yes") return { block: true, reason: decision.denyReason };
		if (decision.action === "ask") recordParentOwnGrant(decision.grantCandidate);
		return undefined;
	});
}
