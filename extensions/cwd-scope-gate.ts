/**
 * CWD Scope Gate Extension (verdict core)
 *
 * Verdict half of the user's file-access policy: a session may touch its
 * working-directory subtree, the os.tmpdir() subtree, and the
 * PISCOPE_EXTRA_ROOTS entries without prompting; every other directory
 * requires an interactive permission ASK. This module is the pure
 * decision core only: it resolves a raw tool-input path and returns an
 * allow/ask verdict as data, plus the load-time release seal that
 * decides whether those verdicts are trustworthy this session. The
 * tool_call handler that turns ask verdicts into ctx.ui prompts (UI
 * sessions) or fail-closed blocks (headless sessions) lands with the
 * wiring unit.
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
 * Extra roots: PISCOPE_EXTRA_ROOTS is a delimiter-separated (":" on
 * POSIX) list of absolute paths; parseExtraRoots stores each entry in
 * both its literal and realpath forms so a symlinked declaration
 * sanctions access by either name.
 * Malformed entries (relative, unresolvable) are ignored with a console
 * warning, never fatal: an entry the session cannot prove strict drops
 * out, which only ever narrows the allowlist. Children inherit the
 * variable through the normal spawn environment chain.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Environment variable carrying extra allowed roots, colon-separated
 * absolute paths parsed by parseExtraRoots.
 */
export const EXTRA_ROOTS_ENV = "PISCOPE_EXTRA_ROOTS";

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
 * Parse the PISCOPE_EXTRA_ROOTS value into allowed roots. Each
 * well-formed entry is stored in BOTH forms, its literal absolute
 * string and its realpath: a symlinked declaration sanctions access by
 * either name. Malformed entries are ignored with a console warning
 * rather than fatal: a relative or unresolvable entry drops out,
 * narrowing the allowlist (fail-closed) instead of failing the
 * session. Empty segments (for example from a trailing delimiter) are
 * skipped quietly, matching ordinary PATH-list tolerance.
 */
export function parseExtraRoots(value: string | undefined): string[] {
	if (typeof value !== "string" || value.trim().length === 0) return [];
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const entry of value.split(path.delimiter)) {
		if (entry.length === 0) continue;
		if (!path.isAbsolute(entry)) {
			console.warn(`cwd-scope-gate: ignoring ${EXTRA_ROOTS_ENV} entry "${entry}": path is not absolute`);
			continue;
		}
		let resolved: string;
		try {
			resolved = fs.realpathSync(entry);
		} catch {
			console.warn(`cwd-scope-gate: ignoring ${EXTRA_ROOTS_ENV} entry "${entry}": path does not resolve`);
			continue;
		}
		if (!seen.has(entry)) {
			seen.add(entry);
			roots.push(entry);
		}
		if (!seen.has(resolved)) {
			seen.add(resolved);
			roots.push(resolved);
		}
	}
	return roots;
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
 * verdict names the escaping candidate so the wiring unit can surface
 * an actionable reason. A degraded seal (evaluateSealState) asks
 * before any resolution runs: parity with the running release is a
 * precondition for trusting the replicated transforms.
 */
export function resolveScopeTarget(
	sessionCwd: string,
	allowedRoots: string[],
	raw: unknown,
	home: string = os.homedir(),
	seal: SealState = { degraded: false, reasons: [] },
): ScopeVerdict {
	if (seal.degraded) {
		return {
			path: typeof raw === "string" ? raw : String(raw),
			scope: "ask",
			detail: `release seal degraded: ${seal.reasons.join("; ")}; every path needs explicit approval until the gate is re-pinned to the running release`,
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
				detail: `${candidate} resolves outside the session cwd, the temp directory, and every extra allowed root; approve interactively or widen ${EXTRA_ROOTS_ENV}`,
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
