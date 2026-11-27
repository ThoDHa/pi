#!/usr/bin/env node
/**
 * Thinking-level frontmatter suite: the agents.ts parse
 * (extensions/subagent/agents.ts) and the runSingleAgent dispatch-default
 * consumption (extensions/subagent/index.ts). Plain node, no test framework:
 *
 *   node tests/subagent-thinking-level.test.mjs
 *
 * Pins, per the EXT-36-1 testing strategy:
 *
 * - the parse vocabulary, hermetically: frontmatter `thinkingLevel` validated
 *   against the THINKING_LEVELS table declared in
 *   extensions/subagent/agents.ts (off | minimal | low | medium | high |
 *   xhigh | max); anything else (wrong string, number, list, map, missing)
 *   yields undefined rather than throwing, so discovery keeps the
 *   loadable-state guarantee and a single bad file never takes down the
 *   other agents in the directory. The table is read out of the agents.ts
 *   source rather than copied here, so these checks cannot drift from the
 *   production table they exercise.
 * - one external vocabulary pin: the agents.ts THINKING_LEVELS table is
 *   asserted against pi's own installed vocabulary (VALID_THINKING_LEVELS in
 *   the installed release's pi-coding-agent dist/cli/args.js, or the
 *   ThinkingLevel union scraped from pi-agent-core dist/types.d.ts when
 *   args.js is not found), so a level pi adds or drops turns this suite red
 *   naming the divergence instead of drifting silently. The pin is gated on
 *   the pi installation being locatable and skips with a printed name when
 *   it is not, the same documented posture tests/run-all.sh applies to its
 *   install-dependent suites; it never skips silently.
 * - the discovery wiring end to end over fixture agent files in a temp dir:
 *   frontmatter value reaches AgentConfig.thinkingLevel, missing key stays
 *   undefined (the current default behavior, unchanged tolerance).
 * - the deployed fleet chart, a separate environment-dependent check: the
 *   six live agent files under ~/.pi/agent/agents load with the chart's
 *   per-agent values (advisor max, planner high, reviewer max, worker high,
 *   verifier low, scout low). The fleet is gitignored machine config the
 *   repo does not carry, so on a host without the deployed directory the
 *   check skips with a printed name instead of failing run-all on machines
 *   that never deployed the fleet (the posture run-all.sh documents); where
 *   the directory exists the pin is hard and fleet drift fails here first.
 *   The hermetic parse and consumption pins never read the live directory.
 * - the dispatch-default consumption precedence, over the pure
 *   resolveDispatchThinkingLevel helper runSingleAgent consumes: agent
 *   frontmatter wins over the session default (including on a model-pinned
 *   agent, where the legacy rule that tied thinking inheritance to model
 *   pinning would otherwise swallow the chart value); with no frontmatter
 *   key the current behavior is unchanged (session default inherited only
 *   when the agent does not pin a model, otherwise no flag).
 * - the override-condition pin: the subagent tool's parameter schema carries
 *   no dispatch-level thinkingLevel, so there is no explicit override to
 *   honor and frontmatter is the strongest override that exists; this pin
 *   goes red if a thinkingLevel parameter is ever added to the schema, which
 *   is the moment the precedence must be re-decided (a dispatch-level value
 *   would then win over frontmatter).
 *
 * The @earendil-works packages and typebox resolve nowhere in a bare
 * checkout, so the suite registers module-customization hooks stubbing the
 * five bare specifiers the subagent module graph binds at link time, the
 * same link-validation pattern as tests/subagent-module-load.test.mjs. The
 * pi-coding-agent stub carries a minimal frontmatter parser (fenced
 * `---` block, one `key: value` scalar per line, optional matching quotes)
 * instead of the real YAML parser, which covers every frontmatter shape the
 * pinned files use.
 */

