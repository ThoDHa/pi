#!/usr/bin/env node
/**
 * Verdict-matrix suite for the workspace-fence core
 * (extensions/workspace-fence.ts). Plain node, no test framework:
 *
 *   node tests/workspace-fence.test.mjs
 *
 * Requires a resolvable release (PI_MANAGED_INSTALL_ROOT or an
 * argv-walk ancestor): from a bare environment the canary reds loudly
 * rather than passing silently.
 *
 * The gate is an inverted allowlist: a tool-input path is allowed only
 * when EVERY resolution candidate (lexical, kernel-style symlink-plus-
 * dotdot, realpath, write-ahead ancestor) lands inside the session cwd
 * subtree, the os.tmpdir() subtree, or one of the PISCOPE_EXTRA_ROOTS
 * entries; any candidate outside, and any input the core cannot prove
 * usable, asks. Asking is the fail-closed direction: over-asking is
 * acceptable, silent allowing is not. This is why a path that reaches
 * scope only THROUGH a symlink planted outside it still asks: its
 * lexical candidate stays outside, and every candidate must clear.
 *
 * Fixture trees are mkdtemp'd under os.tmpdir(). Two root modes:
 * real-scope mode (buildAllowedRoots default: fixture cwd + real /tmp,
 * out-of-scope probes hit /etc and the real home) and custom-root mode
 * (a custom tmpRoot that stays empty, so the sibling "outside" fixture
 * is genuinely out of scope and both symlink directions can be planted
 * writable). Tilde cases pass an explicit fixture home; two probes use
 * the real home to pin the default-parameter path. Unicode-space input
 * is normalized exactly like the tools (the boundary-name class: a
 * root whose name contains a unicode space must not match input
 * spelled in the unicode form, because the tool opens the ascii-space
 * sibling). The A5 seal machinery is pinned against fixture install
 * trees (current-version resolution, digest comparison, ask-mode
 * degradation feeding the verdict surface) and against the real
 * release. The DC-1 canary resolves the managed install through its
 * current-version pointer (never a version glob), asserts SHA-256
 * digest pins over the eight transform-bearing release files, and
 * re-proves replication parity against the release's own normalizers
 * on a combinatorial corpus covering every transform axis plus the
 * unicode-space lattice; any resolution miss, unreadable digest-set
 * file, digest drift, or parity break is a HARD suite failure that
 * never skips to green.
 *
 * Corpus scope, by design: the parity corpus covers the base-changing
 * normalizers (utils/paths.js normalizePath, core/tools/path-utils.js
 * resolveToCwd) and does NOT cover the leaf-variant resolvers (such as
 * read.js resolveReadPath's screenshot/NFD/curly-quote fallbacks).
 * Those variants substitute alternative spellings for the final leaf
 * name inside an already-resolved directory; they alter only WHICH
 * entry of a resolved directory the tool opens, never the directory
 * itself, so they cannot move access across a root boundary and a
 * leaf-variant corpus would over-ask without adding closure. The
 * files carrying those variants (read.js, path-utils.js) are
 * digest-pinned by the seal, so any change to them fails the seal and
 * degrades every verdict to ask instead of changing behavior silently.
 *
 * The wiring half of the extension is exercised here as data, without
 * a live session: decidePathToolCall covers the six gated path tools'
 * pass, ask, refusal, and headless-block branches, the default-
 * exported factory is checked for the extension shape pi's loader
 * requires (a function registering on tool_call), and the DC-R1
 * seal-omission semantics are pinned: omitting the seal evaluates the
 * REAL seal once per process (memoized), while explicit injection is
 * honored verbatim.
 *
 * The bash scope pass (unit 1-3, detection layer swapped to the
 * tree-sitter AST by PISCOPE-2-2) is exercised the same way:
 * scanBashCommand pins the AST extraction (substitution is the
 * presence of expansion nodes with the single-quote narrowing and
 * escape-literal semantics; operands extract from word/string pieces,
 * redirect targets, and assignment RHS; quoted prose splits into
 * pieces; executor shapes are command_name identity plus the -c flag
 * shape; interposition floors on wrapper identities; ERROR-bearing
 * parses bail; heredocs, comments, grouping, and braces parse to
 * verdicts), decideBashToolCall pins its verdict classes
 * (in-scope pass, out-of-scope ask, substitution bias, ERROR-tree
 * bail, parser-unavailable ask, tilde-user and glob-traversal
 * overrides, device exemption, degraded-seal ask, headless block),
 * the sed pattern-first skip pins the EXT-34 incident closure, and
 * the factory handler maps bash events onto the shared ask/block
 * machinery through the async decision seam.
 *
 * The unit 1-2 parent-own grant recorder is pinned at three depths:
 * recordParentOwnGrant's classification classes against real fixture
 * nodes (directory keys itself, file keys its parent, write-ahead
 * tails key their literal dirname, dangling symlinks and trailing
 * separators converge on the containing real directory, symlinked
 * directories key their physical self, idempotent re-recording,
 * unusable candidates record nothing); the escapingCandidate verdict
 * field (set on candidate-bearing asks, absent on allows, degraded
 * asks, and unusable input) and the grantCandidate field it feeds on
 * the ask decision; and the factory wiring end to end, where an
 * approved out-of-scope handler call records the derived grant into
 * the fence-ask ledger and refusals, headless blocks, and repeat
 * approvals record nothing.
 *
 * The unit 1-3 headless forward branch is pinned the same three ways:
 * the decision data (a candidate-bearing headless block carries
 * grantCandidate and askEvidence for the factory's forward branch;
 * degraded-seal and substitution blocks carry neither candidate, so
 * they block without forwarding); forwardHeadlessAsk against the real
 * channel (an applied grant passes the call, lands the dual-form root
 * in appliedSelfGrants, admits through childScopedAllowedRoots, keys
 * form-aware with the candidate and evidence in the prompt body, and
 * denials, timeouts, and channel failures block fail-closed naming
 * tool, directory, and posture); and the factory wiring end to end,
 * where a provisioned headless child's out-of-scope call forwards,
 * the ruling maps onto pass or block, the grant feeds the next
 * verdict with no second round-trip, a candidate-less ask never
 * writes a request file, and an unprovisioned call keeps the plain
 * headless remedy block.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import cwdScopeGate, {
	EXTRA_ROOTS_ENV,
	FENCE_CONFIG_FILE,
	FENCE_DISABLE_ENV,
	FENCE_LOCAL_CONFIG_FILE,
	GATED_BASH_TOOLS,
	GATED_PATH_TOOLS,
	RELEASE_DIGEST_PINS,
	SEAL_DIGEST_FILES,
	buildAllowedRoots,
	computeFileDigest,
	decideBashToolCall,
	decidePathToolCall,
	expandTilde,
	evaluateSealState,
	fenceExtraRoots,
	fenceExtraRootSources,
	isInsideRoots,
	kernelStyleResolve,
	lexicalResolvePath,
	loadFenceConfigRoots,
	normalizeToolInputPath,
	parseExtraRoots,
	parseFenceConfig,
	resetFenceExtraRoots,
	resetSessionSeal,
	resolveRunningRelease,
	childScopedAllowedRoots,
	forwardHeadlessAsk,
	resolveScopeTarget,
	recordParentOwnGrant,
	scanBashCommand,
	sessionSealState,
} from "../extensions/workspace-fence.ts";
import { appliedSelfGrants, inheritedExtraRootsEnvValue, parentGrantedDirectories, registerLiveChild, resetFenceAskState } from "../extensions/fence-ask/grant-ledger.ts";
import { ASK_WAIT_ENV, CHILD_ASK_ROOT_ENV, CHILD_ASK_TOKEN_ENV } from "../extensions/fence-ask/ask-wire.ts";
import { createForwardingRootDirs, deleteAskFile, requestIdsIn, serveForwardingRootTick } from "../extensions/fence-ask/ask-channel.ts";
import {
	BASH_PARSER_INIT_TIMEOUT_MS,
	loadBashParser,
	memoizeAsyncWithRetry,
	verifyGrammarArtifacts,
	withBashParse,
	withInitBudget,
} from "../extensions/fence-ast/bash-parser.ts";
import { GRAMMAR_ARTIFACT_FILES, GRAMMAR_DIGEST_PINS } from "../extensions/fence-ast/grammar-pins.ts";

// Hermeticity over ambient ask-channel provisioning: the factory handler
// reads PISCOPE_ASK_FORWARDING_ROOT / PISCOPE_ASK_CHILD_TOKEN from the live
// environment on every headless block, so a suite run inside a provisioned
// dispatched child would silently route the handler sections below onto the
// real forward path instead of the unprovisioned fail-closed branch they
// pin. The pair is cleared for the whole suite; the forward section sets
// its own fixture provisioning, and the ambient values are restored at the
// bottom so the process env is left as found.
const ambientAskRoot = process.env[CHILD_ASK_ROOT_ENV];
const ambientAskToken = process.env[CHILD_ASK_TOKEN_ENV];
delete process.env[CHILD_ASK_ROOT_ENV];
delete process.env[CHILD_ASK_TOKEN_ENV];

let failed = 0;
let total = 0;
function check(label, actual, expected) {
	total++;
	if (actual !== expected) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      expected: ${expected}`);
		console.log(`      actual  : ${actual}`);
	}
}

function checkContains(label, haystack, needle) {
	check(label, haystack.includes(needle) ? "yes" : "no", "yes");
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-fence-"));
const cwdDir = path.join(fixtureRoot, "project");
const insideDir = path.join(cwdDir, "inside");
const outsideDir = path.join(fixtureRoot, "outside");
const outsideSubDir = path.join(outsideDir, "sub");
const customTmpDir = path.join(fixtureRoot, "empty-tmp");
const fakeHome = path.join(fixtureRoot, "home");
for (const dir of [insideDir, outsideSubDir, customTmpDir, fakeHome]) {
	fs.mkdirSync(dir, { recursive: true });
}
const colonDir = path.join(fixtureRoot, "colon-typo:");
fs.mkdirSync(colonDir, { recursive: true });
const inFile = path.join(insideDir, "file.txt");
const outFile = path.join(outsideSubDir, "target.txt");
fs.writeFileSync(inFile, "fixture");
fs.writeFileSync(outFile, "fixture");
const linkOut = path.join(cwdDir, "link-out");
const linkIn = path.join(outsideDir, "link-in");
const linkCwd = path.join(fixtureRoot, "link-cwd");
const linkExtra = path.join(fixtureRoot, "link-extra");
fs.symlinkSync(outsideDir, linkOut, "dir");
fs.symlinkSync(inFile, linkIn, "file");
fs.symlinkSync(cwdDir, linkCwd, "dir");
fs.symlinkSync(outsideDir, linkExtra, "dir");
const dangleOut = path.join(cwdDir, "dangle-out");
const dangleChainA = path.join(cwdDir, "dangle-chain-a");
const dangleChainB = path.join(cwdDir, "dangle-chain-b");
const dangleIn = path.join(cwdDir, "dangle-in");
const loopA = path.join(cwdDir, "loop-a");
const loopB = path.join(cwdDir, "loop-b");
fs.symlinkSync(path.join(outsideDir, "new.md"), dangleOut, "file");
fs.symlinkSync("dangle-chain-b", dangleChainA, "file");
fs.symlinkSync(path.join("..", "outside", "chained.md"), dangleChainB, "file");
fs.symlinkSync(path.join(insideDir, "created-here.md"), dangleIn, "file");
fs.symlinkSync("loop-b", loopA, "file");
fs.symlinkSync("loop-a", loopB, "file");

// real-scope mode: the fixture cwd plus the REAL os.tmpdir() subtree;
// /etc and the real home stand in as out-of-scope territory.
const realScopeRoots = buildAllowedRoots(cwdDir);
// custom-root mode: the fixture cwd plus an empty tmp stand-in, so the
// sibling outside fixture is genuinely out of scope.
const customRoots = buildAllowedRoots(cwdDir, [], customTmpDir);

// Hermeticity against a provisioned invocation shell: the factory pins
// in the try below run the handler unprovisioned (plain headless
// blocks, no channel flow), but a shell invoking this suite from
// inside a dispatched child carries the forwarding env, which would
// route the out-of-scope handler pins through the live forward branch
// instead. The snapshot is restored in the try's finally; the
// forward-branch section below sets its own provisioning and
// saves/restores the environment independently.
const handlerSavedAskRoot = process.env[CHILD_ASK_ROOT_ENV];
const handlerSavedAskToken = process.env[CHILD_ASK_TOKEN_ENV];

try {
	// --- tilde expansion pins (pi's tools expand ~ like this:
	// --- dist/utils/paths.js normalizePath, expandTilde default true) --
	check("tilde bare expands to home", expandTilde("~", fakeHome), fakeHome);
	check("tilde slash expands under home", expandTilde("~/x", fakeHome), path.join(fakeHome, "x"));
	check("tilde mid-word stays literal", expandTilde("foo~bar", fakeHome), "foo~bar");
	check("tilde user form stays literal", expandTilde("~other/x", fakeHome), "~other/x");

	// --- pi-parity normalization pins (resolveToCwd's base-changing
	// --- transforms: @-strip, tilde, file:// in that order) -------------
	check("normalize strips one leading @", normalizeToolInputPath("@/abs", fakeHome), "/abs");
	check(
		"normalize strips @ then expands tilde",
		normalizeToolInputPath("@~/x", fakeHome),
		path.join(fakeHome, "x"),
	);
	check("normalize converts file URLs", normalizeToolInputPath("file:///abs", fakeHome), "/abs");
	check("normalize expands bare tilde", normalizeToolInputPath("~", fakeHome), fakeHome);
	check(
		"normalize expands tilde slash",
		normalizeToolInputPath("~/rel", fakeHome),
		path.join(fakeHome, "rel"),
	);
	check("normalize keeps ~user literal", normalizeToolInputPath("~user", fakeHome), "~user");
	check("normalize keeps plain absolute", normalizeToolInputPath("/abs/plain", fakeHome), "/abs/plain");
	check("normalize keeps relative", normalizeToolInputPath("rel/path", fakeHome), "rel/path");
	check("normalize strips @ of bare name", normalizeToolInputPath("@name", fakeHome), "name");
	check("normalize strips only one @", normalizeToolInputPath("@@x", fakeHome), "@x");
	check(
		"normalize converts @-prefixed file URL",
		normalizeToolInputPath("@file:///etc/passwd", fakeHome),
		"/etc/passwd",
	);
	check(
		"normalize converts localhost file URL",
		normalizeToolInputPath("file://localhost/etc", fakeHome),
		"/etc",
	);
	check("normalize maps invalid file URL to unusable", normalizeToolInputPath("file://host/x", fakeHome), null);

	// --- unicode-space normalization (pi's first transform) -------------
	check(
		"normalize replaces unicode spaces with ascii space",
		normalizeToolInputPath("/abs/a\u00A0b", fakeHome),
		"/abs/a b",
	);
	check(
		"normalize replaces U+3000 mid-name",
		normalizeToolInputPath("/abs/a\u3000b/c", fakeHome),
		"/abs/a b/c",
	);
	check(
		"normalize strips @ after unicode conversion",
		normalizeToolInputPath("@\u00A0name", fakeHome),
		" name",
	);
	check(
		"normalize keeps converted tilde-lookalike literal",
		normalizeToolInputPath("~\u2003name", fakeHome),
		"~ name",
	);

	// --- lexical + kernel resolution unit pins --------------------------
	check(
		"lexical resolves relative against cwd",
		lexicalResolvePath(cwdDir, "inside/file.txt", fakeHome),
		inFile,
	);
	check(
		"lexical expands tilde with overridden home",
		lexicalResolvePath(cwdDir, "~/file.txt", fakeHome),
		path.join(fakeHome, "file.txt"),
	);
	check("lexical rejects non-string", lexicalResolvePath(cwdDir, 42, fakeHome), null);
	check("lexical rejects empty string", lexicalResolvePath(cwdDir, "", fakeHome), null);
	check(
		"kernel resolves symlink then dotdot onto the link target's parent",
		kernelStyleResolve(cwdDir, "link-out/../planted", fakeHome),
		path.join(fixtureRoot, "planted"),
	);

	// --- containment helper ---------------------------------------------
	check("exact root match is inside", isInsideRoots(cwdDir, [cwdDir]), true);
	check(
		"prefix sibling is not inside",
		isInsideRoots(`${fixtureRoot}-sibling`, [fixtureRoot]),
		false,
	);
	check(
		"empty root entry does not widen scope",
		isInsideRoots("/etc/passwd", [""]),
		false,
	);

	// --- real-scope mode: cwd subtree and /tmp subtree allow ------------
	check(
		"cwd relative file allows",
		resolveScopeTarget(cwdDir, realScopeRoots, "inside/file.txt").scope,
		"allow",
	);
	check(
		"cwd absolute file allows",
		resolveScopeTarget(cwdDir, realScopeRoots, inFile).scope,
		"allow",
	);
	check(
		"dotdot staying inside cwd allows",
		resolveScopeTarget(cwdDir, realScopeRoots, "inside/../inside/file.txt").scope,
		"allow",
	);
	check(
		"write-ahead tail inside cwd allows",
		resolveScopeTarget(cwdDir, realScopeRoots, "inside/newdir/deeper/new.md").scope,
		"allow",
	);
	check(
		"tmp subtree absolute path allows",
		resolveScopeTarget(cwdDir, realScopeRoots, path.join(os.tmpdir(), "cwd-scope-probe")).scope,
		"allow",
	);
	check(
		"tmp subtree with non-existent tail allows",
		resolveScopeTarget("/etc", buildAllowedRoots("/etc"), path.join(os.tmpdir(), "probe", "new.md"))
			.scope,
		"allow",
	);

	// --- real-scope mode: out-of-scope territory asks -------------------
	check(
		"absolute /etc path asks",
		resolveScopeTarget(cwdDir, realScopeRoots, "/etc/passwd").scope,
		"ask",
	);
	check(
		"real home probe asks",
		resolveScopeTarget(cwdDir, realScopeRoots, path.join(os.homedir(), "piscope-outside-probe"))
			.scope,
		"ask",
	);
	check(
		"tilde path outside fixture home asks (expanded, not lexical)",
		resolveScopeTarget(cwdDir, realScopeRoots, "~/piscope-outside-probe").scope,
		"ask",
	);
	check(
		"bare tilde asks (resolves to real home)",
		resolveScopeTarget(cwdDir, realScopeRoots, "~").scope,
		"ask",
	);

	// --- F1: pi normalization parity against out-of-scope targets -------
	check(
		"at-prefixed absolute asks (tool strips the @)",
		resolveScopeTarget(cwdDir, realScopeRoots, "@/etc/passwd").scope,
		"ask",
	);
	check(
		"at-prefixed tilde asks (strip then expand)",
		resolveScopeTarget(cwdDir, realScopeRoots, "@~/piscope-outside-probe").scope,
		"ask",
	);
	check(
		"file URL outside scope asks (tool converts it to a path)",
		resolveScopeTarget(cwdDir, realScopeRoots, "file:///etc/passwd").scope,
		"ask",
	);
	check(
		"invalid file URL asks (pi's converter throws on it too)",
		resolveScopeTarget(cwdDir, realScopeRoots, "file://host/x").scope,
		"ask",
	);
	const atName = resolveScopeTarget(cwdDir, realScopeRoots, "@name");
	check("relative at-name stays in-cwd literal", atName.scope, "allow");
	check("relative at-name resolves where the tool resolves it", atName.path, path.join(cwdDir, "name"));
	const doubleAt = resolveScopeTarget(cwdDir, realScopeRoots, "@@/etc/passwd");
	check("only one leading @ is stripped (pi parity)", doubleAt.scope, "allow");
	check(
		"double-at remainder stays relative literal",
		doubleAt.path,
		path.join(cwdDir, "@", "etc", "passwd"),
	);

	// --- custom-root mode: escapes and divergence classes ---------------
	check(
		"out-of-scope sibling absolute asks",
		resolveScopeTarget(cwdDir, customRoots, outFile).scope,
		"ask",
	);
	check(
		"symlink escape through planted link asks",
		resolveScopeTarget(cwdDir, customRoots, "link-out/sub/target.txt").scope,
		"ask",
	);
	check(
		"symlink-then-dotdot divergence asks (lexical inside, kernel outside)",
		resolveScopeTarget(cwdDir, customRoots, "link-out/../planted").scope,
		"ask",
	);
	check(
		"dotdot escape above cwd asks",
		resolveScopeTarget(cwdDir, customRoots, "inside/../../../etc/passwd").scope,
		"ask",
	);
	check(
		"write-ahead tail out of scope asks",
		resolveScopeTarget(cwdDir, customRoots, path.join(outsideDir, "not-yet", "new.md")).scope,
		"ask",
	);
	check(
		"reverse symlink (outside link into scope) asks: lexical candidate stays outside",
		resolveScopeTarget(cwdDir, customRoots, linkIn).scope,
		"ask",
	);

	// --- F2: dangling FINAL symlinks resolve to the create location -----
	check(
		"dangling final symlink to outside asks (write would create there)",
		resolveScopeTarget(cwdDir, customRoots, "dangle-out").scope,
		"ask",
	);
	check(
		"dangling symlink chain asks",
		resolveScopeTarget(cwdDir, customRoots, "dangle-chain-a").scope,
		"ask",
	);
	check(
		"dangling symlink to inside allows (create lands in scope)",
		resolveScopeTarget(cwdDir, customRoots, "dangle-in").scope,
		"allow",
	);

	// --- F3: unopenable classes stay safe by construction ----------------
	check(
		"symlink loop pair: verdict allow (safe by construction)",
		resolveScopeTarget(cwdDir, customRoots, "loop-a").scope,
		"allow",
	);
	let loopErr = "no-error";
	try {
		fs.openSync(loopA, "w");
	} catch (err) {
		loopErr = err.code;
	}
	check("symlink loop pair: open attempt fails ELOOP", loopErr, "ELOOP");
	const lockedDir = path.join(fixtureRoot, "locked");
	const lockedPlaceholder = path.join(lockedDir, "placeholder.txt");
	const dangleEacc = path.join(cwdDir, "dangle-eacc");
	fs.symlinkSync(path.join(lockedDir, "secret.txt"), dangleEacc, "file");
	fs.mkdirSync(lockedDir);
	fs.writeFileSync(lockedPlaceholder, "fixture");
	fs.chmodSync(lockedDir, 0o000);
	try {
		let realpathProbe = "ok";
		try {
			fs.realpathSync(lockedPlaceholder);
		} catch (err) {
			realpathProbe = err.code;
		}
		if (realpathProbe === "EACCES") {
			check(
				"permission-denied ancestor: verdict allow, tool fails later",
				resolveScopeTarget(cwdDir, customRoots, "dangle-eacc").scope,
				"allow",
			);
			let openErr = "no-error";
			try {
				fs.openSync(dangleEacc, "w");
			} catch (err) {
				openErr = err.code;
			}
			check("permission-denied ancestor: open attempt fails EACCES", openErr, "EACCES");
		} else {
			check(
				`permission-denied fixture not portable (${realpathProbe}); kernel resolves it, target candidate asks`,
				resolveScopeTarget(cwdDir, customRoots, "dangle-eacc").scope,
				"ask",
			);
		}
	} finally {
		fs.chmodSync(lockedDir, 0o700);
	}

	// --- custom-root mode: extra roots widen scope ----------------------
	const extraRoots = parseExtraRoots(outsideDir);
	check("parseExtraRoots realpaths the entry", JSON.stringify(extraRoots), JSON.stringify([outsideDir]));
	const widenedRoots = buildAllowedRoots(cwdDir, extraRoots, customTmpDir);
	check(
		"the extra root itself allows (exact root match)",
		resolveScopeTarget(cwdDir, widenedRoots, outsideDir).scope,
		"allow",
	);
	check(
		"extra root target allows once widened",
		resolveScopeTarget(cwdDir, widenedRoots, outFile).scope,
		"allow",
	);
	check(
		"territory beside the extra root still asks",
		resolveScopeTarget(cwdDir, widenedRoots, path.join(fixtureRoot, "loose.txt")).scope,
		"ask",
	);

	// --- DC-3: a declared root sanctions both of its names ---------------
	const dualRoots = buildAllowedRoots(cwdDir, parseExtraRoots(linkExtra), customTmpDir);
	check(
		"declared root reachable by its literal name allows",
		resolveScopeTarget(cwdDir, dualRoots, linkExtra).scope,
		"allow",
	);
	check(
		"declared root subtree reachable via literal name allows",
		resolveScopeTarget(cwdDir, dualRoots, path.join(linkExtra, "sub", "target.txt")).scope,
		"allow",
	);

	// --- extra roots env wiring -----------------------------------------
	check("EXTRA_ROOTS_ENV names PISCOPE_EXTRA_ROOTS", EXTRA_ROOTS_ENV, "PISCOPE_EXTRA_ROOTS");

	// --- verdict detail strings -----------------------------------------
	const askVerdict = resolveScopeTarget(cwdDir, customRoots, "/etc/passwd");
	checkContains("ask detail names the escaping candidate", askVerdict.detail, "/etc/passwd");
	check("ask verdict echoes the lexical path", askVerdict.path, "/etc/passwd");
	const allowVerdict = resolveScopeTarget(cwdDir, customRoots, inFile);
	checkContains("allow detail names a root", allowVerdict.detail, cwdDir);
	check("allow verdict echoes the lexical path", allowVerdict.path, inFile);

	// --- non-string and unusable input fails closed to ask --------------
	const unusableInputs = [null, undefined, 42, {}, ["x"], ""];
	for (const raw of unusableInputs) {
		check(
			`unusable input ${JSON.stringify(raw)} asks`,
			resolveScopeTarget(cwdDir, customRoots, raw).scope,
			"ask",
		);
	}
	check(
		"unusable input verdict path echoes String(raw)",
		resolveScopeTarget(cwdDir, customRoots, 42).path,
		"42",
	);

	// --- buildAllowedRoots resolution -----------------------------------
	check(
		"buildAllowedRoots realpaths the session cwd",
		buildAllowedRoots(linkCwd, [], customTmpDir)[0],
		cwdDir,
	);
	check(
		"buildAllowedRoots includes the tmp root",
		buildAllowedRoots(cwdDir, [], customTmpDir).includes(customTmpDir),
		true,
	);
	check(
		"buildAllowedRoots dedupes repeated roots",
		buildAllowedRoots(cwdDir, [cwdDir, cwdDir], customTmpDir).length,
		new Set([cwdDir, customTmpDir]).size,
	);

	// --- parseExtraRoots malformed entries ------------------------------
	check("parseExtraRoots undefined yields none", parseExtraRoots(undefined).length, 0);
	check("parseExtraRoots empty string yields none", parseExtraRoots("").length, 0);
	check("parseExtraRoots blank string yields none", parseExtraRoots("   ").length, 0);

	let warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => {
		warnings.push(args.join(" "));
	};
	try {
		check("relative entry ignored", parseExtraRoots("rel/without/lead").length, 0);
		check("relative entry warned", warnings.length, 1);
		warnings = [];
		check("unresolvable entry ignored", parseExtraRoots(path.join(fixtureRoot, "missing-zz")).length, 0);
		check("unresolvable entry warned", warnings.length, 1);
		warnings = [];
		const mixed = [cwdDir, path.join(fixtureRoot, "missing-zz"), "rel/x"].join(":");
		check(
			"mixed entries keep only the resolvable absolute one",
			JSON.stringify(parseExtraRoots(mixed)),
			JSON.stringify([cwdDir]),
		);
		check("each malformed entry warned once", warnings.length, 2);
		warnings = [];
		check(
			"trailing colon tolerated without warning",
			JSON.stringify(parseExtraRoots(`${cwdDir}:`)),
			JSON.stringify([cwdDir]),
		);
		check("trailing colon emits no warning", warnings.length, 0);
		warnings = [];
		check(
			"symlinked entry stores literal and realpath forms",
			JSON.stringify(parseExtraRoots(linkExtra)),
			JSON.stringify([linkExtra, outsideDir]),
		);
	} finally {
		console.warn = originalWarn;
	}

	// --- fence config: tracked defaults + optional local overlay --------
	// Three extra-root sources union into the allowed set: the tracked
	// workspace-fence.config.json beside the module (portable defaults,
	// tilde-spelled), the optional untracked workspace-fence.local.json
	// overlay beside it (machine-dependent), and PISCOPE_EXTRA_ROOTS.
	// Config parsing pins the strict flat shape: unknown keys warn and
	// are skipped, a malformed document warns and contributes nothing,
	// entries expand a leading tilde against the suite's fixture home,
	// and each resolvable entry lands in both its literal and realpath
	// forms exactly like env entries. Sources only ever add: nothing in
	// them can remove the cwd or tmp roots from the union.
	const configDir = path.join(fixtureRoot, "config-fixture");
	fs.mkdirSync(configDir, { recursive: true });
	const configSkillDir = path.join(fakeHome, "skills");
	fs.mkdirSync(configSkillDir, { recursive: true });
	const configLink = path.join(configDir, "link-root");
	fs.symlinkSync(outsideDir, configLink, "dir");

	check(
		"config valid shape parses its roots",
		JSON.stringify(parseFenceConfig(JSON.stringify({ extraRoots: [outsideDir, outsideSubDir] }), "valid.json", fakeHome)),
		JSON.stringify([outsideDir, outsideSubDir]),
	);
	check(
		"config without the extraRoots key parses to nothing",
		parseFenceConfig(JSON.stringify({}), "empty.json", fakeHome).length,
		0,
	);

	const originalConfigWarn = console.warn;
	const configWarnings = [];
	console.warn = (...args) => {
		configWarnings.push(args.join(" "));
	};
	try {
		check(
			"config unknown keys tolerate the known shape",
			JSON.stringify(parseFenceConfig(JSON.stringify({ extraRoots: [outsideDir], future: 1, another: "x" }), "unknown.json", fakeHome)),
			JSON.stringify([outsideDir]),
		);
		check("config warns once per unknown key", configWarnings.length, 2);
		checkContains("unknown-key warning names the key", configWarnings.join("\n"), "future");

		configWarnings.length = 0;
		check(
			"config __proto__ key warns as unknown and contributes nothing",
			parseFenceConfig('{"__proto__": {"extraRoots": ["' + outsideDir + '"]}}', "proto.json", fakeHome).length,
			0,
		);
		check("config __proto__ key warned exactly once", configWarnings.length, 1);
		checkContains("config __proto__ warning names the key", configWarnings.join("\n"), "__proto__");
		check("config __proto__ key does not pollute Object.prototype", "extraRoots" in {}, false);

		configWarnings.length = 0;
		check(
			"config invalid JSON parses to nothing",
			parseFenceConfig("{not json", "broken.json", fakeHome).length,
			0,
		);
		check("config invalid JSON warned", configWarnings.length, 1);
		check(
			"config non-object top level parses to nothing",
			parseFenceConfig(JSON.stringify(["/tmp"]), "array.json", fakeHome).length,
			0,
		);
		check(
			"config non-array extraRoots parses to nothing",
			parseFenceConfig(JSON.stringify({ extraRoots: "/tmp" }), "scalar.json", fakeHome).length,
			0,
		);
		check("each malformed document warned", configWarnings.length, 3);

		configWarnings.length = 0;
		check(
			"config non-string entries ignored",
			parseFenceConfig(JSON.stringify({ extraRoots: [7, null] }), "types.json", fakeHome).length,
			0,
		);
		check("each non-string entry warned", configWarnings.length, 2);

		configWarnings.length = 0;
		check(
			"config empty-string entries skip quietly",
			parseFenceConfig(JSON.stringify({ extraRoots: [""] }), "blank.json", fakeHome).length,
			0,
		);
		check("config empty-string entries emit no warning", configWarnings.length, 0);
		check(
			"config relative entries ignored",
			parseFenceConfig(JSON.stringify({ extraRoots: ["rel/without/lead"] }), "relative.json", fakeHome).length,
			0,
		);
		check("config relative entry warned", configWarnings.length, 1);
		check(
			"config unresolvable entries ignored",
			parseFenceConfig(JSON.stringify({ extraRoots: [path.join(fixtureRoot, "missing-cfg")] }), "missing.json", fakeHome).length,
			0,
		);
		check("config unresolvable entry warned", configWarnings.length, 2);
		checkContains(
			"config warning names the declaring file",
			configWarnings.join("\n"),
			"missing.json",
		);

		configWarnings.length = 0;
		check(
			"loader treats an absent tracked config as empty but warned",
			loadFenceConfigRoots(path.join(configDir, "no-such.json"), path.join(configDir, "no-overlay.json"), fakeHome).length,
			0,
		);
		check("absent tracked config warned", configWarnings.length, 1);
		check(
			"config mid-word tilde stays literal and drops as relative",
			parseFenceConfig(JSON.stringify({ extraRoots: ["foo~bar"] }), "midword.json", fakeHome).length,
			0,
		);
	} finally {
		console.warn = originalConfigWarn;
	}

	check(
		"config tilde entries expand against home",
		JSON.stringify(parseFenceConfig(JSON.stringify({ extraRoots: ["~/skills", "~"] }), "tilde.json", fakeHome)),
		JSON.stringify([configSkillDir, fakeHome]),
	);
	check(
		"config symlinked entry stores literal and realpath forms",
		JSON.stringify(parseFenceConfig(JSON.stringify({ extraRoots: [configLink] }), "link.json", fakeHome)),
		JSON.stringify([configLink, outsideDir]),
	);

	// loader: tracked file + optional overlay union, order-stable
	const trackedConfigPath = path.join(configDir, "tracked.json");
	const overlayConfigPath = path.join(configDir, "overlay.json");
	const absentOverlayPath = path.join(configDir, "no-such-overlay.json");
	fs.writeFileSync(trackedConfigPath, JSON.stringify({ extraRoots: [outsideDir] }));
	fs.writeFileSync(overlayConfigPath, JSON.stringify({ extraRoots: [configSkillDir] }));
	check(
		"loader unions tracked config and overlay roots",
		JSON.stringify(loadFenceConfigRoots(trackedConfigPath, overlayConfigPath, fakeHome)),
		JSON.stringify([outsideDir, configSkillDir]),
	);
	check(
		"loader tolerates an absent overlay silently",
		JSON.stringify(loadFenceConfigRoots(trackedConfigPath, absentOverlayPath, fakeHome)),
		JSON.stringify([outsideDir]),
	);
	check(
		"loader dedupes roots the overlay repeats",
		JSON.stringify(loadFenceConfigRoots(trackedConfigPath, trackedConfigPath, fakeHome)),
		JSON.stringify([outsideDir]),
	);

	// config + env union: the composition the factory evaluates lazily
	const envOnlyDir = path.join(fixtureRoot, "env-only");
	const envOnlyFile = path.join(envOnlyDir, "target.txt");
	fs.mkdirSync(envOnlyDir, { recursive: true });
	fs.writeFileSync(envOnlyFile, "fixture");
	const previousExtraRoots = process.env[EXTRA_ROOTS_ENV];
	process.env[EXTRA_ROOTS_ENV] = envOnlyDir;
	try {
		const configEnvUnion = buildAllowedRoots(
			cwdDir,
			[
				...loadFenceConfigRoots(trackedConfigPath, absentOverlayPath, fakeHome),
				...parseExtraRoots(process.env[EXTRA_ROOTS_ENV]),
			],
			customTmpDir,
		);
		check(
			"config root allows alongside an env root",
			resolveScopeTarget(cwdDir, configEnvUnion, outFile).scope,
			"allow",
		);
		check(
			"env root allows alongside a config root",
			resolveScopeTarget(cwdDir, configEnvUnion, envOnlyFile).scope,
			"allow",
		);
		check(
			"target outside every union source still asks",
			resolveScopeTarget(cwdDir, configEnvUnion, "/etc/passwd").scope,
			"ask",
		);
	} finally {
		if (previousExtraRoots === undefined) delete process.env[EXTRA_ROOTS_ENV];
		else process.env[EXTRA_ROOTS_ENV] = previousExtraRoots;
	}

	// defaults loading: the tracked file beside the module carries
	// exactly the two portable tilde defaults and they load against the
	// real home through the loader the factory runs
	const moduleDir = path.resolve(import.meta.dirname, "..", "extensions");
	const trackedDefaultsPath = path.join(moduleDir, FENCE_CONFIG_FILE);
	check(
		"tracked config declares exactly the two portable tilde defaults",
		JSON.stringify(JSON.parse(fs.readFileSync(trackedDefaultsPath, "utf-8")).extraRoots),
		JSON.stringify(["~/.agents/skills", "~/.pi/agent/install"]),
	);
	const realDefaults = loadFenceConfigRoots(
		trackedDefaultsPath,
		path.join(moduleDir, FENCE_LOCAL_CONFIG_FILE),
		os.homedir(),
	);
	check(
		"defaults include the tilde-expanded skills root",
		realDefaults.includes(path.join(os.homedir(), ".agents", "skills")),
		true,
	);
	check(
		"defaults include the tilde-expanded install root",
		realDefaults.includes(path.join(os.homedir(), ".pi", "agent", "install")),
		true,
	);

	// lazy memo beside the seal: the union evaluates once, later calls
	// reuse it, reset re-evaluates under changed files or env
	resetFenceExtraRoots();
	const firstUnion = fenceExtraRoots();
	check("fence extra roots memoize to a single evaluation", fenceExtraRoots() === firstUnion, true);
	check(
		"memoized union carries the tilde-expanded defaults",
		firstUnion.includes(path.join(os.homedir(), ".agents", "skills")),
		true,
	);
	check(
		"memoized union carries the tilde-expanded install root",
		firstUnion.includes(path.join(os.homedir(), ".pi", "agent", "install")),
		true,
	);
	resetFenceExtraRoots();

	// the per-source breakdown behind the union: the spawn composition
	// consumes the same three sources the gate enforces, split by origin
	resetFenceExtraRoots();
	const previousSourcesEnv = process.env[EXTRA_ROOTS_ENV];
	process.env[EXTRA_ROOTS_ENV] = outsideDir;
	try {
		const sources = fenceExtraRootSources();
		check("the source breakdown memoizes across calls", fenceExtraRootSources() === sources, true);
		check(
			"the source breakdown keeps the tracked config source",
			sources.configRoots.includes(path.join(os.homedir(), ".agents", "skills")),
			true,
		);
		check("the source breakdown parses the env source", sources.envRoots.includes(outsideDir), true);
		check("the source breakdown leaves the overlay source empty without a local file", sources.overlayRoots.length, 0);
		const union = fenceExtraRoots();
		check("the union memoizes across the sources call", fenceExtraRoots() === union, true);
		check(
			"the union stays the merged view of the three sources",
			JSON.stringify(union),
			JSON.stringify([...new Set([...sources.configRoots, ...sources.overlayRoots, ...sources.envRoots])]),
		);
	} finally {
		if (previousSourcesEnv === undefined) delete process.env[EXTRA_ROOTS_ENV];
		else process.env[EXTRA_ROOTS_ENV] = previousSourcesEnv;
	}
	resetFenceExtraRoots();

	// --- env-integrated roots: PISCOPE_EXTRA_ROOTS set around the case --
	const envKey = EXTRA_ROOTS_ENV;
	const previous = process.env[envKey];
	process.env[envKey] = outsideDir;
	try {
		const envRoots = buildAllowedRoots(cwdDir, parseExtraRoots(process.env[envKey]), customTmpDir);
		check(
			"env-declared extra root allows its subtree",
			resolveScopeTarget(cwdDir, envRoots, outFile).scope,
			"allow",
		);
	} finally {
		if (previous === undefined) delete process.env[envKey];
		else process.env[envKey] = previous;
	}
	check(
		"without the env root the same target asks",
		resolveScopeTarget(cwdDir, customRoots, outFile).scope,
		"ask",
	);
	check(
		"roots array carrying an empty entry still asks outside targets",
		resolveScopeTarget(cwdDir, [...customRoots, ""], "/etc/passwd").scope,
		"ask",
	);

	// --- boundary-name verdicts: unicode space inside a root name -------
	// pi converts unicode spaces in tool input before resolving; the
	// gate must too. Without the mirror, input spelled in the unicode
	// form matched a unicode-named extra root literally while the tool
	// opened the ascii-space sibling outside scope (silent allow).
	const unicodeOutsideDir = path.join(fixtureRoot, "out\u00A0side-root");
	fs.mkdirSync(unicodeOutsideDir, { recursive: true });
	const unicodeRoots = buildAllowedRoots(cwdDir, parseExtraRoots(unicodeOutsideDir), customTmpDir);
	check(
		"unicode-form input to a unicode-named root asks (tool opens the ascii sibling)",
		resolveScopeTarget(cwdDir, unicodeRoots, path.join(unicodeOutsideDir, "created.txt")).scope,
		"ask",
	);
	check(
		"ascii-form sibling of a unicode-named root asks",
		resolveScopeTarget(cwdDir, unicodeRoots, path.join(fixtureRoot, "out side-root", "created.txt")).scope,
		"ask",
	);

	// --- A5 seal machinery: fixture install trees ------------------------
	const fakeBodies = Object.fromEntries(
		SEAL_DIGEST_FILES.map((rel, index) => [rel, `body ${index} for ${rel}`]),
	);
	const fakePins = Object.fromEntries(
		Object.entries(fakeBodies).map(([rel, body]) => [
			rel,
			createHash("sha256").update(body).digest("hex"),
		]),
	);
	function plantFakeInstall(baseDir, version) {
		const installDir = path.join(baseDir, "install");
		const versionFile = path.join(installDir, "current-version");
		fs.mkdirSync(path.dirname(versionFile), { recursive: true });
		fs.writeFileSync(versionFile, `${version}\n`);
		const dist = path.join(
			installDir, "releases", version,
			"node_modules", "@earendil-works", "pi-coding-agent", "dist",
		);
		for (const rel of SEAL_DIGEST_FILES) {
			fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
			fs.writeFileSync(path.join(dist, rel), fakeBodies[rel]);
		}
		return { installDir, dist };
	}
	const sealBase = path.join(fixtureRoot, "seal-install");
	const fakeInstall = plantFakeInstall(sealBase, "9.9.9-fake");
	check(
		"release resolution pins through the current-version pointer",
		resolveRunningRelease(fakeInstall.installDir, import.meta.filename),
		fakeInstall.dist,
	);
	const brokenInstall = plantFakeInstall(path.join(fixtureRoot, "seal-install-traversal"), "../../evil");
	check(
		"release resolution rejects a traversal version pointer",
		resolveRunningRelease(brokenInstall.installDir, import.meta.filename),
		null,
	);
	const dotInstall = plantFakeInstall(path.join(fixtureRoot, "seal-install-dot"), "..");
	check(
		"release resolution rejects the dot-dot version pointer",
		resolveRunningRelease(dotInstall.installDir, import.meta.filename),
		null,
	);
	const dotSelfInstall = plantFakeInstall(path.join(fixtureRoot, "seal-install-dotself"), ".");
	check(
		"release resolution rejects the bare-dot version pointer",
		resolveRunningRelease(dotSelfInstall.installDir, import.meta.filename),
		null,
	);
	const emptyInstall = path.join(fixtureRoot, "seal-install-empty");
	fs.mkdirSync(emptyInstall, { recursive: true });
	check(
		"release resolution degrades without a current-version file",
		resolveRunningRelease(emptyInstall, import.meta.filename),
		null,
	);
	const orphanInstall = plantFakeInstall(path.join(fixtureRoot, "seal-install-orphan"), "9.9.9-orphan");
	fs.rmSync(orphanInstall.dist, { recursive: true, force: true });
	check(
		"release resolution degrades when the pinned release tree is missing",
		resolveRunningRelease(orphanInstall.installDir, import.meta.filename),
		null,
	);
	check(
		"argv walk finds the release from an entry deep inside it",
		resolveRunningRelease("", path.join(fakeInstall.dist, "core", "tools", "write.js")),
		fakeInstall.dist,
	);
	check(
		"argv walk degrades from an entry with no release ancestor",
		resolveRunningRelease("", path.join(emptyInstall, "entry.js")),
		null,
	);
	check("argv walk degrades without a usable entry file", resolveRunningRelease("", ""), null);
	check(
		"digest of a fixture file matches its content hash",
		computeFileDigest(path.join(fakeInstall.dist, "utils", "paths.js")),
		fakePins["utils/paths.js"],
	);
	check(
		"digest of missing file is null, never a throw",
		computeFileDigest(path.join(sealBase, "no-such-file")),
		null,
	);
	check(
		"seal evaluates clean when every digest matches its pin",
		JSON.stringify(evaluateSealState(fakePins, fakeInstall.dist)),
		JSON.stringify({ degraded: false, reasons: [] }),
	);
	const driftSeal = evaluateSealState(
		{ ...fakePins, "core/tools/write.js": "0".repeat(64) },
		fakeInstall.dist,
	);
	check("seal degrades on digest drift", driftSeal.degraded, true);
	checkContains("drift reason names the drifted file", driftSeal.reasons.join("; "), "core/tools/write.js");
	const incompletePins = { ...fakePins };
	delete incompletePins["core/tools/edit.js"];
	check(
		"seal degrades when a digest-set file has no pin",
		evaluateSealState(incompletePins, fakeInstall.dist).degraded,
		true,
	);
	fs.rmSync(path.join(fakeInstall.dist, "core", "tools", "ls.js"));
	const missingFileSeal = evaluateSealState(fakePins, fakeInstall.dist);
	check("seal degrades on an unreadable digest-set file", missingFileSeal.degraded, true);
	checkContains("unreadable reason names the missing file", missingFileSeal.reasons.join("; "), "core/tools/ls.js");
	check(
		"seal degrades without a resolvable release",
		evaluateSealState(fakePins, null).degraded,
		true,
	);

	// --- degraded seal feeds the verdict decision surface ----------------
	const degradedSeal = {
		degraded: true,
		reasons: ["core/tools/write.js changed since its digest was pinned (drift or upgrade)"],
	};
	const sealedAsk = resolveScopeTarget(cwdDir, customRoots, inFile, fakeHome, degradedSeal);
	check("degraded seal turns an in-scope path into ask", sealedAsk.scope, "ask");
	checkContains("degraded ask detail names the drift", sealedAsk.detail, "core/tools/write.js");
	checkContains("degraded ask detail is actionable", sealedAsk.detail, "re-pinned");
	const cleanSeal = { degraded: false, reasons: [] };
	check(
		"clean seal leaves the verdict machinery untouched",
		resolveScopeTarget(cwdDir, customRoots, inFile, fakeHome, cleanSeal).scope,
		"allow",
	);

	// --- DC-1 hardened canary (amended ruling) ---------------------------
	// Resolution is pinned through the managed install's current-version
	// pointer (never a version glob): every pointer miss, invalid
	// version, missing digest-set file, unreadable file, or digest drift
	// is a HARD failure (throw or FAIL), never a skip. Digest pins over
	// the eight transform-bearing files force a corpus refresh on any
	// upstream change; the parity corpus then proves the replicated
	// transforms still match the release's own normalizers.
	const installDir = process.env.PI_MANAGED_INSTALL_ROOT
		? path.resolve(process.env.PI_MANAGED_INSTALL_ROOT)
		: path.resolve(import.meta.dirname, "..", "..", "..", "install");
	const versionFile = [
		path.join(installDir, "current-version"),
		path.join(installDir, "install", "current-version"),
	].find((candidate) => fs.existsSync(candidate));
	if (versionFile === undefined) {
		throw new Error(`canary: no current-version pointer under ${installDir}`);
	}
	const releaseVersion = fs.readFileSync(versionFile, "utf-8").trim();
	if (!/^[A-Za-z0-9._+-]+$/.test(releaseVersion)) {
		throw new Error(`canary: unusable version "${releaseVersion}" in ${versionFile}`);
	}
	const suiteReleaseDist = path.join(
		path.dirname(versionFile), "releases", releaseVersion,
		"node_modules", "@earendil-works", "pi-coding-agent", "dist",
	);
	if (!fs.statSync(suiteReleaseDist).isDirectory()) {
		throw new Error(`canary: release dist missing at ${suiteReleaseDist}`);
	}
	check(
		"canary resolution matches the release resolver's current-version pin",
		resolveRunningRelease(installDir, import.meta.filename),
		suiteReleaseDist,
	);
	for (const rel of SEAL_DIGEST_FILES) {
		const digestFile = path.join(suiteReleaseDist, rel);
		if (!fs.existsSync(digestFile)) {
			throw new Error(`canary: digest-set file missing from the running release: ${rel} under ${suiteReleaseDist}`);
		}
		check(`digest pin over the running release: ${rel}`, computeFileDigest(digestFile), RELEASE_DIGEST_PINS[rel]);
	}
	check(
		"seal evaluates clean against the resolved running release",
		JSON.stringify(evaluateSealState(RELEASE_DIGEST_PINS, suiteReleaseDist)),
		JSON.stringify({ degraded: false, reasons: [] }),
	);
	const releasePaths = await import(pathToFileURL(path.join(suiteReleaseDist, "utils", "paths.js")).href);
	const releasePathUtils = await import(
		pathToFileURL(path.join(suiteReleaseDist, "core", "tools", "path-utils.js")).href
	);
	const releaseNormalizePath = releasePaths.normalizePath;
	const releaseResolveToCwd = releasePathUtils.resolveToCwd;
	if (typeof releaseNormalizePath !== "function" || typeof releaseResolveToCwd !== "function") {
		throw new Error(`canary: modules under ${suiteReleaseDist} did not export normalizePath/resolveToCwd`);
	}
	const toolNormalizeOptions = { normalizeUnicodeSpaces: true, stripAtPrefix: true, homeDir: fakeHome };
	const axisProbes = [
		"@/abs",
		"@~/x",
		"@@x",
		"@name",
		"@file:///etc/passwd",
		"~",
		"~/rel",
		"~user",
		"foo~bar",
		"file:///abs",
		"file://localhost/etc",
		"/abs/plain",
		"rel/path",
		"  /abs/leading-space",
		"/abs/trailing-space  ",
		"/abs/with space",
	];
	for (const probe of axisProbes) {
		check(
			`canary normalize parity (axis): ${JSON.stringify(probe)}`,
			normalizeToolInputPath(probe, fakeHome),
			releaseNormalizePath(probe, toolNormalizeOptions),
		);
		check(
			`canary resolve parity (axis): ${JSON.stringify(probe)}`,
			lexicalResolvePath(cwdDir, probe),
			releaseResolveToCwd(probe, cwdDir),
		);
	}
	const unicodeSpaceChars = [
		"\u00A0",
		"\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
		"\u2006", "\u2007", "\u2008", "\u2009", "\u200A",
		"\u202F", "\u205F", "\u3000",
	];
	const latticeTemplates = [
		(u) => `~/out${u}side/x`,
		(u) => `/abs/out${u}side/x`,
		(u) => `@/abs/out${u}side/x`,
		(u) => `file:///abs/out${u}side/x`,
		(u) => `rel${u}name/x`,
	];
	for (const unicodeChar of unicodeSpaceChars) {
		for (const template of latticeTemplates) {
			const probe = template(unicodeChar);
			check(
				`canary normalize parity (unicode lattice): ${JSON.stringify(probe)}`,
				normalizeToolInputPath(probe, fakeHome),
				releaseNormalizePath(probe, toolNormalizeOptions),
			);
			check(
				`canary resolve parity (unicode lattice): ${JSON.stringify(probe)}`,
				lexicalResolvePath(cwdDir, probe),
				releaseResolveToCwd(probe, cwdDir),
			);
		}
	}
	check(
		"unicode-space input normalizes to its ascii-space counterpart",
		normalizeToolInputPath("/abs/out\u00A0side/x", fakeHome),
		normalizeToolInputPath("/abs/out side/x", fakeHome),
	);
	check(
		"release normalizer agrees on the unicode-to-ascii direction",
		releaseNormalizePath("/abs/out\u00A0side/x", toolNormalizeOptions),
		releaseNormalizePath("/abs/out side/x", toolNormalizeOptions),
	);

	// --- extension shape: the default export pi's loader requires -------
	// extensions/ is live-loaded at startup and a module without a
	// default-exported factory function fails the session's startup (the
	// 1-1 integration incident). A recording stub pins the registration
	// shape the permission-gate precedent uses.
	check("extension default export is a factory function", typeof cwdScopeGate, "function");
	// strip the ambient forwarding env so the factory pins below run the
	// handler unprovisioned; the try's finally restores the snapshot
	delete process.env[CHILD_ASK_ROOT_ENV];
	delete process.env[CHILD_ASK_TOKEN_ENV];
	const registered = [];
	const stubPi = {
		on(name, handler) {
			registered.push({ name, handler });
		},
	};
	cwdScopeGate(stubPi);
	check("factory registers exactly one handler", registered.length, 1);
	check("factory registers on tool_call", registered[0] ? registered[0].name : "none", "tool_call");
	check(
		"tool_call handler is async",
		registered[0] ? registered[0].handler.constructor.name : "missing",
		"AsyncFunction",
	);

	// The registered handler itself, invoked with a stub ctx: the wire
	// mapping (undefined on pass, { block: true, reason } on refusal or
	// headless) is pinned end to end. Paths here run in real-scope
	// territory (the factory parses the real environment, so the allowed
	// roots are the fixture cwd plus the REAL tmp tree): /etc/passwd is
	// the out-of-scope probe, exactly as in the real-scope mode above.
	const handler = registered[0].handler;
	const ctxWithChoice = (choice) => ({
		cwd: cwdDir,
		hasUI: true,
		ui: { select: async () => choice },
	});
	check(
		"handler passes an in-scope call through untouched",
		await handler({ toolName: "read", input: { path: "inside/file.txt" } }, ctxWithChoice("Yes")),
		undefined,
	);
	// Purity pin on the allow path: pi runs later handlers on any input
	// mutation with no re-validation, so this handler must leave
	// event.input exactly as it found it; a future edit that mutates
	// the input fails here instead of changing composition silently.
	const purityEvent = { toolName: "read", input: { path: "inside/file.txt", extra: { detail: 1 } } };
	const puritySnapshot = structuredClone(purityEvent.input);
	await handler(purityEvent, ctxWithChoice("Yes"));
	check(
		"handler allow path leaves event.input deeply unmutated",
		JSON.stringify(purityEvent.input),
		JSON.stringify(puritySnapshot),
	);
	check(
		"handler passes an approved out-of-scope call",
		await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctxWithChoice("Yes")),
		undefined,
	);
	const handlerRefusal = await handler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		ctxWithChoice("No"),
	);
	check("handler blocks a refused call", handlerRefusal && handlerRefusal.block, true);
	checkContains("handler refusal names the tool", handlerRefusal.reason, "read");
	checkContains("handler refusal names the resolved path", handlerRefusal.reason, "/etc/passwd");
	checkContains("handler refusal names the workspace-fence", handlerRefusal.reason, "blocked by the workspace-fence");
	check("handler refusal drops the stale space-spelled gate name", handlerRefusal.reason.includes("cwd-scope gate"), false);
	const handlerHeadless = await handler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		{ cwd: cwdDir, hasUI: false, ui: { select: async () => "Yes" } },
	);
	check("handler blocks headless without prompting", handlerHeadless && handlerHeadless.block, true);
	checkContains("handler headless block names the remedy", handlerHeadless.reason, "interactively");

	// --- handler decision surface (unit 1-2 wiring) ----------------------
	// decidePathToolCall is the whole tool_call decision as data; the
	// factory's handler maps pass -> undefined, ask -> ctx.ui.select
	// (title, ["Yes", "No"]) with refusal -> block(denyReason), and
	// block -> block(reason). approved carries the prompt answer
	// (undefined = prompt not yet shown) so the post-prompt branches run
	// here without a live session; the seal stays injected for these
	// cases except where the DC-R1 omission path itself is under test.
	const gate = (overrides = {}) =>
		decidePathToolCall({
			toolName: "read",
			input: { path: inFile },
			sessionCwd: cwdDir,
			allowedRoots: customRoots,
			hasUI: true,
			seal: { degraded: false, reasons: [] },
			...overrides,
		});

	check(
		"gated tool set covers exactly the six path tools",
		[...GATED_PATH_TOOLS].sort().join(","),
		"edit,find,grep,ls,read,write",
	);

	// pass-through: in-scope verdicts and ungated tools never prompt
	check(
		"path decider passes non-path tools (bash dispatches to the bash decider)",
		gate({ toolName: "powershell", input: { command: "cat /etc/passwd" } }).action,
		"pass",
	);
	check("in-scope read passes", gate().action, "pass");
	check(
		"in-scope write passes",
		gate({ toolName: "write", input: { path: "inside/new.txt", content: "x" } }).action,
		"pass",
	);
	check(
		"in-scope edit passes",
		gate({ toolName: "edit", input: { path: "inside/file.txt", edits: [] } }).action,
		"pass",
	);
	check("in-scope ls passes", gate({ toolName: "ls", input: { path: "inside" } }).action, "pass");
	check("ls absent path mirrors the tool's cwd default", gate({ toolName: "ls", input: {} }).action, "pass");
	check("ls empty path mirrors the tool's cwd default", gate({ toolName: "ls", input: { path: "" } }).action, "pass");
	check(
		"grep glob metadata never gates an in-scope path",
		gate({ toolName: "grep", input: { pattern: "x", glob: "*.txt" } }).action,
		"pass",
	);
	check(
		"find pattern metadata never gates an in-scope path",
		gate({ toolName: "find", input: { pattern: "*.txt" } }).action,
		"pass",
	);

	// ask: out-of-scope with UI and no prompt answer yet
	const outScope = gate({ input: { path: outFile } });
	check("out-of-scope read asks under UI", outScope.action, "ask");
	checkContains("ask title names the tool", outScope.title, "read");
	checkContains("ask title names the resolved path", outScope.title, outFile);
	checkContains("ask title ends in the prompt", outScope.title, "Allow?");
	checkContains("ask denial reason names the tool", outScope.denyReason, "read");
	checkContains("ask denial reason names the resolved path", outScope.denyReason, outFile);
	checkContains("ask denial reason names the policy", outScope.denyReason, EXTRA_ROOTS_ENV);
	checkContains("ask denial names the tracked config widening path", outScope.denyReason, FENCE_CONFIG_FILE);

	// the ask title quotes the operand, so a typo'd trailing colon (the
	// live incident form) is visible at a glance instead of reading as
	// sentence punctuation
	const colonAsk = gate({ input: { path: colonDir } });
	check("an out-of-scope colon-suffixed operand asks under UI", colonAsk.action, "ask");
	checkContains("the ask title quotes the colon-suffixed operand", colonAsk.title, `"${colonDir}"`);

	const grepOutside = gate({ toolName: "grep", input: { pattern: "x", path: outsideDir, glob: "*.txt" } });
	check("grep with an out-of-scope path asks regardless of glob metadata", grepOutside.action, "ask");

	const unusable = gate({ input: { path: 42 } });
	check("non-string path asks fail-closed under UI", unusable.action, "ask");
	checkContains("unusable-path denial names the defect", unusable.denyReason, "not a usable string");

	const gateDegradedSeal = {
		degraded: true,
		reasons: ["core/tools/write.js changed since its digest was pinned (drift or upgrade)"],
	};
	const degradedGate = gate({ seal: gateDegradedSeal });
	check("degraded seal asks an in-scope path under UI", degradedGate.action, "ask");
	checkContains("degraded ask names the seal reason", degradedGate.title, "digest was pinned");

	// post-prompt branches: approved carries the ctx.ui.select answer
	check("approved out-of-scope call passes", gate({ input: { path: outFile }, approved: true }).action, "pass");
	const refused = gate({ input: { path: outFile }, approved: false });
	check("refused out-of-scope call blocks", refused.action, "block");
	checkContains("refusal reason names the tool", refused.reason, "read");
	checkContains("refusal reason names the resolved path", refused.reason, outFile);

	// headless: fail-closed with the same actionable reason plus the remedy
	const headless = gate({ input: { path: outFile }, hasUI: false });
	check("out-of-scope read blocks headless", headless.action, "block");
	checkContains("headless reason names the resolved path", headless.reason, outFile);
	checkContains("headless reason names the remedy", headless.reason, "interactively");
	check(
		"headless block shares the refusal reason plus its remedy",
		headless.reason.startsWith(refused.reason),
		true,
	);
	check("in-scope read passes headless without prompting", gate({ hasUI: false }).action, "pass");
	check(
		"non-string path blocks headless fail-closed",
		gate({ input: { path: null }, hasUI: false }).action,
		"block",
	);
	check(
		"degraded seal blocks headless",
		gate({ hasUI: false, seal: gateDegradedSeal }).action,
		"block",
	);

	// DC-R1 through the wiring: seal omitted -> the real memoized session
	// seal (clean under a resolvable release, so this passes through).
	check("wiring with omitted seal consumes the real session seal", gate({ seal: undefined }).action, "pass");

	// --- DC-R1: omitted seal means the real session seal, once -----------
	const previousInstallRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	try {
		resetSessionSeal();
		const firstSeal = sessionSealState();
		check("session seal memoizes to a single evaluation", sessionSealState() === firstSeal, true);
		check("first evaluation under a resolvable release is clean", firstSeal.degraded, false);
		check(
			"omitted-seal core call consults the real seal (clean here)",
			resolveScopeTarget(cwdDir, realScopeRoots, inFile).scope,
			"allow",
		);
		check(
			"omitted-seal core call still asks out-of-scope",
			resolveScopeTarget(cwdDir, realScopeRoots, "/etc/passwd").scope,
			"ask",
		);
		process.env.PI_MANAGED_INSTALL_ROOT = path.join(fixtureRoot, "no-such-install");
		resetSessionSeal();
		const degradedOmission = resolveScopeTarget(cwdDir, realScopeRoots, inFile);
		check("omitted seal under an unresolvable release asks", degradedOmission.scope, "ask");
		checkContains("degraded omission names the seal in its detail", degradedOmission.detail, "degraded");
		check(
			"injected seal overrides the memoized session seal",
			resolveScopeTarget(cwdDir, realScopeRoots, inFile, os.homedir(), { degraded: false, reasons: [] }).scope,
			"allow",
		);
	} finally {
		if (previousInstallRoot === undefined) delete process.env.PI_MANAGED_INSTALL_ROOT;
		else process.env.PI_MANAGED_INSTALL_ROOT = previousInstallRoot;
		resetSessionSeal();
	}

	// --- unit 1-3: bash scope pass (AST-backed extraction, PISCOPE-2-2) --
	// The tool_call surface extends to bash: path-like operands and cd
	// targets resolve through the same verdict core as the path tools,
	// substitution-bearing commands bias toward asking (a parsed tree
	// cannot see expansion results either), and in-scope or relative-only
	// commands run unprompted. The detection layer is a tree-sitter-bash
	// AST walk (extensions/fence-ast/bash-scan.ts) behind the exported
	// BashScanResult contract the lexical walker used to produce:
	// substitution is expansion-node presence, operands are argument
	// pieces plus redirect targets and assignment RHS, executor detection
	// reads command_name identity plus the -c flag shape under lexical
	// path-stripped identity (R4), glued -c forms included, and an
	// interposition floor covers command/env/nohup/nice/timeout (R5;
	// Decision Log "User ruling C"); permission-gate stays untouched.
	// Deliberate semantic flips from the lexical scan, each sanctioned in
	// the Decision Log (answer to Blocks Q3, 2026-11-25 09:40): heredocs,
	// comments, grouping, and braces now parse and run unprompted, while
	// ERROR-bearing parses still bail to ask.
	check("bash gated tool set covers exactly bash", [...GATED_BASH_TOOLS].sort().join(","), "bash");

	const bashGate = (overrides = {}) =>
		decideBashToolCall({
			toolName: "bash",
			input: { command: "echo hello" },
			sessionCwd: cwdDir,
			allowedRoots: customRoots,
			hasUI: true,
			seal: { degraded: false, reasons: [] },
			...overrides,
		});

	// pass-through: in-scope and relative-only commands never prompt
	check("bash decider passes non-bash tools", (await bashGate({ toolName: "read" })).action, "pass");
	check(
		"powershell passes ungated (deferred)",
		(await bashGate({ toolName: "powershell", input: { command: "cat /etc/passwd" } })).action,
		"pass",
	);
	check("bare-word-only command passes", (await bashGate({ input: { command: "echo hello" } })).action, "pass");
	check("git status passes", (await bashGate({ input: { command: "git status --short" } })).action, "pass");
	check("relative-only operand passes", (await bashGate({ input: { command: "cat inside/file.txt" } })).action, "pass");
	check("cd within the cwd subtree passes", (await bashGate({ input: { command: "cd inside" } })).action, "pass");
	check(
		"in-scope redirect target passes",
		(await bashGate({ input: { command: "echo done > inside/log.txt" } })).action,
		"pass",
	);
	check("absolute command word is not a path operand", (await bashGate({ input: { command: "/bin/echo hi" } })).action, "pass");
	check(
		"assignment-prefix RHS outside asks (the env form's argv access point)",
		(await bashGate({ input: { command: "OUT=/etc/capture.txt run" } })).action,
		"ask",
	);
	check(
		"lone assignment segment passes (bash only sets the variable)",
		(await bashGate({ input: { command: "X=/etc/capture.txt" } })).action,
		"pass",
	);
	check("in-scope glob operand passes", (await bashGate({ input: { command: "cat inside/*.txt" } })).action, "pass");
	check(
		"in-scope executor payload passes",
		(await bashGate({ input: { command: "bash -c 'cat inside/file.txt'" } })).action,
		"pass",
	);

	// ask: out-of-scope operands and cd targets through the verdict core
	const bashOut = (await bashGate({ input: { command: "cat /etc/passwd" } }));
	check("out-of-scope absolute operand asks", bashOut.action, "ask");
	checkContains("bash ask title names the tool", bashOut.title, "bash");
	checkContains("bash ask title names the resolved path", bashOut.title, "/etc/passwd");
	checkContains("bash ask title ends in the prompt", bashOut.title, "Allow?");
	const bashColon = (await bashGate({ input: { command: `cd ${colonDir}` } }));
	check("an out-of-scope cd to a colon-suffixed target asks", bashColon.action, "ask");
	checkContains("the bash ask title quotes the colon-suffixed operand", bashColon.title, `"${colonDir}"`);
	checkContains(
		"the bash colon ask title carries the cd/pushd provenance",
		bashColon.title,
		"the scope pass extracted it from the cd/pushd target",
	);
	checkContains("bash denial reason names the policy", bashOut.denyReason, EXTRA_ROOTS_ENV);
	check("cd outside the cwd subtree asks", (await bashGate({ input: { command: "cd /etc" } })).action, "ask");
	check("cd to tilde home asks", (await bashGate({ input: { command: "cd ~" } })).action, "ask");
	// F2: cd/pushd targets extract regardless of spelling, so bare and
	// symlinked names route through the core; unresolvable targets ask
	check(
		"cd through a bare symlinked name asks",
		(await bashGate({ input: { command: "cd link-out" } })).action,
		"ask",
	);
	check(
		"pushd through a bare symlinked name asks",
		(await bashGate({ input: { command: "pushd link-out" } })).action,
		"ask",
	);
	check("bare cd asks (home is not lexically resolvable)", (await bashGate({ input: { command: "cd" } })).action, "ask");
	check(
		"cd - asks (OLDPWD is not lexically resolvable)",
		(await bashGate({ input: { command: "cd -" } })).action,
		"ask",
	);
	check("cd .. asks (the parent of the session cwd)", (await bashGate({ input: { command: "cd .." } })).action, "ask");
	check("pushd within the cwd subtree passes", (await bashGate({ input: { command: "pushd inside" } })).action, "pass");
	check(
		"cd option-qualified in-scope target passes",
		(await bashGate({ input: { command: "cd -L inside" } })).action,
		"pass",
	);
	check(
		"dotdot escape via relative operand asks",
		(await bashGate({ input: { command: "cat ../outside/target.txt" } })).action,
		"ask",
	);
	check(
		"bash operand through a planted symlink asks (verdict core reuse)",
		(await bashGate({ input: { command: "cat link-out/sub/target.txt" } })).action,
		"ask",
	);
	check("absolute option value outside asks", (await bashGate({ input: { command: "tool --config=/etc/app.conf" } })).action, "ask");
	check(
		"env-carried argv value outside asks",
		(await bashGate({ input: { command: "env OUT=/etc/capture.txt run" } })).action,
		"ask",
	);
	check("option value in scope passes", (await bashGate({ input: { command: "tool --config=inside/app.conf" } })).action, "pass");
	// DC-1: process-internal and data-null devices exempt from bash
	// operand verdicts only; the path tools still resolve them
	check(
		"redirect to /dev/null passes (data-null device, bash-only exemption)",
		(await bashGate({ input: { command: "make 2>/dev/null" } })).action,
		"pass",
	);
	check(
		"write redirect to /dev/null passes",
		(await bashGate({ input: { command: "echo done > /dev/null" } })).action,
		"pass",
	);
	check(
		"reading /dev/null passes (device as source)",
		(await bashGate({ input: { command: "cat /dev/null" } })).action,
		"pass",
	);
	check(
		"fd-device redirect passes",
		(await bashGate({ input: { command: "echo done > /dev/fd/3" } })).action,
		"pass",
	);
	check(
		"/dev/tty stays gated (it reads user input)",
		(await bashGate({ input: { command: "cat /dev/tty" } })).action,
		"ask",
	);
	check(
		"arbitrary device nodes stay gated",
		(await bashGate({ input: { command: "cat /dev/sda" } })).action,
		"ask",
	);
	check(
		"reading /dev/stdin passes (process-internal stream, same class as stdout/stderr)",
		(await bashGate({ input: { command: "cat /dev/stdin" } })).action,
		"pass",
	);
	check(
		"redirect source /dev/stdin passes",
		(await bashGate({ input: { command: "tr a b < /dev/stdin" } })).action,
		"pass",
	);
	check(
		"redirect to an out-of-scope file still asks",
		(await bashGate({ input: { command: "> /etc/capture.txt" } })).action,
		"ask",
	);
	check(
		"device exemption does not reach the path tools",
		resolveScopeTarget(cwdDir, customRoots, "/dev/null").scope,
		"ask",
	);

	// F1: redirect targets extract wherever they sit; a segment-head one
	// would otherwise read as the executable and pass silently
	check(
		"redirect-only command at segment head asks",
		(await bashGate({ input: { command: `> ${outFile}` } })).action,
		"ask",
	);
	check(
		"append redirect at segment head asks",
		(await bashGate({ input: { command: `echo ok; >> ${outFile}` } })).action,
		"ask",
	);
	check(
		"read-write redirect at segment head asks",
		(await bashGate({ input: { command: `<> ${outFile}` } })).action,
		"ask",
	);
	check(
		"background stream redirect after a command asks",
		(await bashGate({ input: { command: `make &> ${outFile}` } })).action,
		"ask",
	);
	check(
		"fd duplication stays inert",
		(await bashGate({ input: { command: "echo ok 2>&1" } })).action,
		"pass",
	);
	check(
		"input fd duplication stays inert",
		(await bashGate({ input: { command: "cat <&0" } })).action,
		"pass",
	);

	// substitution bias: the scanner cannot see expansion results
	check(
		"command substitution biases toward ask",
		(await bashGate({ input: { command: "echo $(cat inside/file.txt)" } })).action,
		"ask",
	);
	check("backtick substitution biases toward ask", (await bashGate({ input: { command: "cat `ls inside`" } })).action, "ask");
	check("process substitution asks", (await bashGate({ input: { command: "cat <(cat inside/file.txt)" } })).action, "ask");
	check("bare variable expansion biases toward ask", (await bashGate({ input: { command: "cat $HOME/notes" } })).action, "ask");
	check(
		"variable inside quotes biases toward ask",
		(await bashGate({ input: { command: 'cat "$HOME/notes"' } })).action,
		"ask",
	);

	// DC-2: single-quoted spans are inert for the substitution test;
	// double-quoted and unquoted $ and the ANSI-C form still gate
	check(
		"single-quoted awk program passes (bash cannot expand it)",
		(await bashGate({ input: { command: "awk '{print $1}' inside/file.txt" } })).action,
		"pass",
	);
	check(
		"single-quoted literal dollar passes",
		(await bashGate({ input: { command: "grep '\\$' inside/file.txt" } })).action,
		"pass",
	);
	check(
		"single-quoted backticks pass (inert in bash)",
		(await bashGate({ input: { command: "echo '`ls inside`'" } })).action,
		"pass",
	);
	check(
		"ANSI-C quoting still asks (the $ sits outside the stripped span)",
		(await bashGate({ input: { command: "grep $'\\t' inside/file.txt" } })).action,
		"ask",
	);
	check(
		"executor payload dollars still ask (a child shell re-evaluates them)",
		(await bashGate({ input: { command: "bash -c 'echo $HOME/notes'" } })).action,
		"ask",
	);
	check(
		"executor payload bare cd asks",
		(await bashGate({ input: { command: "bash -c 'cd'" } })).action,
		"ask",
	);

	// R1: the quote walker honors backslash escapes, so an escaped quote
	// is a literal apostrophe, never a span opener, and the $ behind it
	// still gates; an escaped dollar is literal and passes
	check(
		"escaped-quote substitution bypass asks",
		(await bashGate({ input: { command: "echo \\' && cat \"$HOME/secrets\"" } })).action,
		"ask",
	);
	check(
		"a lone escaped quote passes (literal apostrophe, nothing live)",
		(await bashGate({ input: { command: "echo \\'" } })).action,
		"pass",
	);
	check(
		"escaped dollar is a literal (walker escape handling)",
		(await bashGate({ input: { command: "cat \\$HOME/notes" } })).action,
		"pass",
	);

	// unmodeled syntax biases toward ask
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): grouping parens
	// used to bail as unmodeled syntax; under the AST the subshell parses
	// and the inner commands' operands gate. The ask verdict is preserved
	// here through operand extraction (cd /etc), not through the bail
	// class.
	check("grouping parens ask", (await bashGate({ input: { command: "(cd /etc && cat passwd)" } })).action, "ask");
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): brace expansion
	// text used to bail as unmodeled syntax; the grammar parses it as a
	// concatenation whose text still gates through the operand core.
	check("brace expansion asks", (await bashGate({ input: { command: "cat /etc/{passwd,group}" } })).action, "ask");
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): a trailing
	// comment used to bail the scan; bash never executes a comment, so
	// the AST walk reads none of it and the command's own operands gate.
	check(
		"trailing comments pass (a comment is inert to bash)",
		(await bashGate({ input: { command: "cat inside/file.txt # trailing note" } })).action,
		"pass",
	);
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): heredocs used to
	// bail the scan; the grammar parses the redirect and the body, the
	// tag is not an operand, and a plain body names nothing, so an
	// in-scope heredoc runs unprompted. Interpolating bodies still ask
	// (their expansions run) and ERROR-bearing parses still bail.
	check("heredocs parse and run unprompted", (await bashGate({ input: { command: "cat << EOF\nbody\nEOF" } })).action, "pass");
	check("unterminated quotes ask", (await bashGate({ input: { command: "cat 'inside/file.txt" } })).action, "ask");
	check("trailing escape asks", (await bashGate({ input: { command: "cat inside/\\" } })).action, "ask");
	// F3: backslash-newline continuations remove the way bash removes
	// them, so the continuation line cannot hide behind the join
	check(
		"glued continuation cannot hide an absolute operand",
		(await bashGate({ input: { command: "cat \\\n/etc/passwd" } })).action,
		"ask",
	);
	check(
		"indented continuation cannot hide an absolute operand",
		(await bashGate({ input: { command: "cat \\\n   /etc/passwd" } })).action,
		"ask",
	);
	check(
		"in-scope continuation passes",
		(await bashGate({ input: { command: "cat \\\ninside/file.txt" } })).action,
		"pass",
	);

	// quoted text gates (R2): the mention exemption was withdrawn by the
	// recorded policy decision (Decision Log "PAUSE EXTENDED", 2026-11-23:
	// fix-later remedy (a) semantics, not accepted-bypass) - a quoted path
	// is the access, not a mention
	check(
		"quoted path mentions ask",
		(await bashGate({ input: { command: 'echo "see /etc/passwd for details"' } })).action,
		"ask",
	);
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): parentheses
	// inside double quotes used to bail as unmodeled syntax; in bash they
	// are literal string data, and the grammar proves it (a string node,
	// no ERROR), so the mention passes while its own words stay inert.
	check(
		"quoted parens in a mention pass (literal data inside quotes under the grammar)",
		(await bashGate({ input: { command: 'grep "(foo" inside/file.txt' } })).action,
		"pass",
	);
	check(
		"quoted out-of-scope operand asks",
		(await bashGate({ input: { command: 'cat "/etc/passwd"' } })).action,
		"ask",
	);
	check(
		"quoted redirect target asks",
		(await bashGate({ input: { command: 'echo x > "/etc/capture.txt"' } })).action,
		"ask",
	);
	check(
		"quoted operand as a copy source asks",
		(await bashGate({ input: { command: 'cp "/etc/passwd" .' } })).action,
		"ask",
	);
	check(
		"quoted assignment-prefix RHS asks",
		(await bashGate({ input: { command: 'X="/etc/capture.txt" run' } })).action,
		"ask",
	);

	// executor shapes gate payload operands inside quotes
	check("bash -c payload outside asks", (await bashGate({ input: { command: "bash -c 'cat /etc/passwd'" } })).action, "ask");
	check("sh -c payload outside asks", (await bashGate({ input: { command: "sh -c 'ls /etc'" } })).action, "ask");
	check("eval payload outside asks", (await bashGate({ input: { command: "eval 'cat /etc/group'" } })).action, "ask");
	check("su -c payload outside asks", (await bashGate({ input: { command: "su -c 'cat /etc/shadow'" } })).action, "ask");
	check("ssh payload outside asks", (await bashGate({ input: { command: "ssh host 'cat /etc/hosts'" } })).action, "ask");
	// an escaped quote before an executor shape must not hide it: the
	// walker reads \' as a literal apostrophe, so the executor tokens
	// stay visible as tokens
	check(
		"an escaped quote cannot hide a bash -c executor payload (the hidden executor asks)",
		(await bashGate({ input: { command: "echo \\' ; bash -c 'cat \"$HOME/secrets\"'" } })).action,
		"ask",
	);
	check(
		"an escaped quote cannot hide an eval executor payload",
		(await bashGate({ input: { command: "echo \\' ; eval 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"an escaped quote cannot hide an executor write payload",
		(await bashGate({ input: { command: "echo \\' ; bash -c 'echo x > \"$HOME/.ssh/authorized_keys\"'" } })).action,
		"ask",
	);
	check(
		"executor word inside a quoted mention does not trigger the raw scan",
		(await bashGate({ input: { command: 'echo "never write bash -c in reports"' } })).action,
		"pass",
	);

	// R4 (review 27): executor identity survives path-qualified spellings -
	// the token's directory prefix strips lexically before identity
	// matching, with no filesystem resolution (a missing /bin/bash still
	// gates; the ask posture keys on the invocation shape)
	check(
		"path-qualified bash executor asks",
		(await bashGate({ input: { command: "/bin/bash -c 'cat \"$HOME/s\"'" } })).action,
		"ask",
	);
	check(
		"relative-path bash executor asks",
		(await bashGate({ input: { command: "./bash -c 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"relative-path sh executor asks",
		(await bashGate({ input: { command: "./sh -c 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"home-anchored bash executor asks",
		(await bashGate({ input: { command: "~/bin/bash -c 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"path-qualified su executor asks",
		(await bashGate({ input: { command: "/bin/su -c 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"path-qualified ssh executor asks",
		(await bashGate({ input: { command: "/usr/bin/ssh host 'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"a missing path-qualified executor still gates (the ask posture keys on the shape)",
		(await bashGate({ input: { command: "/no/such/dir/bash -c 'cat $HOME/x'" } })).action,
		"ask",
	);

	// R5 (review 27): glued -c forms - bash takes a short option's
	// cluster remainder as the -c value, so -c'payload', -c"payload",
	// and -cpayload are the executor shape however the value glues
	check(
		"single-quote-glued -c payload asks",
		(await bashGate({ input: { command: "bash -c'cat $HOME/x'" } })).action,
		"ask",
	);
	check(
		"double-quote-glued -c payload asks",
		(await bashGate({ input: { command: 'bash -c"cat $HOME/x"' } })).action,
		"ask",
	);
	check(
		"bare glued -c cluster with a quoted payload tail asks",
		(await bashGate({ input: { command: "bash -ccat' $HOME/x'" } })).action,
		"ask",
	);
	check(
		"a bare glued -c payload inside the scope passes (detection alone is not the ask)",
		(await bashGate({ input: { command: "bash -cecho hi" } })).action,
		"pass",
	);

	// interposition floors (review 27 / Decision Log "User ruling C"):
	// a command/env/nohup/nice/timeout wrapper before an executor shape
	// asks without scanning through - the wrapper re-executes its
	// arguments and the scanner cannot model what it will run
	check(
		"command-prefixed executor asks",
		(await bashGate({ input: { command: "command bash -c 'cat $X'" } })).action,
		"ask",
	);
	check(
		"env-prefixed executor with a redirect payload asks",
		(await bashGate({ input: { command: "env bash -c 'x > $Y'" } })).action,
		"ask",
	);
	check(
		"env-prefixed executor asks even on an inert payload (the wrapper is the point)",
		(await bashGate({ input: { command: "env bash -c 'echo inside'" } })).action,
		"ask",
	);
	check(
		"nohup-prefixed executor asks",
		(await bashGate({ input: { command: "nohup bash -c 'echo inside'" } })).action,
		"ask",
	);
	check(
		"nice with its flags before an executor asks",
		(await bashGate({ input: { command: "nice -n 5 bash -c 'echo inside'" } })).action,
		"ask",
	);
	check(
		"timeout with a duration before a path-qualified executor asks",
		(await bashGate({ input: { command: "timeout 30 /bin/bash -c 'echo inside'" } })).action,
		"ask",
	);
	check(
		"path-qualified env before an executor asks",
		(await bashGate({ input: { command: "/usr/bin/env bash -c 'echo inside'" } })).action,
		"ask",
	);
	check(
		"command before an eval shape asks",
		(await bashGate({ input: { command: "command eval 'echo inside'" } })).action,
		"ask",
	);

	// bash-only operand overrides ahead of the shared core
	check(
		"~user operand asks (bash expands it, the core keeps it literal)",
		(await bashGate({ input: { command: "cat ~root/.bashrc" } })).action,
		"ask",
	);
	check("glob-plus-dotdot operand asks", (await bashGate({ input: { command: "cat */../secret" } })).action, "ask");

	// unusable inputs fail closed
	check("non-string bash command asks", (await bashGate({ input: { command: 42 } })).action, "ask");
	check("missing bash command asks", (await bashGate({ input: {} })).action, "ask");
	check("empty bash command asks", (await bashGate({ input: { command: "" } })).action, "ask");
	check(
		"unusable session cwd asks",
		(await bashGate({ sessionCwd: "", input: { command: "echo hello" } })).action,
		"ask",
	);

	// degraded seal asks every bash call
	const bashDegraded = (await bashGate({ seal: gateDegradedSeal }));
	check("degraded seal asks even an operand-free command", bashDegraded.action, "ask");
	checkContains("degraded bash ask names the seal reason", bashDegraded.title, "digest was pinned");
	check("degraded seal blocks headless bash", (await bashGate({ hasUI: false, seal: gateDegradedSeal })).action, "block");

	// post-prompt and headless branches
	check(
		"approved out-of-scope bash passes",
		(await bashGate({ input: { command: "cat /etc/passwd" }, approved: true })).action,
		"pass",
	);
	const bashRefused = (await bashGate({ input: { command: "cat /etc/passwd" }, approved: false }));
	check("refused out-of-scope bash blocks", bashRefused.action, "block");
	checkContains("bash refusal reason names the tool", bashRefused.reason, "bash");
	checkContains("bash refusal reason names the operand", bashRefused.reason, "/etc/passwd");
	const bashHeadless = (await bashGate({ input: { command: "cat /etc/passwd" }, hasUI: false }));
	check("out-of-scope bash blocks headless", bashHeadless.action, "block");
	checkContains("headless bash reason names the operand", bashHeadless.reason, "/etc/passwd");
	checkContains("headless bash reason names the remedy", bashHeadless.reason, "interactively");
	check("headless in-scope bash passes", (await bashGate({ hasUI: false })).action, "pass");

	// DC-R1 through the bash wiring: seal omitted -> the real memoized session seal
	check(
		"bash wiring with omitted seal consumes the real session seal",
		(await bashGate({ seal: undefined })).action,
		"pass",
	);

	// scanner extraction pins
	const scan = async (command) => await scanBashCommand(command);
	check(
		"scan extracts an absolute operand",
		JSON.stringify((await scan("cat /etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a relative operand",
		JSON.stringify((await scan("cat inside/file.txt")).operands),
		JSON.stringify(["inside/file.txt"]),
	);
	check(
		"scan keeps multiple operands in order",
		JSON.stringify((await scan("cp /etc/passwd inside/copy.txt")).operands),
		JSON.stringify(["/etc/passwd", "inside/copy.txt"]),
	);
	check("scan skips bare words and the command word", (await scan("echo hello")).operands.length, 0);
	check(
		"scan extracts quoted mention pieces",
		JSON.stringify((await scan('echo "see /etc/passwd"')).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a quoted operand",
		JSON.stringify((await scan('cat "/etc/passwd"')).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a quoted redirect target",
		JSON.stringify((await scan('echo x > "/etc/capture.txt"')).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan extracts a quoted assignment-prefix RHS",
		JSON.stringify((await scan('X="/etc/capture.txt" run')).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan flags substitution behind an escaped quote",
		(await scan("echo \\' && cat \"$HOME/secrets\"")).substitution,
		true,
	);
	check("scan treats an escaped dollar as literal", (await scan("cat \\$HOME/notes")).substitution, false);
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): a quoted
	// parenthesis is literal string data under the grammar, so the bail
	// pin re-derives to the ERROR-only class.
	check("double-quoted grouping syntax parses as literal data", (await scan('grep "(foo" f')).bail, false);
	check(
		"scan honors escaped-space operands",
		JSON.stringify((await scan("cat inside/my\\ file.txt")).operands),
		JSON.stringify(["inside/my file.txt"]),
	);
	check(
		"scan takes the full word and the RHS of option assignments",
		JSON.stringify((await scan("tool --config=/etc/app.conf")).operands),
		JSON.stringify(["--config=/etc/app.conf", "/etc/app.conf"]),
	);
	check(
		"scan takes an assignment-prefix RHS",
		JSON.stringify((await scan("OUT=/etc/capture.txt run")).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check("scan keeps a lone assignment inert", (await scan("X=/etc/capture.txt")).operands.length, 0);
	check(
		"scan flags a segment-head redirect target",
		JSON.stringify((await scan("> /etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan flags a background stream redirect target",
		JSON.stringify((await scan("make &> /etc/log")).operands),
		JSON.stringify(["/etc/log"]),
	);
	check(
		"scan flags a noclobber redirect target",
		JSON.stringify((await scan("cat >| /etc/log")).operands),
		JSON.stringify(["/etc/log"]),
	);
	check(
		"scan extracts a bare cd target",
		JSON.stringify((await scan("cd link-out")).operands),
		JSON.stringify(["link-out"]),
	);
	check("scan asks on bare cd", (await scan("cd")).cdAsk !== null, true);
	checkContains(
		"scan bare-cd ask names the unresolvable target class",
		(await scan("cd")).cdAsk ?? "",
		"cannot resolve",
	);
	checkContains("scan cd - ask names OLDPWD", (await scan("cd -")).cdAsk ?? "", "OLDPWD");
	check("scan cd with an extractable target raises no ask", (await scan("cd inside")).cdAsk, null);
	check(
		"scan removes a glued continuation",
		JSON.stringify((await scan("cat \\\n/etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan joins a mid-word continuation exactly as bash does",
		JSON.stringify((await scan("cat foo\\\n/etc/passwd")).operands),
		JSON.stringify(["foo/etc/passwd"]),
	);
	check("scan treats single-quoted dollars as inert", (await scan("awk '{print $1}' f")).substitution, false);
	check("scan keeps double-quoted dollars as substitution", (await scan('cat "$HOME/x"')).substitution, true);
	check("scan keeps ANSI-C dollars as substitution", (await scan("grep $'\\t' f")).substitution, true);
	check("scan flags executor payload dollars", (await scan("bash -c 'echo $X'")).substitution, true);
	check("scan raises the cd ask through an executor payload", (await scan("bash -c 'cd'")).cdAsk !== null, true);
	check(
		"scan splits executor payloads through quotes",
		JSON.stringify((await scan("bash -c 'cat /etc/passwd'")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check("scan flags substitution", (await scan("echo $(x)")).substitution, true);
	check("scan flags executor shapes", (await scan("bash -c 'ls /'")).executor, true);
	check("scan detects the executor shape behind an escaped quote", (await scan("echo \\' ; bash -c 'cat /etc/passwd'")).executor, true);
	check("scan keeps a quoted prose mention of the executor shape inert", (await scan('echo "never write bash -c in reports"')).executor, false);
	check("scan detects executor shapes through option flags and intervening arguments", (await scan("bash --norc -lc 'ls inside'")).executor, true);
	check("scan detects the bare glued -c cluster", (await scan("bash -ccat")).executor, true);
	check("scan detects -cu as the -c cluster (the disclosed inert-junk over-ask)", (await scan("bash -cu x")).executor, true);
	check(
		"scan floors an interposer-prefixed executor shape and names the wrapper",
		(await scan("env bash -c 'echo inside'")).interposed,
		"env",
	);
	check(
		"scan keeps an interposer without an executor shape inert",
		(await scan("env FOO=1 ls inside")).interposed,
		null,
	);
	// SEMANTIC FLIP (PISCOPE-2-2, sanctioned Blocks Q3): tree-sitter
	// recovers a stray parenthesized group as a subshell with no ERROR
	// node, and bash itself rejects the spelling before anything runs,
	// so the lexical bail pin re-derives to the ERROR-only class.
	check("a stray parenthesized group parses without an ERROR tree", (await scan("ls (x)")).bail, false);

	// the factory handler maps bash events onto the shared ask/block machinery
	check(
		"handler passes an in-scope bash call",
		await handler({ toolName: "bash", input: { command: "cat inside/file.txt" } }, ctxWithChoice("Yes")),
		undefined,
	);
	const handlerBashRefusal = await handler(
		{ toolName: "bash", input: { command: "cat /etc/passwd" } },
		ctxWithChoice("No"),
	);
	check("handler blocks a refused bash call", handlerBashRefusal && handlerBashRefusal.block, true);
	checkContains("handler bash refusal names the resolved path", handlerBashRefusal.reason, "/etc/passwd");
	const handlerBashHeadless = await handler(
		{ toolName: "bash", input: { command: "cat /etc/passwd" } },
		{ cwd: cwdDir, hasUI: false, ui: { select: async () => "Yes" } },
	);
	check("handler blocks headless bash without prompting", handlerBashHeadless && handlerBashHeadless.block, true);
	checkContains("handler headless bash names the remedy", handlerBashHeadless.reason, "interactively");
	const handlerRedirectHead = await handler(
		{ toolName: "bash", input: { command: "> /etc/passwd" } },
		ctxWithChoice("No"),
	);
	check(
		"handler blocks a segment-head redirect write on refusal",
		handlerRedirectHead && handlerRedirectHead.block,
		true,
	);
	checkContains(
		"handler redirect refusal names the resolved path",
		handlerRedirectHead.reason,
		"/etc/passwd",
	);

	// --- EXT-38: the FENCE_DISABLE registration switch -------------------
	// The sanctioned off-switch (the dispatch-interval precedent): with
	// FENCE_DISABLE set to any non-empty value the factory registers an
	// inert no-op handler. The import graph stays intact (the subagent
	// extension imports this module directly, so a source-level disable
	// fails extension load and kills every dispatched child), the gate
	// never consults the seal, the roots, or the filesystem, and nothing
	// prompts or forwards. Unset or empty arms the gate exactly as the
	// pins above hold it.
	check("FENCE_DISABLE_ENV export is the switch name", FENCE_DISABLE_ENV, "FENCE_DISABLE");
	const registeredToolCallHandler = () => {
		const captured = [];
		cwdScopeGate({
			on(name, handler) {
				captured.push({ name, handler });
			},
		});
		return captured.length === 1 && captured[0].name === "tool_call" ? captured[0].handler : null;
	};
	process.env[FENCE_DISABLE_ENV] = "1";
	const disabledHandler = registeredToolCallHandler();
	delete process.env[FENCE_DISABLE_ENV];
	check(
		"the disabled factory still registers exactly one tool_call handler",
		disabledHandler !== null,
		true,
	);
	const inertCtx = {
		cwd: cwdDir,
		hasUI: false,
		ui: {
			select: async () => {
				throw new Error("the inert handler must not prompt");
			},
		},
	};
	check(
		"the disabled handler passes an out-of-scope read without prompting or blocking",
		await disabledHandler({ toolName: "read", input: { path: "/etc/passwd" } }, inertCtx),
		undefined,
	);
	check(
		"the disabled handler passes an out-of-scope bash call without prompting or blocking",
		await disabledHandler({ toolName: "bash", input: { command: "cat /etc/passwd" } }, inertCtx),
		undefined,
	);
	process.env[FENCE_DISABLE_ENV] = "";
	const emptyValueHandler = registeredToolCallHandler();
	delete process.env[FENCE_DISABLE_ENV];
	const emptyValueBlock = await emptyValueHandler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		{ cwd: cwdDir, hasUI: false, ui: { select: async () => "Yes" } },
	);
	check("an empty FENCE_DISABLE value arms the gate (headless block, no channel flow)", emptyValueBlock && emptyValueBlock.block, true);
	checkContains("the armed empty-value block names the fence", emptyValueBlock.reason, "blocked by the workspace-fence");
	const unsetHandler = registeredToolCallHandler();
	const unsetBlock = await unsetHandler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		{ cwd: cwdDir, hasUI: false, ui: { select: async () => "Yes" } },
	);
	check("an unset FENCE_DISABLE arms the gate (headless block, no channel flow)", unsetBlock && unsetBlock.block, true);

	// --- PISCOPE-2-2: the AST detection layer swap -----------------------
	// Pins for the tree-sitter detection layer behind the unchanged
	// BashScanResult contract: the EXT-34 sed closure (the pattern-first
	// skip adapted from permission-gate's PATTERN_FIRST_COMMANDS, scoped
	// to sed per the driver record), the heredoc tree-quirk corpus (the
	// GPS correction class: a redirect attached to a heredoc statement
	// hangs under heredoc_redirect and still extracts), ERROR-tree bail
	// equivalence, the expansion-node vocabulary, and the parser-
	// unavailable fail-safe boundary at the async decision seam.

	// EXT-34 closure: a sed range is an argument, structurally. The
	// script positional is skipped and the file operands still gate, so
	// the false-positive class closes without opening a silent direction.
	check(
		"the EXT-34 incident command passes (a sed range is an argument, not a path)",
		(await bashGate({ input: { command: "sed -n '/^next_report_seq()/,/^}/p' file" } })).action,
		"pass",
	);
	check(
		"the EXT-34 sed script is not extracted as an operand (the lexical scan surfaced it as a garbage absolute path)",
		JSON.stringify((await scan("sed -n '/^next_report_seq()/,/^}/p' file")).operands),
		JSON.stringify([]),
	);
	check(
		"the EXT-34 command parses clean through the grammar",
		(await scan("sed -n '/^next_report_seq()/,/^}/p' file")).bail,
		false,
	);
	check(
		"a sed script positional still gates a real out-of-scope file operand",
		(await bashGate({ input: { command: "sed 's/a/b/' /etc/passwd" } })).action,
		"ask",
	);
	check(
		"a sed -e script is consumed and not extracted",
		JSON.stringify((await scan("sed -e '/a/,/b/p' file")).operands),
		JSON.stringify([]),
	);
	check(
		"an unquoted sed -e script is consumed too",
		JSON.stringify((await scan("sed -e s/a/b/ file")).operands),
		JSON.stringify([]),
	);
	check(
		"a sed -f script file stays an operand while the data file extracts",
		JSON.stringify((await scan("sed -f /scripts/fix.sed /etc/data")).operands),
		JSON.stringify(["/scripts/fix.sed", "/etc/data"]),
	);
	check(
		"a sed inline --expression value is not extracted",
		JSON.stringify((await scan("sed --expression=/a/,/b/p file")).operands),
		JSON.stringify([]),
	);
	check(
		"sed -i consumes nothing and only the script positional is skipped",
		JSON.stringify((await scan("sed -i 's/a/b/' file")).operands),
		JSON.stringify([]),
	);

	// heredoc tree-quirk corpus (the GPS correction class)
	check(
		"an interpolating heredoc body still asks (its expansion runs)",
		(await bashGate({ input: { command: "cat << EOF\n${HOME}\nEOF" } })).action,
		"ask",
	);
	check(
		"a redirect attached to a heredoc statement still extracts its target (the tree hangs it under heredoc_redirect)",
		(await bashGate({ input: { command: `cat << EOF > ${outFile}\nbody\nEOF` } })).action,
		"ask",
	);
	check(
		"a post-heredoc redirect statement still extracts its target",
		(await bashGate({ input: { command: `wc -l << EOF\nbody\nEOF\n> ${outFile}` } })).action,
		"ask",
	);

	// --- EXT-38: the benign-heredoc defect corpus ------------------------
	// The dispatch-file idiom (cat writing a report body through a
	// quoted-delimiter heredoc to an in-scope target) blocked headless on
	// the deployed legacy lexical fence: that scanner bailed on every
	// heredoc leader with the unmodeled-syntax reason, so every manager
	// dispatch entry and instruction file heredoc asked. The AST walk
	// parses each shape below to a verdict; these pins hold the passes so
	// the merge carrying the AST stack cannot regress them, and the
	// closing gate pin proves the corpus carries no silent direction.
	const ext38Body = "---\nFindings:\n- prose naming /etc/passwd stays body data\n---";
	check(
		"the dispatch report idiom passes (quoted delimiter, redirect-first, benign body)",
		(await bashGate({ input: { command: `cat > ${insideDir}/ext38-report.md << 'EOF'\n${ext38Body}\nEOF` } })).action,
		"pass",
	);
	check(
		"the dispatch report idiom parses clean through the grammar (the legacy bail trigger is gone)",
		(await scan(`cat > ${insideDir}/ext38-report.md << 'EOF'\n${ext38Body}\nEOF`)).bail,
		false,
	);
	check(
		"the dispatch report idiom extracts only its target (the body stays data)",
		JSON.stringify((await scan(`cat > ${insideDir}/ext38-report.md << 'EOF'\n${ext38Body}\nEOF`)).operands),
		JSON.stringify([`${insideDir}/ext38-report.md`]),
	);
	check(
		"the unquoted-delimiter idiom passes (redirect-first, benign body)",
		(await bashGate({ input: { command: `cat > ${insideDir}/ext38-report.md << EOF\nplain body line\nEOF` } })).action,
		"pass",
	);
	check(
		"the heredoc-first placement passes (quoted delimiter after the redirect target)",
		(await bashGate({ input: { command: `cat << 'EOF' > ${insideDir}/ext38-report.md\nplain body line\nEOF` } })).action,
		"pass",
	);
	check(
		"the dash-dash delimiter form passes (indented benign body)",
		(await bashGate({ input: { command: `cat >> ${insideDir}/ext38-report.md <<- 'EOF'\n\t\tindented body line\n\tEOF` } })).action,
		"pass",
	);
	check(
		"a non-shell consumer keeps a body of path prose as data (tee)",
		(await bashGate({ input: { command: `tee ${insideDir}/ext38-report.md << 'EOF'\nsee docs/workspace-fence.md and/or /etc/passwd prose\nEOF` } })).action,
		"pass",
	);
	check(
		"the defect idiom with an out-of-scope target still gates",
		(await bashGate({ input: { command: `cat > /etc/ext38-probe.md << 'EOF'\n${ext38Body}\nEOF` } })).action,
		"ask",
	);

	// --- EXT-38: the clean-idiom shapes -----------------------------------
	// The probe round's passing shapes pinned so the idioms the fleet's
	// instruction files rely on stay fence-clean across the merge: board
	// ops run from the project cwd with no cd prefix (a bare-word task
	// filename extracts no path operand), the cross-board --dir flag
	// form carries the board root as an ordinary in-scope operand, a
	// report body rides a redirect whose source resolves in the temp
	// subtree, and the cd-to-unseeded-root form still asks (the
	// cross-board block; --dir is its remedy).
	check(
		"the no-cd board op passes (tasks show with a bare-word task filename from the project cwd)",
		(await bashGate({ input: { command: "tasks show EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md" } })).action,
		"pass",
	);
	check(
		"the no-cd board op extracts no operand (the bare-word filename is not path-shaped)",
		JSON.stringify((await scan("tasks show EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md")).operands),
		JSON.stringify([]),
	);
	check(
		"the --dir cross-board form passes (the board root rides as an in-scope operand)",
		(await bashGate({ input: { command: `tasks show EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md --dir ${insideDir}` } })).action,
		"pass",
	);
	check(
		"the report redirect-from-file shape passes (the body file resolves in the temp subtree)",
		(await bashGate({ input: { command: `tasks report EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md --slug 1-heredoc-defect --from worker < ${customTmpDir}/ext38-report-body.md` } })).action,
		"pass",
	);
	check(
		"the report redirect-from-file shape extracts its source file as the one operand",
		JSON.stringify((await scan(`tasks report EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md --slug 1-heredoc-defect --from worker < ${customTmpDir}/ext38-report-body.md`)).operands),
		JSON.stringify([`${customTmpDir}/ext38-report-body.md`]),
	);
	check(
		"the cd-to-unseeded-board-root compound asks (the cross-board block)",
		(await bashGate({ input: { command: `cd ${outsideDir} && tasks show EXT-38-20261126-1529-make-tasks-cli-usage-fence-clean.md` } })).action,
		"ask",
	);

	// ERROR-tree bail equivalence: the bail class is now the parse-health
	// class (rootNode.hasError), the GPS parse-health precedent.
	check("an unterminated quote parses to the bail class", (await scan("cat 'inside/file.txt")).bail, true);
	check("a trailing escape parses to the bail class", (await scan("cat inside/\\")).bail, true);
	check("a malformed read-write redirect parses to the bail class", (await scan("<> /etc/out")).bail, true);

	// the expansion-node vocabulary: every form bash would expand asks,
	// matching the lexical scanner's dollar-sighting posture
	check("brace parameter expansion asks", (await bashGate({ input: { command: "echo ${HOME}/secret" } })).action, "ask");
	check("arithmetic expansion asks", (await bashGate({ input: { command: "echo $((1+2))" } })).action, "ask");
	check("a top-level assignment carrying an expansion asks", (await bashGate({ input: { command: "X=$HOME/notes" } })).action, "ask");

	// --- PISCOPE-2-2 fix round (review 08 findings) ----------------------
	// The swap's walk missed two tree positions the lexical scanner saw
	// and its continuation join was not bash-exact. The pins below hold
	// the closed gaps at both the gate and the scan seam.

	// Assignment values are expansion positions: a value that is itself
	// a bare expansion node (the grammar allows one directly) asks, as
	// does an expansion nested in a literal value, at every assignment
	// posture the grammar spells (top-level, command prefix, backtick,
	// declaration command).
	check(
		"command substitution as an assignment value asks",
		(await bashGate({ input: { command: "x=$(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"backtick substitution as an assignment value asks",
		(await bashGate({ input: { command: "v=`cat /etc/passwd`" } })).action,
		"ask",
	);
	check(
		"command substitution in a prefix assignment value asks",
		(await bashGate({ input: { command: "FOO=$(cat /etc/passwd) cmd" } })).action,
		"ask",
	);
	check(
		"command substitution in a declaration assignment value asks",
		(await bashGate({ input: { command: "export v=$(cat /etc/passwd)" } })).action,
		"ask",
	);
	check("scan flags a bare parameter-expansion assignment value", (await scan("x=$HOME")).substitution, true);
	check("scan flags a bare arithmetic-expansion assignment value", (await scan("x=$((1+1))")).substitution, true);
	check("scan flags substitution in a prefix assignment value", (await scan("FOO=$(cat /etc/x) cmd")).substitution, true);
	check("scan flags substitution in a declaration assignment value", (await scan("export v=`cat /etc/x`")).substitution, true);
	check(
		"a stray expansion argument to a declaration command asks",
		(await bashGate({ input: { command: "export $HOME" } })).action,
		"ask",
	);
	check(
		"scan flags a stray expansion child of a declaration command",
		(await scan("export `cat /etc/x`")).substitution,
		true,
	);

	// Declaration-command assignment values extract as operands exactly
	// like the command-prefix form: the exported value is the same
	// environment access point, and the lexical scanner gated it.
	check(
		"an exported value gates like the prefix form",
		(await bashGate({ input: { command: "export X=/etc/passwd" } })).action,
		"ask",
	);
	check(
		"scan extracts a declaration-command value",
		JSON.stringify((await scan("export X=/etc/capture.txt")).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan extracts a declare value",
		JSON.stringify((await scan("declare x=/etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a readonly value",
		JSON.stringify((await scan("readonly r=/etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);

	// Redirect destinations are expansion positions too: a destination
	// that is itself an expansion (process or command substitution, a
	// parameter) asks, covering both the runtime-named write target and
	// the process substitution's inner command.
	check(
		"a process-substitution redirect destination asks",
		(await bashGate({ input: { command: "echo hi > >(cp /etc/passwd /tmp/stolen)" } })).action,
		"ask",
	);
	check(
		"an input process-substitution redirect destination asks",
		(await bashGate({ input: { command: "echo x > <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"a parameter-expansion redirect destination asks",
		(await bashGate({ input: { command: "out=/etc/passwd; echo x > $out" } })).action,
		"ask",
	);
	check(
		"a command-substitution redirect destination asks",
		(await bashGate({ input: { command: "echo x > $(cat namefile)" } })).action,
		"ask",
	);
	check("scan flags substitution in an expansion redirect destination", (await scan("cat > $out")).substitution, true);
	check(
		"scan flags substitution in a process-substitution destination",
		(await scan("echo x > >(tee /etc/passwd)")).substitution,
		true,
	);

	// A literal redirect destination is one shell word and extracts
	// whole (the lexical posture), not split into prose pieces; a bare
	// number destination is an fd target and extracts nothing.
	check(
		"a multi-word quoted redirect destination stays one in-scope word",
		(await bashGate({ input: { command: 'echo x > "note /etc/passwd"' } })).action,
		"pass",
	);
	check(
		"scan extracts a redirect destination whole",
		JSON.stringify((await scan('echo x > "note /etc/passwd"')).operands),
		JSON.stringify(["note /etc/passwd"]),
	);
	check("scan extracts nothing from a numeric redirect destination", JSON.stringify((await scan("echo x > 2")).operands), JSON.stringify([]));

	// --- PISCOPE-2-2 fix round 2 (review 10 findings) --------------------
	// Substitution was position-enumerated and the fourth unvisited
	// position (command_name) re-opened the same silent-allow class: a
	// variable-assembled invocation passed where the lexical scanner's
	// raw-dollar sighting asked. The remedy is class-level: ONE
	// position-blind traversal flags substitution for every expansion
	// node wherever the grammar allows one, so no position can hide an
	// expansion (command names under command, negation, pipeline, and
	// subshell parents included); operand extraction stays position-aware
	// with command_name read for identity (a literal name is identity,
	// not an operand, the pinned historical posture). The LOW residuals
	// ride the same round: array declaration values extract their
	// element pieces exactly as the scalar value does, and the fd-close
	// operator spellings join the operator table (inert shapes, not
	// asks).
	check(
		"the variable-assembled invocation chain asks",
		(await bashGate({ input: { command: "c='cat /etc/passwd'\n$c" } })).action,
		"ask",
	);
	check("a bare variable command name asks", (await bashGate({ input: { command: "$c" } })).action, "ask");
	check(
		"a command substitution as the command name asks",
		(await bashGate({ input: { command: "$(cat /etc/passwd)" } })).action,
		"ask",
	);
	check("a backtick command name asks", (await bashGate({ input: { command: "`cat /etc/passwd`" } })).action, "ask");
	check(
		"a substitution concatenated into the command name asks",
		(await bashGate({ input: { command: "$(cat /etc/passwd)x /tmp/out" } })).action,
		"ask",
	);
	check(
		"a parameter expansion in the command name asks",
		(await bashGate({ input: { command: "${HOME}bin/tool" } })).action,
		"ask",
	);
	check(
		"an ANSI-C string command name asks",
		(await bashGate({ input: { command: "$'cat' /etc/passwd" } })).action,
		"ask",
	);
	check("scan flags a variable command name after a lone assignment", (await scan("c='cat /etc/x'\n$c")).substitution, true);
	check("scan flags a command-name substitution under negation", (await scan("! $c")).substitution, true);
	check("scan flags a command-name substitution in a pipeline", (await scan("$c | cat")).substitution, true);
	check("scan flags a command-name substitution in a subshell", (await scan("($c)")).substitution, true);
	check(
		"scan flags a substitution concatenated into the command name",
		(await scan("$(cat /etc/x)t")).substitution,
		true,
	);

	// Array declaration values extract their element pieces exactly as
	// the scalar value does (the same environment access point), while
	// the lone array assignment stays inert like the scalar one; an
	// expansion inside an array value asks.
	check(
		"an exported array of absolute paths asks",
		(await bashGate({ input: { command: "export arr=(/etc/passwd /etc/shadow)" } })).action,
		"ask",
	);
	check(
		"an exported array with quoted elements asks",
		(await bashGate({ input: { command: "export arr=(\"/etc/a\" '/etc/b')" } })).action,
		"ask",
	);
	check(
		"a subscript array element asks",
		(await bashGate({ input: { command: "export arr=([0]=/etc/capture.txt)" } })).action,
		"ask",
	);
	check(
		"scan extracts array element pieces like the scalar value",
		JSON.stringify((await scan("export arr=(/etc/capture.txt)")).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan extracts quoted array elements in order",
		JSON.stringify((await scan("export arr=(\"/etc/a\" '/etc/b')")).operands),
		JSON.stringify(["/etc/a", "/etc/b"]),
	);
	check(
		"scan extracts a subscript array element value",
		JSON.stringify((await scan("export arr=([0]=/etc/capture.txt)")).operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check("scan flags an expansion inside an array value", (await scan("arr=($(cat /etc/x))")).substitution, true);
	check(
		"a lone array assignment passes like the scalar one",
		(await bashGate({ input: { command: "arr=(/etc/passwd)" } })).action,
		"pass",
	);

	// The fd-close operator spellings are inert (a closed descriptor
	// names no path) and sit in the operator table, so they neither ask
	// nor read as unmodeled destination shapes.
	check("an input fd close passes", (await bashGate({ input: { command: "cat <&-" } })).action, "pass");
	check("an output fd close passes", (await bashGate({ input: { command: "echo ok 2>&-" } })).action, "pass");
	check("an fd-prefixed close passes", (await bashGate({ input: { command: "echo x 3>&-" } })).action, "pass");

	// The continuation join is bash-exact: bash removes the
	// backslash-newline pair and splits the remainder on whitespace, so
	// only the bare pair glues the words; an indented continuation or a
	// space before the backslash leaves two words, each gated on its own
	// text. A \r spelling is not the pair (bash escapes the carriage
	// return and the newline still separates).
	check(
		"an indented continuation cannot hide an absolute operand",
		(await bashGate({ input: { command: "cat foo\\\n   /etc/passwd" } })).action,
		"ask",
	);
	check(
		"a spaced continuation cannot hide an absolute operand",
		(await bashGate({ input: { command: "cat foo \\\n/etc/passwd" } })).action,
		"ask",
	);
	check(
		"a glued in-scope continuation passes",
		(await bashGate({ input: { command: "cat foo\\\ninside/file.txt" } })).action,
		"pass",
	);
	check(
		"scan reads an indented continuation as two words",
		JSON.stringify((await scan("cat foo\\\n   /etc/passwd")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan keeps a CRLF continuation split",
		JSON.stringify((await scan("cat foo\\\r\nbar")).operands),
		JSON.stringify([]),
	);
	// --- PISCOPE-2-2 fix round 3 (advisor memo 15) -----------------------
	// The verdict assembly, not the traversal, was the open seam: the
	// executor corner erased a true substitution flag for dollar-free
	// expansion spellings. An executor command carrying a process
	// substitution passed with zero operands while the substitution's
	// inner command ran ungated, because the substitution branch carried
	// an executor carve-out and the final return hardcoded the flag
	// false. The traversal always flagged these trees correctly; the
	// pins hold all ten memo spellings asking at the gate plus the
	// scan-level flag surviving the executor corner, while the interposed
	// wrapper branch that always preserved the flag stays pinned. DC-1
	// rides the same round: PROMPT_COMMAND and BASH_ENV are env-var-
	// carried execution vectors (the prompt hook and the non-interactive
	// startup file), so an assignment in any posture or an env spelling
	// carrying those names floors to ask regardless of value shape,
	// while a plain argument merely mentioning a name stays inert.
	check(
		"an executor command with an input process substitution asks",
		(await bashGate({ input: { command: "bash -c 'true' <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an executor command with a login-flag payload and an input process substitution asks",
		(await bashGate({ input: { command: "bash -lc 'true' <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an executor command with an output process substitution asks",
		(await bashGate({ input: { command: "bash -c 'true' >(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an executor command with a redirect-destination process substitution asks",
		(await bashGate({ input: { command: "bash -c 'true' > <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an executor command with a nested process substitution asks",
		(await bashGate({ input: { command: "bash -c 'true' <(cat <(cat /etc/passwd))" } })).action,
		"ask",
	);
	check(
		"a su executor command with a process substitution asks",
		(await bashGate({ input: { command: "su -c 'true' <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an ssh executor command with a process substitution asks",
		(await bashGate({ input: { command: "ssh host 'true' <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an eval executor command with a process substitution asks",
		(await bashGate({ input: { command: "eval <(cat /etc/passwd)" } })).action,
		"ask",
	);
	check(
		"an executor command with a writing process substitution asks",
		(await bashGate({ input: { command: "bash -c 'true' <(cp /etc/passwd /tmp/stolen)" } })).action,
		"ask",
	);
	check(
		"an executor command with an output-bearing process substitution asks",
		(await bashGate({ input: { command: "bash -c 'echo hi' <(cp /etc/a /etc/b)" } })).action,
		"ask",
	);
	check("the substitution flag survives the executor corner", (await scan("bash -c 'true' <(cat /etc/passwd)")).substitution, true);
	check(
		"an interposed executor with a process substitution still asks through the wrapper",
		(await bashGate({ input: { command: "env bash -c 'true' <(cat /etc/passwd)" } })).action,
		"ask",
	);

	// DC-1: the env-var-carried execution vectors floor to ask. The
	// value's shape proves nothing about when bash will run it, so the
	// floor keys on the name in assignment posture (lone, command
	// prefix, declaration, append, and subscript forms ride the same
	// variable_name read) or in env spelling, never on the value.
	check(
		"a lone prompt-hook assignment asks regardless of its payload",
		(await bashGate({ input: { command: "PROMPT_COMMAND='cat /etc/passwd'" } })).action,
		"ask",
	);
	checkContains(
		"the prompt-hook ask names the vector",
		String((await bashGate({ input: { command: "PROMPT_COMMAND='cat /etc/passwd'" } })).title ?? ""),
		"PROMPT_COMMAND",
	);
	check(
		"a lone startup-file assignment asks",
		(await bashGate({ input: { command: "BASH_ENV=/etc/evil.sh" } })).action,
		"ask",
	);
	check(
		"a prompt-hook assignment with a benign value still asks",
		(await bashGate({ input: { command: "PROMPT_COMMAND=echo hi" } })).action,
		"ask",
	);
	check(
		"an exported prompt-hook assignment asks",
		(await bashGate({ input: { command: "export PROMPT_COMMAND='x'" } })).action,
		"ask",
	);
	check(
		"an env spelling carrying a vector name asks",
		(await bashGate({ input: { command: "env PROMPT_COMMAND=x cat file" } })).action,
		"ask",
	);
	check(
		"a prefix vector assignment on an executor command asks",
		(await bashGate({ input: { command: "FOO=1 BASH_ENV=x bash -c 'true'" } })).action,
		"ask",
	);
	check("scan names the vector for a prefix assignment", (await scan("PROMPT_COMMAND=x cat file")).envVector, "PROMPT_COMMAND");
	check("scan names the vector for a lone startup-file assignment", (await scan("BASH_ENV=/etc/evil.sh")).envVector, "BASH_ENV");
	check(
		"a plain argument mentioning a vector name passes",
		(await bashGate({ input: { command: "cat PROMPT_COMMAND" } })).action,
		"pass",
	);
	check(
		"a prose mention of a vector assignment passes",
		(await bashGate({ input: { command: "echo PROMPT_COMMAND=x" } })).action,
		"pass",
	);

	// --- PISCOPE-2-2 fix round 4 (advisor confirmation memo 19) ----------
	// Three surviving HIGH swap regressions. One: the executor payload
	// pieces ride their inner quote and backslash characters, so
	// `bash -c 'cat "/etc/passwd"'` extracted a quote-leading piece the
	// verdict core resolved as a cwd-relative in-scope name while the
	// child shell stripped the quoting and opened the real absolute
	// path; extraction now reproduces the child's word split at executor
	// shapes (quote characters are word boundaries and are dropped,
	// outside-quote escapes consume the escaped character), the
	// splitQuotes posture the swap retired. Two: the deferred-execution
	// floor widens from its two names to the full hijackable family
	// (ZDOTDIR and ENV source shell startup files, LD_PRELOAD loads into
	// the next exec, PS4 executes under xtrace, PATH redirects
	// executable lookup). Three: the stdin-script seam is in-tree, so a
	// shell/su/ssh/eval head whose statement carries a heredoc_redirect
	// or herestring_redirect extracts the body's words exactly as it
	// extracts payload words, while a non-shell consumer's heredoc stays
	// data.
	check(
		"an executor payload with a double-quoted path asks",
		(await bashGate({ input: { command: `bash -c 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"an executor payload with a single-quoted path asks",
		(await bashGate({ input: { command: `bash -c "cat '/etc/passwd'"` } })).action,
		"ask",
	);
	check(
		"an executor payload with backslash-escaped slashes asks",
		(await bashGate({ input: { command: `bash -c 'cat \\\/etc\\/passwd'` } })).action,
		"ask",
	);
	check(
		"a single-quote-glued payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `bash -c'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"a double-quote-glued payload with a single-quoted path asks",
		(await bashGate({ input: { command: `bash -c"cat '/etc/passwd'"` } })).action,
		"ask",
	);
	check(
		"an executor payload read-and-write with both paths quoted asks",
		(await bashGate({ input: { command: `bash -c 'cat "/etc/shadow" > "/home/khave/stolen"'` } })).action,
		"ask",
	);
	check(
		"a su executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `su -c 'cat "/etc/passwd"' root` } })).action,
		"ask",
	);
	check(
		"an ssh executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `ssh host 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"an eval executor write payload with both paths quoted asks",
		(await bashGate({ input: { command: `eval 'cat "/etc/passwd" > "/etc/stolen-eval"'` } })).action,
		"ask",
	);
	check(
		"a path-qualified executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `/bin/bash -c 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"a login-cluster executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `bash -lc 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"an interactive-cluster executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `bash -ic 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"a zsh executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `zsh -c 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"an executor cd payload with a quoted target asks",
		(await bashGate({ input: { command: `bash -c 'cd "/etc"'` } })).action,
		"ask",
	);
	check(
		"scan splits the quoted executor payload into the clean path",
		JSON.stringify((await scan(`bash -c 'cat "/etc/passwd"'`)).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts both clean paths from the quoted read-and-write payload",
		JSON.stringify((await scan(`bash -c 'cat "/etc/shadow" > "/home/khave/stolen"'`)).operands),
		JSON.stringify(["/etc/shadow", "/home/khave/stolen"]),
	);
	check(
		"an executor payload with no path-like words passes",
		(await bashGate({ input: { command: `bash -c 'echo hi'` } })).action,
		"pass",
	);
	check(
		"a trace-variable assignment asks",
		(await bashGate({ input: { command: `PS4='$(cat /etc/passwd)'; set -x; ls` } })).action,
		"ask",
	);
	check("scan names the trace vector", (await scan(`PS4='$(cat /etc/passwd)'; set -x; ls`)).envVector, "PS4");
	check(
		"a lone lookup-path assignment asks",
		(await bashGate({ input: { command: "PATH=/etc/evil; ls" } })).action,
		"ask",
	);
	check("scan names the lookup-path vector", (await scan("PATH=/etc/evil; ls")).envVector, "PATH");
	check(
		"a lone startup-directory assignment asks",
		(await bashGate({ input: { command: "ZDOTDIR=/etc/evil; zsh -c true" } })).action,
		"ask",
	);
	check("scan names the zsh-startup vector", (await scan("ZDOTDIR=/etc/evil; zsh -c true")).envVector, "ZDOTDIR");
	check(
		"a lone dash-startup assignment asks",
		(await bashGate({ input: { command: "ENV=/etc/evil.sh; dash -i" } })).action,
		"ask",
	);
	check("scan names the dash-startup vector", (await scan("ENV=/etc/evil.sh; dash -i")).envVector, "ENV");
	check(
		"a lone loader-preload assignment asks",
		(await bashGate({ input: { command: "set -a; LD_PRELOAD=/tmp/evil.so; ls" } })).action,
		"ask",
	);
	check("scan names the loader-preload vector", (await scan("set -a; LD_PRELOAD=/tmp/evil.so; ls")).envVector, "LD_PRELOAD");
	check(
		"an exported startup-directory assignment asks",
		(await bashGate({ input: { command: "export ZDOTDIR=/etc/evil" } })).action,
		"ask",
	);
	check("scan names the vector for an exported startup-directory assignment", (await scan("export ZDOTDIR=/etc/evil")).envVector, "ZDOTDIR");
	check(
		"a declared startup-file assignment asks",
		(await bashGate({ input: { command: "declare -x ENV=/etc/evil.sh" } })).action,
		"ask",
	);
	check("scan names the vector for a declared startup-file assignment", (await scan("declare -x ENV=/etc/evil.sh")).envVector, "ENV");
	check(
		"a prefix loader-preload assignment asks",
		(await bashGate({ input: { command: "LD_PRELOAD=/tmp/evil.so ls" } })).action,
		"ask",
	);
	check("scan names the vector for a prefix loader-preload assignment", (await scan("LD_PRELOAD=/tmp/evil.so ls")).envVector, "LD_PRELOAD");
	check(
		"an env spelling carrying a startup-directory name asks",
		(await bashGate({ input: { command: "env ZDOTDIR=/etc/evil zsh -i" } })).action,
		"ask",
	);
	check("scan names the vector in env spelling", (await scan("env ZDOTDIR=/etc/evil zsh -i")).envVector, "ZDOTDIR");
	check(
		"a prefix lookup-path assignment asks",
		(await bashGate({ input: { command: "PATH=/etc/evil ls" } })).action,
		"ask",
	);
	check("scan names the vector for a prefix lookup-path assignment", (await scan("PATH=/etc/evil ls")).envVector, "PATH");
	check(
		"a prose mention of a lookup-path assignment passes",
		(await bashGate({ input: { command: "echo PATH=x" } })).action,
		"pass",
	);
	check(
		"a plain argument mentioning a loader name passes",
		(await bashGate({ input: { command: "cat LD_PRELOAD" } })).action,
		"pass",
	);
	check(
		"a shell heredoc body carrying an out-of-scope read asks",
		(await bashGate({ input: { command: "bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"scan extracts the shell heredoc body's words",
		JSON.stringify((await scan("bash << EOF\ncat /etc/passwd\nEOF")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"a quoted-delimiter shell heredoc body carrying an out-of-scope read asks",
		(await bashGate({ input: { command: "bash << 'EOF'\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a shell stdin-script heredoc through -s asks",
		(await bashGate({ input: { command: "bash -s << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an executor compound shell heredoc asks",
		(await bashGate({ input: { command: "bash -c 'sh' << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a shell heredoc body carrying an out-of-scope write asks",
		(await bashGate({ input: { command: "bash << EOF\necho x > /etc/evil\nEOF" } })).action,
		"ask",
	);
	check(
		"scan extracts the heredoc body's write target",
		JSON.stringify((await scan("bash << EOF\necho x > /etc/evil\nEOF")).operands),
		JSON.stringify(["/etc/evil"]),
	);
	check(
		"a zsh heredoc body carrying an out-of-scope read asks",
		(await bashGate({ input: { command: "zsh << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a su stdin-script heredoc asks",
		(await bashGate({ input: { command: "su user << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an ssh stdin-script heredoc asks",
		(await bashGate({ input: { command: "ssh host << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an eval stdin-script heredoc asks",
		(await bashGate({ input: { command: "eval 'cat' << EOF\n/etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a compound-headed shell heredoc asks",
		(await bashGate({ input: { command: "{ bash; } << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a subshell-wrapped shell heredoc asks",
		(await bashGate({ input: { command: "( bash << EOF\ncat /etc/passwd\nEOF )" } })).action,
		"ask",
	);
	check(
		"a here-string carrying an inner-quoted path asks",
		(await bashGate({ input: { command: `bash <<< 'cat "/etc/passwd"'` } })).action,
		"ask",
	);
	check(
		"a here-string carrying a clean path still asks",
		(await bashGate({ input: { command: `bash <<< 'cat /etc/passwd'` } })).action,
		"ask",
	);
	check(
		"a here-string carrying an out-of-scope write still asks",
		(await bashGate({ input: { command: `bash <<< 'echo x > /etc/evil'` } })).action,
		"ask",
	);
	check(
		"a non-shell consumer's heredoc body stays data",
		(await bashGate({ input: { command: "cat << EOF\ncat /etc/passwd\nEOF" } })).action,
		"pass",
	);
	check(
		"a non-shell consumer's here-string still extracts its value",
		(await bashGate({ input: { command: `echo hi <<< 'cat /etc/passwd'` } })).action,
		"ask",
	);

	// loop-hardening pins (review pass, iteration 1): the seam's head
	// read missed two stdin-consumer shapes. A wrapper hides the shell
	// (`command bash << EOF` runs bash on the body) and the executor
	// detection posture already looks past interposer words, so the
	// head read strips them; a pipeline child reads its LAST stage
	// because the statement's stdin feeds the pipeline's end.
	check(
		"a wrapper-hidden shell heredoc body asks",
		(await bashGate({ input: { command: "command bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a nohup-hidden shell heredoc body asks",
		(await bashGate({ input: { command: "nohup bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a pipeline whose last stage is a shell reads the heredoc body as its script",
		(await bashGate({ input: { command: "cat x | bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a pipeline whose last stage is not a shell keeps the heredoc body as data",
		(await bashGate({ input: { command: "bash | cat << EOF\ncat /etc/passwd\nEOF" } })).action,
		"pass",
	);
	check(
		"a wrapper over a non-shell head keeps the heredoc body as data",
		(await bashGate({ input: { command: "command cat << EOF\ncat /etc/passwd\nEOF" } })).action,
		"pass",
	);
	check(
		"a wrapper-hidden shell here-string with an inner-quoted path asks",
		(await bashGate({ input: { command: `command bash <<< 'cat "/etc/passwd"'` } })).action,
		"ask",
	);

	// --- PISCOPE-2-2 fix round 5 (review 22 seam gaps + advisor memo 23) --
	// Four gap classes, all live-confirmed passing before this round. One:
	// the seam's wrapper strip stopped at the first non-interposer
	// argument, so any flag, assignment, or duration between the wrapper
	// and the shell (env -i, env NAME=x, env -u, env long flags, timeout
	// 5s, timeout --foreground, nice -n 5, chained spellings, the
	// pipeline-end crossover) left the heredoc and here-string seams
	// inactive and the body ran ungated. The head read now scans every
	// argument token for the stdin-script identity, the same full-stream
	// look executor detection uses. Two: the seam lacked the executor
	// corner's raw-dollar backstop, so a dollar the grammar cannot see
	// (quoted-delimiter bodies, quoted here-string values, escaped
	// dollars) assembled the real path inside the child shell; a
	// seam-active body or value whose raw text carries $ or a backtick
	// now biases to substitution. Three: exec replaces the process with
	// its argument, so it joins the interposer strip (the head read sees
	// through it, and an executor shape behind it floors to ask), and
	// LD_AUDIT and LD_LIBRARY_PATH join the deferred-execution floor as
	// the loader family of LD_PRELOAD. Four (advisor memo 23 Q1): the
	// executor detection keyed on the command's own name, so a
	// non-vocabulary prefix (sudo, strace, xargs, setsid, watch) hid a
	// prefixed executor payload from the re-split while the lexical
	// baseline asked; detection is now position-independent over the
	// command's token stream, so a prefixed payload gates identically to
	// the bare spelling.
	check(
		"an env -i wrapper heredoc body carrying an out-of-scope read asks",
		(await bashGate({ input: { command: "env -i bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an env -i wrapper heredoc body carrying a quoted read-and-write asks",
		(await bashGate({ input: { command: `env -i bash << EOF\ncat \"/etc/shadow\" > \"/home/khave/stolen\"\nEOF` } })).action,
		"ask",
	);
	check(
		"scan reads the stdin-script head through env -i",
		JSON.stringify((await scan("env -i bash << EOF\ncat /etc/passwd\nEOF")).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"an env assignment wrapper heredoc body asks",
		(await bashGate({ input: { command: "env FOO=bar bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an env -u wrapper heredoc body asks",
		(await bashGate({ input: { command: "env -u X bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"an env long-flag wrapper heredoc body asks",
		(await bashGate({ input: { command: "env --ignore-environment bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a word-duration timeout wrapper heredoc body asks",
		(await bashGate({ input: { command: "timeout 5s bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a long-flag timeout wrapper heredoc body asks",
		(await bashGate({ input: { command: "timeout --foreground 5 bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a nice -n wrapper heredoc body asks",
		(await bashGate({ input: { command: "nice -n 5 bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a chained wrapper-argument heredoc body asks",
		(await bashGate({ input: { command: "nohup nice -n 5 bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a pipeline-end wrapper-argument heredoc body asks",
		(await bashGate({ input: { command: "cat x | env -i bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a wrapper-argument here-string with an inner-quoted path asks",
		(await bashGate({ input: { command: `env -i bash <<< 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"scan splits the wrapper-argument here-string into the clean path",
		JSON.stringify((await scan(`env -i bash <<< 'cat \"/etc/passwd\"'`)).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"a quoted-delimiter heredoc body with a dollar-assembled path asks",
		(await bashGate({ input: { command: "bash << 'EOF'\ncat $HOME/secret\nEOF" } })).action,
		"ask",
	);
	check(
		"a here-string with a dollar-assembled path asks",
		(await bashGate({ input: { command: `bash <<< 'cat $HOME/secret'` } })).action,
		"ask",
	);
	check(
		"the seam dollar backstop biases a quoted-literal body to substitution",
		(await scan("bash << 'EOF'\ncat $HOME/secret\nEOF")).substitution,
		true,
	);
	check(
		"the seam dollar backstop biases a quoted here-string value to substitution",
		(await scan(`bash <<< 'cat $HOME/secret'`)).substitution,
		true,
	);
	check(
		"a dollar-indirection heredoc body asks",
		(await bashGate({ input: { command: "f=/etc/passwd; bash <<'EOF'\ncat $f\nEOF" } })).action,
		"ask",
	);
	check(
		"a dollar-indirection here-string asks",
		(await bashGate({ input: { command: `f=/etc/passwd; bash <<< 'cat $f'` } })).action,
		"ask",
	);
	check(
		"an escaped-dollar heredoc body asks",
		(await bashGate({ input: { command: "bash << EOF\ncat \\$HOME/secret\nEOF" } })).action,
		"ask",
	);
	check(
		"a su heredoc body with a dollar-assembled path asks",
		(await bashGate({ input: { command: "su user << 'EOF'\ncat $HOME/secret\nEOF" } })).action,
		"ask",
	);
	check(
		"an exec-headed heredoc body carrying a quoted read-and-write asks",
		(await bashGate({ input: { command: `exec bash << EOF\ncat \"/etc/shadow\" > \"/home/khave/stolen\"\nEOF` } })).action,
		"ask",
	);
	check(
		"an exec-headed here-string with an inner-quoted path asks",
		(await bashGate({ input: { command: `exec bash <<< 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"an exec-headed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `exec sh -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"an exec-prefixed clean executor payload asks (the disclosed interposer over-ask)",
		(await bashGate({ input: { command: `exec bash -c 'echo hi'` } })).action,
		"ask",
	);
	check(
		"a lone loader-audit assignment asks",
		(await bashGate({ input: { command: "LD_AUDIT=/tmp/evil.so; ls" } })).action,
		"ask",
	);
	check(
		"a lone library-path assignment asks",
		(await bashGate({ input: { command: "LD_LIBRARY_PATH=/tmp/evil; ls" } })).action,
		"ask",
	);
	check("scan names the loader-audit vector", (await scan("LD_AUDIT=/tmp/evil.so; ls")).envVector, "LD_AUDIT");
	check(
		"scan names the library-path vector",
		(await scan("LD_LIBRARY_PATH=/tmp/evil; ls")).envVector,
		"LD_LIBRARY_PATH",
	);
	check(
		"a sudo-prefixed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `sudo bash -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"a sudo-prefixed executor payload read-and-write with both paths quoted asks",
		(await bashGate({ input: { command: `sudo bash -c 'cat \"/etc/shadow\" > \"/home/khave/stolen\"'` } })).action,
		"ask",
	);
	check(
		"scan splits the sudo-prefixed quoted payload into the clean path identically",
		JSON.stringify((await scan(`sudo bash -c 'cat \"/etc/passwd\"'`)).operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts both clean paths from the sudo-prefixed read-and-write payload",
		JSON.stringify((await scan(`sudo bash -c 'cat \"/etc/shadow\" > \"/home/khave/stolen\"'`)).operands),
		JSON.stringify(["/etc/shadow", "/home/khave/stolen"]),
	);
	check(
		"a strace-prefixed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `strace bash -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"an xargs-prefixed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `xargs bash -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"a setsid-prefixed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `setsid bash -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"a watch-prefixed executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `watch bash -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"a sudo-prefixed su executor payload with an inner-quoted path asks",
		(await bashGate({ input: { command: `sudo su -c 'cat \"/etc/passwd\"'` } })).action,
		"ask",
	);
	check(
		"an exec-headed plain command keeps its operands as the only gate",
		(await bashGate({ input: { command: "exec ls" } })).action,
		"pass",
	);
	check(
		"an exec-headed command with an in-scope operand passes",
		(await bashGate({ input: { command: "exec cat inside/file.txt" } })).action,
		"pass",
	);
	check(
		"a quoted-delimiter data heredoc body carrying dollars stays data",
		(await bashGate({ input: { command: "cat << 'EOF'\ncat $HOME/secret\nEOF" } })).action,
		"pass",
	);
	check(
		"a non-shell here-string value with a dollar-assembled path keeps the generic posture",
		(await bashGate({ input: { command: `echo hi <<< 'cat $HOME/secret'` } })).action,
		"pass",
	);
	check(
		"a number-duration timeout wrapper heredoc body still asks",
		(await bashGate({ input: { command: "timeout 5 bash << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a prefix loader-audit assignment still gates on its value",
		(await bashGate({ input: { command: "LD_AUDIT=/tmp/evil.so ls" } })).action,
		"ask",
	);
	check(
		"a backtick quoted-delimiter heredoc body still asks",
		(await bashGate({ input: { command: "bash << 'EOF'\necho `cat /etc/passwd`\nEOF" } })).action,
		"ask",
	);
	check(
		"an ssh heredoc body with a dollar-assembled path still asks",
		(await bashGate({ input: { command: "ssh host << 'EOF'\ncat $HOME/secret\nEOF" } })).action,
		"ask",
	);

	// loop-hardening pins (review pass, iteration 1): redirect-only exec
	// (no argument) applies its redirections to the current shell, so a
	// later command in the same string reads the attached body as its
	// stdin script; exec joins the stdin-script identity family, which
	// only bites in the no-argument fallback (the strip's argument
	// short-circuit still names the real program whenever exec carries
	// one).
	check(
		"a redirect-only exec heredoc body followed by a shell asks",
		(await bashGate({ input: { command: "exec << EOF\ncat /etc/passwd\nEOF\nbash" } })).action,
		"ask",
	);
	check(
		"a redirect-only exec heredoc body asks on its own",
		(await bashGate({ input: { command: "exec << EOF\ncat /etc/passwd\nEOF" } })).action,
		"ask",
	);
	check(
		"a quoted redirect-only exec heredoc body with a dollar path asks",
		(await bashGate({ input: { command: "exec << 'EOF'\ncat $HOME/secret\nEOF\nbash" } })).action,
		"ask",
	);
	check(
		"an exec-headed non-shell command keeps the heredoc body as data",
		(await bashGate({ input: { command: "exec ls << EOF\ncat /etc/passwd\nEOF" } })).action,
		"pass",
	);

	// the async decision seam: parser unavailability degrades to ask
	// (UI) or an actionable block (headless), never a silent allow, and
	// the scan surface is injectable the way the seal is.
	const rejectingScan = async () => {
		throw new Error("wasm load failed");
	};
	check(
		"parser unavailability asks every bash call",
		(await bashGate({ input: { command: "echo hello" }, scan: rejectingScan })).action,
		"ask",
	);
	checkContains(
		"the parser-unavailable ask names the failure",
		(await bashGate({ input: { command: "echo hello" }, scan: rejectingScan })).title,
		"parser is unavailable",
	);
	check(
		"parser unavailability blocks headless",
		(await bashGate({ input: { command: "echo hello" }, scan: rejectingScan, hasUI: false })).action,
		"block",
	);
	check(
		"parser unavailability carries no grant candidate",
		(await bashGate({ input: { command: "cat /etc/passwd" }, scan: rejectingScan })).grantCandidate,
		undefined,
	);
	check(
		"the injected scanner surface drives the decision verbatim",
		(
			await bashGate({
				input: { command: "anything" },
				scan: async () => ({ substitution: false, executor: false, interposed: null, bail: false, cdAsk: null, operands: ["/etc/passwd"] }),
			})
		).action,
		"ask",
	);

	// --- EXT-37: ask reasons carry trigger provenance ------------------
	// Every fence ask/block reason names its trigger class wherever the
	// machinery already knows it: each extracted operand carries the
	// extraction position the walk read it from (plain argument, redirect
	// destination, cd/pushd target, assignment value, stdin-script
	// heredoc/here-string body word naming the statement head, executor
	// payload naming the executor identity, interpreter payload naming
	// the interpreter and its script flag), the substitution bias names
	// the expansion kinds it saw, the env-vector floor names its
	// posture, and the user seeing a prompt for a probe command can tell
	// exactly which role the path played in the command. The provenance
	// rides the scan result as data (operandPositions,
	// substitutionKinds, envVectorPosture) so the decision layer renders
	// it into the ask title, the refusal reason, and the forwarded ask
	// evidence; suite scan injections without provenance read as the
	// plain argument posture.
	const operandPosition = async (command, operand) =>
		((await scan(command)).operandPositions ?? {})[operand];
	check(
		"provenance: a plain argument operand names the argument posture",
		await operandPosition("cat /etc/passwd", "/etc/passwd"),
		"a command argument",
	);
	check(
		"provenance: a redirect destination names the redirect posture",
		await operandPosition("echo x > /etc/passwd", "/etc/passwd"),
		"a redirect destination",
	);
	check(
		"provenance: a segment-head redirect target names the redirect posture",
		await operandPosition("> /etc/passwd", "/etc/passwd"),
		"a redirect destination",
	);
	check(
		"provenance: a resolvable cd target names the cd/pushd posture",
		await operandPosition("cd /etc", "/etc"),
		"the cd/pushd target",
	);
	check(
		"provenance: a prefix assignment value names the assignment posture",
		await operandPosition("FOO=/etc/passwd cmd", "/etc/passwd"),
		"a variable-assignment value",
	);
	check(
		"provenance: a declaration value names the assignment posture",
		await operandPosition("export X=/etc/passwd", "/etc/passwd"),
		"a variable-assignment value",
	);
	check(
		"provenance: an executor payload names the shell and its -c flag",
		await operandPosition("bash -c 'cat /etc/passwd'", "/etc/passwd"),
		"the bash -c payload",
	);
	check(
		"provenance: an eval payload names eval",
		await operandPosition("eval 'cat /etc/group'", "/etc/group"),
		"the eval payload",
	);
	check(
		"provenance: an ssh payload names ssh",
		await operandPosition("ssh host 'cat /etc/hosts'", "/etc/hosts"),
		"the ssh payload",
	);
	check(
		"provenance: a su payload names su and its -c flag",
		await operandPosition("su -c 'cat /etc/shadow' root", "/etc/shadow"),
		"the su -c payload",
	);
	check(
		"provenance: a heredoc body word names the statement head",
		await operandPosition("bash << EOF\ncat /etc/passwd\nEOF", "/etc/passwd"),
		"a heredoc body fed to bash as its stdin script",
	);
	check(
		"provenance: a wrapper-hidden heredoc body names the stripped shell",
		await operandPosition("command bash << EOF\ncat /etc/passwd\nEOF", "/etc/passwd"),
		"a heredoc body fed to bash as its stdin script",
	);
	check(
		"provenance: a redirect-only exec heredoc body names exec",
		await operandPosition("exec << EOF\ncat /etc/passwd\nEOF\nbash", "/etc/passwd"),
		"a heredoc body fed to exec as its stdin script",
	);
	check(
		"provenance: a here-string word names the statement head",
		await operandPosition("bash <<< 'cat /etc/passwd'", "/etc/passwd"),
		"a here-string fed to bash as its stdin script",
	);
	check(
		"provenance: a node -e script word names the interpreter payload",
		await operandPosition("node -e 'cat /etc/passwd'", "/etc/passwd"),
		"the node -e script payload",
	);
	check(
		"provenance: a node --eval script word names the long flag",
		await operandPosition("node --eval 'cat /etc/passwd'", "/etc/passwd"),
		"the node --eval script payload",
	);
	check(
		"provenance: a glued node -e cluster names the interpreter payload",
		await operandPosition("node -e'cat /etc/passwd'", "/etc/passwd"),
		"the node -e script payload",
	);
	check(
		"provenance: a python -c script word names the interpreter payload",
		await operandPosition("python -c 'cat /etc/passwd'", "/etc/passwd"),
		"the python -c script payload",
	);
	check(
		"provenance: a python3 -c script word names the interpreter payload",
		await operandPosition("python3 -c 'cat /etc/passwd'", "/etc/passwd"),
		"the python3 -c script payload",
	);
	check(
		"provenance: a perl -e script word names the interpreter payload",
		await operandPosition("perl -e 'cat /etc/passwd'", "/etc/passwd"),
		"the perl -e script payload",
	);
	check(
		"provenance: a prefixed interpreter payload still names the interpreter",
		await operandPosition("sudo node -e 'cat /etc/passwd'", "/etc/passwd"),
		"the node -e script payload",
	);
	check(
		"provenance: an executor-carried interpreter payload reads as the executor payload",
		await operandPosition("bash -c 'node -e \"cat /etc/passwd\"'", "/etc/passwd"),
		"the bash -c payload",
	);
	check(
		"provenance: a sed script-file flag value names its role",
		((await scan("sed -f /scripts/fix.sed /etc/data")).operandPositions ?? {})["/scripts/fix.sed"],
		"a sed script-file flag value",
	);
	check(
		"provenance: a sed data-file operand keeps the argument posture",
		((await scan("sed -f /scripts/fix.sed /etc/data")).operandPositions ?? {})["/etc/data"],
		"a command argument",
	);

	const substitutionKinds = async (command) => (await scan(command)).substitutionKinds;
	check(
		"provenance: a command substitution names its kind",
		JSON.stringify(await substitutionKinds("echo $(cat inside/file.txt)")),
		JSON.stringify(["a command substitution"]),
	);
	check(
		"provenance: a backtick substitution names the command-substitution kind",
		JSON.stringify(await substitutionKinds("cat `ls inside`")),
		JSON.stringify(["a command substitution"]),
	);
	check(
		"provenance: a bare parameter expansion names its kind",
		JSON.stringify(await substitutionKinds("cat $HOME/notes")),
		JSON.stringify(["a parameter expansion ($var)"]),
	);
	check(
		"provenance: a brace parameter expansion names its kind",
		JSON.stringify(await substitutionKinds("echo ${HOME}/secret")),
		JSON.stringify(["a brace parameter expansion (${var})"]),
	);
	check(
		"provenance: a process substitution names its kind",
		JSON.stringify(await substitutionKinds("cat <(cat inside/file.txt)")),
		JSON.stringify(["a process substitution"]),
	);
	check(
		"provenance: an arithmetic expansion names its kind",
		JSON.stringify(await substitutionKinds("echo $((1+2))")),
		JSON.stringify(["an arithmetic expansion"]),
	);
	check(
		"provenance: an ANSI-C string names its kind",
		JSON.stringify(await substitutionKinds("grep $'\\t' f")),
		JSON.stringify(["an ANSI-C quoted string"]),
	);
	check(
		"provenance: executor payload dollars name the payload-raw kind",
		JSON.stringify(await substitutionKinds("bash -c 'echo $HOME/notes'")),
		JSON.stringify(["a raw $ or backtick in an executor payload (the child shell re-evaluates it)"]),
	);
	check(
		"provenance: a seam body dollar names the stdin-script kind",
		JSON.stringify(await substitutionKinds("bash << 'EOF'\ncat $HOME/secret\nEOF")),
		JSON.stringify(["a raw $ or backtick in a stdin-script body (the consumer shell re-evaluates it)"]),
	);
	check(
		"provenance: mixed expansion kinds list in first-seen order",
		JSON.stringify(await substitutionKinds("echo $(x) ${y}")),
		JSON.stringify(["a command substitution", "a brace parameter expansion (${var})"]),
	);
	check(
		"provenance: a heredoc body word keeps its seam posture under the dollar backstop kinds",
		(await scan("bash << 'EOF'\ncat $HOME/secret\nEOF")).substitution,
		true,
	);
	check(
		"provenance: an assignment vector names the assignment posture",
		(await scan("PROMPT_COMMAND='cat /etc/passwd'")).envVectorPosture,
		"assignment",
	);
	check(
		"provenance: an env-spelling vector names the env posture",
		(await scan("env PROMPT_COMMAND=x cat file")).envVectorPosture,
		"env spelling",
	);

	// the gate renders the provenance into the live prompt: the ask
	// title, the refusal reason, and the headless ask evidence all name
	// the extraction position, so the user sees exactly why the fence
	// fired (the EXT-37 ruling's motivating probe: a node -e payload
	// path prompting as a bare out-of-scope path).
	const probeAsk = async (command) => bashGate({ input: { command } });
	checkContains(
		"the plain-argument ask names the argument posture",
		(await probeAsk("cat /etc/passwd")).title,
		"the scope pass extracted it from a command argument",
	);
	checkContains(
		"the redirect ask names the redirect posture",
		(await probeAsk("echo x > /etc/passwd")).title,
		"the scope pass extracted it from a redirect destination",
	);
	checkContains(
		"the cd ask names the cd/pushd posture",
		(await probeAsk("cd /etc")).title,
		"the scope pass extracted it from the cd/pushd target",
	);
	checkContains(
		"the assignment-value ask names the assignment posture",
		(await probeAsk("FOO=/etc/passwd run")).title,
		"the scope pass extracted it from a variable-assignment value",
	);
	checkContains(
		"the executor ask names the payload posture",
		(await probeAsk("bash -c 'cat /etc/passwd'")).title,
		"the scope pass extracted it from the bash -c payload",
	);
	checkContains(
		"the heredoc ask names the seam and the head",
		(await probeAsk("bash << EOF\ncat /etc/passwd\nEOF")).title,
		"the scope pass extracted it from a heredoc body fed to bash as its stdin script",
	);
	checkContains(
		"the here-string ask names the seam and the head",
		(await probeAsk("bash <<< 'cat /etc/passwd'")).title,
		"the scope pass extracted it from a here-string fed to bash as its stdin script",
	);
	const interpreterProbe = await probeAsk("node -e 'cat /etc/passwd'");
	check("the interpreter-payload probe asks", interpreterProbe.action, "ask");
	checkContains(
		"the interpreter-payload ask names the resolved path",
		interpreterProbe.title,
		"/etc/passwd resolves outside",
	);
	checkContains(
		"the interpreter-payload ask names the interpreter and its flag",
		interpreterProbe.title,
		"the scope pass extracted it from the node -e script payload",
	);
	checkContains(
		"the python -c ask names the interpreter",
		(await probeAsk("python -c 'cat /etc/passwd'")).title,
		"the scope pass extracted it from the python -c script payload",
	);
	checkContains(
		"the perl -e ask names the interpreter",
		(await probeAsk("perl -e 'cat /etc/passwd'")).title,
		"the scope pass extracted it from the perl -e script payload",
	);
	checkContains(
		"the substitution ask names the expansion kind",
		(await probeAsk("echo $(cat inside/file.txt)")).title,
		"(a command substitution)",
	);
	checkContains(
		"the executor-dollar substitution ask names the payload-raw kind",
		(await probeAsk("bash -c 'echo $HOME/notes'")).title,
		"a raw $ or backtick in an executor payload",
	);
	checkContains(
		"the env-spelling vector ask names the posture",
		(await probeAsk("env PROMPT_COMMAND=x cat file")).title,
		"command carries PROMPT_COMMAND in an env spelling",
	);
	checkContains(
		"the assignment vector ask keeps the assignment posture",
		(await probeAsk("PROMPT_COMMAND='cat /etc/passwd'")).title,
		"command assigns PROMPT_COMMAND",
	);
	const interpreterHeadless = bashGate({ input: { command: "node -e 'cat /etc/passwd'" }, hasUI: false });
	check("the interpreter-payload probe blocks headless", (await interpreterHeadless).action, "block");
	checkContains(
		"the headless forwarded evidence carries the provenance",
		(await interpreterHeadless).askEvidence ?? "",
		"the node -e script payload",
	);
	check(
		"a scan injection without provenance reads as the argument posture",
		(
			await bashGate({
				input: { command: "anything" },
				scan: async () => ({ substitution: false, executor: false, interposed: null, bail: false, cdAsk: null, operands: ["/etc/passwd"] }),
			})
		).title.includes("the scope pass extracted it from a command argument"),
		true,
	);
	check(
		"the path-tool ask keeps its generic shape (no bash extraction provenance)",
		gate({ input: { path: outFile } }).title.includes("the scope pass extracted it"),
		false,
	);

	// --- parent-own grant recorder: unit 1-2 wiring ----------------------
	// The interactive Yes on the parent's own ask path is property 1's
	// producer: the approved ask's escaping candidate is classified
	// (directory/file/unresolved) and keyed per the fence-ask
	// grant-key contract, then recorded into the ledger as a parent-own
	// grant. Verdicts never consult the ledger: recording changes what
	// FUTURE CHILDREN inherit and what the ask-dedup index holds, not
	// this session's decisions.

	const recBase = path.join(fixtureRoot, "recorder");
	const recDir = path.join(recBase, "dir");
	fs.mkdirSync(recDir, { recursive: true });
	const recFile = path.join(recDir, "file.txt");
	fs.writeFileSync(recFile, "fixture");
	const recAlias = path.join(recBase, "alias");
	fs.symlinkSync(recDir, recAlias, "dir");
	const recDangle = path.join(recDir, "dangle-link");
	fs.symlinkSync(path.join(recDir, "missing-target"), recDangle, "file");
	const recWriteAhead = path.join(recDir, "newdir", "newfile.txt");
	const recRealDir = fs.realpathSync(recDir);

	resetFenceAskState();
	check(
		"the recorder starts from an empty parent-own ledger",
		parentGrantedDirectories().length,
		0,
	);
	check("recording a directory-form candidate keys itself", recordParentOwnGrant(recDir), recRealDir);
	check(
		"the recorded directory joins the parent-own source",
		JSON.stringify(parentGrantedDirectories()),
		JSON.stringify([recRealDir]),
	);
	check(
		"recording a file-form candidate keys its parent directory",
		recordParentOwnGrant(recFile),
		recRealDir,
	);
	check(
		"recording a symlinked directory keys the physical self",
		recordParentOwnGrant(recAlias),
		recRealDir,
	);
	check(
		"recording a dangling symlink keys the containing real directory",
		recordParentOwnGrant(recDangle),
		recRealDir,
	);
	check(
		"recording a trailing-separator directory form keys the stripped self",
		recordParentOwnGrant(recDir + path.sep),
		recRealDir,
	);
	check(
		"recording a write-ahead candidate keys the literal dirname",
		recordParentOwnGrant(recWriteAhead),
		path.dirname(recWriteAhead),
	);
	check("re-recording a keyed directory keeps one row", parentGrantedDirectories().length, 2);
	check("recording an unusable candidate records nothing", recordParentOwnGrant(null), null);
	check("recording an empty candidate records nothing", recordParentOwnGrant(""), null);
	check("recording a relative candidate records nothing", recordParentOwnGrant("rel/path"), null);
	check("recording an undefined candidate records nothing", recordParentOwnGrant(undefined), null);
	check("unusable candidates leave the ledger untouched", parentGrantedDirectories().length, 2);
	resetFenceAskState();

	// property 1 as the Task Breakdown's measurable, with the re-review
	// 11 DC-A negative at both the roots level and the verdict level:
	// the real classifier seeds a parent-own grant, the real
	// composition produces the child env value, the child-side
	// parseExtraRoots consumes it, and the child's verdict allows the
	// granted directory while its parent stays asked (a mis-wired
	// classifier that keyed the parent would fail the second half).
	resetFenceAskState();
	const propDir = path.join(fixtureRoot, "property1", "granted");
	fs.mkdirSync(propDir, { recursive: true });
	fs.writeFileSync(path.join(propDir, "inner.txt"), "fixture");
	const childSessionCwd = path.join(fixtureRoot, "childwork");
	fs.mkdirSync(childSessionCwd, { recursive: true });
	check("the seeded grant records the directory itself", recordParentOwnGrant(propDir), fs.realpathSync(propDir));
	const childEnvValue = inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: cwdDir,
		dispatchCwd: childSessionCwd,
	});
	const childRoots = parseExtraRoots(childEnvValue);
	check(
		"the child's composed roots contain exactly the granted directory",
		childRoots.includes(fs.realpathSync(propDir)),
		true,
	);
	check(
		"the child's composed roots do not contain the granted directory's parent",
		childRoots.includes(fs.realpathSync(path.join(fixtureRoot, "property1"))),
		false,
	);
	const childAllowed = buildAllowedRoots(childSessionCwd, childRoots, customTmpDir);
	const childAllowVerdict = resolveScopeTarget(
		childSessionCwd,
		childAllowed,
		path.join(propDir, "inner.txt"),
		fakeHome,
		cleanSeal,
	);
	check("the child's verdict allows the granted directory", childAllowVerdict.scope, "allow");
	checkContains("the child allow names the granted root", childAllowVerdict.detail, fs.realpathSync(propDir));
	const childParentAsk = resolveScopeTarget(
		childSessionCwd,
		childAllowed,
		path.join(fixtureRoot, "property1"),
		fakeHome,
		cleanSeal,
	);
	check("the granted directory's parent stays asked for the child", childParentAsk.scope, "ask");
	resetFenceAskState();

	// the escaping candidate rides the ask verdict so the recorder has
	// the exact candidate to key, whatever resolution surfaced it
	const candidateAsk = resolveScopeTarget(cwdDir, customRoots, outFile, fakeHome, cleanSeal);
	check("an out-of-scope ask carries its escaping candidate", candidateAsk.escapingCandidate, outFile);
	const candidateKernelAsk = resolveScopeTarget(cwdDir, customRoots, linkOut, fakeHome, cleanSeal);
	check(
		"a symlink-escape ask carries the kernel-resolved candidate",
		candidateKernelAsk.escapingCandidate,
		fs.realpathSync(outsideDir),
	);
	check(
		"an allow verdict carries no escaping candidate",
		resolveScopeTarget(cwdDir, customRoots, inFile, fakeHome, cleanSeal).escapingCandidate,
		undefined,
	);
	check(
		"a degraded-seal ask carries no escaping candidate",
		resolveScopeTarget(cwdDir, customRoots, inFile, fakeHome, degradedSeal).escapingCandidate,
		undefined,
	);
	check(
		"an unusable-input ask carries no escaping candidate",
		resolveScopeTarget(cwdDir, customRoots, "", fakeHome, cleanSeal).escapingCandidate,
		undefined,
	);

	// the ask decision carries the candidate for the factory's Yes branch
	const candidateDecision = decidePathToolCall({
		toolName: "read",
		input: { path: outFile },
		sessionCwd: cwdDir,
		allowedRoots: customRoots,
		hasUI: true,
		seal: cleanSeal,
	});
	check("the path ask decision carries the grant candidate", candidateDecision.grantCandidate, outFile);
	const bashCandidateDecision = await decideBashToolCall({
		toolName: "bash",
		input: { command: `cat ${outFile}` },
		sessionCwd: cwdDir,
		allowedRoots: customRoots,
		hasUI: true,
		seal: cleanSeal,
	});
	check("the bash operand ask decision carries the grant candidate", bashCandidateDecision.grantCandidate, outFile);
	const bashSubstitutionDecision = await decideBashToolCall({
		toolName: "bash",
		input: { command: "echo $HOME/secret" },
		sessionCwd: cwdDir,
		allowedRoots: customRoots,
		hasUI: true,
		seal: cleanSeal,
	});
	check(
		"a bash substitution ask carries no grant candidate",
		bashSubstitutionDecision.grantCandidate,
		undefined,
	);
	const bashCdDecision = await decideBashToolCall({
		toolName: "bash",
		input: { command: "cd" },
		sessionCwd: cwdDir,
		allowedRoots: customRoots,
		hasUI: true,
		seal: cleanSeal,
	});
	check("a bash cd ask carries no grant candidate", bashCdDecision.grantCandidate, undefined);
	check(
		"a pass decision carries no grant candidate",
		decidePathToolCall({
			toolName: "read",
			input: { path: inFile },
			sessionCwd: cwdDir,
			allowedRoots: customRoots,
			hasUI: true,
			seal: cleanSeal,
		}).grantCandidate,
		undefined,
	);

	// end-to-end through the real handler: the approved out-of-scope
	// call records the derived parent-own grant; refusal, headless
	// block, and repeat approval record nothing
	resetFenceAskState();
	const approvedRecorder = await handler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		ctxWithChoice("Yes"),
	);
	check("the approved out-of-scope handler call still passes", approvedRecorder, undefined);
	check(
		"the approval records the derived parent-own grant",
		JSON.stringify(parentGrantedDirectories()),
		JSON.stringify(["/etc"]),
	);
	const refusedRecorder = await handler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		ctxWithChoice("No"),
	);
	check("the refused handler call still blocks", refusedRecorder && refusedRecorder.block, true);
	check("a refusal records nothing", parentGrantedDirectories().length, 1);
	const headlessRecorder = await handler(
		{ toolName: "read", input: { path: "/etc/passwd" } },
		{ cwd: cwdDir, hasUI: false, ui: { select: async () => "Yes" } },
	);
	check("the headless handler call still blocks", headlessRecorder && headlessRecorder.block, true);
	check("a headless block records nothing", parentGrantedDirectories().length, 1);
	await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctxWithChoice("Yes"));
	check("a repeat approval stays one grant row", parentGrantedDirectories().length, 1);
	resetFenceAskState();
} finally {
	if (typeof handlerSavedAskRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = handlerSavedAskRoot;
	else delete process.env[CHILD_ASK_ROOT_ENV];
	if (typeof handlerSavedAskToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = handlerSavedAskToken;
	else delete process.env[CHILD_ASK_TOKEN_ENV];
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

// --- unit 1-3: the headless forward branch --------------------------
// A provisioned headless child's out-of-scope ask forwards up the
// channel instead of failing closed. The decision data carries the
// candidate and evidence so the factory can forward; degraded-seal and
// unusable-input asks carry neither field, so they block without ever
// touching the channel. forwardHeadlessAsk runs the bounded flow with
// the form-aware grant key and applies a grant to this child's own
// verdicts; the factory handler maps the outcome onto pass or block,
// and its per-call allowed-roots build consumes appliedSelfGrants.

const fwdCwd = fs.mkdtempSync(path.join(os.tmpdir(), "fence-fwd-suite-"));
const fwdFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fence-fwd-fixture-"));
const fwdTmp = path.join(fwdFixtureRoot, "tmp");
fs.mkdirSync(fwdTmp);
const fwdCleanSeal = { degraded: false, reasons: [] };
const fwdDegradedSeal = { degraded: true, reasons: ["fixture drift"] };
const fwdRoots = buildAllowedRoots(fwdCwd, [], fwdTmp);
const forwardRoot = path.join(os.tmpdir(), `fence-fwd-root-${randomUUID()}`);
createForwardingRootDirs(forwardRoot);
const forwardToken = randomUUID();
registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 200_000);
const fwdSavedWait = process.env[ASK_WAIT_ENV];
const fwdSavedAskRoot = process.env[CHILD_ASK_ROOT_ENV];
const fwdSavedAskToken = process.env[CHILD_ASK_TOKEN_ENV];
process.env[CHILD_ASK_ROOT_ENV] = forwardRoot;
process.env[CHILD_ASK_TOKEN_ENV] = forwardToken;

function fwdSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
async function fwdWaitFor(predicate, timeoutMs = 5_000, step = 10) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await fwdSleep(step);
	}
	return null;
}

try {
	// decision data: the headless block of a candidate-bearing ask
	// carries the candidate and the evidence; degraded and unusable
	// asks carry neither, so the factory branch cannot reach the
	// channel for them.
	const fwdPathHeadless = decidePathToolCall({
		toolName: "read",
		input: { path: "/etc/hostname" },
		sessionCwd: fwdCwd,
		allowedRoots: fwdRoots,
		hasUI: false,
		seal: fwdCleanSeal,
	});
	check("a headless path block carries the grant candidate", fwdPathHeadless.grantCandidate, "/etc/hostname");
	check(
		"a headless path block carries the ask evidence",
		typeof fwdPathHeadless.askEvidence === "string" && fwdPathHeadless.askEvidence.length > 0,
		true,
	);
	checkContains("the ask evidence explains the policy breach", fwdPathHeadless.askEvidence ?? "", "allowed");
	const fwdBashHeadless = await decideBashToolCall({
		toolName: "bash",
		input: { command: "cat /etc/hostname" },
		sessionCwd: fwdCwd,
		allowedRoots: fwdRoots,
		hasUI: false,
		seal: fwdCleanSeal,
	});
	check("a headless bash operand block carries the grant candidate", fwdBashHeadless.grantCandidate, "/etc/hostname");
	check(
		"a headless bash operand block carries the ask evidence",
		typeof fwdBashHeadless.askEvidence === "string" && fwdBashHeadless.askEvidence.length > 0,
		true,
	);
	const fwdDegradedPath = decidePathToolCall({
		toolName: "read",
		input: { path: "/etc/hostname" },
		sessionCwd: fwdCwd,
		allowedRoots: fwdRoots,
		hasUI: false,
		seal: fwdDegradedSeal,
	});
	check("a degraded headless block carries no grant candidate", fwdDegradedPath.grantCandidate, undefined);
	checkContains("a degraded headless block still explains itself", fwdDegradedPath.askEvidence ?? "", "degraded");
	const fwdDegradedBash = await decideBashToolCall({
		toolName: "bash",
		input: { command: "cat /etc/hostname" },
		sessionCwd: fwdCwd,
		allowedRoots: fwdRoots,
		hasUI: false,
		seal: fwdDegradedSeal,
	});
	check("a degraded headless bash block carries no grant candidate", fwdDegradedBash.grantCandidate, undefined);
	const fwdSubstitution = await decideBashToolCall({
		toolName: "bash",
		input: { command: "echo $HOME/secret" },
		sessionCwd: fwdCwd,
		allowedRoots: fwdRoots,
		hasUI: false,
		seal: fwdCleanSeal,
	});
	check("a substitution headless block carries no grant candidate", fwdSubstitution.grantCandidate, undefined);
	checkContains("a substitution headless block still explains itself", fwdSubstitution.askEvidence ?? "", "expansion");

	// forwardHeadlessAsk applied: the served grant passes the call,
	// lands the dual-form root in appliedSelfGrants, and the derived
	// key is form-aware. A file candidate keys its parent directory.
	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 200_000);
	const fwdSeen = [];
	const fwdServed = (async () => {
		await fwdWaitFor(() => requestIdsIn(forwardRoot).length === 1);
		await serveForwardingRootTick({
			root: forwardRoot,
			handler: async (ask, provenance) => {
				fwdSeen.push({ ask, provenance });
				return true;
			},
			maxAge: 60_000,
		});
	})();
	const fwdApplied = await forwardHeadlessAsk({
		toolName: "read",
		candidate: "/etc/hostname",
		askEvidence: "the fixture evidence text",
		provisioning: { root: forwardRoot, token: forwardToken },
		waitMs: 10_000,
		pollMs: 20,
	});
	await fwdServed;
	check("an applied forward passes the call", fwdApplied.action, "pass");
	check(
		"the applied grant lands in appliedSelfGrants",
		appliedSelfGrants().includes("/etc"),
		true,
	);
	check(
		"the granted directory admits through the child-scoped roots",
		resolveScopeTarget(fwdCwd, childScopedAllowedRoots(fwdCwd), "/etc/hostname", os.homedir(), fwdCleanSeal).scope,
		"allow",
	);
	check(
		"the forwarded ask keys the parent directory of a file candidate",
		fwdSeen[0] ? fwdSeen[0].ask.resolvedPath : "none",
		"/etc",
	);
	checkContains("the forwarded ask reason names the candidate", fwdSeen[0] ? fwdSeen[0].ask.reason : "", "/etc/hostname");
	checkContains("the forwarded ask reason carries the evidence", fwdSeen[0] ? fwdSeen[0].ask.reason : "", "the fixture evidence text");
	check("the forwarded ask rides this child's token", fwdSeen[0] ? fwdSeen[0].ask.childToken : "none", forwardToken);
	check(
		"the prompt provenance names the registry identity, not the wire",
		fwdSeen[0] ? fwdSeen[0].provenance.agentName : "none",
		"fwd-worker",
	);

	// forwardHeadlessAsk denied: the block names the via, the
	// directory, and the fail-closed posture.
	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 200_100);
	const fwdDenyServed = (async () => {
		await fwdWaitFor(() => requestIdsIn(forwardRoot).length === 1);
		await serveForwardingRootTick({ root: forwardRoot, handler: async () => false, maxAge: 60_000 });
	})();
	const fwdDenied = await forwardHeadlessAsk({
		toolName: "write",
		candidate: "/var/log/fwd-denied.txt",
		askEvidence: "denial fixture evidence",
		provisioning: { root: forwardRoot, token: forwardToken },
		waitMs: 10_000,
		pollMs: 20,
	});
	await fwdDenyServed;
	check("a denied forward blocks", fwdDenied.action, "block");
	checkContains("the deny block names the via", fwdDenied.reason ?? "", "user");
	checkContains("the deny block names the directory", fwdDenied.reason ?? "", "/var/log");
	checkContains("the deny block states the fail-closed posture", fwdDenied.reason ?? "", "fails closed");
	check(
		"a denial lands nothing in appliedSelfGrants",
		appliedSelfGrants().length,
		0,
	);

	// forwardHeadlessAsk timeout: no serving surface, the explicit
	// wait bound is honored, and the block is fail-closed.
	const fwdTimedOut = await forwardHeadlessAsk({
		toolName: "read",
		candidate: "/usr/share",
		askEvidence: "timeout fixture evidence",
		provisioning: { root: forwardRoot, token: forwardToken },
		waitMs: 120,
		pollMs: 20,
	});
	check("an unserved forward times out into a block", fwdTimedOut.action, "block");
	checkContains("the timeout block names the wait bound", fwdTimedOut.reason ?? "", "120");
	checkContains("the timeout block names the directory", fwdTimedOut.reason ?? "", "/usr/share");
	checkContains("the timeout block states the fail-closed posture", fwdTimedOut.reason ?? "", "fails closed");
	deleteAskFile(forwardRoot, requestIdsIn(forwardRoot)[0] ?? "");

	// forwardHeadlessAsk failed: an unusable channel root fails closed
	// with the channel-unusable reason instead of throwing.
	const fwdBrokenRoot = path.join(os.tmpdir(), `fence-fwd-broken-${randomUUID()}`);
	fs.writeFileSync(fwdBrokenRoot, "not a directory");
	const fwdFailed = await forwardHeadlessAsk({
		toolName: "read",
		candidate: "/etc/hostname",
		askEvidence: "failed fixture evidence",
		provisioning: { root: fwdBrokenRoot, token: forwardToken },
		waitMs: 500,
		pollMs: 20,
	});
	check("a channel failure blocks", fwdFailed.action, "block");
	checkContains("the failed block names the unusable channel", fwdFailed.reason ?? "", "unusable");
	checkContains("the failed block states the fail-closed posture", fwdFailed.reason ?? "", "fails closed");
	fs.rmSync(fwdBrokenRoot, { force: true });

	// factory wiring: a provisioned headless child's out-of-scope call
	// forwards, and the ruling maps onto pass or block through the
	// live handler. The granted directory then admits through the
	// handler's own per-call allowed-roots build.
	const fwdRegistered = [];
	const fwdStubPi = {
		on(name, fwdHandler) {
			fwdRegistered.push({ name, handler: fwdHandler });
		},
	};
	cwdScopeGate(fwdStubPi);
	const fwdHandler = fwdRegistered[0].handler;
	const fwdCtx = { cwd: fwdCwd, hasUI: false, ui: { select: async () => "Yes" } };

	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 201_000);
	process.env[ASK_WAIT_ENV] = "10000";
	const fwdGrantCall = fwdHandler({ toolName: "read", input: { path: "/etc/hostname" } }, fwdCtx);
	const fwdGrantServed = (async () => {
		await fwdWaitFor(() => requestIdsIn(forwardRoot).length === 1);
		await serveForwardingRootTick({ root: forwardRoot, handler: async () => true, maxAge: 60_000 });
	})();
	check("a granted forward passes through the live handler", await fwdGrantCall, undefined);
	await fwdGrantServed;
	check(
		"the handler's granted root feeds the next verdict",
		resolveScopeTarget(fwdCwd, childScopedAllowedRoots(fwdCwd), "/etc/hostname", os.homedir(), fwdCleanSeal).scope,
		"allow",
	);
	check(
		"the granted call passes again with no second round-trip",
		await fwdHandler({ toolName: "read", input: { path: "/etc/hostname" } }, fwdCtx),
		undefined,
	);
	check("the granted re-call wrote no request file", requestIdsIn(forwardRoot).length, 0);

	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 201_100);
	const fwdHandlerDenyCall = fwdHandler({ toolName: "read", input: { path: "/usr/local" } }, fwdCtx);
	const fwdHandlerDenyServed = (async () => {
		await fwdWaitFor(() => requestIdsIn(forwardRoot).length === 1);
		await serveForwardingRootTick({ root: forwardRoot, handler: async () => false, maxAge: 60_000 });
	})();
	const fwdDenyResult = await fwdHandlerDenyCall;
	await fwdHandlerDenyServed;
	check("a denied forward blocks through the live handler", fwdDenyResult && fwdDenyResult.block, true);
	checkContains("the handler deny names the via", fwdDenyResult ? fwdDenyResult.reason : "", "user");

	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 201_200);
	process.env[ASK_WAIT_ENV] = "150";
	const fwdTimeoutResult = await fwdHandler({ toolName: "read", input: { path: "/usr/share" } }, fwdCtx);
	check("an unserved forward blocks through the live handler", fwdTimeoutResult && fwdTimeoutResult.block, true);
	checkContains("the handler timeout names the bound", fwdTimeoutResult ? fwdTimeoutResult.reason : "", "150");

	deleteAskFile(forwardRoot, requestIdsIn(forwardRoot)[0] ?? "");

	// guards: a candidate-less ask never writes a request file even
	// when provisioning is present, and without provisioning the
	// headless block keeps today's remedy posture.
	resetFenceAskState();
	registerLiveChild(forwardToken, "fwd-worker", "fwd dispatch", 201_300);
	process.env[ASK_WAIT_ENV] = "10000";
	const fwdGuardResult = await fwdHandler(
		{ toolName: "bash", input: { command: "echo $HOME/secret" } },
		fwdCtx,
	);
	check("a candidate-less ask blocks without forwarding", fwdGuardResult && fwdGuardResult.block, true);
	check("the candidate-less ask wrote no request file", requestIdsIn(forwardRoot).length, 0);
	delete process.env[CHILD_ASK_ROOT_ENV];
	delete process.env[CHILD_ASK_TOKEN_ENV];
	const fwdUnprovisioned = await fwdHandler({ toolName: "read", input: { path: "/etc/hostname" } }, fwdCtx);
	check("an unprovisioned headless call still blocks", fwdUnprovisioned && fwdUnprovisioned.block, true);
	checkContains(
		"the unprovisioned block keeps the interactive remedy",
		fwdUnprovisioned ? fwdUnprovisioned.reason : "",
		"no interactive UI",
	);
	check("the unprovisioned call wrote no request file", requestIdsIn(forwardRoot).length, 0);
} finally {
	if (typeof fwdSavedWait === "string") process.env[ASK_WAIT_ENV] = fwdSavedWait;
	else delete process.env[ASK_WAIT_ENV];
	if (typeof fwdSavedAskRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = fwdSavedAskRoot;
	else delete process.env[CHILD_ASK_ROOT_ENV];
	if (typeof fwdSavedAskToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = fwdSavedAskToken;
	else delete process.env[CHILD_ASK_TOKEN_ENV];
	resetFenceAskState();
	resetFenceExtraRoots();
	fs.rmSync(forwardRoot, { recursive: true, force: true });
	fs.rmSync(fwdFixtureRoot, { recursive: true, force: true });
	fs.rmSync(fwdCwd, { recursive: true, force: true });
}
if (typeof ambientAskRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = ambientAskRoot;
else delete process.env[CHILD_ASK_ROOT_ENV];
if (typeof ambientAskToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = ambientAskToken;
else delete process.env[CHILD_ASK_TOKEN_ENV];

// --- PISCOPE-2-1: the fence-ast parser infrastructure --------------
// The bash pass's parser infrastructure is a sibling package under
// extensions/, importable by relative path and invisible to pi's
// extension auto-discovery, whose subdirectory rule reads exactly
// three entry shapes: a package.json with a pi.extensions manifest,
// index.ts, and index.js (pi's dist/core/extensions/loader.js
// resolveExtensionEntries, one level deep, no recursion). fence-ast
// carries none of them, so nothing in the package is loadable until
// the fence itself imports it (unit PISCOPE-2-2). The pins cover the
// undiscovered-by-loader negative probe, the vendored artifacts'
// SHA-256 pins with a mutated-fixture red, and the loader's init,
// retry, and memoization contract (the GPS shape the module docstring
// carries).

const fenceAstDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "fence-ast");
const fenceAstVendorDir = path.join(fenceAstDir, "vendor");

check("fence-ast exists for the infrastructure pins to cover", fs.existsSync(fenceAstDir), true);
check("fence-ast carries no index.ts for the loader to discover", fs.existsSync(path.join(fenceAstDir, "index.ts")), false);
check("fence-ast carries no index.js for the loader to discover", fs.existsSync(path.join(fenceAstDir, "index.js")), false);
check("fence-ast carries no package.json manifest for the loader to discover", fs.existsSync(path.join(fenceAstDir, "package.json")), false);
for (const artifact of GRAMMAR_ARTIFACT_FILES) {
	check(`the vendored ${artifact} is present`, fs.existsSync(path.join(fenceAstVendorDir, artifact)), true);
}
check("the web-tree-sitter license text is vendored", fs.existsSync(path.join(fenceAstVendorDir, "web-tree-sitter.LICENSE")), true);
check("the tree-sitter-bash license text is vendored", fs.existsSync(path.join(fenceAstVendorDir, "tree-sitter-bash.LICENSE")), true);
check("the vendor attribution record is present", fs.existsSync(path.join(fenceAstVendorDir, "ATTRIBUTION.md")), true);
check("the loader entry bash-parser.ts is present", fs.existsSync(path.join(fenceAstDir, "bash-parser.ts")), true);
check("the pins surface grammar-pins.ts is present", fs.existsSync(path.join(fenceAstDir, "grammar-pins.ts")), true);

check("every vendored artifact carries a digest pin", GRAMMAR_ARTIFACT_FILES.every((artifact) => typeof GRAMMAR_DIGEST_PINS[artifact] === "string"), true);
check("the digest pin set covers exactly the vendored artifact list", Object.keys(GRAMMAR_DIGEST_PINS).length === GRAMMAR_ARTIFACT_FILES.length, true);
for (const artifact of GRAMMAR_ARTIFACT_FILES) {
	check(
		`the vendored ${artifact} hashes to its recorded pin`,
		computeFileDigest(path.join(fenceAstVendorDir, artifact)),
		GRAMMAR_DIGEST_PINS[artifact],
	);
}
{
	const mutationFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fence-ast-mutation-"));
	try {
		const artifact = "web-tree-sitter.wasm";
		const source = path.join(fenceAstVendorDir, artifact);
		const pristine = path.join(mutationFixtureDir, "pristine.wasm");
		const mutated = path.join(mutationFixtureDir, "mutated.wasm");
		const bytes = fs.readFileSync(source);
		fs.writeFileSync(pristine, bytes);
		const flipped = Buffer.from(bytes);
		flipped[Math.floor(flipped.length / 2)] ^= 0xff;
		fs.writeFileSync(mutated, flipped);
		check("the mutation fixture's unmutated copy hashes to the pin", computeFileDigest(pristine), GRAMMAR_DIGEST_PINS[artifact]);
		check("a mutated fixture fails the digest comparison the seal will apply", computeFileDigest(mutated) === GRAMMAR_DIGEST_PINS[artifact], false);
	} finally {
		fs.rmSync(mutationFixtureDir, { recursive: true, force: true });
	}
}

const bashParser = await loadBashParser();
check("the loader resolves a parser with a parse function", typeof bashParser.parse === "function", true);
{
	const tree = bashParser.parse("cat /etc/secrets");
	check("a real command parses to a program root", tree?.rootNode.type, "program");
	check("a clean command's parse carries no error", tree?.rootNode.hasError, false);
	tree.delete();
}
{
	const tree = bashParser.parse("FOO=/etc/passwd cat");
	const commandNode = tree?.rootNode.child(0);
	check("the bash grammar is live: the root command parses", commandNode?.type, "command");
	const childTypes = [];
	for (let i = 0; i < (commandNode?.childCount ?? 0); i++) {
		const child = commandNode.child(i);
		if (child) childTypes.push(child.type);
	}
	check("an assignment prefix parses as variable_assignment inside the command", childTypes.includes("variable_assignment"), true);
	tree.delete();
}
{
	const tree = bashParser.parse("echo 'unterminated");
	check("an unterminated quote parses with the error flag set", tree?.rootNode.hasError, true);
	tree.delete();
}
check("repeat loads resolve to the same memoized parser instance", (await loadBashParser()) === bashParser, true);
{
	const [firstConcurrent, secondConcurrent] = await Promise.all([loadBashParser(), loadBashParser()]);
	check("concurrent callers share one parser instance", firstConcurrent === bashParser && secondConcurrent === bashParser, true);
}
{
	let factoryRuns = 0;
	const retrying = memoizeAsyncWithRetry(async () => {
		factoryRuns += 1;
		if (factoryRuns === 1) throw new Error("transient wasm load failure");
		return { marker: factoryRuns };
	});
	let firstCallRejected = false;
	try {
		await retrying();
	} catch {
		firstCallRejected = true;
	}
	check("a failing first load rejects instead of throwing synchronously", firstCallRejected, true);
	const retried = await retrying();
	check("a rejected load is dropped and the next call retries the factory", factoryRuns === 2, true);
	check("the retried load resolves the fresh factory result", retried?.marker, 2);
	check("a resolved load stays memoized without re-running the factory", factoryRuns === 2 && (await retrying()) === retried, true);
}

// --- PISCOPE-2-2: the fence-ast hardening surfaces ------------------
// The advisory obligations folded into the detection-layer swap: the
// tree-lifetime helper (DC-2), the bounded init budget (DC-1), and the
// digest-before-import ordering (advisor R2, the engine entry is
// executable code and the grammar wasm load path can evaluate embedded
// JS, so no vendored byte may load before its pin verifies). The
// module-type pin (DC-3) walks the in-repo manifest chain above the
// vendored entry; the deployed agent-root walk is discharged by unit
// PISCOPE-2-3's landing evidence.

check(
	"the parser init budget is a positive bounded constant",
	typeof BASH_PARSER_INIT_TIMEOUT_MS === "number" && BASH_PARSER_INIT_TIMEOUT_MS > 0,
	true,
);
{
	let hungRejected = false;
	try {
		await withInitBudget(new Promise(() => {}), 40);
	} catch {
		hungRejected = true;
	}
	check("a hung init rejects within the budget instead of stalling", hungRejected, true);
	check("a settling init passes the budget unchanged", await withInitBudget(Promise.resolve("ok"), 40), "ok");
	let factoryRuns = 0;
	const healing = memoizeAsyncWithRetry(() => {
		factoryRuns += 1;
		if (factoryRuns === 1) return withInitBudget(new Promise(() => {}), 30);
		return Promise.resolve("healed");
	});
	let budgetRejected = false;
	try {
		await healing();
	} catch {
		budgetRejected = true;
	}
	check("a hung first init rejects through the budget, not the hang", budgetRejected, true);
	check("a budget-rejected init does not poison the memo and heals on retry", await healing(), "healed");
}
{
	const rootType = await withBashParse("cat /etc/secrets", (rootNode) => rootNode.type);
	check("withBashParse runs the body over the parsed root and returns its result", rootType, "program");
	let bodyThrew = false;
	try {
		await withBashParse("cat /etc/secrets", () => {
			throw new Error("body failure");
		});
	} catch {
		bodyThrew = true;
	}
	check("a body throw propagates out of withBashParse", bodyThrew, true);
	check(
		"the parser stays usable after a body throw (the tree was still released)",
		await withBashParse("cat /etc/secrets", (rootNode) => rootNode.type),
		"program",
	);
	let allParsed = true;
	for (const command of ["echo hi", "cat << EOF\nbody\nEOF", "(echo hi)", "echo 'unterminated", "echo \\'; cat \"$HOME/x\""]) {
		const type = await withBashParse(command, (rootNode) => rootNode.type);
		if (type !== "program") allParsed = false;
	}
	check("withBashParse serves every verdict-branch shape without losing the parser", allParsed, true);
}
{
	let verified = "threw";
	try {
		verifyGrammarArtifacts();
		verified = "clean";
	} catch {
		verified = "threw";
	}
	check("the vendored artifacts verify against the recorded pins as shipped", verified, "clean");
	const digestFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fence-ast-digest-"));
	try {
		for (const artifact of GRAMMAR_ARTIFACT_FILES) {
			fs.copyFileSync(path.join(fenceAstVendorDir, artifact), path.join(digestFixtureDir, artifact));
		}
		const mutatedName = "tree-sitter-bash.wasm";
		const mutatedPath = path.join(digestFixtureDir, mutatedName);
		const bytes = fs.readFileSync(mutatedPath);
		bytes[Math.floor(bytes.length / 2)] ^= 0xff;
		fs.writeFileSync(mutatedPath, bytes);
		let namesArtifact = false;
		try {
			verifyGrammarArtifacts(digestFixtureDir);
		} catch (error) {
			namesArtifact = String(error && error.message).includes(mutatedName);
		}
		check("a mutated artifact aborts verification naming it", namesArtifact, true);
	} finally {
		fs.rmSync(digestFixtureDir, { recursive: true, force: true });
	}
	const loaderSource = fs.readFileSync(path.join(fenceAstDir, "bash-parser.ts"), "utf8");
	const verifyCall = loaderSource.indexOf("verifyGrammarArtifacts()");
	const vendoredImport = loaderSource.indexOf('import("./vendor/web-tree-sitter.js")');
	check(
		"digest verification precedes the vendored import in the loader (verify-before-import)",
		verifyCall >= 0 && vendoredImport >= 0 && verifyCall < vendoredImport,
		true,
	);
}
{
	let governing = "none";
	let dir = fenceAstVendorDir;
	const repoRoot = path.join(fenceAstDir, "..", "..");
	while (dir !== path.dirname(dir)) {
		const manifestPath = path.join(dir, "package.json");
		if (fs.existsSync(manifestPath)) {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			if (manifest.type === "commonjs") {
				governing = "commonjs";
				break;
			}
		}
		if (dir === repoRoot) break;
		dir = path.dirname(dir);
	}
	check("no commonjs manifest governs the vendored ESM entry in-repo (the module-type pin)", governing, "none");
}
{
	const attribution = fs.readFileSync(path.join(fenceAstVendorDir, "ATTRIBUTION.md"), "utf8");
	check(
		"the registry integrity anchors are recorded",
		attribution.includes("YJwSHANl6XFgeEjB8nitgj0qZYt5gkIesJ4w2srS2wcLB4GUa4xcOkM0YaMsU6WNR53YVIkDSY7Ej4pf3IXtCA==") &&
			attribution.includes("7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw=="),
		true,
	);
	check(
		"the tarball provenance hashes are recorded",
		attribution.includes("aacd8ab6058fc132e531526d7253476abc56b0c64637e2037b0209205c14691b") &&
			attribution.includes("d4b2819508ea97cb8953fff7e304a610d443007bd395c8f03a15de9a8ae4a6f9"),
		true,
	);
}

check("the suite leaves the ask-root env at its start state", process.env[CHILD_ASK_ROOT_ENV], handlerSavedAskRoot);
check("the suite leaves the ask-token env at its start state", process.env[CHILD_ASK_TOKEN_ENV], handlerSavedAskToken);

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
