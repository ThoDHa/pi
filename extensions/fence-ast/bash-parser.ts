/**
 * The vendored tree-sitter-bash loader for the workspace-fence bash
 * pass (unit PISCOPE-2-1, task PISCOPE-2; hardened by unit PISCOPE-2-2
 * with the bounded init budget, the digest-before-import ordering, and
 * the tree-lifetime helper).
 *
 * Contract (the GPS shape, wired against @gotgenes/pi-permission-system
 * 42.2.0 whose src/access-intent/bash/parser.ts:60-77 defines the same
 * load sequence and whose src/access-intent/bash/async-cache.ts defines
 * the same memoization discipline):
 *
 * - `loadBashParser()` initializes once per process: the engine wasm
 *   and the grammar wasm load exactly once, and every later caller
 *   awaits the same resolved parser (memoization identity).
 * - VERIFY-BEFORE-IMPORT (advisor finding R2): the vendored artifacts
 *   are hashed against GRAMMAR_DIGEST_PINS before any of them loads.
 *   The engine entry is executable JavaScript that runs at import
 *   time, and the grammar wasm's load path can evaluate embedded JS
 *   sections, so every vendored byte is executable content: a digest
 *   mismatch rejects initialization before a single vendored byte is
 *   imported or loaded, and the rejection surfaces to the consumer as
 *   a fail-safe ask, never as a load of drifted bytes.
 * - The init sequence is bounded: `withInitBudget` races the load
 *   against BASH_PARSER_INIT_TIMEOUT_MS so a stalled wasm load
 *   degrades to a rejection (and then to ask verdicts) instead of
 *   holding every gated bash call for the process lifetime (review
 *   finding DC-1). The budget rejects; it does not cancel the
 *   underlying load, so a slow-but-alive init can still complete and
 *   the reject-and-retry memoization picks it up on the next call.
 * - Failures are rejections, never synchronous throws: the factory is
 *   async and `loadBashParser()` always returns a promise. A rejected
 *   or budget-expired initialization does not poison the memo; the
 *   rejected promise is dropped so the next call retries from scratch
 *   (a transient wasm load failure heals on the next tool call
 *   instead of lasting for the process lifetime).
 * - `withBashParse(input, body)` is the tree-lifetime helper (review
 *   finding DC-2): web-tree-sitter trees are wasm-heap allocations
 *   freed only by explicit `delete()`, so every parse runs its body
 *   inside try/finally and releases the tree on success, on body
 *   throw, and on every early-return verdict path, making the
 *   per-call leak class structurally impossible rather than
 *   review-enforced.
 * - The returned `BashParser` deliberately omits the engine parser's
 *   `delete()`: deleting the shared instance would destroy the
 *   process-wide memoized parser for every later caller (the hazard
 *   GPS documents when it narrows its own consumer surface), so it is
 *   not on the exported type.
 * - Artifacts resolve by relative path from vendor/ (no npm
 *   resolution; the package directory carries its bytes), per the
 *   vendored-delivery ruling the digests in grammar-pins.ts record.
 *   The engine entry is the package's own ESM module; Node decides
 *   its module type from the nearest governing package.json, and no
 *   commonjs manifest governs it anywhere in this repository (the
 *   suite pins that walk). The deployed agent root sits above this
 *   repository and is untracked by design; unit PISCOPE-2-3's landing
 *   evidence re-runs the live parse probe from that directory to
 *   discharge the deployed walk, which this repo cannot see.
 *
 * The parser never throws at load time from the fence's perspective:
 * the bash pass's detection layer awaits this promise inside its own
 * fail-safe boundary, so parser unavailability (a load failure, a
 * digest mismatch, or an expired init budget) degrades bash verdicts
 * to ask instead of failing the extension factory.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GRAMMAR_ARTIFACT_FILES, GRAMMAR_DIGEST_PINS } from "./grammar-pins.ts";

/**
 * The bounded budget for one parser initialization, in milliseconds.
 * A cold wasm compile stays well under this on a loaded machine; the
 * budget exists so a stalled load (fs stall on the vendor directory,
 * a wedged compile) bounds every gated bash call's wait to one ask
 * verdict instead of holding the tool_call for the process lifetime
 * (review finding DC-1). A budget rejection drops the memo, so the
 * next call retries the initialization from scratch.
 */