import { register } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
let skipped = 0;
let total = 0;
function check(label, fn) {
	total++;
	try {
		fn();
	} catch (error) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      ${String(error.message).split("\n").join("\n      ")}`);
	}
}
function skip(label, reason) {
	total++;
	skipped++;
	console.log(`SKIP  ${label}`);
	console.log(`      ${reason}`);
}

const stubSources = {
	"@earendil-works/pi-coding-agent": `
export const CONFIG_DIR_NAME = ".pi";
let agentDir = "";
export const setAgentDir = (dir) => { agentDir = dir; };
export const getAgentDir = () => agentDir;
export const formatReadLineRange = () => "";
export const getMarkdownTheme = () => () => "";
export const parseFrontmatter = (content) => {
	const text = String(content);
	if (!text.startsWith("---")) return { frontmatter: {}, body: text };
	const end = text.indexOf("\\n---", 3);
	if (end === -1) return { frontmatter: {}, body: text };
	const bodyStart = text.indexOf("\\n", end + 1);
	const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1);
	const frontmatter = {};
	for (const line of text.slice(4, end).split("\\n")) {
		const match = line.match(/^([A-Za-z][A-Za-z_-]*):\\s*(.*)$/);
		if (match === null) continue;
		let value = match[2];
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
			value = value.slice(1, -1);
		}
		frontmatter[match[1]] = value;
	}
	return { frontmatter, body };
};
`,
	"@earendil-works/pi-agent-core": `
export const stubMarker = "pi-agent-core-stub";
`,
	"@earendil-works/pi-ai": `
export const StringEnum = (values, options) => ({ enum: values, ...options });
`,
	"@earendil-works/pi-tui": `
export const Container = class {};
export const Markdown = class {};
export const Spacer = class {};
export const Text = class {};
`,
	typebox: `
