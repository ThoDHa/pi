#!/usr/bin/env node
/**
 * Structural load probe for the live-loaded extension modules, plain
 * node, no test framework:
 *
 *   node tests/subagent-module-load.test.mjs
 *
 * extensions/subagent/index.ts is live-loaded by every pi session, and
 * a module that fails to load or a default export that is not a
 * factory fails the session's startup (the incident rule), so the
 * probe imports the real module tree on every run. The module tree
 * imports @earendil-works packages and typebox, which no bare checkout
 * resolves, so the probe registers module-customization hooks that
 * stub exactly those five bare specifiers with minimal ESM sources
 * carrying the named exports the tree actually binds at link time:
 * link validation is the point, because a renamed or removed export
 * behind the spawn wiring fails the import here instead of failing a
 * live session. Type-only imports strip out before resolution and
 * need no stubs.
 *
 * The probe pins four layers: the real subagent module graph links
 * and evaluates (its top level runs for real: the timeout env read,
 * the schema constants over the typebox stub, the exit hook), the
 * default export is a function and the factory completes registration
 * against a recording stub (two registerTool calls naming the subagent
 * and jobs tools, three event handlers), the touched fence-ask and
 * workspace-fence modules load standalone with the unit 1-2 surface
 * present (childProvisioningEnv, the forwarding-root mint,
 * inheritedExtraRootsEnvValue, recordParentOwnGrant) plus the unit
 * 1-3 surface (the headless forward branch, the child-scoped roots
 * build), and the fence-ask entry loads standalone and its factory
 * registers the session lifecycle pair, the live-load discipline the
 * incident rule demands of every loadable entry. The EXT-33 layer
 * drives the two-hop grandchild inheritance through the spawn site's
 * exported composition (buildChildInheritedRootsEnvValue): the top
 * session's env-carried root must survive into the grandchild's
 * composed env value, and the spawn site must keep calling that
 * exported composition.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { register } from "node:module";

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

const stubSources = {
	"@earendil-works/pi-coding-agent": `
export const CONFIG_DIR_NAME = "stub-agents-dir";
export const formatReadLineRange = () => "";
export const getAgentDir = () => "/tmp/stub-agents";
export const getMarkdownTheme = () => () => "";
export const parseFrontmatter = () => ({});
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

const subagent = await import("../extensions/subagent/index.ts");
check("the subagent module graph links and evaluates", typeof subagent.default, "function");

const registeredCalls = [];
const stubPi = new Proxy(
	{},
	{
		get(_target, prop) {
			return (...args) => {
				registeredCalls.push({ method: String(prop), name: args[0]?.name });
			};
		},
	},
);
let factoryThrew = null;
try {
	subagent.default(stubPi);
} catch (error) {
	factoryThrew = error;
}
check("the factory completes registration against a recording stub", factoryThrew, null);
checkDeepLabel();

function checkDeepLabel() {
	const registered = registeredCalls.map((call) => `${call.method}:${call.name ?? "*"}`).sort();
	const expected = ["on:*", "on:*", "on:*", "registerTool:jobs", "registerTool:subagent"].sort();
	check(
		"the factory registers the two tools and three event handlers",
		JSON.stringify(registered),
		JSON.stringify(expected),
	);
}

const askWire = await import("../extensions/fence-ask/ask-wire.ts");
check("ask-wire loads standalone", typeof askWire.childProvisioningEnv, "function");
check("ask-wire keeps the wire validators", typeof askWire.parseForwardedAsk, "function");
const grantLedger = await import("../extensions/fence-ask/grant-ledger.ts");
check("grant-ledger loads standalone", typeof grantLedger.ensureForwardingRoot, "function");
check("grant-ledger carries the env-value composer", typeof grantLedger.inheritedExtraRootsEnvValue, "function");
check("grant-ledger carries the parent-own recorder feed", typeof grantLedger.recordParentGrant, "function");
const fence = await import("../extensions/workspace-fence.ts");
check("workspace-fence loads standalone", typeof fence.recordParentOwnGrant, "function");
check("workspace-fence keeps the spawn composition input", typeof fence.fenceExtraRoots, "function");
check("workspace-fence carries the per-source spawn composition feed", typeof fence.fenceExtraRootSources, "function");
check("workspace-fence carries the headless forward branch", typeof fence.forwardHeadlessAsk, "function");
check("workspace-fence carries the child-scoped roots build", typeof fence.childScopedAllowedRoots, "function");
check("the subagent module carries the parent spawn root sources feed", typeof subagent.parentSpawnRootSources, "function");
check("the subagent module carries the exported spawn composition", typeof subagent.buildChildInheritedRootsEnvValue, "function");
const spawnSiteSource = fs.readFileSync(path.join(import.meta.dirname, "..", "extensions", "subagent", "index.ts"), "utf-8");
checkContains(
	"the spawn site's inherited-roots value is the exported composition call",
	spawnSiteSource,
	"const inheritedRootsValue = buildChildInheritedRootsEnvValue({",
);

const fenceAskEntry = await import("../extensions/fence-ask/index.ts");
check("the fence-ask entry loads standalone", typeof fenceAskEntry.default, "function");
const entryRegistrations = [];
let entryThrew = null;
try {
	fenceAskEntry.default({
		on(name, handler) {
			entryRegistrations.push(`${String(name)}:${typeof handler}`);
		},
	});
} catch (error) {
	entryThrew = error;
}
check("the fence-ask entry factory completes against a recording stub", entryThrew, null);
check(
	"the fence-ask entry registers the session lifecycle pair",
	entryRegistrations.join(","),
	"session_start:function,session_shutdown:function",
);

// --- EXT-33: the two-hop grandchild inheritance through the real
// spawn composition. Both hops call the exported function the spawn
// site itself calls (buildChildInheritedRootsEnvValue), so a
// regression that hardcodes empty overlay or env sources inside the
// composition loses the top root at hop one and fails the hop pins;
// a spawn site that stops calling the exported composition fails the
// call-site pin above.

let hopThrew = null;
const hopFixture = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-load-hop-"));
const topRoot = path.join(hopFixture, "top-root");
const topCwd = path.join(hopFixture, "session-top");
const middleCwd = path.join(hopFixture, "session-middle");
const grandCwd = path.join(hopFixture, "session-grand");
for (const dir of [topRoot, topCwd, middleCwd, grandCwd]) fs.mkdirSync(dir, { recursive: true });
const topRootReal = fs.realpathSync(topRoot);
const savedHopEnv = process.env[fence.EXTRA_ROOTS_ENV];
try {
	try {
		process.env[fence.EXTRA_ROOTS_ENV] = topRootReal;
		fence.resetFenceExtraRoots();
		const middleEnvValue = subagent.buildChildInheritedRootsEnvValue({
			parentSessionCwd: topCwd,
			dispatchCwd: middleCwd,
		});
		checkContains(
			"hop one composes the top session's env root into the middle child's env value",
			middleEnvValue,
			topRootReal,
		);
		process.env[fence.EXTRA_ROOTS_ENV] = middleEnvValue;
		fence.resetFenceExtraRoots();
		const grandEnvValue = subagent.buildChildInheritedRootsEnvValue({
			parentSessionCwd: middleCwd,
			dispatchCwd: grandCwd,
		});
		checkContains(
			"hop two keeps the top session's env root in the grandchild's composed env value",
			grandEnvValue,
			topRootReal,
		);
		check(
			"the grandchild-side parse resolves the surviving top root",
			fence.parseExtraRoots(grandEnvValue).includes(topRootReal),
			true,
		);
	} finally {
		if (savedHopEnv === undefined) delete process.env[fence.EXTRA_ROOTS_ENV];
		else process.env[fence.EXTRA_ROOTS_ENV] = savedHopEnv;
		fence.resetFenceExtraRoots();
		fs.rmSync(hopFixture, { recursive: true, force: true });
	}
} catch (error) {
	hopThrew = error;
}
check("the two-hop inheritance chain composes through the real spawn feed", hopThrew, null);

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