export const BASH_PARSER_INIT_TIMEOUT_MS = 15_000;

/**
 * The slice of a parsed tree's nodes the AST walk reads. Structurally
 * identical to the web-tree-sitter SyntaxNode members the walker uses,
 * defined locally so callers never import the vendored engine's types
 * (the same narrowing GPS applies). `hasError` is the parse's own
 * health: true for the node or any descendant being an error or
 * missing token, the fail-safe ask trigger.
 */
export interface BashSyntaxNode {
	readonly type: string;
	readonly text: string;
	/** Absolute byte offset of this node's start in the parsed source. */
	readonly startIndex: number;
	/** Absolute byte offset one past this node's end in the parsed source. */
	readonly endIndex: number;
	readonly childCount: number;
	/** False for anonymous tokens (operators, delimiters); true for named nodes. */
	readonly isNamed: boolean;
	/** True when this node is an error or missing token, or contains one. */
	readonly hasError: boolean;
	/** The node immediately before this one under the same parent, named or not. */
	readonly previousSibling: BashSyntaxNode | null;
	child(index: number): BashSyntaxNode | null;
}

/** A completed parse of one command string. */
export interface BashParseTree {
	readonly rootNode: BashSyntaxNode;
	delete(): void;
}

/**
 * The consumer surface over the process-wide parser. Parse is a pure
 * function of its input (the engine parser is stateless across calls),
 * so one shared instance serves every command. `delete()` is omitted
 * on purpose; see the module docstring.
 */
export interface BashParser {
	parse(input: string): BashParseTree | null;
}

/**
 * Narrow structural types for the vendored engine entry. The vendored
 * web-tree-sitter.js ships no in-repo type declarations (only the
 * runtime entry and the two wasm artifacts are vendored, per
 * vendor/ATTRIBUTION.md), so the single dynamic-import boundary casts
 * the loaded module to the members the loader touches. This is the
 * documented untyped-external-library exception; every exported type
 * consumers see is the structural surface above, not this boundary.
 */
interface VendoredEngineTree {
	rootNode: BashSyntaxNode;
	delete(): void;
}

interface VendoredEngineParser {
	parse(input: string): VendoredEngineTree | null;
	setLanguage(language: VendoredEngineLanguage): void;
}

interface VendoredEngineLanguage {}

interface VendoredParserConstructor {
	init(options: { locateFile(file: string): string }): Promise<void>;
	new (): VendoredEngineParser;
}

interface VendoredLanguageConstructor {
	load(input: string): Promise<VendoredEngineLanguage>;
}

interface VendoredEngineModule {
	Parser: VendoredParserConstructor;
	Language: VendoredLanguageConstructor;
}

/** Absolute path of a file shipped inside vendor/, next to this module. */
function vendoredArtifactPath(fileName: string): string {
	return fileURLToPath(new URL(`./vendor/${fileName}`, import.meta.url));
}

