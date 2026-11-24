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
 * The probe pins three layers: the real subagent module graph links
 * and evaluates (its top level runs for real: the timeout env read,
 * the schema constants over the typebox stub, the exit hook), the
 * default export is a function and the factory completes registration
 * against a recording stub (two registerTool calls naming the subagent
 * and jobs tools, three event handlers), and the touched fence-ask and
 * workspace-fence modules load standalone with the unit 1-2 surface
 * present (childProvisioningEnv, the forwarding-root mint,
 * inheritedExtraRootsEnvValue, recordParentOwnGrant).
 */

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

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
