/**
 * The re-pin helper for the workspace-fence's two digest-pin surfaces
 * (unit PISCOPE-2-3, task PISCOPE-2): one command that recomputes the
 * release pins (RELEASE_DIGEST_PINS in extensions/workspace-fence.ts,
 * the transform-parity seal over the running release's dist files)
 * and the grammar pins (GRAMMAR_DIGEST_PINS in grammar-pins.ts, the
 * vendored parser artifacts), and prints the constants to paste back
 * into the source, after the walk-vocabulary gate has passed.
 *
 * The gate is the fail-open drift direction the byte pins cannot see
 * (advisor memo 15 F2/DC-2): the walk keys on node-type names while
 * the pins pin bytes, so a sanctioned grammar upgrade could re-pin
 * new bytes over a walk whose vocabulary no longer matches the
 * grammar's declared surface - a renamed argument shape silently
 * stops extracting and verdicts pass with empty operands. The helper
 * therefore reads the candidate vendor directory's node-types.json,
 * extracts the grammar's declared vocabulary, diffs it against the
 * walk's sets, and REFUSES to emit pins while any gap stands or the
 * source cannot be verified. A refusal is a stop, not a warning: the
 * upgrade ride is finish-the-walk-vocabulary, then re-pin.
 *
 * The pack-compare-copy-review steps of the upgrade procedure stay
 * manual per vendor/ATTRIBUTION.md; this helper covers the recompute
 * and gate steps, and the suite pins that its output evaluates clean
 * against both committed pin sets on the shipped tree.
 *
 * Usage:
 *
 *   node extensions/fence-ast/re-pin.ts
 *   node extensions/fence-ast/re-pin.ts --release /path/to/dist --vendor /path/to/vendor
 *
 * Exit 0: the gate passed and both computed pin sets equal the
 * committed constants (nothing to do). Exit 1: the gate passed but at
 * least one pin set drifted - the printed constants are the new
 * pins to apply through review. Exit 2: the gate refused (the
 * vocabulary is unverifiable or gapped) or an artifact is unreadable;
 * nothing is emitted.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RELEASE_DIGEST_PINS, SEAL_DIGEST_FILES, resolveRunningRelease } from "../workspace-fence.ts";
import { GRAMMAR_ARTIFACT_FILES, GRAMMAR_DIGEST_PINS } from "./grammar-pins.ts";
import { extractGrammarVocabulary, vocabularyIsClean, walkVocabularyGaps } from "./grammar-vocabulary.ts";

/** The vendored node-types file the vocabulary gate reads. */
const NODE_TYPES_FILE = "node-types.json";