function sha256Hex(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Verify the vendored parser artifacts against their recorded digest
 * pins before anything loads (advisor finding R2's ordering
 * requirement). Reads and hashes every pinned file; on the first
 * mismatch, missing file, or unreadable artifact it throws naming the
 * artifact, so a drifted vendored byte can never reach the dynamic
 * import below. `vendorDirectory` and `pins` are injectable so the
 * suite can pin the mismatch behavior against a mutated fixture
 * without touching the shipped vendor directory.
 *
 * Throws: when a pinned artifact is missing, unreadable, or hashes to
 * a digest other than its recorded pin. The message names the artifact
 * and both digests; the consumer turns the rejection into a fail-safe
 * ask.
 */
export function verifyGrammarArtifacts(
	vendorDirectory: string = fileURLToPath(new URL("./vendor/", import.meta.url)),
	pins: Record<string, string> = GRAMMAR_DIGEST_PINS,
	files: readonly string[] = GRAMMAR_ARTIFACT_FILES,
): void {
	const directory = vendorDirectory.endsWith("/") ? vendorDirectory : `${vendorDirectory}/`;
	for (const fileName of files) {
		const expected = pins[fileName];
		if (typeof expected !== "string") {
			throw new Error(`vendored parser artifact ${fileName} carries no recorded digest pin`);
		}
		let actual: string;
		try {
			actual = sha256Hex(`${directory}${fileName}`);
		} catch (error) {
			throw new Error(
				`vendored parser artifact ${fileName} is missing or unreadable; refusing to load unverified bytes (${error instanceof Error ? error.message : String(error)})`,
			);
		}
		if (actual !== expected) {
			throw new Error(
				`vendored parser artifact ${fileName} does not match its recorded digest pin: expected ${expected}, got ${actual}; refusing to load unverified bytes`,
			);
		}
	}
}

/**
 * Race one initialization step-set against the bounded budget (review
 * finding DC-1). The budget rejects with a descriptive error; it does
 * not cancel the raced promise, so a slow-but-alive init completes in
 * the background and the reject-and-retry memoization adopts it on the
 * next call. `budgetMs` is injectable so the suite can pin the hung
 * init behavior against a small budget instead of waiting out the real
 * constant.
 */
export function withInitBudget<T>(init: Promise<T>, budgetMs: number = BASH_PARSER_INIT_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`bash parser initialization exceeded its ${budgetMs}ms budget`));
		}, budgetMs);
	});
	return Promise.race([init, expired]).finally(() => clearTimeout(timer));
}

/**
 * Memoize an async factory, dropping a rejected result so the next
 * call retries (GPS async-cache.ts's discipline). On success the
 * resolved promise is cached and shared across all callers, so the
 * factory runs once per process. On failure the cache is cleared
 * before the rejection propagates, so a transient init failure does
 * not poison the memo for the process lifetime.
 */
export function memoizeAsyncWithRetry<T>(factory: () => Promise<T>): () => Promise<T> {
	let cached: Promise<T> | null = null;
	return () => {
		cached ??= factory().catch((error: unknown) => {
			cached = null;
			throw error;
		});
		return cached;
	};
}

async function initializeBashParser(): Promise<BashParser> {
	verifyGrammarArtifacts();
	const init = (async () => {
		const engine = (await import("./vendor/web-tree-sitter.js")) as VendoredEngineModule;
		await engine.Parser.init({ locateFile: () => vendoredArtifactPath("web-tree-sitter.wasm") });
		const parser = new engine.Parser();
		const bash = await engine.Language.load(vendoredArtifactPath("tree-sitter-bash.wasm"));
		parser.setLanguage(bash);
		return parser;
	})();
	return withInitBudget(init);
}

/**
 * The parser every bash-pass consumer reads the grammar through:
 * memoized once per process, retrying after a rejected load, and
 * resolving to a parser whose trees carry the `BashSyntaxNode`
 * structural surface. Digest verification precedes every vendored
 * import and the init sequence is bounded. See the module docstring
 * for the full contract.
 */
export const loadBashParser = memoizeAsyncWithRetry(initializeBashParser);

/**
 * Run `body` over one parsed command's root node and release the tree
 * on every path (review finding DC-2). web-tree-sitter trees are
 * wasm-heap allocations freed only by explicit `delete()`; this helper
 * is the walker's only parse entry point so an early-return verdict
 * branch cannot leak a tree. The body's result is returned; a body
 * throw propagates after the tree is released.
 *
 * Rejects: when the parser is unavailable (load failure, digest
 * mismatch, expired init budget) or the parse returns no tree; the
 * consumer boundary turns the rejection into a fail-safe ask.
 */
export async function withBashParse<T>(
	input: string,
	body: (rootNode: BashSyntaxNode) => T,
): Promise<T> {
	const parser = await loadBashParser();
	const tree = parser.parse(input);
	if (tree === null) {
		throw new Error(`the bash parser returned no tree for a command (${input.length} chars)`);
	}
	try {
		return body(tree.rootNode);
	} finally {
		tree.delete();
	}
}
