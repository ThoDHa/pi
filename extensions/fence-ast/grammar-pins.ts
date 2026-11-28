/**
 * Grammar artifact digest pins: the SHA-256 surface of the vendored
 * parser artifacts (extensions/fence-ast/vendor/), unit PISCOPE-2-1.
 *
 * The fence is a security control and these artifacts are third-party
 * executable code inside that trust base (an ESM engine entry that
 * runs at import time plus two wasm artifacts whose load path can
 * evaluate embedded JS sections), so their bytes are pinned the same
 * way the pi-release seal pins the replicated dist files: a hash whose
 * meaning is "this exact vendored artifact was reviewed and
 * sanctioned". The registry-anchored provenance record these pins
 * trace to lives in vendor/ATTRIBUTION.md (dist.integrity and tarball
 * hashes), and unit PISCOPE-2-2 wired the runtime enforcement: the
 * loader verifies every artifact against these pins before any
 * vendored byte imports, so a mismatch or unreadable artifact rejects
 * to ask-mode instead of executing drifted bytes. Unit PISCOPE-2-3
 * folded the same pins into the seal's bash decision as a grammar
 * leg (evaluateGrammarSealState, sessionGrammarSealState in
 * workspace-fence.ts): a grammar drift or an unreadable artifact
 * turns every bash verdict into an ask while path verdicts stay
 * governed by the release pins, the same never-throws
 * never-silently-allows posture the release seal holds. The vendored
 * node-types.json joins the pins as the grammar's declared vocabulary
 * surface: the grammar-vocabulary completeness check reads it, and
 * the re-pin helper refuses to bless new bytes while the walk's
 * node-type sets do not cover it.
 *
 * Keys are file names relative to the vendor/ directory, so a pin set
 * travels with the directory it describes. Recomputing a pin after a
 * sanctioned upgrade is part of the pack-compare-copy-repin-review
 * procedure documented in vendor/ATTRIBUTION.md; the suite asserts the
 * vendored bytes still hash to these pins, so any artifact change
 * without a re-pin reds the suite before it can ship.
 */
export const GRAMMAR_DIGEST_PINS: Record<string, string> = {
	"web-tree-sitter.wasm": "1ed02fe75a60642bea084670e33267795aab26c19012805b9fb513ab458680ee",
	"web-tree-sitter.js": "0c868236a47296b4ff3c1570f20e0899e4a784ff6e5cd7bfc9c3a55225463e4a",
	"tree-sitter-bash.wasm": "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
	"node-types.json": "b644629f7f9460cb0af080cb88f3bef898e6c47b6f8a76ed512b67ae16ef5ac5",
};

/**
 * The vendored artifact files the pins cover, in the same relative-to-
 * vendor/ spelling as the pin keys. Listing the names explicitly (not
 * deriving them from the pin keys) keeps the loader's import surface
 * and the seal's digest surface independently reviewable: the loader
 * may legitimately load a subset, while the seal must cover every
 * file this directory carries. node-types.json is inert vocabulary
 * data (the grammar's declared node-type surface), never imported;
 * it is the authority the grammar-vocabulary completeness check and
 * the re-pin gate read, and it verifies with the rest before any
 * vendored byte loads.
 */
export const GRAMMAR_ARTIFACT_FILES = [
	"web-tree-sitter.wasm",
	"web-tree-sitter.js",
	"tree-sitter-bash.wasm",
	"node-types.json",
] as const;
