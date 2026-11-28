/**
 * The grammar-vocabulary completeness check (advisor memo 15 F2/DC-2,
 * landed by unit PISCOPE-2-3): the AST walk keys on node-type NAME
 * sets (expansion forms, argument shapes, skip subtrees, redirect
 * operators), while the digest pins pin BYTES, so a sanctioned
 * grammar upgrade that renames or adds a node type can re-pin the
 * digests and still leave the walk's vocabulary stale - the
 * fail-open direction where a renamed argument shape silently stops
 * extracting and verdicts pass with empty operands. This module
 * closes that direction: it extracts the walk-relevant vocabulary
 * FROM the vendored grammar's own node-types.json (the grammar's
 * declared surface, vendored and digest-pinned beside the wasm it
 * describes) and reports every gap against the walk's sets. The
 * suite pins the shipped grammar clean, and the re-pin helper
 * (re-pin.ts) refuses to bless new bytes when the vocabulary the
 * walk would pin against is unverifiable or gapped.
 *
 * Mechanical definitions, stated so they survive review:
 *
 * - Expansion forms: every grammar node type whose name carries the
 *   expansion/substitution morpheme (the grammar's own naming
 *   convention for expansion syntax), plus the ANSI-C string form,
 *   whose $'...' spelling the morpheme cannot catch and whose name is
 *   declared here. Today this yields exactly the six names
 *   EXPANSION_NODE_TYPES carries.
 * - Argument shapes: the word-like leaves that can stand in a
 *   command's argument position - the command node's argument field
 *   types with underscore supertypes (the grammar's grouping entries)
 *   flattened to their subtypes, minus the expansion forms the
 *   substitution traversal owns (asking beats extracting), minus the
 *   deliberate non-word exclusions (number: a bare number operand
 *   never spells a path; brace_expression: command grouping, not a
 *   word; regex: operator pattern text whose extraction would surface
 *   garbage paths with no closure). Today this yields concatenation,
 *   raw_string, string, translated_string, and word - and it found
 *   translated_string missing from the walk's set on its first run,
 *   which is the check working.
 */

import { ARG_NODE_TYPES, EXPANSION_NODE_TYPES, SKIP_SUBTREE_TYPES } from "./bash-scan.ts";

/** The grammar's own grouping entries (underscore-prefixed supertypes) declare their member types here. */
interface GrammarNodeTypeEntry {
	type: string;
	named?: boolean;
	subtypes?: { type: string }[];
	fields?: Record<string, { types?: { type: string }[] }>;
}

/** The grammar-declared vocabulary the walk's sets must cover. */
export interface FenceGrammarVocabulary {
	/** Every expansion-form node type the grammar produces (morpheme matches plus the declared ANSI-C form). */
	expansionForms: string[];
	/** Every word-like argument shape the grammar can stand in a command's argument position. */
	argumentShapes: string[];
	/** Every node type name the grammar declares, named or anonymous: the stale-direction authority. */
	grammarTypeNames: string[];
}

/** Non-word argument-field members the extraction walk deliberately does not treat as operand shapes. */
const NON_WORD_ARGUMENT_SHAPES: ReadonlySet<string> = new Set(["number", "brace_expression", "regex"]);

/** The ANSI-C string form's node type: an expansion-bearing literal the expansion/substitution morpheme cannot catch by name. */
const ANSI_C_STRING_TYPE = "ansi_c_string";

/** The command node type whose argument field defines argument position. */
const COMMAND_TYPE = "command";
/** The command field whose types are the grammar's argument-position shapes. */
const ARGUMENT_FIELD = "argument";
/** The grammar's grouping entries: underscore-prefixed supertype declarations flattened to their subtypes. */
const SUPERTYPE_PREFIX = "_";

/** The morpheme the grammar's naming convention uses for expansion syntax. */
function isExpansionMorphemeName(name: string): boolean {
	return name.includes("expansion") || name.includes("substitution");
}

function requireNodeTypeEntries(nodeTypes: unknown): GrammarNodeTypeEntry[] {
	if (!Array.isArray(nodeTypes)) {
		throw new Error("the grammar node-type data is not an array; the vocabulary it would pin against is unverifiable");
	}
	const entries: GrammarNodeTypeEntry[] = [];
	for (const entry of nodeTypes) {
		if (typeof entry !== "object" || entry === null || typeof (entry as GrammarNodeTypeEntry).type !== "string") {
			throw new Error("a grammar node-type entry carries no usable type name; the vocabulary it would pin against is unverifiable");
		}
		entries.push(entry as GrammarNodeTypeEntry);
	}
	if (entries.length === 0) {
		throw new Error("the grammar node-type data is empty; the vocabulary it would pin against is unverifiable");
	}
	return entries;
}

/**
 * Extract the walk-relevant vocabulary from parsed node-types.json
 * data. Throws when the data cannot prove the surface the check
 * needs (no command entry, no argument field, an undeclared
 * supertype reference): a vocabulary the walk would pin against must
 * be verifiable or nothing gets pinned, the fail-open direction
 * closed at the source.
 */
