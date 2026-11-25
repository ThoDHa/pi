# Vendored parser artifacts

The workspace-fence bash pass parses commands through tree-sitter rather than
a hand-rolled tokenizer, and the parser artifacts are vendored in-repo by user
sign-off (PISCOPE-2 Decision Log, 2026-11-25 09:40, answer to Blocks Q1): the
fence is the security control, so its third-party trust base is fully visible
tracked bytes with recorded SHA-256 pins, never an install-time execution and
never an untracked runtime tree.

## Artifacts

| File | Source package | Upstream bytes | SHA-256 |
| --- | --- | --- | --- |
| `web-tree-sitter.wasm` | web-tree-sitter@0.26.9 | 200297 | `1ed02fe75a60642bea084670e33267795aab26c19012805b9fb513ab458680ee` |
| `web-tree-sitter.js` | web-tree-sitter@0.26.9 | 153666 | `0c868236a47296b4ff3c1570f20e0899e4a784ff6e5cd7bfc9c3a55225463e4a` |
| `tree-sitter-bash.wasm` | tree-sitter-bash@0.25.1 | 1358224 | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |

Both packages are published under the MIT license; the two `.LICENSE` files in
this directory are the verbatim license texts shipped inside those packages.
The pins above are mirrored in `../grammar-pins.ts` as `GRAMMAR_DIGEST_PINS`,
the surface the grammar seal folds into `SealState` (unit PISCOPE-2-3), where
a mismatch or an unreadable artifact degrades every bash verdict to ask-mode
instead of trusting drifted bytes.

## Provenance and reproducibility

Every artifact was extracted from the npm tarball of the exact version named
above (`npm pack web-tree-sitter@0.26.9`, `npm pack tree-sitter-bash@0.25.1`)
with no modification. The two wasm digests were recorded independently by the
PISCOPE-2 recon from a pack performed on 2026-11-23 and reproduced byte-exactly
by the PISCOPE-2-1 worker from a fresh pack on 2026-11-25, pinning registry
immutability for these versions across the whole window the task spanned.

`web-tree-sitter.js` is the engine's ESM entry: it is the module the loader
imports, and `Parser.init({ locateFile })` points it at the vendored
`web-tree-sitter.wasm`. The grammar wasm is loaded through
`Language.load` from the vendored path. Neither artifact is used through npm
resolution; the loader resolves them by relative path from this directory, so
the route works with no `node_modules` present.

## Upgrade procedure

Upgrades ride the pack-compare-copy-repin-review procedure demonstrated by the
recon and required by the supply-chain ruling: pack the candidate version,
byte-compare every artifact against this directory, copy only after reviewing
the delta, recompute and re-pin `GRAMMAR_DIGEST_PINS`, and land the change
through the grammar-seal review. A mutated, truncated, or re-spelled artifact
without a matching re-pin fails the suite's digest pins immediately and the
seal at runtime.