const marker = (kind) => (...args) => ({ typebox: kind, args });
export const Type = {
	Object: marker("Object"),
	String: marker("String"),
	Optional: (schema) => schema,
	Array: marker("Array"),
	Boolean: marker("Boolean"),
	Number: marker("Number"),
};
`,
};

const hooksSource = `
const stubSources = ${JSON.stringify(stubSources)};
const stubUrls = new Map(Object.keys(stubSources).map((specifier) => ["stub:" + specifier, specifier]));
export async function resolve(specifier, context, next) {
	if (stubSources[specifier] !== undefined) return { url: "stub:" + specifier, shortCircuit: true };
	return next(specifier, context);
}
export async function load(url, context, next) {
	const specifier = stubUrls.get(url);
	if (specifier !== undefined) {
		return { format: "module", source: stubSources[specifier], shortCircuit: true };
	}
	return next(url, context);
}
`;

register(`data:text/javascript;base64,${Buffer.from(hooksSource, "utf-8").toString("base64")}`, import.meta.url);

const agents = await import("../extensions/subagent/agents.ts");
const subagent = await import("../extensions/subagent/index.ts");
const { setAgentDir } = await import("stub:@earendil-works/pi-coding-agent");

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_SOURCE = fs.readFileSync(path.join(WORKTREE_ROOT, "extensions", "subagent", "agents.ts"), "utf8");
const LIVE_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const LIVE_AGENTS_DIR = path.join(LIVE_AGENT_DIR, "agents");
const CHART_LEVELS = { advisor: "max", planner: "high", reviewer: "max", worker: "high", verifier: "low", scout: "low" };

function readDeclaredVocabulary() {
	const match = AGENTS_SOURCE.match(/const THINKING_LEVELS: readonly ThinkingLevel\[\] = \[([^\]]*)\];/);
	if (match === null) return null;
	return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function piScopeRootCandidates() {
	const roots = [];
	let piReal;
	try {
		piReal = fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	} catch {
		return roots;
	}
	// pi's managed launcher resolves its release through
	// <agent dir>/install/current-version; mirror that first so hosts using
	// the wrapper script (which lives outside the release tree) still locate
	// the installed packages.
	const agentDir = path.dirname(path.dirname(piReal));
	try {
		const version = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
		if (/^[A-Za-z0-9._+-]+$/.test(version)) {
			roots.push(path.join(agentDir, "install", "releases", version, "node_modules", "@earendil-works"));
		}
	} catch {
		// Not a managed launcher; the up-tree probe below still applies.
	}
	// Up-tree probe for installs where the executable resolves (through
	// symlinks) into the package tree itself, as tests/provision-pi-tui.mjs
	// locates the installation.
	let root = path.dirname(piReal);
	while (root !== path.dirname(root)) {
		roots.push(path.join(root, "node_modules", "@earendil-works"));
		root = path.dirname(root);
	}
	return roots;
}

/**
 * Read pi's ThinkingLevel vocabulary from the installed release: the module
 * -local VALID_THINKING_LEVELS array in pi-coding-agent's dist/cli/args.js,
 * falling back to the ThinkingLevel union scraped from pi-agent-core's
 * dist/types.d.ts. Neither is exported, so the value is read from the
 * installed source text.
 *
 * Returns: { source, levels } naming where the vocabulary was read from, or
 * null when no pi installation is locatable.
 */
function locatePiVocabulary() {
	for (const scope of piScopeRootCandidates()) {
		const argsJs = path.join(scope, "pi-coding-agent", "dist", "cli", "args.js");
		if (fs.existsSync(argsJs)) {
			const match = fs.readFileSync(argsJs, "utf8").match(/const VALID_THINKING_LEVELS = \[([^\]]*)\]/);
			const levels = match === null ? [] : [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
			if (levels.length > 0) return { source: "VALID_THINKING_LEVELS in pi-coding-agent dist/cli/args.js", levels };
		}
		const typesDts = path.join(scope, "pi-agent-core", "dist", "types.d.ts");
		if (fs.existsSync(typesDts)) {
			const match = fs.readFileSync(typesDts, "utf8").match(/export type ThinkingLevel = ([^;]+);/);
			const levels = match === null ? [] : [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
			if (levels.length > 0) return { source: "the ThinkingLevel union in pi-agent-core dist/types.d.ts", levels };
		}
	}
	return null;
}

const declaredLevels = readDeclaredVocabulary();
const piVocabulary = locatePiVocabulary();

// The production table, read from the agents.ts source: the parse pins
// exercise exactly the table the extension ships, never a test-local copy.
check("agents.ts declares the THINKING_LEVELS table", () => {
	if (declaredLevels === null) {
		throw new Error("const THINKING_LEVELS declaration not found in extensions/subagent/agents.ts source");
	}
	if (declaredLevels.length === 0) throw new Error("the declared THINKING_LEVELS table is empty");
});

// Parse vocabulary, hermetic: every declared value round-trips.
if (declaredLevels === null) {
	skip(
		"parseThinkingLevel accepts every declared vocabulary value",
		"the THINKING_LEVELS table is missing from agents.ts source, so there are no declared values to round-trip; the failing structural check above names the root cause",
	);
} else {
	for (const level of declaredLevels) {
		check(`parseThinkingLevel accepts "${level}"`, () => {
			const parsed = agents.parseThinkingLevel(level);
			if (parsed !== level) throw new Error(`expected ${level}, got ${parsed}`);
		});
	}
}

// External pin: the shipped table matches pi's installed vocabulary, so a
// level pi adds or drops goes red here instead of drifting silently.
if (piVocabulary === null) {
	skip(
		"THINKING_LEVELS matches pi's installed ThinkingLevel vocabulary",
		"install-dependent check: no pi installation locatable (which pi failed, or neither pi-coding-agent dist/cli/args.js nor pi-agent-core dist/types.d.ts was found or parsed); skipped by name per the run-all documented posture, never silently",
	);
} else if (declaredLevels === null) {
	skip(
		"THINKING_LEVELS matches pi's installed ThinkingLevel vocabulary",
		"the THINKING_LEVELS table is missing from agents.ts source, so there is nothing to compare against pi's installed vocabulary; the failing structural check above names the root cause",
	);
} else {
	check("THINKING_LEVELS matches pi's installed ThinkingLevel vocabulary", () => {
		const problems = [];
		for (const level of piVocabulary.levels) {
			if (!declaredLevels.includes(level)) problems.push(`pi accepts "${level}" (${piVocabulary.source}) but the agents.ts table omits it`);
		}
		for (const level of declaredLevels) {
			if (!piVocabulary.levels.includes(level)) problems.push(`the agents.ts table declares "${level}" but ${piVocabulary.source} does not include it`);
		}
		if (problems.length > 0) {
			throw new Error(`drift between the agents.ts THINKING_LEVELS table and ${piVocabulary.source}: ${problems.join("; ")}`);
		}
	});
}

// Parse tolerance: anything outside the vocabulary yields undefined instead
// of throwing, so a bad frontmatter value never fails agent discovery.
const toleranceCases = [
	["unknown level string", "ultra"],
	["capitalized level", "Max"],
	["number", 3],
	["list", ["high"]],
	["map", { level: "high" }],
	["null", null],
	["undefined (missing key)", undefined],
];
for (const [label, value] of toleranceCases) {
	check(`parseThinkingLevel rejects a ${label}`, () => {
		const parsed = agents.parseThinkingLevel(value);
		if (parsed !== undefined) throw new Error(`expected undefined, got ${parsed}`);
	});
}

// Discovery wiring over temp fixture agent files: the frontmatter value
// reaches AgentConfig.thinkingLevel, and a missing key leaves undefined.
check("discovery wires frontmatter thinkingLevel onto the agent config", () => {
	const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinking-level-pin-"));
	try {
		fs.mkdirSync(path.join(fixtureDir, "agents"));
		fs.writeFileSync(
			path.join(fixtureDir, "agents", "pinned.md"),
			["---", "name: pinned", "description: carries the key", "model: glm-5.3", "thinkingLevel: low", "---", "", "body"].join("\n"),
		);
		fs.writeFileSync(
			path.join(fixtureDir, "agents", "bare.md"),
			["---", "name: bare", "description: missing the key", "model: glm-5.3", "---", "", "body"].join("\n"),
		);
		fs.writeFileSync(
			path.join(fixtureDir, "agents", "invalid.md"),
			["---", "name: invalid", "description: carries a bad value", "model: glm-5.3", "thinkingLevel: ultra", "---", "", "body"].join("\n"),
		);
		setAgentDir(fixtureDir);
		const discovered = agents.discoverAgents(WORKTREE_ROOT, "user").agents;
		if (discovered.length !== 3) throw new Error(`expected 3 fixtures loaded, got ${discovered.length}`);
		const byName = new Map(discovered.map((agent) => [agent.name, agent]));
		const pinned = byName.get("pinned");
		if (pinned === undefined) throw new Error("pinned fixture agent failed to load");
		if (pinned.thinkingLevel !== "low") throw new Error(`expected low, got ${pinned.thinkingLevel}`);
		const bare = byName.get("bare");
		if (bare === undefined) throw new Error("bare fixture agent failed to load");
		if (bare.thinkingLevel !== undefined) throw new Error(`expected undefined, got ${bare.thinkingLevel}`);
		const invalid = byName.get("invalid");
		if (invalid === undefined) throw new Error("invalid-level fixture agent failed to load (a bad value must not block discovery)");
		if (invalid.thinkingLevel !== undefined) throw new Error(`expected undefined, got ${invalid.thinkingLevel}`);
	} finally {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		setAgentDir("");
	}
});

// Deployed fleet chart, a separate environment-dependent check: pins the
// live ~/.pi/agent/agents files against the chart. The fleet is untracked
// machine config the repo does not carry, so a host without the deployed
// directory gets a printed named skip (the posture run-all.sh documents)
// instead of a red suite; where the directory exists the pin is hard.
let fleetDirPresent = false;
try {
	fleetDirPresent = fs.statSync(LIVE_AGENTS_DIR).isDirectory();
} catch {
	fleetDirPresent = false;
}
if (!fleetDirPresent) {
	skip(
		"the deployed fleet files match the chart (environment-dependent)",
		`${LIVE_AGENTS_DIR} is absent on this host: the fleet is untracked machine config the repo does not deploy, so the chart pin skips by name per the run-all documented posture, never silently`,
	);
} else {
	check("the deployed fleet files match the chart (environment-dependent)", () => {
		setAgentDir(LIVE_AGENT_DIR);
		try {
			const fleet = new Map(agents.discoverAgents(WORKTREE_ROOT, "user").agents.map((agent) => [agent.name, agent]));
			const problems = [];
			for (const [name, level] of Object.entries(CHART_LEVELS)) {
				const agent = fleet.get(name);
				if (agent === undefined) {
					problems.push(`${name}: not found in ${LIVE_AGENTS_DIR}`);
					continue;
				}
				if (agent.thinkingLevel !== level) problems.push(`${name}: expected ${level}, got ${agent.thinkingLevel}`);
			}
			if (problems.length > 0) throw new Error(problems.join("; "));
		} finally {
			setAgentDir("");
		}
	});
}

// Dispatch-default consumption precedence over the pure helper.
const makeAgent = (overrides = {}) => ({
	name: "pinned-agent",
	description: "fixture",
	tools: undefined,
	model: "glm-5.3",
	detach: undefined,
	thinkingLevel: undefined,
	systemPrompt: "body",
	source: "user",
	filePath: "/tmp/fixture.md",
	...overrides,
});

const precedenceCases = [
	[
		"frontmatter thinking wins over the session default on a model-pinned agent",
		{ thinkingLevel: "max" },
		{ thinkingLevel: "high" },
		"max",
	],
	["frontmatter thinking applies with no session default present", { thinkingLevel: "low" }, {}, "low"],
	[
		"missing frontmatter key on an unpinned agent inherits the session default (unchanged behavior)",
		{ model: undefined },
		{ thinkingLevel: "high" },
		"high",
	],
	[
		"missing frontmatter key on a model-pinned agent passes no flag (unchanged behavior)",
		{},
		{ thinkingLevel: "high" },
		undefined,
	],
	["missing frontmatter key and no session default passes no flag", { model: undefined }, {}, undefined],
];
for (const [label, overrides, defaults, expected] of precedenceCases) {
	check(`resolveDispatchThinkingLevel: ${label}`, () => {
		const resolved = subagent.resolveDispatchThinkingLevel(makeAgent(overrides), defaults);
		if (resolved !== expected) throw new Error(`expected ${expected}, got ${resolved}`);
	});
}

// Override-condition pin: the subagent tool schema carries no dispatch-level
// thinkingLevel. A thinkingLevel parameter added to SubagentParams turns
// this red and forces the precedence re-decision (dispatch value would then
// win over frontmatter).
check("the subagent tool schema carries no thinkingLevel parameter", () => {
	const indexSource = fs.readFileSync(path.join(WORKTREE_ROOT, "extensions", "subagent", "index.ts"), "utf8");
	const start = indexSource.indexOf("const SubagentParams = Type.Object({");
	if (start === -1) throw new Error("SubagentParams schema not found in index.ts");
	const end = indexSource.indexOf("\n});", start);
	if (end === -1) throw new Error("SubagentParams schema block has no closing fence");
	const schemaBlock = indexSource.slice(start, end);
	if (schemaBlock.includes("thinkingLevel")) {
		throw new Error("SubagentParams now carries a thinkingLevel parameter: re-decide the dispatch-default precedence");
	}
});

check("runSingleAgent consumes the resolveDispatchRuntime resolution, which routes the --thinking decision through resolveDispatchThinkingLevel", () => {
	const indexSource = fs.readFileSync(path.join(WORKTREE_ROOT, "extensions", "subagent", "index.ts"), "utf8");
	if (!indexSource.includes("resolveDispatchRuntime(agent, dispatchDefaults)")) {
		throw new Error("runSingleAgent no longer routes its spawn runtime through resolveDispatchRuntime");
	}
	const resolverStart = indexSource.indexOf("export function resolveDispatchRuntime(");
	if (resolverStart === -1) throw new Error("resolveDispatchRuntime helper not found in index.ts");
	const resolverEnd = indexSource.indexOf("\n}", resolverStart);
	const resolverBody = indexSource.slice(resolverStart, resolverEnd);
	if (!resolverBody.includes("resolveDispatchThinkingLevel(agent, dispatchDefaults)")) {
		throw new Error("resolveDispatchRuntime no longer routes the --thinking decision through resolveDispatchThinkingLevel");
	}
});

// The registry pickup sites resolve through the same helper, so a
// registry node carries its spawn-time model and thinking level from
// the moment it exists (the parallel pickup, the single and chain
// round rosters, and the detached slot start) instead of waiting for
// the first streamed update.
check("the dispatch registry pickups record the resolved runtime via the same helper", () => {
	const indexSource = fs.readFileSync(path.join(WORKTREE_ROOT, "extensions", "subagent", "index.ts"), "utf8");
	for (const pickup of ["resolveAgentRuntime(t.agent)", "resolveAgentRuntime(params.agent)", "resolveAgentRuntime(step.agent)", "resolveSlotRuntime(slot)"]) {
		if (!indexSource.includes(pickup)) {
			throw new Error(`registry pickup wiring lost: ${pickup} no longer feeds the pickup site`);
		}
	}
});

// resolveDispatchRuntime: the pair a dispatch runs an agent with. The
// model resolution mirrors runSingleAgent's legacy fallback (frontmatter
// model, else the session model) and the thinking level routes through
// resolveDispatchThinkingLevel; an unknown agent claims nothing, since
// the dispatch fails before spawning and the node must not carry a
// runtime it never ran.
const runtimeCases = [
	["frontmatter thinking and pinned model reach the pair untouched", { thinkingLevel: "max" }, {}, "max", "glm-5.3"],
	[
		"an unpinned agent inherits the session model and thinking level",
		{ model: undefined },
		{ model: "session/model", thinkingLevel: "high" },
		"high",
		"session/model",
	],
	[
		"a model-pinned agent without frontmatter claims no thinking level",
		{},
		{ model: "session/model", thinkingLevel: "high" },
		undefined,
		"glm-5.3",
	],
	["no defaults and no frontmatter yields the empty pair", { model: undefined }, {}, undefined, undefined],
];
for (const [label, overrides, defaults, expectedLevel, expectedModel] of runtimeCases) {
	check(`resolveDispatchRuntime: ${label}`, () => {
		const resolved = subagent.resolveDispatchRuntime(makeAgent(overrides), defaults);
		if (resolved.thinkingLevel !== expectedLevel) throw new Error(`expected thinkingLevel ${expectedLevel}, got ${resolved.thinkingLevel}`);
		if (resolved.model !== expectedModel) throw new Error(`expected model ${expectedModel}, got ${resolved.model}`);
	});
}
check("resolveDispatchRuntime: an unknown agent claims nothing", () => {
	const resolved = subagent.resolveDispatchRuntime(undefined, { model: "session/model", thinkingLevel: "high" });
	if (resolved.model !== undefined || resolved.thinkingLevel !== undefined) {
		throw new Error(`expected the empty pair, got ${JSON.stringify(resolved)}`);
	}
});

const passed = total - failed - skipped;
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped of ${total} checks`);
if (failed > 0) process.exitCode = 1;