export function extractGrammarVocabulary(nodeTypes: unknown): FenceGrammarVocabulary {
	const entries = requireNodeTypeEntries(nodeTypes);
	const grammarTypeNames = entries.map((entry) => entry.type);
	const allNames = new Set(grammarTypeNames);
	const supertypes = new Map<string, string[]>();
	for (const entry of entries) {
		if (!entry.type.startsWith(SUPERTYPE_PREFIX) || !Array.isArray(entry.subtypes)) continue;
		supertypes.set(entry.type, entry.subtypes.map((subtype) => subtype.type));
	}
	const flatten = (name: string, seen: Set<string>): string[] => {
		if (!name.startsWith(SUPERTYPE_PREFIX)) return [name];
		if (seen.has(name)) throw new Error(`the grammar node-type data carries a cyclic supertype reference at ${name}`);
		seen.add(name);
		const members = supertypes.get(name);
		if (members === undefined) {
			throw new Error(`the grammar's argument field references supertype ${name} with no declared subtypes; the vocabulary it would pin against is unverifiable`);
		}
		return members.flatMap((member) => flatten(member, seen));
	};
	const commandEntry = entries.find((entry) => entry.type === COMMAND_TYPE);
	const argumentTypes = commandEntry?.fields?.[ARGUMENT_FIELD]?.types;
	if (!commandEntry || !Array.isArray(argumentTypes)) {
		throw new Error("the grammar node-type data carries no command argument field; the vocabulary it would pin against is unverifiable");
	}
	const argumentShapes = new Set<string>();
	for (const argumentType of argumentTypes) {
		if (argumentType.named === false) continue;
		for (const flattened of flatten(argumentType.type, new Set<string>())) {
			if (!isExpansionMorphemeName(flattened) && flattened !== ANSI_C_STRING_TYPE && !NON_WORD_ARGUMENT_SHAPES.has(flattened)) {
				argumentShapes.add(flattened);
			}
		}
	}
	const expansionForms = new Set<string>(grammarTypeNames.filter((name) => isExpansionMorphemeName(name)));
	if (allNames.has(ANSI_C_STRING_TYPE)) expansionForms.add(ANSI_C_STRING_TYPE);
	return {
		expansionForms: [...expansionForms].sort(),
		argumentShapes: [...argumentShapes].sort(),
		grammarTypeNames,
	};
}

/** Every gap class between the walk's vocabularies and the grammar's declared surface; every array empty means the walk covers the grammar it runs against. */
export interface WalkVocabularyGaps {
	/** Expansion forms the grammar produces that the walk's substitution set does not flag (the under-flag direction). */
	expansionMissing: string[];
	/** Word-like argument shapes the grammar produces that the walk's extraction set does not read (the silent empty-operands direction). */
	argumentMissing: string[];
	/** Expansion set entries the grammar no longer declares (rename drift; the walk keys on a type that no longer exists). */
	staleExpansion: string[];
	/** Argument set entries the grammar no longer declares. */
	staleArgument: string[];
	/** Skip-subtree entries the grammar no longer declares. */
	staleSkip: string[];
}

/**
 * Compute the gaps between the walk's vocabularies and one grammar
 * vocabulary. Completeness is the fail-open direction (a missing
 * member silently under-flags or under-extracts); staleness is the
 * drift direction (a renamed member means the walk keys on a type
 * the grammar no longer produces). Both directions must be empty
 * before a grammar's bytes may re-pin. The redirect-operator set is
 * deliberately outside this report: its members are anonymous
 * defensive spellings, and operator drift degrades to the
 * unmodeled-shape substitution bias, the fail-safe direction, so its
 * staleness is noise rather than a hazard.
 */
export function walkVocabularyGaps(vocabulary: FenceGrammarVocabulary): WalkVocabularyGaps {
	const declared = new Set(vocabulary.grammarTypeNames);
	const missing = (names: Iterable<string>, covered: ReadonlySet<string>): string[] =>
		[...names].filter((name) => !covered.has(name)).sort();
	const stale = (covered: ReadonlySet<string>): string[] => [...covered].filter((name) => !declared.has(name)).sort();
	return {
		expansionMissing: missing(vocabulary.expansionForms, EXPANSION_NODE_TYPES),
		argumentMissing: missing(vocabulary.argumentShapes, ARG_NODE_TYPES),
		staleExpansion: stale(EXPANSION_NODE_TYPES),
		staleArgument: stale(ARG_NODE_TYPES),
		staleSkip: stale(SKIP_SUBTREE_TYPES),
	};
}

/** True when every gap array is empty: the walk's vocabulary covers the grammar's declared surface in both directions. */
export function vocabularyIsClean(gaps: WalkVocabularyGaps): boolean {
	return (
		gaps.expansionMissing.length === 0 &&
		gaps.argumentMissing.length === 0 &&
		gaps.staleExpansion.length === 0 &&
		gaps.staleArgument.length === 0 &&
		gaps.staleSkip.length === 0
	);
}
