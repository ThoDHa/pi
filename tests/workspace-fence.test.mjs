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
 * The bash scope pass (unit 1-3) is exercised the same way:
 * scanBashCommand pins the recall-limited extraction (tokenizer-based
 * extraction from the raw command: quoted operands, redirect targets,
 * and assignment RHS gate; quoted prose splits into pieces;
 * substitution flags with the single-quote narrowing and escape-
 * literal semantics; unmodeled-syntax flags in plain and double-quoted
 * text; executor payload splitting and token-based executor-shape
 * detection; redirect-target extraction;
 * cd/pushd target extraction; continuation removal; assignment-prefix
 * RHS), decideBashToolCall pins its verdict classes
 * (in-scope pass, out-of-scope ask, substitution bias, unmodeled bail,
 * tilde-user and glob-traversal overrides, device exemption, degraded-
 * seal ask, headless block), and the factory handler maps bash events
 * onto the shared ask/block machinery.
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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import cwdScopeGate, {
	EXTRA_ROOTS_ENV,
	FENCE_CONFIG_FILE,
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
	resolveScopeTarget,
	recordParentOwnGrant,
	scanBashCommand,
	sessionSealState,
} from "../extensions/workspace-fence.ts";
import { inheritedExtraRootsEnvValue, parentGrantedDirectories, resetFenceAskState } from "../extensions/fence-ask/grant-ledger.ts";

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

	// --- unit 1-3: bash scope pass (recall-limited lexical scan) ---------
	// The tool_call surface extends to bash: path-like operands and cd
	// targets resolve through the same verdict core as the path tools,
	// substitution-bearing commands and unmodeled syntax bias toward
	// asking (the scanner cannot see expansion results or model every
	// grammar), and in-scope or relative-only commands run unprompted.
	// The bash pass generalizes permission-gate's scanner conventions
	// (executor dual-scan, raw payload splitting) but carries its own
	// single quote walker, and executor detection is token-based over
	// the walker's segments under lexical path-stripped identity (R4),
	// with glued -c forms and an interposition floor over
	// command/env/nohup/nice/timeout (R5; Decision Log "User ruling C");
	// permission-gate stays untouched.
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
	check("bash decider passes non-bash tools", bashGate({ toolName: "read" }).action, "pass");
	check(
		"powershell passes ungated (deferred)",
		bashGate({ toolName: "powershell", input: { command: "cat /etc/passwd" } }).action,
		"pass",
	);
	check("bare-word-only command passes", bashGate({ input: { command: "echo hello" } }).action, "pass");
	check("git status passes", bashGate({ input: { command: "git status --short" } }).action, "pass");
	check("relative-only operand passes", bashGate({ input: { command: "cat inside/file.txt" } }).action, "pass");
	check("cd within the cwd subtree passes", bashGate({ input: { command: "cd inside" } }).action, "pass");
	check(
		"in-scope redirect target passes",
		bashGate({ input: { command: "echo done > inside/log.txt" } }).action,
		"pass",
	);
	check("absolute command word is not a path operand", bashGate({ input: { command: "/bin/echo hi" } }).action, "pass");
	check(
		"assignment-prefix RHS outside asks (the env form's argv access point)",
		bashGate({ input: { command: "OUT=/etc/capture.txt run" } }).action,
		"ask",
	);
	check(
		"lone assignment segment passes (bash only sets the variable)",
		bashGate({ input: { command: "X=/etc/capture.txt" } }).action,
		"pass",
	);
	check("in-scope glob operand passes", bashGate({ input: { command: "cat inside/*.txt" } }).action, "pass");
	check(
		"in-scope executor payload passes",
		bashGate({ input: { command: "bash -c 'cat inside/file.txt'" } }).action,
		"pass",
	);

	// ask: out-of-scope operands and cd targets through the verdict core
	const bashOut = bashGate({ input: { command: "cat /etc/passwd" } });
	check("out-of-scope absolute operand asks", bashOut.action, "ask");
	checkContains("bash ask title names the tool", bashOut.title, "bash");
	checkContains("bash ask title names the resolved path", bashOut.title, "/etc/passwd");
	checkContains("bash ask title ends in the prompt", bashOut.title, "Allow?");
	checkContains("bash denial reason names the policy", bashOut.denyReason, EXTRA_ROOTS_ENV);
	check("cd outside the cwd subtree asks", bashGate({ input: { command: "cd /etc" } }).action, "ask");
	check("cd to tilde home asks", bashGate({ input: { command: "cd ~" } }).action, "ask");
	// F2: cd/pushd targets extract regardless of spelling, so bare and
	// symlinked names route through the core; unresolvable targets ask
	check(
		"cd through a bare symlinked name asks",
		bashGate({ input: { command: "cd link-out" } }).action,
		"ask",
	);
	check(
		"pushd through a bare symlinked name asks",
		bashGate({ input: { command: "pushd link-out" } }).action,
		"ask",
	);
	check("bare cd asks (home is not lexically resolvable)", bashGate({ input: { command: "cd" } }).action, "ask");
	check(
		"cd - asks (OLDPWD is not lexically resolvable)",
		bashGate({ input: { command: "cd -" } }).action,
		"ask",
	);
	check("cd .. asks (the parent of the session cwd)", bashGate({ input: { command: "cd .." } }).action, "ask");
	check("pushd within the cwd subtree passes", bashGate({ input: { command: "pushd inside" } }).action, "pass");
	check(
		"cd option-qualified in-scope target passes",
		bashGate({ input: { command: "cd -L inside" } }).action,
		"pass",
	);
	check(
		"dotdot escape via relative operand asks",
		bashGate({ input: { command: "cat ../outside/target.txt" } }).action,
		"ask",
	);
	check(
		"bash operand through a planted symlink asks (verdict core reuse)",
		bashGate({ input: { command: "cat link-out/sub/target.txt" } }).action,
		"ask",
	);
	check("absolute option value outside asks", bashGate({ input: { command: "tool --config=/etc/app.conf" } }).action, "ask");
	check(
		"env-carried argv value outside asks",
		bashGate({ input: { command: "env OUT=/etc/capture.txt run" } }).action,
		"ask",
	);
	check("option value in scope passes", bashGate({ input: { command: "tool --config=inside/app.conf" } }).action, "pass");
	// DC-1: process-internal and data-null devices exempt from bash
	// operand verdicts only; the path tools still resolve them
	check(
		"redirect to /dev/null passes (data-null device, bash-only exemption)",
		bashGate({ input: { command: "make 2>/dev/null" } }).action,
		"pass",
	);
	check(
		"write redirect to /dev/null passes",
		bashGate({ input: { command: "echo done > /dev/null" } }).action,
		"pass",
	);
	check(
		"reading /dev/null passes (device as source)",
		bashGate({ input: { command: "cat /dev/null" } }).action,
		"pass",
	);
	check(
		"fd-device redirect passes",
		bashGate({ input: { command: "echo done > /dev/fd/3" } }).action,
		"pass",
	);
	check(
		"/dev/tty stays gated (it reads user input)",
		bashGate({ input: { command: "cat /dev/tty" } }).action,
		"ask",
	);
	check(
		"arbitrary device nodes stay gated",
		bashGate({ input: { command: "cat /dev/sda" } }).action,
		"ask",
	);
	check(
		"reading /dev/stdin passes (process-internal stream, same class as stdout/stderr)",
		bashGate({ input: { command: "cat /dev/stdin" } }).action,
		"pass",
	);
	check(
		"redirect source /dev/stdin passes",
		bashGate({ input: { command: "tr a b < /dev/stdin" } }).action,
		"pass",
	);
	check(
		"redirect to an out-of-scope file still asks",
		bashGate({ input: { command: "> /etc/capture.txt" } }).action,
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
		bashGate({ input: { command: `> ${outFile}` } }).action,
		"ask",
	);
	check(
		"append redirect at segment head asks",
		bashGate({ input: { command: `echo ok; >> ${outFile}` } }).action,
		"ask",
	);
	check(
		"read-write redirect at segment head asks",
		bashGate({ input: { command: `<> ${outFile}` } }).action,
		"ask",
	);
	check(
		"background stream redirect after a command asks",
		bashGate({ input: { command: `make &> ${outFile}` } }).action,
		"ask",
	);
	check(
		"fd duplication stays inert",
		bashGate({ input: { command: "echo ok 2>&1" } }).action,
		"pass",
	);

	// substitution bias: the scanner cannot see expansion results
	check(
		"command substitution biases toward ask",
		bashGate({ input: { command: "echo $(cat inside/file.txt)" } }).action,
		"ask",
	);
	check("backtick substitution biases toward ask", bashGate({ input: { command: "cat `ls inside`" } }).action, "ask");
	check("process substitution asks", bashGate({ input: { command: "cat <(cat inside/file.txt)" } }).action, "ask");
	check("bare variable expansion biases toward ask", bashGate({ input: { command: "cat $HOME/notes" } }).action, "ask");
	check(
		"variable inside quotes biases toward ask",
		bashGate({ input: { command: 'cat "$HOME/notes"' } }).action,
		"ask",
	);

	// DC-2: single-quoted spans are inert for the substitution test;
	// double-quoted and unquoted $ and the ANSI-C form still gate
	check(
		"single-quoted awk program passes (bash cannot expand it)",
		bashGate({ input: { command: "awk '{print $1}' inside/file.txt" } }).action,
		"pass",
	);
	check(
		"single-quoted literal dollar passes",
		bashGate({ input: { command: "grep '\\$' inside/file.txt" } }).action,
		"pass",
	);
	check(
		"single-quoted backticks pass (inert in bash)",
		bashGate({ input: { command: "echo '`ls inside`'" } }).action,
		"pass",
	);
	check(
		"ANSI-C quoting still asks (the $ sits outside the stripped span)",
		bashGate({ input: { command: "grep $'\\t' inside/file.txt" } }).action,
		"ask",
	);
	check(
		"executor payload dollars still ask (a child shell re-evaluates them)",
		bashGate({ input: { command: "bash -c 'echo $HOME/notes'" } }).action,
		"ask",
	);
	check(
		"executor payload bare cd asks",
		bashGate({ input: { command: "bash -c 'cd'" } }).action,
		"ask",
	);

	// R1: the quote walker honors backslash escapes, so an escaped quote
	// is a literal apostrophe, never a span opener, and the $ behind it
	// still gates; an escaped dollar is literal and passes
	check(
		"escaped-quote substitution bypass asks",
		bashGate({ input: { command: "echo \\' && cat \"$HOME/secrets\"" } }).action,
		"ask",
	);
	check(
		"a lone escaped quote passes (literal apostrophe, nothing live)",
		bashGate({ input: { command: "echo \\'" } }).action,
		"pass",
	);
	check(
		"escaped dollar is a literal (walker escape handling)",
		bashGate({ input: { command: "cat \\$HOME/notes" } }).action,
		"pass",
	);

	// unmodeled syntax biases toward ask
	check("grouping parens ask", bashGate({ input: { command: "(cd /etc && cat passwd)" } }).action, "ask");
	check("brace expansion asks", bashGate({ input: { command: "cat /etc/{passwd,group}" } }).action, "ask");
	check(
		"trailing comments ask",
		bashGate({ input: { command: "cat inside/file.txt # trailing note" } }).action,
		"ask",
	);
	check("heredocs ask", bashGate({ input: { command: "cat << EOF\nbody\nEOF" } }).action, "ask");
	check("unterminated quotes ask", bashGate({ input: { command: "cat 'inside/file.txt" } }).action, "ask");
	check("trailing escape asks", bashGate({ input: { command: "cat inside/\\" } }).action, "ask");
	// F3: backslash-newline continuations remove the way bash removes
	// them, so the continuation line cannot hide behind the join
	check(
		"glued continuation cannot hide an absolute operand",
		bashGate({ input: { command: "cat \\\n/etc/passwd" } }).action,
		"ask",
	);
	check(
		"indented continuation cannot hide an absolute operand",
		bashGate({ input: { command: "cat \\\n   /etc/passwd" } }).action,
		"ask",
	);
	check(
		"in-scope continuation passes",
		bashGate({ input: { command: "cat \\\ninside/file.txt" } }).action,
		"pass",
	);

	// quoted text gates (R2): the mention exemption was withdrawn by the
	// recorded policy decision (Decision Log "PAUSE EXTENDED", 2026-11-23:
	// fix-later remedy (a) semantics, not accepted-bypass) - a quoted path
	// is the access, not a mention
	check(
		"quoted path mentions ask",
		bashGate({ input: { command: 'echo "see /etc/passwd for details"' } }).action,
		"ask",
	);
	check(
		"quoted parens in a mention ask (unmodeled syntax gates in double quotes)",
		bashGate({ input: { command: 'grep "(foo" inside/file.txt' } }).action,
		"ask",
	);
	check(
		"quoted out-of-scope operand asks",
		bashGate({ input: { command: 'cat "/etc/passwd"' } }).action,
		"ask",
	);
	check(
		"quoted redirect target asks",
		bashGate({ input: { command: 'echo x > "/etc/capture.txt"' } }).action,
		"ask",
	);
	check(
		"quoted operand as a copy source asks",
		bashGate({ input: { command: 'cp "/etc/passwd" .' } }).action,
		"ask",
	);
	check(
		"quoted assignment-prefix RHS asks",
		bashGate({ input: { command: 'X="/etc/capture.txt" run' } }).action,
		"ask",
	);

	// executor shapes gate payload operands inside quotes
	check("bash -c payload outside asks", bashGate({ input: { command: "bash -c 'cat /etc/passwd'" } }).action, "ask");
	check("sh -c payload outside asks", bashGate({ input: { command: "sh -c 'ls /etc'" } }).action, "ask");
	check("eval payload outside asks", bashGate({ input: { command: "eval 'cat /etc/group'" } }).action, "ask");
	check("su -c payload outside asks", bashGate({ input: { command: "su -c 'cat /etc/shadow'" } }).action, "ask");
	check("ssh payload outside asks", bashGate({ input: { command: "ssh host 'cat /etc/hosts'" } }).action, "ask");
	// an escaped quote before an executor shape must not hide it: the
	// walker reads \' as a literal apostrophe, so the executor tokens
	// stay visible as tokens
	check(
		"an escaped quote cannot hide a bash -c executor payload (the hidden executor asks)",
		bashGate({ input: { command: "echo \\' ; bash -c 'cat \"$HOME/secrets\"'" } }).action,
		"ask",
	);
	check(
		"an escaped quote cannot hide an eval executor payload",
		bashGate({ input: { command: "echo \\' ; eval 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"an escaped quote cannot hide an executor write payload",
		bashGate({ input: { command: "echo \\' ; bash -c 'echo x > \"$HOME/.ssh/authorized_keys\"'" } }).action,
		"ask",
	);
	check(
		"executor word inside a quoted mention does not trigger the raw scan",
		bashGate({ input: { command: 'echo "never write bash -c in reports"' } }).action,
		"pass",
	);

	// R4 (review 27): executor identity survives path-qualified spellings -
	// the token's directory prefix strips lexically before identity
	// matching, with no filesystem resolution (a missing /bin/bash still
	// gates; the ask posture keys on the invocation shape)
	check(
		"path-qualified bash executor asks",
		bashGate({ input: { command: "/bin/bash -c 'cat \"$HOME/s\"'" } }).action,
		"ask",
	);
	check(
		"relative-path bash executor asks",
		bashGate({ input: { command: "./bash -c 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"relative-path sh executor asks",
		bashGate({ input: { command: "./sh -c 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"home-anchored bash executor asks",
		bashGate({ input: { command: "~/bin/bash -c 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"path-qualified su executor asks",
		bashGate({ input: { command: "/bin/su -c 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"path-qualified ssh executor asks",
		bashGate({ input: { command: "/usr/bin/ssh host 'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"a missing path-qualified executor still gates (the ask posture keys on the shape)",
		bashGate({ input: { command: "/no/such/dir/bash -c 'cat $HOME/x'" } }).action,
		"ask",
	);

	// R5 (review 27): glued -c forms - bash takes a short option's
	// cluster remainder as the -c value, so -c'payload', -c"payload",
	// and -cpayload are the executor shape however the value glues
	check(
		"single-quote-glued -c payload asks",
		bashGate({ input: { command: "bash -c'cat $HOME/x'" } }).action,
		"ask",
	);
	check(
		"double-quote-glued -c payload asks",
		bashGate({ input: { command: 'bash -c"cat $HOME/x"' } }).action,
		"ask",
	);
	check(
		"bare glued -c cluster with a quoted payload tail asks",
		bashGate({ input: { command: "bash -ccat' $HOME/x'" } }).action,
		"ask",
	);
	check(
		"a bare glued -c payload inside the scope passes (detection alone is not the ask)",
		bashGate({ input: { command: "bash -cecho hi" } }).action,
		"pass",
	);

	// interposition floors (review 27 / Decision Log "User ruling C"):
	// a command/env/nohup/nice/timeout wrapper before an executor shape
	// asks without scanning through - the wrapper re-executes its
	// arguments and the scanner cannot model what it will run
	check(
		"command-prefixed executor asks",
		bashGate({ input: { command: "command bash -c 'cat $X'" } }).action,
		"ask",
	);
	check(
		"env-prefixed executor with a redirect payload asks",
		bashGate({ input: { command: "env bash -c 'x > $Y'" } }).action,
		"ask",
	);
	check(
		"env-prefixed executor asks even on an inert payload (the wrapper is the point)",
		bashGate({ input: { command: "env bash -c 'echo inside'" } }).action,
		"ask",
	);
	check(
		"nohup-prefixed executor asks",
		bashGate({ input: { command: "nohup bash -c 'echo inside'" } }).action,
		"ask",
	);
	check(
		"nice with its flags before an executor asks",
		bashGate({ input: { command: "nice -n 5 bash -c 'echo inside'" } }).action,
		"ask",
	);
	check(
		"timeout with a duration before a path-qualified executor asks",
		bashGate({ input: { command: "timeout 30 /bin/bash -c 'echo inside'" } }).action,
		"ask",
	);
	check(
		"path-qualified env before an executor asks",
		bashGate({ input: { command: "/usr/bin/env bash -c 'echo inside'" } }).action,
		"ask",
	);
	check(
		"command before an eval shape asks",
		bashGate({ input: { command: "command eval 'echo inside'" } }).action,
		"ask",
	);

	// bash-only operand overrides ahead of the shared core
	check(
		"~user operand asks (bash expands it, the core keeps it literal)",
		bashGate({ input: { command: "cat ~root/.bashrc" } }).action,
		"ask",
	);
	check("glob-plus-dotdot operand asks", bashGate({ input: { command: "cat */../secret" } }).action, "ask");

	// unusable inputs fail closed
	check("non-string bash command asks", bashGate({ input: { command: 42 } }).action, "ask");
	check("missing bash command asks", bashGate({ input: {} }).action, "ask");
	check("empty bash command asks", bashGate({ input: { command: "" } }).action, "ask");
	check(
		"unusable session cwd asks",
		bashGate({ sessionCwd: "", input: { command: "echo hello" } }).action,
		"ask",
	);

	// degraded seal asks every bash call
	const bashDegraded = bashGate({ seal: gateDegradedSeal });
	check("degraded seal asks even an operand-free command", bashDegraded.action, "ask");
	checkContains("degraded bash ask names the seal reason", bashDegraded.title, "digest was pinned");
	check("degraded seal blocks headless bash", bashGate({ hasUI: false, seal: gateDegradedSeal }).action, "block");

	// post-prompt and headless branches
	check(
		"approved out-of-scope bash passes",
		bashGate({ input: { command: "cat /etc/passwd" }, approved: true }).action,
		"pass",
	);
	const bashRefused = bashGate({ input: { command: "cat /etc/passwd" }, approved: false });
	check("refused out-of-scope bash blocks", bashRefused.action, "block");
	checkContains("bash refusal reason names the tool", bashRefused.reason, "bash");
	checkContains("bash refusal reason names the operand", bashRefused.reason, "/etc/passwd");
	const bashHeadless = bashGate({ input: { command: "cat /etc/passwd" }, hasUI: false });
	check("out-of-scope bash blocks headless", bashHeadless.action, "block");
	checkContains("headless bash reason names the operand", bashHeadless.reason, "/etc/passwd");
	checkContains("headless bash reason names the remedy", bashHeadless.reason, "interactively");
	check("headless in-scope bash passes", bashGate({ hasUI: false }).action, "pass");

	// DC-R1 through the bash wiring: seal omitted -> the real memoized session seal
	check(
		"bash wiring with omitted seal consumes the real session seal",
		bashGate({ seal: undefined }).action,
		"pass",
	);

	// scanner extraction pins
	const scan = (command) => scanBashCommand(command);
	check(
		"scan extracts an absolute operand",
		JSON.stringify(scan("cat /etc/passwd").operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a relative operand",
		JSON.stringify(scan("cat inside/file.txt").operands),
		JSON.stringify(["inside/file.txt"]),
	);
	check(
		"scan keeps multiple operands in order",
		JSON.stringify(scan("cp /etc/passwd inside/copy.txt").operands),
		JSON.stringify(["/etc/passwd", "inside/copy.txt"]),
	);
	check("scan skips bare words and the command word", scan("echo hello").operands.length, 0);
	check(
		"scan extracts quoted mention pieces",
		JSON.stringify(scan('echo "see /etc/passwd"').operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a quoted operand",
		JSON.stringify(scan('cat "/etc/passwd"').operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan extracts a quoted redirect target",
		JSON.stringify(scan('echo x > "/etc/capture.txt"').operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan extracts a quoted assignment-prefix RHS",
		JSON.stringify(scan('X="/etc/capture.txt" run').operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check(
		"scan flags substitution behind an escaped quote",
		scan("echo \\' && cat \"$HOME/secrets\"").substitution,
		true,
	);
	check("scan treats an escaped dollar as literal", scan("cat \\$HOME/notes").substitution, false);
	check("scan keeps double-quoted grouping syntax as bail", scan('grep "(foo" f').bail, true);
	check(
		"scan honors escaped-space operands",
		JSON.stringify(scan("cat inside/my\\ file.txt").operands),
		JSON.stringify(["inside/my file.txt"]),
	);
	check(
		"scan takes the full word and the RHS of option assignments",
		JSON.stringify(scan("tool --config=/etc/app.conf").operands),
		JSON.stringify(["--config=/etc/app.conf", "/etc/app.conf"]),
	);
	check(
		"scan takes an assignment-prefix RHS",
		JSON.stringify(scan("OUT=/etc/capture.txt run").operands),
		JSON.stringify(["/etc/capture.txt"]),
	);
	check("scan keeps a lone assignment inert", scan("X=/etc/capture.txt").operands.length, 0);
	check(
		"scan flags a segment-head redirect target",
		JSON.stringify(scan("> /etc/passwd").operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan flags a background stream redirect target",
		JSON.stringify(scan("make &> /etc/log").operands),
		JSON.stringify(["/etc/log"]),
	);
	check(
		"scan flags a noclobber redirect target",
		JSON.stringify(scan("cat >| /etc/log").operands),
		JSON.stringify(["/etc/log"]),
	);
	check(
		"scan extracts a bare cd target",
		JSON.stringify(scan("cd link-out").operands),
		JSON.stringify(["link-out"]),
	);
	check("scan asks on bare cd", scan("cd").cdAsk !== null, true);
	checkContains(
		"scan bare-cd ask names the unresolvable target class",
		scan("cd").cdAsk ?? "",
		"cannot resolve",
	);
	checkContains("scan cd - ask names OLDPWD", scan("cd -").cdAsk ?? "", "OLDPWD");
	check("scan cd with an extractable target raises no ask", scan("cd inside").cdAsk, null);
	check(
		"scan removes a glued continuation",
		JSON.stringify(scan("cat \\\n/etc/passwd").operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check(
		"scan joins a mid-word continuation exactly as bash does",
		JSON.stringify(scan("cat foo\\\n/etc/passwd").operands),
		JSON.stringify(["foo/etc/passwd"]),
	);
	check("scan treats single-quoted dollars as inert", scan("awk '{print $1}' f").substitution, false);
	check("scan keeps double-quoted dollars as substitution", scan('cat "$HOME/x"').substitution, true);
	check("scan keeps ANSI-C dollars as substitution", scan("grep $'\\t' f").substitution, true);
	check("scan flags executor payload dollars", scan("bash -c 'echo $X'").substitution, true);
	check("scan raises the cd ask through an executor payload", scan("bash -c 'cd'").cdAsk !== null, true);
	check(
		"scan splits executor payloads through quotes",
		JSON.stringify(scan("bash -c 'cat /etc/passwd'").operands),
		JSON.stringify(["/etc/passwd"]),
	);
	check("scan flags substitution", scan("echo $(x)").substitution, true);
	check("scan flags executor shapes", scan("bash -c 'ls /'").executor, true);
	check("scan detects the executor shape behind an escaped quote", scan("echo \\' ; bash -c 'cat /etc/passwd'").executor, true);
	check("scan keeps a quoted prose mention of the executor shape inert", scan('echo "never write bash -c in reports"').executor, false);
	check("scan detects executor shapes through option flags and intervening arguments", scan("bash --norc -lc 'ls inside'").executor, true);
	check("scan detects the bare glued -c cluster", scan("bash -ccat").executor, true);
	check("scan detects -cu as the -c cluster (the disclosed inert-junk over-ask)", scan("bash -cu x").executor, true);
	check(
		"scan floors an interposer-prefixed executor shape and names the wrapper",
		scan("env bash -c 'echo inside'").interposed,
		"env",
	);
	check(
		"scan keeps an interposer without an executor shape inert",
		scan("env FOO=1 ls inside").interposed,
		null,
	);
	check("scan flags unmodeled syntax", scan("ls (x)").bail, true);

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
	const bashCandidateDecision = decideBashToolCall({
		toolName: "bash",
		input: { command: `cat ${outFile}` },
		sessionCwd: cwdDir,
		allowedRoots: customRoots,
		hasUI: true,
		seal: cleanSeal,
	});
	check("the bash operand ask decision carries the grant candidate", bashCandidateDecision.grantCandidate, outFile);
	const bashSubstitutionDecision = decideBashToolCall({
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
	const bashCdDecision = decideBashToolCall({
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
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
