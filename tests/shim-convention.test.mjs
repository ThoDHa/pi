#!/usr/bin/env node
/**
 * Convention guard for the pi-tui test shim (tests/provision-pi-tui.mjs).
 * Plain node, no test framework:
 *
 *   node tests/shim-convention.test.mjs
 *
 * Enforces the shim convention across the suite directory: no
 * tests/*.test.mjs may embed a @earendil-works/ module specifier in any
 * import form (static `import ... from`, side-effect `import "..."`,
 * dynamic `import(...)`), because the shim backing that specifier is
 * gitignored and provisioned on demand, so a direct import resolves only
 * in a checkout where the shim already exists and fails standalone on a
 * fresh clone with ERR_MODULE_NOT_FOUND. A suite wanting pi-tui bindings
 * takes them from importPiTui(), which provisions before importing. The
 * shared helper is not a .test.mjs and holds the one permitted specifier
 * occurrence (its own post-provisioning dynamic import); this guard file
 * is excluded from its own scan.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPECIFIER = "@earendil-works/";
const SELF_NAME = basename(fileURLToPath(import.meta.url));
const testsDir = fileURLToPath(new URL(".", import.meta.url));

// Import shapes that embed a module specifier, matched over
// comment-stripped source so prose mentions of the package (docstrings,
// inline remarks) never read as imports. The `from` shape also covers
// `export ... from` re-exports, which load the module just the same.
const IMPORT_FORM_PATTERNS = [
	{ form: "static import ... from", pattern: /from\s*["']@earendil-works\//g },
	{ form: "dynamic import(...)", pattern: /import\s*\(\s*["']@earendil-works\//g },
	{ form: "side-effect import", pattern: /import\s*["']@earendil-works\//g },
];

/**
 * Return source with line and block comments blanked while string and
 * template literal contents are preserved, keeping every newline so
 * offsets and line numbers in the result still address the original
 * source.
 *
 * Parameter: source, the file content to blank.
 * Returns: comment-free content with an unchanged line count.
 */
function stripComments(source) {
	let out = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			while (index < source.length && source[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
				if (source[index] === "\n") out += "\n";
				index++;
			}
			index += 2;
			out += " ";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			out += char;
			index++;
			while (index < source.length && source[index] !== quote) {
				if (source[index] === "\\") {
					out += source.slice(index, index + 2);
					index += 2;
				} else {
					out += source[index];
					index++;
				}
			}
			out += quote;
			index++;
			continue;
		}
		out += char;
		index++;
	}
	return out;
}

/**
 * Find every @earendil-works/ import specifier in comment-stripped suite
 * source, one descriptor per occurrence.
 *
 * Parameter: strippedSource, content with comments blanked (see
 * stripComments).
 * Returns: array of { line, form, matchedText } in ascending line order;
 * empty when the source honors the convention.
 */
function findSpecifierViolations(strippedSource) {
	const violations = [];
	for (const { form, pattern } of IMPORT_FORM_PATTERNS) {
		for (const match of strippedSource.matchAll(pattern)) {
			violations.push({
				line: strippedSource.slice(0, match.index).split("\n").length,
				form,
				matchedText: match[0],
			});
		}
	}
	return violations.sort((first, second) => first.line - second.line);
}

const suiteNames = readdirSync(testsDir)
	.filter((name) => name.endsWith(".test.mjs") && name !== SELF_NAME)
	.sort();

for (const name of suiteNames) {
	const strippedSource = stripComments(readFileSync(join(testsDir, name), "utf8"));
	const violations = findSpecifierViolations(strippedSource);
	const offendingLines = violations
		.map((violation) => `  ${name}:${violation.line}: ${violation.form} ${JSON.stringify(violation.matchedText)}`)
		.join("\n");
	assert.equal(
		violations.length,
		0,
		`shim convention violated in ${name}: suites must take pi-tui bindings via importPiTui() from ./provision-pi-tui.mjs instead of importing ${SPECIFIER} directly, because a direct import only resolves where the gitignored shim exists and fails standalone on a fresh clone. Offending lines:\n${offendingLines}`,
	);
}

console.log("shim-convention: all assertions passed");
