#!/usr/bin/env node
/**
 * Verdict-matrix suite for the cwd-scope-gate core
 * (extensions/cwd-scope-gate.ts). Plain node, no test framework:
 *
 *   node tests/cwd-scope-gate.test.mjs
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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	EXTRA_ROOTS_ENV,
	RELEASE_DIGEST_PINS,
	SEAL_DIGEST_FILES,
	buildAllowedRoots,
	computeFileDigest,
	expandTilde,
	evaluateSealState,
	isInsideRoots,
	kernelStyleResolve,
	lexicalResolvePath,
	normalizeToolInputPath,
	parseExtraRoots,
	resolveRunningRelease,
	resolveScopeTarget,
} from "../extensions/cwd-scope-gate.ts";

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

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-scope-gate-"));
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
} finally {
	fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