function sha256Hex(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Digest one directory's file list into the name-to-sha256 pin shape
 * both pin surfaces share. Throws when a file is missing or unreadable:
 * pinning an absent byte is meaningless, and the caller's gate refuses
 * loudly instead (the runtime seal's degradation paths cover a
 * half-present tree; the helper's job is to pin bytes that exist).
 */
function artifactDigests(directory: string, fileNames: readonly string[]): Record<string, string> {
	const pins: Record<string, string> = {};
	for (const fileName of fileNames) {
		pins[fileName] = sha256Hex(join(directory, fileName));
	}
	return pins;
}

/** Recompute the grammar pin set over one vendor directory. */
export function computeGrammarPins(vendorDirectory: string): Record<string, string> {
	return artifactDigests(vendorDirectory, GRAMMAR_ARTIFACT_FILES);
}

/** Recompute the release pin set over one release dist tree. */
export function computeReleasePins(releaseDist: string): Record<string, string> {
	return artifactDigests(releaseDist, SEAL_DIGEST_FILES);
}

/**
 * The vocabulary gate: verify the candidate grammar's declared
 * node-type surface against the walk's vocabularies. Returns the
 * parsed vocabulary on success; throws with the actionable gap list
 * when any gap stands or the source is missing, unparsable, or
 * structurally unusable. This is the check a sanctioned grammar
 * upgrade must satisfy BEFORE its bytes may re-pin.
 */
export function verifyRepinVocabulary(vendorDirectory: string): ReturnType<typeof extractGrammarVocabulary> {
	const nodeTypesPath = join(vendorDirectory, NODE_TYPES_FILE);
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(nodeTypesPath, "utf8"));
	} catch (error) {
		throw new Error(
			`the grammar vocabulary source ${nodeTypesPath} is missing, unreadable, or not valid JSON; refusing to pin against an unverifiable vocabulary (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const vocabulary = extractGrammarVocabulary(data);
	const gaps = walkVocabularyGaps(vocabulary);
	if (!vocabularyIsClean(gaps)) {
		const parts: string[] = [];
		if (gaps.expansionMissing.length > 0) parts.push(`expansion forms missing from EXPANSION_NODE_TYPES: ${gaps.expansionMissing.join(", ")}`);
		if (gaps.argumentMissing.length > 0) parts.push(`argument shapes missing from ARG_NODE_TYPES: ${gaps.argumentMissing.join(", ")}`);
		if (gaps.staleExpansion.length > 0) parts.push(`stale EXPANSION_NODE_TYPES entries the grammar no longer declares: ${gaps.staleExpansion.join(", ")}`);
		if (gaps.staleArgument.length > 0) parts.push(`stale ARG_NODE_TYPES entries the grammar no longer declares: ${gaps.staleArgument.join(", ")}`);
		if (gaps.staleSkip.length > 0) parts.push(`stale SKIP_SUBTREE_TYPES entries the grammar no longer declares: ${gaps.staleSkip.join(", ")}`);
		throw new Error(`the walk's vocabulary does not cover the grammar's declared surface; finish the walk before re-pinning: ${parts.join("; ")}`);
	}
	return vocabulary;
}

function defaultVendorDirectory(): string {
	return fileURLToPath(new URL("./vendor/", import.meta.url));
}

function printPinSet(label: string, fileHint: string, pins: Record<string, string>): void {
	console.log(`# ${label} (${fileHint})`);
	for (const [name, digest] of Object.entries(pins)) {
		console.log(`\t"${name}": "${digest}",`);
	}
}

async function main(argv: string[]): Promise<number> {
	let releaseDist: string | null = null;
	let vendorDirectory = defaultVendorDirectory();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--release" && argv[i + 1]) releaseDist = argv[++i];
		else if (argv[i] === "--vendor" && argv[i + 1]) vendorDirectory = argv[++i];
	}
	const resolvedRelease = releaseDist ?? resolveRunningRelease();
	if (resolvedRelease === null) {
		console.error("no release dist to pin (pass --release or run under a resolvable pi install); nothing emitted");
		return 2;
	}
	try {
		verifyRepinVocabulary(vendorDirectory);
		const grammarPins = computeGrammarPins(vendorDirectory);
		const releasePins = computeReleasePins(resolvedRelease);
		const grammarClean = JSON.stringify(grammarPins) === JSON.stringify(GRAMMAR_DIGEST_PINS);
		const releaseClean = JSON.stringify(releasePins) === JSON.stringify(RELEASE_DIGEST_PINS);
		console.log(`vocabulary gate: passed (the walk covers the grammar's declared surface)`);
		console.log(`grammar pins ${grammarClean ? "clean" : "drifted"}; release pins ${releaseClean ? "clean" : "drifted"}`);
		if (grammarClean && releaseClean) return 0;
		if (!releaseClean) printPinSet("RELEASE_DIGEST_PINS", "extensions/workspace-fence.ts", releasePins);
		if (!grammarClean) printPinSet("GRAMMAR_DIGEST_PINS", "extensions/fence-ast/grammar-pins.ts", grammarPins);
		console.log("apply the printed constants through the grammar-seal review, then re-run this helper for exit 0.");
		return 1;
	} catch (error) {
		console.error(String(error instanceof Error ? error.message : error));
		return 2;
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
