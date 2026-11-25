/**
 * The vendored tree-sitter-bash loader for the workspace-fence bash
 * pass (unit PISCOPE-2-1, task PISCOPE-2).
 *
 * Contract (the GPS shape, wired against @gotgenes/pi-permission-system
 * 42.2.0 whose src/access-intent/bash/parser.ts:60-77 defines the same
 * load sequence and whose src/access-intent/bash/async-cache.ts defines
 * the same memoization discipline):
 *
 * - `loadBashParser()` initializes once per process: the engine wasm
 *   and the grammar wasm load exactly once, and every later caller
 *   awaits the same resolved parser (memoization identity).
 * - Failures are rejections, never synchronous throws: the factory is
 *   async and `loadBashParser()` always returns a promise. A rejected
 *   initialization does not poison the memo; the rejected promise is
 *   dropped so the next call retries from scratch (a transient wasm
 *   load failure heals on the next tool call instead of lasting for
 *   the process lifetime).
 * - The returned `BashParser` deliberately omits the engine parser's
 *   `delete()`: deleting the shared instance would destroy the
 *   process-wide memoized parser for every later caller (the hazard
 *   GPS documents when it narrows its own consumer surface), so it is
 *   not on the exported type.
 * - Artifacts resolve by relative path from vendor/ (no npm
 *   resolution; the package directory carries its bytes), per the
 *   vendored-delivery ruling the digests in grammar-pins.ts record.
 *
 * The parser never throws at load time from the fence's perspective:
 * unit PISCOPE-2-2's detection layer awaits this promise inside its
 * own fail-safe boundary, so parser unavailability degrades bash
 * verdicts to ask instead of failing the extension factory.
 */

import { fileURLToPath } from "node:url";

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

/** Absolute path of a file shipped inside vendor/, next to this module. */
function vendoredArtifactPath(fileName: string): string {
	return fileURLToPath(new URL(`./vendor/${fileName}`, import.meta.url));
}

async function initializeBashParser(): Promise<BashParser> {
	const engine = (await import("./vendor/web-tree-sitter.js")) as VendoredEngineModule;
	await engine.Parser.init({ locateFile: () => vendoredArtifactPath("web-tree-sitter.wasm") });
	const parser = new engine.Parser();
	const bash = await engine.Language.load(vendoredArtifactPath("tree-sitter-bash.wasm"));
	parser.setLanguage(bash);
	return parser;
}

/**
 * The parser every bash-pass consumer reads the grammar through:
 * memoized once per process, retrying after a rejected load, and
 * resolving to a parser whose trees carry the `BashSyntaxNode`
 * structural surface. See the module docstring for the full contract.
 */
export const loadBashParser = memoizeAsyncWithRetry(initializeBashParser);
