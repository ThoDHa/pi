#!/usr/bin/env node
/**
 * Suite for the fence-ask contract package: extensions/fence-ask/
 * ask-wire.ts (the child-parent forwarded-ask message contract) and
 * grant-ledger.ts (the per-child grant ledger and the spam-cap
 * admission machine). Plain node, no test framework:
 *
 *   node tests/fence-ask.test.mjs
 *
 * The wire half pins the message contracts without any filesystem:
 * create/serialize/parse round-trips deep-equal for both messages, and
 * every validation rejection class (bad JSON, non-object top level,
 * each field's type/bound/shape defects, uuid v4 strictness on ids,
 * absolute-path requirements, grant/deny/via pairing with cap
 * deny-only, session-dedup grant-only, and session-deny deny-only,
 * echo-field matching as the accident-and-mixup guard, honestly not
 * integrity against same-user processes, the constructor throwing on
 * programmer error while the parse path returns null), the locked
 * timing bounds (120s default wait, strict-digits env override,
 * GPS-calibrated poll spacing), the child provisioning env keys, the
 * grant-key derivation and the dual-form normalization contract, and
 * the forwarding layout helpers (segment encoding round-trip,
 * directory joins, uuid-keyed filenames refusing non-uuid ids, root
 * path safety).
 *
 * The ledger half pins the state machine the serving loop consumes:
 * token registration, identity provenance, release; admission
 * (unknown-token refusal, the outstanding slot, queue positions 1..3,
 * the Q5 cap ladder ending in denied-cap with the policy reason,
 * same-directory coalescing onto outstanding and queued hosts across
 * children without touching the cap ladder, the staleness bound
 * evicting zombie hosts with admit-time re-hosting so a kill -9 child
 * costs one wait bound, and denial memory denying a user-refused
 * directory from memory with no prompt and no cap slot); resolution
 * (approval recording per-child grants plus session-wide membership,
 * refusal denying every attached request with the user-deny reason
 * and recording the session's denial memory, queued ids refusing
 * resolution until promotion, unknown ids, queue promotion into the
 * outstanding slot); the parent-side staleness sweep and its
 * attachment semantics; the bound prompt provenance naming the
 * registry identity and the admitted directory; the four user
 * properties at the interface level - property 1 as
 * composeInheritedExtraRoots over the parent's own grants (four
 * sources in order, cross-source dedup, the Q4 conditional parent
 * cwd), property 2 as the wire shapes themselves, property 3 as
 * per-child scoping (a grant for child A invisible to child B's
 * checks and absent from child B's composed scope, and child B
 * attaching to child A's unanswered ask instead of riding it),
 * property 4 as the session-dedup grant with no user round-trip and
 * no duplicate records; the grant source dimension (parent-own vs
 * child-ask) with parent-own as the only inheritance source and the
 * ask-dedup index fed by every source; and the globalThis convergence
 * contract (one state object across calls, in-place reset keeping
 * reference identity).
 *
 * The unit 1-2 spawn-wiring surface pins the forwarding-root mint
 * (one root per parent process, carried on the shared ledger state so
 * the spawn site and the 1-3 serving loop converge, embedded session
 * id plus nonce, tmpdir-subtree placement so channel file I/O never
 * crosses a scope boundary, hostile session ids surviving as one
 * encoded segment), the child provisioning env fragment (the exact
 * two wire keys, uuid-validated token, normalized-root validation),
 * and the composed inherited roots serialized into the child env
 * value (delimiter join, empty-to-empty, Q4 parent cwd riding the
 * value, parent-own grants reaching the value).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
	ASK_FILE_SUFFIX,
	ASK_WAIT_ENV,
	CHILD_ASK_ROOT_ENV,
	CHILD_ASK_TOKEN_ENV,
	DEFAULT_ASK_WAIT_MS,
	MAX_PATH_LENGTH,
	POLL_INTERVAL_MS,
	RESPONSES_DIR_NAME,
	REQUESTS_DIR_NAME,
	askFileName,
	createForwardedAsk,
	createForwardedDecision,
	decisionMatchesRequest,
	encodePathSegment,
	expandGrantedRoot,
	forwardingRequestsDir,
	forwardingResponsesDir,
	grantScopeDirectory,
	isValidForwardedAsk,
	isValidForwardedDecision,
	isValidForwardingRoot,
	parseForwardedAsk,
	parseForwardedDecision,
	resolveAskWaitMs,
	childProvisioningEnv,
	serializeForwardedAsk,
	serializeForwardedDecision,
} from "../extensions/fence-ask/ask-wire.ts";
import {
	ASK_CAP_DENY_REASON,
	ASK_HOST_STALE_MS,
	ASK_OUTSTANDING_CAP,
	ASK_QUEUE_CAPACITY,
	ASK_SESSION_DEDUP_REASON,
	ASK_SESSION_DENY_REASON,
	ASK_USER_DENY_REASON,
	ASK_USER_GRANT_REASON,
	admitChildAsk,
	appliedSelfGrants,
	applyGrantToSelf,
	childIdentity,
	composeForwardingRootPath,
	composeInheritedExtraRoots,
	currentForwardingRoot,
	dropChildAsk,
	ensureForwardingRoot,
	inheritedExtraRootsEnvValue,
	expireStaleAsks,
	getFenceAskState,
	grantsForChild,
	hasGrantForChild,
	isLiveChild,
	isSessionGranted,
	outstandingAskForChild,
	parentGrantedDirectories,
	pendingAskCountForChild,
	pendingRequestLocation,
	promptProvenanceForRequest,
	recordParentGrant,
	releaseChild,
	resetFenceAskState,
	resolveChildAsk,
	registerLiveChild,
	sessionGrantedDirectories,
} from "../extensions/fence-ask/grant-ledger.ts";
import {
	askPromptTitle,
	childProvisioningFromEnv,
	createForwardingRootDirs,
	deleteAskFile,
	deleteDecisionFile,
	forwardOutOfScopeAsk,
	readForwardedDecision,
	requestIdsIn,
	serveForwardingRootTick,
	writeForwardedAsk,
	writeForwardedDecision,
} from "../extensions/fence-ask/ask-channel.ts";
import {
	SERVE_TICK_MS,
	childProxyHandler,
	configureForwardingServer,
	ensureForwardingServer,
	servingMaxAgeMs,
	stopForwardingServer,
} from "../extensions/fence-ask/serve.ts";

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

function checkDeep(label, actual, expected) {
	total++;
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failed++;
		console.log(`FAIL  ${label}`);
		console.log(`      expected: ${JSON.stringify(expected)}`);
		console.log(`      actual  : ${JSON.stringify(actual)}`);
	}
}

const fixtureDir = path.join(os.tmpdir(), "fence-ask-suite");
const dirIn = path.join(fixtureDir, "granted");
const dirOut = path.join(fixtureDir, "asked");

// --- wire: forwarded ask round-trip and validation -------------------

const askFields = {
	requestId: randomUUID(),
	childToken: randomUUID(),
	agentName: "worker-a",
	dispatchLabel: "FENCE-1-1 checkpoint",
	toolName: "read",
	resolvedPath: dirOut,
	reason: "resolves outside the session cwd, the temp directory, and every extra allowed root",
	askedAt: 1_000_000,
};
const ask = createForwardedAsk(askFields);
check("wire ask passes its own validator", isValidForwardedAsk(ask), true);
checkDeep("wire ask preserves every field", ask, askFields);
checkDeep(
	"wire ask round-trips serialize and parse",
	parseForwardedAsk(serializeForwardedAsk(ask)),
	ask,
);
check("wire parse rejects bad JSON", parseForwardedAsk("{nope"), null);
check("wire parse rejects non-object top level", parseForwardedAsk("[]"), null);
const askDefectCases = [
	["missing requestId", { ...askFields, requestId: undefined }],
	["non-uuid requestId", { ...askFields, requestId: "00000000-0000-0000-0000-000000000000" }],
	["non-uuid childToken", { ...askFields, childToken: randomUUID().toUpperCase() }],
	["empty agentName", { ...askFields, agentName: "" }],
	["oversized agentName", { ...askFields, agentName: "x".repeat(257) }],
	["missing dispatchLabel", { ...askFields, dispatchLabel: undefined }],
	["oversized toolName", { ...askFields, toolName: "x".repeat(129) }],
	["relative resolvedPath", { ...askFields, resolvedPath: "rel/dir" }],
	["oversized resolvedPath", { ...askFields, resolvedPath: `/${"x".repeat(MAX_PATH_LENGTH)}` }],
	["empty reason", { ...askFields, reason: "" }],
	["oversized reason", { ...askFields, reason: "x".repeat(4097) }],
	["zero askedAt", { ...askFields, askedAt: 0 }],
	["non-integer askedAt", { ...askFields, askedAt: 1.5 }],
	["string askedAt", { ...askFields, askedAt: "1000" }],
];
for (const [label, fields] of askDefectCases) {
	check(`wire parse rejects ${label}`, parseForwardedAsk(JSON.stringify(fields)), null);
	check(`wire validator rejects ${label}`, isValidForwardedAsk(fields), false);
}
let askThrewTypeError = false;
try {
	createForwardedAsk({ ...askFields, requestId: "not-a-uuid" });
} catch (error) {
	askThrewTypeError = error instanceof TypeError;
}
check("wire ask create throws TypeError on invalid fields", askThrewTypeError, true);

// --- wire: forwarded decision round-trip, validation, pairing --------

const decisionFields = {
	requestId: askFields.requestId,
	childToken: askFields.childToken,
	decision: "grant",
	grantedRoot: dirIn,
	via: "user",
	reason: ASK_USER_GRANT_REASON,
	decidedAt: 2_000_000,
};
const decision = createForwardedDecision(decisionFields);
check("wire decision passes its own validator", isValidForwardedDecision(decision), true);
checkDeep(
	"wire decision round-trips serialize and parse",
	parseForwardedDecision(serializeForwardedDecision(decision)),
	decision,
);
check("wire decision parse rejects bad JSON", parseForwardedDecision(""), null);
const decisionDefectCases = [
	["unknown decision kind", { ...decisionFields, decision: "maybe" }],
	["unknown via", { ...decisionFields, via: "luck" }],
	["cap via with a grant", { ...decisionFields, via: "cap" }],
	["session-dedup via with a deny", { ...decisionFields, decision: "deny" }],
	["session-deny via with a grant", { ...decisionFields, via: "session-deny" }],
	["grant without a granted root", { ...decisionFields, grantedRoot: null }],
	["grant with a relative root", { ...decisionFields, grantedRoot: "rel/dir" }],
	["deny carrying a granted root", { ...decisionFields, decision: "deny", grantedRoot: dirIn }],
	["deny without an explicit null root", { ...decisionFields, decision: "deny", grantedRoot: undefined }],
	["non-uuid echoed requestId", { ...decisionFields, requestId: "zzzzzzzz-zzzz-4zzz-yzzz-zzzzzzzzzzzz" }],
	["empty decision reason", { ...decisionFields, reason: "" }],
	["zero decidedAt", { ...decisionFields, decidedAt: 0 }],
];
for (const [label, fields] of decisionDefectCases) {
	check(`wire parse rejects ${label}`, parseForwardedDecision(JSON.stringify(fields)), null);
}
check(
	"wire accepts a user deny with an explicit null root",
	isValidForwardedDecision({ ...decisionFields, decision: "deny", grantedRoot: null, reason: ASK_USER_DENY_REASON }),
	true,
);
check(
	"wire accepts a cap deny",
	isValidForwardedDecision({ ...decisionFields, decision: "deny", grantedRoot: null, via: "cap", reason: "capped" }),
	true,
);
check(
	"wire accepts a session-dedup grant",
	isValidForwardedDecision({ ...decisionFields, via: "session-dedup", reason: ASK_SESSION_DEDUP_REASON }),
	true,
);
check(
	"wire accepts a session-deny deny",
	isValidForwardedDecision({
		...decisionFields,
		decision: "deny",
		grantedRoot: null,
		via: "session-deny",
		reason: ASK_SESSION_DENY_REASON,
	}),
	true,
);
check("echo matcher accepts the matching pair", decisionMatchesRequest(decision, decisionFields.requestId, decisionFields.childToken), true);
check("echo matcher refuses another request's decision", decisionMatchesRequest(decision, randomUUID(), decisionFields.childToken), false);
check("echo matcher refuses another child's decision", decisionMatchesRequest(decision, decisionFields.requestId, randomUUID()), false);
let decisionThrewTypeError = false;
try {
	createForwardedDecision({ ...decisionFields, via: "cap" });
} catch (error) {
	decisionThrewTypeError = error instanceof TypeError;
}
check("wire decision create throws TypeError on mispaired via", decisionThrewTypeError, true);

// --- wire: locked timing bounds, env keys, layout helpers ------------

check("wait bound default is the locked 120 seconds", DEFAULT_ASK_WAIT_MS, 120000);
check("wait override absent keeps the default", resolveAskWaitMs(undefined), DEFAULT_ASK_WAIT_MS);
check("wait override empty keeps the default", resolveAskWaitMs(""), DEFAULT_ASK_WAIT_MS);
check("wait override digits are honored", resolveAskWaitMs("30000"), 30000);
check("wait override zero keeps the default", resolveAskWaitMs("0"), DEFAULT_ASK_WAIT_MS);
check("wait override negative keeps the default", resolveAskWaitMs("-5"), DEFAULT_ASK_WAIT_MS);
check("wait override float keeps the default", resolveAskWaitMs("1.5"), DEFAULT_ASK_WAIT_MS);
check("wait override exponent keeps the default", resolveAskWaitMs("1e3"), DEFAULT_ASK_WAIT_MS);
check("wait override padded keeps the default", resolveAskWaitMs(" 5000"), DEFAULT_ASK_WAIT_MS);
check("wait override junk keeps the default", resolveAskWaitMs("soon"), DEFAULT_ASK_WAIT_MS);
check("poll spacing is the GPS-calibrated 250ms", POLL_INTERVAL_MS, 250);
check("child forwarding-root env key", CHILD_ASK_ROOT_ENV, "PISCOPE_ASK_FORWARDING_ROOT");
check("child spawn-token env key", CHILD_ASK_TOKEN_ENV, "PISCOPE_ASK_CHILD_TOKEN");
check("wait override env key", ASK_WAIT_ENV, "PISCOPE_ASK_WAIT_MS");
check("requests dir name", REQUESTS_DIR_NAME, "requests");
check("responses dir name", RESPONSES_DIR_NAME, "responses");
check("message file suffix", ASK_FILE_SUFFIX, ".json");
check("segment encoding keeps plain names", encodePathSegment("abc-123.def"), "abc-123.def");
checkContains("segment encoding escapes slashes", encodePathSegment("a/b"), "%2F");
check(
	"segment encoding round-trips through decode",
	decodeURIComponent(encodePathSegment("s p!a*c(e)")),
	"s p!a*c(e)",
);
check("requests dir joins the layout name", forwardingRequestsDir("/root"), "/root/requests");
check("responses dir joins the layout name", forwardingResponsesDir("/root"), "/root/responses");
check("ask file names the request id", askFileName(askFields.requestId), `${askFields.requestId}.json`);
check("ask file refuses a non-uuid id", askFileName("../escape"), null);
check("forwarding root accepts absolute normalized", isValidForwardingRoot("/tmp/fence-ask-root-1"), true);
check("forwarding root refuses relative", isValidForwardingRoot("rel/root"), false);
check("forwarding root refuses traversal", isValidForwardingRoot("/tmp/x/../root"), false);
check("forwarding root refuses empty", isValidForwardingRoot(""), false);
check("forwarding root refuses non-string", isValidForwardingRoot(undefined), false);

// --- advisor F2, review DC1, re-review 08 SEC-1/DC-1: form-aware
// grant-key derivation and normalization. A candidate that names or
// resolves to an existing directory keys ITSELF (grant exactly what
// was asked); a file-form candidate keys its parent directory; an
// unresolved write-ahead tail keys its deepest existing ancestor's
// parent directory; the root path keys itself and no branch derives
// above it.

checkDeep(
	"a file-path ask keys to its parent directory",
	grantScopeDirectory("/etc/passwd", "file", "/etc"),
	"/etc",
);
checkDeep(
	"a file-path ask with an unresolved dirname keys to the literal dirname",
	grantScopeDirectory("/realA/newfile", "unresolved", null),
	"/realA",
);
checkDeep(
	"a write-ahead tail keys to its not-yet-existing parent directory",
	grantScopeDirectory("/realA/newdir/newfile", "unresolved", null),
	"/realA/newdir",
);
checkDeep(
	"a resolvable dirname takes the realpath spelling past a lexical alias",
	grantScopeDirectory("/tmp/link/f", "file", "/private"),
	"/private",
);
checkDeep(
	"two lexical spellings of one physical directory converge on one grant key",
	grantScopeDirectory("/private/f", "file", "/private"),
	grantScopeDirectory("/tmp/link/f", "file", "/private"),
);
checkDeep(
	"a directory-form ask keys itself, never its parent",
	grantScopeDirectory("/opt/tools", "directory", "/opt/tools"),
	"/opt/tools",
);
checkDeep(
	"a directory-form ask whose realpath fails keys its literal self, never its parent",
	grantScopeDirectory("/opt/tools", "directory", null),
	"/opt/tools",
);
checkDeep(
	"a directory-form ask through a symlink keys its physical self",
	grantScopeDirectory("/alias-tools", "directory", "/opt/tools"),
	"/opt/tools",
);
checkDeep(
	"a directory-form ask with a trailing separator keys the directory itself, separator stripped",
	grantScopeDirectory("/opt/tools/", "directory", null),
	"/opt/tools",
);
checkDeep(
	"the root path keys itself",
	grantScopeDirectory("/", "directory", "/"),
	"/",
);
checkDeep(
	"the root path with a failed realpath keys itself, never above it",
	grantScopeDirectory("/", "directory", null),
	"/",
);
checkDeep(
	"an unresolved top-level candidate keys the root, never above it",
	grantScopeDirectory("/missing-top", "unresolved", "/"),
	"/",
);
checkDeep(
	"an unresolved top-level candidate with no resolved ancestor keys the literal root",
	grantScopeDirectory("/missing-top", "unresolved", null),
	"/",
);
let derivationThrewRelative = false;
try {
	grantScopeDirectory("rel/f", "file", null);
} catch (error) {
	derivationThrewRelative = error instanceof TypeError;
}
check("grantScopeDirectory throws on a relative candidate", derivationThrewRelative, true);
let derivationThrewRealpath = false;
try {
	grantScopeDirectory("/f", "file", "rel/real");
} catch (error) {
	derivationThrewRealpath = error instanceof TypeError;
}
check("grantScopeDirectory throws on a non-absolute realpath", derivationThrewRealpath, true);
let derivationThrewForm = false;
try {
	grantScopeDirectory("/f", "symlink", "/f");
} catch (error) {
	derivationThrewForm = error instanceof TypeError;
}
check("grantScopeDirectory throws on an unknown form", derivationThrewForm, true);
checkDeep(
	"a granted root with a failing realpath keeps its literal form alone",
	expandGrantedRoot("/tmp/new-root", null),
	["/tmp/new-root"],
);
checkDeep(
	"a granted root with a differing realpath expands to dual forms",
	expandGrantedRoot("/tmp/link", "/private/tmp-link"),
	["/tmp/link", "/private/tmp-link"],
);
checkDeep(
	"a granted root whose realpath matches collapses to one form",
	expandGrantedRoot("/real/root", "/real/root"),
	["/real/root"],
);
let expandThrewRelative = false;
try {
	expandGrantedRoot("rel/root", null);
} catch (error) {
	expandThrewRelative = error instanceof TypeError;
}
check("expandGrantedRoot throws on a relative root", expandThrewRelative, true);

// --- advisor F3: parent-side staleness bound --------------------------

resetFenceAskState();
const staleChild = randomUUID();
registerLiveChild(staleChild, "stale", "bound", 1000);
check("the stale bound defaults to the child wait bound", ASK_HOST_STALE_MS, DEFAULT_ASK_WAIT_MS);
const zombieDir = path.join(fixtureDir, "stale", "zombie");
const queuedBehindDir = path.join(fixtureDir, "stale", "queued");
const zombieReq = randomUUID();
const staleQueueReq = randomUUID();
admitChildAsk(zombieReq, staleChild, zombieDir, 1000);
check("the queue fills behind a stale-bound outstanding ask", admitChildAsk(staleQueueReq, staleChild, queuedBehindDir, 1100).position, 1);
const firstSweep = expireStaleAsks(1000 + DEFAULT_ASK_WAIT_MS, DEFAULT_ASK_WAIT_MS);
checkDeep("the sweep evicts the stale outstanding host", firstSweep, [zombieReq]);
check("the evicted zombie resolves unknown", resolveChildAsk(zombieReq, true, 1000 + DEFAULT_ASK_WAIT_MS).kind, "unknown");
check("the queue promotes into the vacated slot", outstandingAskForChild(staleChild)?.requestId, staleQueueReq);
check("a young queued ask survives the sweep", pendingAskCountForChild(staleChild), 1);
const secondSweep = expireStaleAsks(1100 + DEFAULT_ASK_WAIT_MS, DEFAULT_ASK_WAIT_MS);
checkDeep("a stale queued ask is evicted on a later sweep", secondSweep, [staleQueueReq]);
check("the emptied child carries no pending asks", pendingAskCountForChild(staleChild), 0);
check("resolution of a swept queued id resolves unknown", resolveChildAsk(staleQueueReq, true, 1100 + DEFAULT_ASK_WAIT_MS).kind, "unknown");

resetFenceAskState();
const attHost = randomUUID();
const attGuest = randomUUID();
registerLiveChild(attHost, "att-host", "sweep", 2000);
registerLiveChild(attGuest, "att-guest", "sweep", 2000);
const attDir = path.join(fixtureDir, "stale", "attached");
const attHostReq = randomUUID();
const attGuestReq = randomUUID();
admitChildAsk(attHostReq, attHost, attDir, 2000);
admitChildAsk(attGuestReq, attGuest, attDir, 2100);
const attachedSweep = expireStaleAsks(2000 + DEFAULT_ASK_WAIT_MS + 1, DEFAULT_ASK_WAIT_MS);
checkDeep("the sweep returns the evicted host and its coalesced attachments", attachedSweep, [attHostReq, attGuestReq]);
check("the attached host has no pending asks after the sweep", pendingAskCountForChild(attHost), 0);
check("the attached guest has no pending asks after the sweep", pendingAskCountForChild(attGuest), 0);

resetFenceAskState();
const killedChild = randomUUID();
const survivorChild = randomUUID();
registerLiveChild(killedChild, "killed", "kill-9", 3000);
registerLiveChild(survivorChild, "survivor", "kill-9", 3000);
const killDir = path.join(fixtureDir, "stale", "killed");
const zombieReq2 = randomUUID();
const freshReq = randomUUID();
admitChildAsk(zombieReq2, killedChild, killDir, 3000);
const rehostOutcome = admitChildAsk(freshReq, survivorChild, killDir, 3000 + DEFAULT_ASK_WAIT_MS + 1);
check("a stale directory's pending ask does not capture a new child", rehostOutcome.kind, "outstanding");
check("the re-hosted ask is the new child's own", outstandingAskForChild(survivorChild)?.requestId, freshReq);
check("the zombie resolves unknown after the admit-time eviction", resolveChildAsk(zombieReq2, true, 3000 + DEFAULT_ASK_WAIT_MS + 2).kind, "unknown");
check("the fresh ask carries its own admission time with no zombie tax", outstandingAskForChild(survivorChild)?.askedAt, 3000 + DEFAULT_ASK_WAIT_MS + 1);

resetFenceAskState();
const qHost = randomUUID();
const qFresh = randomUUID();
registerLiveChild(qHost, "q-host", "queue-rehost", 5000);
registerLiveChild(qFresh, "q-fresh", "queue-rehost", 5000);
const qSlotDir = path.join(fixtureDir, "stale", "q-slot");
const qStaleDir = path.join(fixtureDir, "stale", "q-stale");
const qSlotReq = randomUUID();
const qStaleReq = randomUUID();
admitChildAsk(qSlotReq, qHost, qSlotDir, 5000);
check("the queue takes the second directory", admitChildAsk(qStaleReq, qHost, qStaleDir, 5100).position, 1);
const qOutcome = admitChildAsk(randomUUID(), qFresh, qStaleDir, 5100 + DEFAULT_ASK_WAIT_MS + 1);
check("a stale queued host re-hosts the directory for a new ask", qOutcome.kind, "outstanding");
check("the stale queued entry left its holder's queue", pendingAskCountForChild(qHost), 1);

resetFenceAskState();
const liveHost = randomUUID();
const liveGuest = randomUUID();
registerLiveChild(liveHost, "live-host", "live", 4000);
registerLiveChild(liveGuest, "live-guest", "live", 4000);
const liveDir = path.join(fixtureDir, "stale", "live");
const liveHostReq = randomUUID();
admitChildAsk(liveHostReq, liveHost, liveDir, 4000);
checkDeep(
	"a live host still takes coalesced attachments",
	admitChildAsk(randomUUID(), liveGuest, liveDir, 4000 + DEFAULT_ASK_WAIT_MS - 1),
	{ kind: "coalesced", canonicalRequestId: liveHostReq },
);

// --- advisor F6: session denial memory --------------------------------

resetFenceAskState();
const denyChildA = randomUUID();
const denyChildB = randomUUID();
registerLiveChild(denyChildA, "deny-a", "denial", 1000);
registerLiveChild(denyChildB, "deny-b", "denial", 1000);
const deniedDir = path.join(fixtureDir, "denial", "denied");
const denyReqA = randomUUID();
const denyReqB = randomUUID();
admitChildAsk(denyReqA, denyChildA, deniedDir, 2000);
const denialRefusal = resolveChildAsk(denyReqA, false, 3000);
check("the refusal itself resolves as a user deny", denialRefusal.kind, "resolved");
check("a user refusal records session denial memory", getFenceAskState().sessionWideDenied.has(deniedDir), true);
const denyRecord = getFenceAskState().sessionWideDenied.get(deniedDir);
check("the denial record stamps the parent clock", denyRecord?.deniedAt, 3000);
check("the denial record carries the user provenance", denyRecord?.via, "user");
const reAskOutcome = admitChildAsk(denyReqB, denyChildB, deniedDir, 4000);
check("a denied directory's re-ask is denied from session memory", reAskOutcome.kind, "denied-dedup");
check("the deny-dedup decision denies", reAskOutcome.decision.decision, "deny");
check("the deny-dedup decision carries the session-deny provenance", reAskOutcome.decision.via, "session-deny");
check("the deny-dedup decision carries no granted root", reAskOutcome.decision.grantedRoot, null);
check("the deny-dedup decision echoes its own request id", reAskOutcome.decision.requestId, denyReqB);
check("the deny-dedup reason names the earlier refusal", reAskOutcome.decision.reason, ASK_SESSION_DENY_REASON);
check("the deny-dedup decision stamps the parent clock", reAskOutcome.decision.decidedAt, 4000);
check("the deny-dedup outcome consumes no cap slots", pendingAskCountForChild(denyChildB), 0);
check("the deny-dedup records no grant rows", hasGrantForChild(denyChildB, deniedDir), false);
check("repeated asks for a denied directory keep denying without prompts", admitChildAsk(randomUUID(), denyChildB, deniedDir, 4100).kind, "denied-dedup");
check("the originally denied child's re-ask dedups too", admitChildAsk(randomUUID(), denyChildA, deniedDir, 4200).kind, "denied-dedup");

resetFenceAskState();
const flipChildA = randomUUID();
const flipChildB = randomUUID();
registerLiveChild(flipChildA, "flip-a", "precedence", 1000);
registerLiveChild(flipChildB, "flip-b", "precedence", 1000);
const flippedDir = path.join(fixtureDir, "denial", "flipped");
const flipReqA = randomUUID();
admitChildAsk(flipReqA, flipChildA, flippedDir, 5000);
resolveChildAsk(flipReqA, false, 5100);
recordParentGrant(flippedDir, 5200);
const flippedAsk = admitChildAsk(randomUUID(), flipChildB, flippedDir, 5300);
check("a parent-own grant after a denial rules the directory granted", flippedAsk.kind, "granted-dedup");

resetFenceAskState();
const capDenyChild = randomUUID();
registerLiveChild(capDenyChild, "cap-deny", "denial", 6000);
const capBaseDir = path.join(fixtureDir, "denial", "cap-base");
const capExtraDir = path.join(fixtureDir, "denial", "cap-extra");
admitChildAsk(randomUUID(), capDenyChild, capBaseDir, 6000);
admitChildAsk(randomUUID(), capDenyChild, path.join(fixtureDir, "denial", "cap-q1"), 6000);
admitChildAsk(randomUUID(), capDenyChild, path.join(fixtureDir, "denial", "cap-q2"), 6000);
admitChildAsk(randomUUID(), capDenyChild, path.join(fixtureDir, "denial", "cap-q3"), 6000);
const capRejection = admitChildAsk(randomUUID(), capDenyChild, capExtraDir, 6000);
check("the cap ladder still denies the fifth distinct directory", capRejection.kind, "denied-cap");
check("a cap denial records no session denial memory", getFenceAskState().sessionWideDenied.has(capExtraDir), false);

// --- advisor F5: prompt provenance binds to the registry --------------

resetFenceAskState();
const provChild = randomUUID();
const provGuest = randomUUID();
registerLiveChild(provChild, "registry-agent", "registry-label", 1000);
registerLiveChild(provGuest, "guest-agent", "guest-label", 1000);
const provDir = path.join(fixtureDir, "provenance", "hosted");
const provQueueDir = path.join(fixtureDir, "provenance", "queued");
const provReq = randomUUID();
const provGuestReq = randomUUID();
const provQueueReq = randomUUID();
admitChildAsk(provReq, provChild, provDir, 2000);
checkDeep(
	"the outstanding ask's provenance names the registry identity and the admitted directory",
	promptProvenanceForRequest(provReq),
	{ requestId: provReq, childToken: provChild, agentName: "registry-agent", dispatchLabel: "registry-label", directory: provDir },
);
admitChildAsk(provGuestReq, provGuest, provDir, 2100);
checkDeep(
	"a coalesced attachment's provenance names its own child under the host directory",
	promptProvenanceForRequest(provGuestReq),
	{ requestId: provGuestReq, childToken: provGuest, agentName: "guest-agent", dispatchLabel: "guest-label", directory: provDir },
);
admitChildAsk(provQueueReq, provChild, provQueueDir, 2200);
checkDeep(
	"a queued ask's provenance resolves from the registry and ledger",
	promptProvenanceForRequest(provQueueReq),
	{ requestId: provQueueReq, childToken: provChild, agentName: "registry-agent", dispatchLabel: "registry-label", directory: provQueueDir },
);
check("an unknown request id has no provenance", promptProvenanceForRequest(randomUUID()), null);

// --- ledger: token registration, identity, release -------------------

resetFenceAskState();
const tokenA = randomUUID();
const tokenB = randomUUID();
const tokenGhost = randomUUID();
check("unregistered token is not live", isLiveChild(tokenA), false);
check(
	"ask from an unregistered token is refused",
	admitChildAsk(randomUUID(), tokenGhost, dirIn, 1000).kind,
	"refused-unknown-child",
);
registerLiveChild(tokenA, "worker-a", "label-a", 1000);
registerLiveChild(tokenB, "worker-b", "label-b", 1001);
check("registered token is live", isLiveChild(tokenA), true);
checkDeep(
	"identity carries the spawn provenance",
	childIdentity(tokenA),
	{ agentName: "worker-a", dispatchLabel: "label-a", issuedAt: 1000 },
);
check("unknown token has no identity", childIdentity(tokenGhost), undefined);
releaseChild(tokenB);
check("released token is not live", isLiveChild(tokenB), false);

// --- ledger: the locked spam-cap ladder (sign-off Q5) ----------------

resetFenceAskState();
const capChild = randomUUID();
const capOther = randomUUID();
registerLiveChild(capChild, "worker", "cap", 1000);
registerLiveChild(capOther, "other", "cap", 1000);
const capDirs = [1, 2, 3, 4, 5].map((index) => path.join(fixtureDir, "cap", String(index)));
const capReqs = [1, 2, 3, 4, 5].map(() => randomUUID());
const capNow = 2000;
check("locked outstanding cap constant", ASK_OUTSTANDING_CAP, 1);
check("locked queue capacity constant", ASK_QUEUE_CAPACITY, 3);
check("first ask fills the outstanding slot", admitChildAsk(capReqs[0], capChild, capDirs[0], capNow).kind, "outstanding");
check("outstanding ask is visible to the serving loop", outstandingAskForChild(capChild)?.requestId, capReqs[0]);
check("second distinct directory queues at position 1", admitChildAsk(capReqs[1], capChild, capDirs[1], capNow).position, 1);
check("third distinct directory queues at position 2", admitChildAsk(capReqs[2], capChild, capDirs[2], capNow).position, 2);
check("fourth distinct directory queues at position 3", admitChildAsk(capReqs[3], capChild, capDirs[3], capNow).position, 3);
const capOutcome = admitChildAsk(capReqs[4], capChild, capDirs[4], capNow + 10);
check("fifth distinct directory is denied by the cap", capOutcome.kind, "denied-cap");
check("cap denial echoes its own request id", capOutcome.decision.requestId, capReqs[4]);
check("cap denial is a deny", capOutcome.decision.decision, "deny");
check("cap denial carries no granted root", capOutcome.decision.grantedRoot, null);
check("cap denial records cap provenance", capOutcome.decision.via, "cap");
check("cap denial carries the policy reason", capOutcome.decision.reason, ASK_CAP_DENY_REASON);
checkContains("cap denial reason names the outstanding cap", ASK_CAP_DENY_REASON, "1 outstanding ask");
checkContains("cap denial reason names the queue capacity", ASK_CAP_DENY_REASON, "3-ask queue");
check("cap denial stamps the parent clock", capOutcome.decision.decidedAt, capNow + 10);
check("cap denies before any prompt so nothing was granted", isSessionGranted(capDirs[4]), false);
check(
	"pending count carries the outstanding ask plus the full queue",
	pendingAskCountForChild(capChild),
	4,
);
checkDeep(
	"same-directory ask coalesces onto the outstanding host",
	admitChildAsk(randomUUID(), capOther, capDirs[0], capNow + 20),
	{ kind: "coalesced", canonicalRequestId: capReqs[0] },
);
checkDeep(
	"ask for a queued directory coalesces onto the queued host",
	admitChildAsk(randomUUID(), capOther, capDirs[2], capNow + 30),
	{ kind: "coalesced", canonicalRequestId: capReqs[2] },
);
check("coalescing leaves the cap ladder untouched", pendingAskCountForChild(capChild), 4);
check("coalesced attachments create no pending asks of their own", pendingAskCountForChild(capOther), 0);

// --- ledger: resolution semantics ------------------------------------

resetFenceAskState();
const hostChild = randomUUID();
const guestChild = randomUUID();
registerLiveChild(hostChild, "host", "resolve", 1000);
registerLiveChild(guestChild, "guest", "resolve", 1000);
const sharedDir = path.join(fixtureDir, "resolve", "shared");
const soloDir = path.join(fixtureDir, "resolve", "solo");
const tailDir = path.join(fixtureDir, "resolve", "tail");
const hostReqs = { shared: randomUUID(), solo: randomUUID(), tail: randomUUID(), extra: randomUUID() };
const guestReqs = { shared: randomUUID() };
const resolveAt = 3000;
check("host ask fills the outstanding slot", admitChildAsk(hostReqs.shared, hostChild, sharedDir, 2900).kind, "outstanding");
checkDeep(
	"guest asking the same pending directory attaches instead of prompting",
	admitChildAsk(guestReqs.shared, guestChild, sharedDir, 2950),
	{ kind: "coalesced", canonicalRequestId: hostReqs.shared },
);
const approvedShared = resolveChildAsk(hostReqs.shared, true, resolveAt);
check("approval resolves the outstanding ask", approvedShared.kind, "resolved");
check("approval records the grant session-wide", isSessionGranted(sharedDir), true);
check("approval records the grant for the host child", hasGrantForChild(hostChild, sharedDir), true);
check(
	"approval records the grant for the coalesced child too",
	hasGrantForChild(guestChild, sharedDir),
	true,
);
check(
	"resolved decisions answer every attached request id in order",
	approvedShared.decisions.map((entry) => entry.requestId).join(","),
	[hostReqs.shared, guestReqs.shared].join(","),
);
check(
	"every resolved decision grants the same directory via user",
	approvedShared.decisions.every(
		(entry) =>
			entry.decision === "grant" &&
			entry.grantedRoot === sharedDir &&
			entry.via === "user" &&
			entry.reason === ASK_USER_GRANT_REASON &&
			entry.decidedAt === resolveAt,
	),
	true,
);
check("grant records cover exactly the two involved children", approvedShared.grants.length, 2);
check("host slot empties with no queue behind it", outstandingAskForChild(hostChild), null);
checkDeep(
	"next ask after resolution fills the outstanding slot again",
	admitChildAsk(hostReqs.solo, hostChild, soloDir, resolveAt + 10),
	{ kind: "outstanding" },
);
checkDeep(
	"the ask after that queues behind it",
	admitChildAsk(hostReqs.tail, hostChild, tailDir, resolveAt + 20),
	{ kind: "queued", position: 1 },
);
const refusedSolo = resolveChildAsk(hostReqs.solo, false, resolveAt + 30);
check("refusal resolves the outstanding ask", refusedSolo.kind, "resolved");
check("refusal grants nothing session-wide", isSessionGranted(soloDir), false);
check(
	"refusal resolves only the answered request",
	refusedSolo.decisions.map((entry) => entry.requestId).join(","),
	hostReqs.solo,
);
check(
	"refusal carries the user-deny reason with a null root",
	refusedSolo.decisions.every(
		(entry) => entry.decision === "deny" && entry.grantedRoot === null && entry.reason === ASK_USER_DENY_REASON,
	),
	true,
);
check("refusal records no grant rows", refusedSolo.grants.length, 0);
check("queued ask promotes into the outstanding slot after resolution", outstandingAskForChild(hostChild)?.requestId, hostReqs.tail);
check("pending count drops to the promoted ask", pendingAskCountForChild(hostChild), 1);
checkDeep(
	"ask after promotion queues behind the promoted ask",
	admitChildAsk(hostReqs.extra, hostChild, path.join(fixtureDir, "resolve", "extra"), resolveAt + 40),
	{ kind: "queued", position: 1 },
);
check("a queued id cannot be resolved before its promotion", resolveChildAsk(hostReqs.extra, true, resolveAt + 50).kind, "not-outstanding");
check("resolution of a never-admitted id resolves unknown", resolveChildAsk(randomUUID(), true, resolveAt + 60).kind, "unknown");
const promoted = resolveChildAsk(hostReqs.tail, true, resolveAt + 70);
check("the promoted ask itself resolves", promoted.kind, "resolved");
check("the promoted ask's approval grants its own directory", isSessionGranted(tailDir), true);
check("resolution of an unknown id resolves unknown", resolveChildAsk(randomUUID(), true, resolveAt + 80).kind, "unknown");
check("resolution of an already-resolved id resolves unknown", resolveChildAsk(hostReqs.shared, true, resolveAt + 90).kind, "unknown");

// --- ledger: property 3 (per-child scoping) and property 4 (dedup) ---

resetFenceAskState();
const childA = randomUUID();
const childB = randomUUID();
registerLiveChild(childA, "agent-a", "props", 1000);
registerLiveChild(childB, "agent-b", "props", 1000);
const propX = path.join(fixtureDir, "props", "x");
const propY = path.join(fixtureDir, "props", "y");
const propA1 = randomUUID();
const propB1 = randomUUID();
const propB2 = randomUUID();
const propA2 = randomUUID();
const propB3 = randomUUID();
admitChildAsk(propA1, childA, propX, 4000);
resolveChildAsk(propA1, true, 4000 + 1000);
check("property 3: the asking child holds its grant", hasGrantForChild(childA, propX), true);
check("property 3: a grant for child A is invisible to child B's checks", hasGrantForChild(childB, propX), false);
const dedupOutcome = admitChildAsk(propB1, childB, propX, 5000);
check("property 4: child B's ask for the granted directory skips the user round-trip", dedupOutcome.kind, "granted-dedup");
check("property 4: the dedup decision grants the directory", dedupOutcome.decision.grantedRoot, propX);
check("property 4: the dedup decision records session-dedup provenance", dedupOutcome.decision.via, "session-dedup");
check("property 4: the dedup decision carries the dedup reason", dedupOutcome.decision.reason, ASK_SESSION_DEDUP_REASON);
check("property 4: the dedup decision echoes child B's own request id", dedupOutcome.decision.requestId, propB1);
check("property 4: the dedup grant leaves child B with no pending asks", pendingAskCountForChild(childB), 0);
check("property 4: the dedup grant is recorded for child B", hasGrantForChild(childB, propX), true);
check("re-asking the granted directory dedups again", admitChildAsk(propB2, childB, propX, 5100).kind, "granted-dedup");
check("repeated dedup creates no duplicate grant records", grantsForChild(childB).length, 1);
admitChildAsk(propA2, childA, propY, 5200);
check(
	"property 3: child B attaches to child A's unanswered ask instead of riding it",
	admitChildAsk(propB3, childB, propY, 5300).kind,
	"coalesced",
);
check("property 3: coalescing grants nothing before the user answers", hasGrantForChild(childB, propY), false);
check("property 3: the unanswered directory is not session-granted", isSessionGranted(propY), false);
resolveChildAsk(propA2, true, 5400);
check(
	"the user's answer on the coalesced host records child B's grant",
	hasGrantForChild(childB, propY),
	true,
);
checkDeep(
	"session grant set carries both directories in grant order",
	sessionGrantedDirectories(),
	[propX, propY],
);
checkDeep(
	"grantsForChild lists only the child's own directories in grant order",
	grantsForChild(childB),
	[propX, propY],
);

// --- ledger: release keeps the session memory (sign-off Q3) ----------

const releaseReq = randomUUID();
const releaseGuest = randomUUID();
const releaseGuestReq = randomUUID();
const releaseDir = path.join(fixtureDir, "props", "release");
registerLiveChild(releaseGuest, "guest", "release", 6000);
admitChildAsk(releaseReq, childA, releaseDir, 6000);
admitChildAsk(releaseGuestReq, releaseGuest, releaseDir, 6050);
releaseChild(childA);
check("release drops the child's pending asks", pendingAskCountForChild(childA), 0);
check("resolution of a released child's ask resolves unknown", resolveChildAsk(releaseReq, true, 6100).kind, "unknown");
check(
	"coalesced attachments die with their released host",
	resolveChildAsk(releaseGuestReq, true, 6150).kind,
	"unknown",
);
check("release does not admit further asks from the token", admitChildAsk(randomUUID(), childA, releaseDir, 6200).kind, "refused-unknown-child");
check("session memory survives release: the child's grants stay", hasGrantForChild(childA, propX), true);
check("session memory survives release: the dedup index stays", isSessionGranted(propX), true);

// --- advisor F1: grant source dimension, parent-own composition ------

resetFenceAskState();
const srcA = randomUUID();
const srcB = randomUUID();
const srcDedup = randomUUID();
registerLiveChild(srcA, "agent-a", "source", 1000);
registerLiveChild(srcB, "agent-b", "source", 1000);
registerLiveChild(srcDedup, "agent-d", "source", 1000);
const childGrantDir = path.join(fixtureDir, "source", "child-ask");
const parentGrantDir = path.join(fixtureDir, "source", "parent-own");
const srcReqA = randomUUID();
admitChildAsk(srcReqA, srcA, childGrantDir, 2000);
const srcApproval = resolveChildAsk(srcReqA, true, 3000);
check("a child-ask approval records the child-ask source", srcApproval.grants[0]?.source, "child-ask");
check(
	"a child-ask grant is invisible to the parent-own inheritance source",
	parentGrantedDirectories().includes(childGrantDir),
	false,
);
checkDeep(
	"property 3: a fresh child's composed scope excludes child A's child-ask grant",
	composeInheritedExtraRoots({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/parent",
	}),
	[],
);
const dedupOutcomeB = admitChildAsk(randomUUID(), srcB, childGrantDir, 4000);
check(
	"property 4: child B's ask for the child-granted directory still resolves granted-dedup",
	dedupOutcomeB.kind,
	"granted-dedup",
);
admitChildAsk(randomUUID(), srcDedup, childGrantDir, 4500);
check(
	"the session-dedup grant records the child-ask source",
	getFenceAskState().grantsByChild.get(srcDedup)?.[0]?.source,
	"child-ask",
);
const parentRecord = recordParentGrant(parentGrantDir, 5000);
checkDeep(
	"a parent-own grant records the full provenance",
	parentRecord,
	{ childToken: "", directory: parentGrantDir, grantedAt: 5000, via: "user", source: "parent-own" },
);
check("a parent-own grant feeds the ask-dedup index", isSessionGranted(parentGrantDir), true);
checkDeep("the parent-own inheritance source lists the directory", parentGrantedDirectories(), [parentGrantDir]);
const repeatedParentRecord = recordParentGrant(parentGrantDir, 6000);
check("re-recording a parent-own grant returns the first record", repeatedParentRecord.grantedAt, 5000);
check("re-recording a parent-own grant keeps one row", parentGrantedDirectories().length, 1);
const dedupForParentDir = admitChildAsk(randomUUID(), srcB, parentGrantDir, 7000);
check("a child's ask for a parent-granted directory dedups without a prompt", dedupForParentDir.kind, "granted-dedup");
checkDeep(
	"property 1: a parent-own grant composes into a later child's scope",
	composeInheritedExtraRoots({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/child",
	}),
	[parentGrantDir, "/work/parent"],
);

// --- property 1: composeInheritedExtraRoots (inheritance composition) -

const staticInput = {
	configRoots: ["/cfg/a", "/cfg/shared"],
	overlayRoots: ["/overlay/b"],
	envRoots: ["/env/c", "/cfg/shared"],
	parentGrantRoots: ["/parent-own/d", "/env/c"],
};
checkDeep(
	"composition unions the four sources in order",
	composeInheritedExtraRoots({ ...staticInput, parentSessionCwd: "/work/parent", dispatchCwd: "/work/parent" }),
	["/cfg/a", "/cfg/shared", "/overlay/b", "/env/c", "/parent-own/d"],
);
checkDeep(
	"composition appends the parent session cwd when the dispatch cwd differs (Q4)",
	composeInheritedExtraRoots({ ...staticInput, parentSessionCwd: "/work/parent", dispatchCwd: "/work/child" }),
	["/cfg/a", "/cfg/shared", "/overlay/b", "/env/c", "/parent-own/d", "/work/parent"],
);
checkDeep(
	"composition with empty grants is the static scope",
	composeInheritedExtraRoots({
		configRoots: ["/cfg/a"],
		overlayRoots: [],
		envRoots: ["/env/c"],
		parentGrantRoots: [],
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/child",
	}),
	["/cfg/a", "/env/c", "/work/parent"],
);
checkDeep(
	"composition skips empty entries from every source",
	composeInheritedExtraRoots({
		configRoots: [""],
		overlayRoots: [],
		envRoots: ["/env/c", ""],
		parentGrantRoots: [""],
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/parent",
	}),
	["/env/c"],
);
checkDeep(
	"composition with no sources and matching cwds is empty",
	composeInheritedExtraRoots({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: [],
		parentSessionCwd: "/work/same",
		dispatchCwd: "/work/same",
	}),
	[],
);

// --- unit 1-2: forwarding-root mint on the shared state --------------
// One root per parent process, minted by the spawn site (the producer)
// and read by the serving loop (the 1-3 consumer) through the same
// globalThis state as the grants. The mint does no I/O: creating the
// root with mode 0700 stays the 1-3 consumer obligation.

resetFenceAskState();
check("no forwarding root exists before the first mint", currentForwardingRoot(), null);
const mintedSession = "session id with spaces/and:colons";
const minted = ensureForwardingRoot(mintedSession, "nonce-1");
check("the minted root is stored on the shared state", currentForwardingRoot(), minted);
check(
	"re-minting with a different nonce returns the stored root",
	ensureForwardingRoot(mintedSession, "nonce-2"),
	minted,
);
checkDeep(
	"the minted root composes from the session id and the first nonce",
	minted,
	composeForwardingRootPath(mintedSession, "nonce-1", os.tmpdir()),
);
checkContains("the minted root embeds the encoded session id", minted, encodePathSegment(mintedSession));
checkContains("the minted root embeds the nonce", minted, "nonce-1");
check(
	"the minted root stays inside the tmpdir subtree",
	minted.startsWith(os.tmpdir() + path.sep),
	true,
);
check(
	"a hostile session id survives as one encoded path segment under the base",
	path.dirname(composeForwardingRootPath("../../etc-hostile", "n", "/base")),
	"/base",
);
check(
	"composition is deterministic per inputs",
	composeForwardingRootPath("s", "n", "/base"),
	composeForwardingRootPath("s", "n", "/base"),
);
check(
	"different session ids mint different roots",
	composeForwardingRootPath("s1", "n", "/base") !== composeForwardingRootPath("s2", "n", "/base"),
	true,
);
resetFenceAskState();
check("reset clears the minted root", currentForwardingRoot(), null);
checkContains(
	"a different session mints a different root",
	ensureForwardingRoot("other-session", "nonce-3"),
	"other-session",
);
resetFenceAskState();

// --- unit 1-2: child provisioning env fragment ------------------------

resetFenceAskState();
const provisioningToken = randomUUID();
const provisioningRoot = composeForwardingRootPath("prov-session", "prov-nonce", os.tmpdir());
checkDeep(
	"child provisioning env carries exactly the wire's root and token keys",
	childProvisioningEnv({ childToken: provisioningToken, forwardingRoot: provisioningRoot }),
	{ [CHILD_ASK_ROOT_ENV]: provisioningRoot, [CHILD_ASK_TOKEN_ENV]: provisioningToken },
);
let provisioningTokenThrew = false;
try {
	childProvisioningEnv({ childToken: "not-a-uuid", forwardingRoot: provisioningRoot });
} catch {
	provisioningTokenThrew = true;
}
check("child provisioning refuses a non-uuid token", provisioningTokenThrew, true);
let provisioningRootThrew = false;
try {
	childProvisioningEnv({ childToken: provisioningToken, forwardingRoot: "relative/root" });
} catch {
	provisioningRootThrew = true;
}
check("child provisioning refuses a relative forwarding root", provisioningRootThrew, true);
let provisioningTraversalThrew = false;
try {
	childProvisioningEnv({ childToken: provisioningToken, forwardingRoot: "/tmp/x/../root" });
} catch {
	provisioningTraversalThrew = true;
}
check("child provisioning refuses a traversal-carrying root", provisioningTraversalThrew, true);

// --- unit 1-2: composed inherited roots as the child env value --------

checkDeep(
	"the env value joins the composed union with the env delimiter",
	inheritedExtraRootsEnvValue({
		configRoots: ["/cfg/a"],
		overlayRoots: ["/overlay/b"],
		envRoots: ["/env/c"],
		parentGrantRoots: ["/grants/d"],
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/parent",
	}),
	["/cfg/a", "/overlay/b", "/env/c", "/grants/d"].join(path.delimiter),
);
check(
	"composition with no sources serializes to the empty value",
	inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: [],
		parentSessionCwd: "/work/same",
		dispatchCwd: "/work/same",
	}),
	"",
);
check(
	"the Q4 parent cwd rides the env value when the dispatch cwd differs",
	inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: [],
		parentSessionCwd: "/work/parent",
		dispatchCwd: "/work/child",
	}).includes("/work/parent"),
	true,
);
resetFenceAskState();
const envGrantDir = "/env-value-probe/granted";
recordParentGrant(envGrantDir, 1000);
check(
	"a parent-own grant reaches the child env value",
	inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: "/p",
		dispatchCwd: "/p",
	}).includes(envGrantDir),
	true,
);
resetFenceAskState();

// --- ledger: globalThis convergence ----------------------------------

resetFenceAskState();
const sharedState = getFenceAskState();
check("repeated accessor calls return one state object", getFenceAskState(), sharedState);
registerLiveChild(randomUUID(), "convergence", "probe", 7000);
resetFenceAskState();
check("reset keeps the state reference identity", getFenceAskState(), sharedState);
check("reset empties the live-children map", sharedState.liveChildren.size, 0);
check("reset empties the session-wide map", sharedState.sessionWideGranted.size, 0);
check("reset empties the grants map", sharedState.grantsByChild.size, 0);
check("reset empties the pending map", sharedState.pendingByChild.size, 0);
check("reset empties the parent-own grants", sharedState.parentOwnGrants.length, 0);
check("reset empties the session denial map", sharedState.sessionWideDenied.size, 0);
check("reset clears the forwarding root", sharedState.forwardingRoot, null);
check("reset empties the applied self grants", sharedState.appliedSelfGrants.length, 0);

// --- unit 1-3: the child-side applied self-grant set ----------------
// The forward branch of a dispatched child applies an approved grant
// to THIS process's fence verdicts through applyGrantToSelf, which
// stores the expandGrantedRoot dual forms on the shared state so the
// factory's per-call allowed-roots build can concat them. Proxy flows
// (a middle serving its own root) never call it: a proxy grant binds
// the grandchild, never the middle's own verdicts.

resetFenceAskState();
check("applied self grants start empty", appliedSelfGrants().length, 0);
checkDeep(
	"applyGrantToSelf stores the dual forms of a synonym-granted root",
	applyGrantToSelf("/tmp/fence-ask-suite/granted", "/real/granted"),
	["/tmp/fence-ask-suite/granted", "/real/granted"],
);
checkDeep(
	"appliedSelfGrants exposes the stored dual forms",
	appliedSelfGrants(),
	["/tmp/fence-ask-suite/granted", "/real/granted"],
);
checkDeep(
	"applyGrantToSelf with a null realpath stores the literal only",
	applyGrantToSelf("/tmp/fence-ask-suite/asked", null),
	["/tmp/fence-ask-suite/asked"],
);
checkDeep(
	"applyGrantToSelf with the realpath equal to the literal stores no synonym",
	applyGrantToSelf("/tmp/fence-ask-suite/granted", "/tmp/fence-ask-suite/granted"),
	["/tmp/fence-ask-suite/granted"],
);
checkDeep(
	"re-applying an already-applied root adds nothing",
	appliedSelfGrants(),
	["/tmp/fence-ask-suite/granted", "/real/granted", "/tmp/fence-ask-suite/asked"],
);

// --- unit 1-3: pendingRequestLocation and the proxy-timeout drop -------
// The serving tick must know whether a request file's id already has a
// ledger entry, because a promoted queue entry re-appears in requests/
// with the same id and must be prompted, not re-admitted onto itself;
// and a proxy whose up-chain wait expired must evict the local entry
// WITHOUT deny memory, because no authority ruled (the asker's own
// wait bound then expires and the asker fails closed).

resetFenceAskState();
const dropHostToken = randomUUID();
const dropAttToken = randomUUID();
const dropLaterToken = randomUUID();
const dropQToken = randomUUID();
registerLiveChild(dropHostToken, "host", "host dispatch", 10_000);
registerLiveChild(dropAttToken, "attachment", "attachment dispatch", 10_000);
registerLiveChild(dropLaterToken, "later", "later dispatch", 10_000);
registerLiveChild(dropQToken, "qchild", "q dispatch", 10_000);
const dropHostId = randomUUID();
const dropAttId = randomUUID();
const dropQueuedId = randomUUID();
const dropLaterId = randomUUID();
const dropQOutId = randomUUID();
const dropQQueuedId = randomUUID();
check("pendingRequestLocation is null for an unknown id", pendingRequestLocation(dropHostId), null);
check(
	"admit of the first ask lands it in the outstanding slot",
	admitChildAsk(dropHostId, dropHostToken, "/opt/tools-a", 10_001).kind,
	"outstanding",
);
check(
	"a same-directory ask from another child coalesces onto the host",
	admitChildAsk(dropAttId, dropAttToken, "/opt/tools-a", 10_002).kind,
	"coalesced",
);
check(
	"the host child's second distinct directory queues behind its slot",
	admitChildAsk(dropQueuedId, dropHostToken, "/opt/tools-b", 10_003).kind,
	"queued",
);
check(
	"another child's ask for the queued directory coalesces onto it",
	admitChildAsk(dropLaterId, dropLaterToken, "/opt/tools-b", 10_004).kind,
	"coalesced",
);
check(
	"an unrelated child's first ask takes its own outstanding slot",
	admitChildAsk(dropQOutId, dropQToken, "/opt/tools-c", 10_005).kind,
	"outstanding",
);
check(
	"that child's second distinct directory queues too",
	admitChildAsk(dropQQueuedId, dropQToken, "/opt/tools-e", 10_006).kind,
	"queued",
);
check("pendingRequestLocation names the outstanding host", pendingRequestLocation(dropHostId), "outstanding");
check(
	"pendingRequestLocation names an outstanding attachment coalesced",
	pendingRequestLocation(dropAttId),
	"coalesced",
);
check("pendingRequestLocation names a queued entry", pendingRequestLocation(dropQueuedId), "queued");
check("pendingRequestLocation names a queued attachment coalesced", pendingRequestLocation(dropLaterId), "coalesced");
checkDeep(
	"dropping the outstanding host evicts it and its attachments in order",
	dropChildAsk(dropHostId),
	[dropHostId, dropAttId],
);
check("a dropped host id resolves unknown", resolveChildAsk(dropHostId, true).kind, "unknown");
check("a dropped attachment id resolves unknown", resolveChildAsk(dropAttId, true).kind, "unknown");
check(
	"the drop records no grant for the host child",
	hasGrantForChild(dropHostToken, "/opt/tools-a"),
	false,
);
check(
	"a re-ask of the dropped directory passes the dedup checks and queues instead of denying from memory",
	admitChildAsk(randomUUID(), dropHostToken, "/opt/tools-a", 10_007).kind,
	"queued",
);
check(
	"the host child's queue promoted into the vacated outstanding slot",
	pendingRequestLocation(dropQueuedId),
	"outstanding",
);
check("dropping an unknown id returns no evictions", dropChildAsk(randomUUID()).length, 0);
checkDeep(
	"dropping a promoted host by its attachment id evicts host and attachments",
	dropChildAsk(dropLaterId),
	[dropQueuedId, dropLaterId],
);
check("the dropped promoted id has no ledger location", pendingRequestLocation(dropQueuedId), null);
checkDeep(
	"dropping a still-queued id evicts just it",
	dropChildAsk(dropQQueuedId),
	[dropQQueuedId],
);
check("the dropped queued id has no ledger location", pendingRequestLocation(dropQQueuedId), null);
check(
	"the sibling outstanding slot survives a queue drop",
	pendingRequestLocation(dropQOutId),
	"outstanding",
);
resetFenceAskState();

// --- unit 1-3: the ask-forwarding channel, file primitives ----------
// ask-channel.ts is the fs-bearing half: the forwarding directory
// creation at the locked 0700 mode (the F4 consumer obligation), the
// atomic request/response writes, the echo-checked decision read, and
// the id enumeration the serving tick walks.

const channelRoot = path.join(os.tmpdir(), `fence-ask-suite-channel-${randomUUID()}`);
createForwardingRootDirs(channelRoot);
check(
	"the forwarding root is created at mode 0700",
	fs.statSync(channelRoot).mode & 0o777,
	0o700,
);
check(
	"the requests directory is created at mode 0700",
	fs.statSync(path.join(channelRoot, REQUESTS_DIR_NAME)).mode & 0o777,
	0o700,
);
check(
	"the responses directory is created at mode 0700",
	fs.statSync(path.join(channelRoot, RESPONSES_DIR_NAME)).mode & 0o777,
	0o700,
);
const channelAsk = createForwardedAsk({
	requestId: randomUUID(),
	childToken: randomUUID(),
	agentName: "pid-1",
	dispatchLabel: "channel fixture",
	toolName: "read",
	resolvedPath: dirOut,
	reason: "channel fixture ask",
	askedAt: 20_000,
});
writeForwardedAsk(channelRoot, channelAsk);
check(
	"the written ask file parses back through the wire parser",
	isValidForwardedAsk(JSON.parse(fs.readFileSync(path.join(channelRoot, REQUESTS_DIR_NAME, askFileName(channelAsk.requestId)), "utf8"))),
	true,
);
checkDeep("requestIdsIn enumerates the written ask id", requestIdsIn(channelRoot), [channelAsk.requestId]);
check("readForwardedDecision on an unanswered ask is null", readForwardedDecision(channelRoot, channelAsk.requestId, channelAsk.childToken), null);
const channelDecision = createForwardedDecision({
	requestId: channelAsk.requestId,
	childToken: channelAsk.childToken,
	decision: "grant",
	grantedRoot: dirOut,
	via: "user",
	reason: ASK_USER_GRANT_REASON,
	decidedAt: 21_000,
});
writeForwardedDecision(channelRoot, channelDecision);
checkDeep(
	"readForwardedDecision returns a matching decision",
	readForwardedDecision(channelRoot, channelAsk.requestId, channelAsk.childToken),
	channelDecision,
);
check(
	"readForwardedDecision refuses another child's token echo",
	readForwardedDecision(channelRoot, channelAsk.requestId, randomUUID()),
	null,
);
check(
	"readForwardedDecision on a missing response file is null",
	readForwardedDecision(channelRoot, randomUUID(), channelAsk.childToken),
	null,
);
check(
	"writeForwardedAsk refuses an invalid ask",
	(() => {
		try {
			writeForwardedAsk(channelRoot, { ...channelAsk, requestId: "not-a-uuid" });
			return "no throw";
		} catch (error) {
			return error instanceof TypeError ? "TypeError" : "wrong error";
		}
	})(),
	"TypeError",
);
checkDeep(
	"atomic writes leave no temporary leftovers",
	fs.readdirSync(path.join(channelRoot, REQUESTS_DIR_NAME)).length,
	1,
);
deleteDecisionFile(channelRoot, channelDecision.requestId);
check(
	"deleteDecisionFile removes the response file",
	fs.readdirSync(path.join(channelRoot, RESPONSES_DIR_NAME)).length,
	0,
);
deleteAskFile(channelRoot, channelAsk.requestId);
deleteAskFile(channelRoot, channelAsk.requestId);
check("a repeated deleteAskFile is a no-op", requestIdsIn(channelRoot).length, 0);
fs.rmSync(channelRoot, { recursive: true, force: true });

// --- unit 1-3: child provisioning from the spawn env ----------------

const provisioningEnv = {
	[CHILD_ASK_ROOT_ENV]: path.join(os.tmpdir(), "fence-ask-suite-root"),
	[CHILD_ASK_TOKEN_ENV]: randomUUID(),
};
checkDeep(
	"childProvisioningFromEnv reads both spawn keys",
	childProvisioningFromEnv(provisioningEnv),
	{ root: provisioningEnv[CHILD_ASK_ROOT_ENV], token: provisioningEnv[CHILD_ASK_TOKEN_ENV] },
);
check(
	"childProvisioningFromEnv rejects a missing root",
	childProvisioningFromEnv({ [CHILD_ASK_TOKEN_ENV]: randomUUID() }),
	null,
);
check(
	"childProvisioningFromEnv rejects a relative root",
	childProvisioningFromEnv({ [CHILD_ASK_ROOT_ENV]: "rel/root", [CHILD_ASK_TOKEN_ENV]: randomUUID() }),
	null,
);
check(
	"childProvisioningFromEnv rejects a missing token",
	childProvisioningFromEnv({ [CHILD_ASK_ROOT_ENV]: provisioningEnv[CHILD_ASK_ROOT_ENV] }),
	null,
);
check(
	"childProvisioningFromEnv rejects an empty token",
	childProvisioningFromEnv({ [CHILD_ASK_ROOT_ENV]: provisioningEnv[CHILD_ASK_ROOT_ENV], [CHILD_ASK_TOKEN_ENV]: "" }),
	null,
);

// --- unit 1-3: the child-side forward flow ---------------------------
// forwardOutOfScopeAsk writes the ask, polls the bounded wait, and
// resolves into applied, denied, timeout, or failed. Timeout removes
// the request file best-effort; a decision read is consumed best-
// effort; an applied flow calls onGrant exactly once with the granted
// root; every fail-closed reason names the tool, the directory, and
// the closed posture.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5_000, step = 10) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await sleep(step);
	}
	return null;
}
const flowRoot = path.join(os.tmpdir(), `fence-ask-suite-flow-${randomUUID()}`);
createForwardingRootDirs(flowRoot);
const flowToken = randomUUID();
const flowDir = "/opt/flow-target";
{
	const grantCalls = [];
	const timeoutOutcome = await forwardOutOfScopeAsk({
		root: flowRoot,
		childToken: flowToken,
		toolName: "read",
		directory: flowDir,
		reason: "timeout fixture",
		identityAgentName: "pid-2",
		identityDispatchLabel: "flow fixture",
		waitMs: 80,
		pollMs: 20,
		onGrant: (root) => grantCalls.push(root),
	});
	check("an unanswered ask times out", timeoutOutcome.status, "timeout");
	checkContains("the timeout reason names the tool", timeoutOutcome.blockReason, "read");
	checkContains("the timeout reason names the directory", timeoutOutcome.blockReason, flowDir);
	checkContains("the timeout reason names the wait bound", timeoutOutcome.blockReason, "80");
	checkContains("the timeout reason states the fail-closed posture", timeoutOutcome.blockReason, "fails closed");
	check("the timeout never grants", grantCalls.length, 0);
	check(
		"the timed-out request file is removed",
		requestIdsIn(flowRoot).length,
		0,
	);
}
{
	const grantCalls = [];
	const denyToken = randomUUID();
	const denyFlow = forwardOutOfScopeAsk({
		root: flowRoot,
		childToken: denyToken,
		toolName: "bash",
		directory: flowDir,
		reason: "deny fixture",
		identityAgentName: "pid-3",
		identityDispatchLabel: "flow fixture",
		waitMs: 5_000,
		pollMs: 10,
		onGrant: (root) => grantCalls.push(root),
	});
	const denyId = await waitFor(() => requestIdsIn(flowRoot)[0] ?? null);
	writeForwardedDecision(
		flowRoot,
		createForwardedDecision({
			requestId: denyId,
			childToken: denyToken,
			decision: "deny",
			grantedRoot: null,
			via: "user",
			reason: ASK_USER_DENY_REASON,
			decidedAt: 22_000,
		}),
	);
	const denyOutcome = await denyFlow;
	check("a user denial resolves denied", denyOutcome.status, "denied");
	checkContains("the deny reason carries the via", denyOutcome.blockReason, "user");
	checkContains("the deny reason carries the decision reason", denyOutcome.blockReason, ASK_USER_DENY_REASON);
	checkContains("the deny reason states the fail-closed posture", denyOutcome.blockReason, "fails closed");
	check("a denial never grants", grantCalls.length, 0);
	check("the consumed response file is removed", fs.readdirSync(path.join(flowRoot, RESPONSES_DIR_NAME)).length, 0);
	deleteAskFile(flowRoot, denyId);
}
{
	const grantCalls = [];
	const grantToken = randomUUID();
	const grantFlow = forwardOutOfScopeAsk({
		root: flowRoot,
		childToken: grantToken,
		toolName: "read",
		directory: flowDir,
		reason: "grant fixture",
		identityAgentName: "pid-4",
		identityDispatchLabel: "flow fixture",
		waitMs: 5_000,
		pollMs: 10,
		onGrant: (root) => grantCalls.push(root),
	});
	const grantId = await waitFor(() => requestIdsIn(flowRoot)[0] ?? null);
	writeForwardedDecision(
		flowRoot,
		createForwardedDecision({
			requestId: grantId,
			childToken: grantToken,
			decision: "grant",
			grantedRoot: flowDir,
			via: "user",
			reason: ASK_USER_GRANT_REASON,
			decidedAt: 23_000,
		}),
	);
	const grantOutcome = await grantFlow;
	check("a user grant resolves applied", grantOutcome.status, "applied");
	check("the applied flow grants exactly once", grantCalls.join(","), flowDir);
	check("the consumed response file is removed after a grant", fs.readdirSync(path.join(flowRoot, RESPONSES_DIR_NAME)).length, 0);
	deleteAskFile(flowRoot, grantId);
}
{
	const grantCalls = [];
	const foreignToken = randomUUID();
	const foreignFlow = forwardOutOfScopeAsk({
		root: flowRoot,
		childToken: foreignToken,
		toolName: "read",
		directory: flowDir,
		reason: "foreign decision fixture",
		identityAgentName: "pid-5",
		identityDispatchLabel: "flow fixture",
		waitMs: 80,
		pollMs: 20,
		onGrant: (root) => grantCalls.push(root),
	});
	const foreignId = await waitFor(() => requestIdsIn(flowRoot)[0] ?? null);
	writeForwardedDecision(
		flowRoot,
		createForwardedDecision({
			requestId: foreignId,
			childToken: randomUUID(),
			decision: "grant",
			grantedRoot: flowDir,
			via: "user",
			reason: ASK_USER_GRANT_REASON,
			decidedAt: 24_000,
		}),
	);
	const foreignOutcome = await foreignFlow;
	check("a decision with a mismatched token echo never applies", foreignOutcome.status, "timeout");
	check("a mismatched-echo decision never grants", grantCalls.length, 0);
	check("the mismatched decision file is left for the sweep", fs.readdirSync(path.join(flowRoot, RESPONSES_DIR_NAME)).length, 1);
}
fs.rmSync(flowRoot, { recursive: true, force: true });

// --- unit 1-3: serving tick, the four properties end to end ----------
// One in-process harness drives both roles through the real channel on
// a real forwarding root: scripted child flows write real request
// files; the tick admits, prompts through an injected handler with
// registry-bound provenance, resolves, and writes responses the flows
// consume. The nine dispatch pins live here.

resetFenceAskState();
const tickRoot = path.join(os.tmpdir(), `fence-ask-suite-tick-${randomUUID()}`);
createForwardingRootDirs(tickRoot);
const e2eChildA = randomUUID();
const e2eChildB = randomUUID();
const e2eChildZ = randomUUID();
const e2eChildD = randomUUID();
registerLiveChild(e2eChildA, "worker-alpha", "alpha dispatch", 30_000);
registerLiveChild(e2eChildB, "worker-beta", "beta dispatch", 30_000);
registerLiveChild(e2eChildZ, "worker-zombie", "zombie dispatch", 30_000);
registerLiveChild(e2eChildD, "worker-delta", "delta dispatch", 30_000);
const promptLog = [];
function makeHandler(script) {
	return async (ask, provenance) => {
		promptLog.push({ ask, provenance, answer: script });
		return script;
	};
}
const tickOptions = { root: tickRoot, handler: null, now: () => 40_000, maxAge: 1_000 };
async function runTick(overrides = {}) {
	return serveForwardingRootTick({ ...tickOptions, ...overrides });
}
async function startFlow(token, directory, toolName, grantSink) {
	return forwardOutOfScopeAsk({
		root: tickRoot,
		childToken: token,
		toolName,
		directory,
		reason: `e2e ask for ${directory}`,
		identityAgentName: `pid-${token.slice(0, 4)}`,
		identityDispatchLabel: "e2e",
		waitMs: 3_000,
		pollMs: 10,
		onGrant: (granted) => grantSink.push(granted),
	});
}

// property 2 + F5: a child asks, the parent is prompted with the
// registry identity and the resolved path; a Yes applies to the asking
// child only.
promptLog.length = 0;
const grantsA = [];
const flowA = startFlow(e2eChildA, "/opt/e2e-alpha", "read", grantsA);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
await runTick({ handler: makeHandler(true), now: () => 40_100 });
const outcomeA = await flowA;
check("the asking child's flow resolves applied", outcomeA.status, "applied");
check("the grant reaches the asking child", grantsA.join(","), "/opt/e2e-alpha");
check("the grant is recorded for the asking child", hasGrantForChild(e2eChildA, "/opt/e2e-alpha"), true);
check("the prompt names the registry agent name", promptLog[0] ? promptLog[0].provenance.agentName : "none", "worker-alpha");
check("the prompt names the registry dispatch label", promptLog[0] ? promptLog[0].provenance.dispatchLabel : "none", "alpha dispatch");
check("the prompt carries the ledger directory", promptLog[0] ? promptLog[0].provenance.directory : "none", "/opt/e2e-alpha");
check(
	"the prompt never trusts the child-asserted identity",
	promptLog[0] ? promptLog[0].provenance.agentName !== "pid-" + e2eChildA.slice(0, 4) : false,
	true,
);
check("exactly one prompt ran", promptLog.length, 1);
check("the resolved request file is gone", requestIdsIn(tickRoot).length, 0);
check("the consumed response file is gone", fs.readdirSync(path.join(tickRoot, RESPONSES_DIR_NAME)).length, 0);

// property 3 + 4: a second child asking the same directory resolves
// granted-dedup with no user round-trip, and the grant stays per-child.
const grantsB = [];
const flowB = startFlow(e2eChildB, "/opt/e2e-alpha", "read", grantsB);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
await runTick({ handler: makeHandler(true), now: () => 40_200 });
const outcomeB = await flowB;
check("the second child's same-directory ask resolves applied", outcomeB.status, "applied");
check("the dedup decision carries the session-dedup via", outcomeB.decision ? outcomeB.decision.via : "none", "session-dedup");
check("the dedup resolution prompts nothing", promptLog.length, 1);
check("the second child holds its own grant record", hasGrantForChild(e2eChildB, "/opt/e2e-alpha"), true);
check("the grants stay per-child rows", grantsForChild(e2eChildB).length, 1);

// property 1: a parent-own grant composes into a later child's scope;
// sibling child-ask grants never do.
resetFenceAskState();
registerLiveChild(e2eChildA, "worker-alpha", "alpha dispatch", 30_000);
check(
	"a sibling child-ask grant is absent from spawn composition",
	inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: "/session",
		dispatchCwd: "/session",
	}).includes("/opt/e2e-alpha"),
	false,
);
recordParentGrant("/opt/parent-own", 50_000);
check(
	"a parent-own grant composes into a later child's scope",
	inheritedExtraRootsEnvValue({
		configRoots: [],
		overlayRoots: [],
		envRoots: [],
		parentGrantRoots: parentGrantedDirectories(),
		parentSessionCwd: "/session",
		dispatchCwd: "/session",
	}).includes("/opt/parent-own"),
	true,
);

// F3 at channel level: an admitted ask with no prompting surface
// pends until the staleness sweep evicts it and removes its request
// file; a fresh ask for the same directory then re-hosts and re-prompts.
resetFenceAskState();
promptLog.length = 0;
registerLiveChild(e2eChildZ, "worker-zombie", "zombie dispatch", 60_000);
registerLiveChild(e2eChildD, "worker-delta", "delta dispatch", 60_000);
const zombieRequest = createForwardedAsk({
	requestId: randomUUID(),
	childToken: e2eChildZ,
	agentName: "pid-z",
	dispatchLabel: "zombie",
	toolName: "read",
	resolvedPath: "/opt/e2e-zombie",
	reason: "zombie ask",
	askedAt: 60_000,
});
writeForwardedAsk(tickRoot, zombieRequest);
const pendZombie = await runTick({ handler: null, now: () => 60_100 });
check("an ask with no prompting surface pends without prompting", pendZombie.prompted, 0);
check("the pended entry keeps its request file", requestIdsIn(tickRoot).length, 1);
await runTick({ handler: null, now: () => 60_100 + 1_500 });
check("the staleness sweep evicted the zombie entry and file", requestIdsIn(tickRoot).length, 0);
const freshFlow = startFlow(e2eChildD, "/opt/e2e-zombie", "read", []);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
await runTick({ handler: makeHandler(true), now: () => 60_100 + 1_600 });
const freshOutcome = await freshFlow;
check("a fresh ask after zombie eviction re-hosts and re-prompts", promptLog.length, 1);
check("the fresh ask resolves applied", freshOutcome.status, "applied");
check("the fresh prompt names the new child", promptLog[0] ? promptLog[0].provenance.agentName : "none", "worker-delta");

// the Q5 cap ladder at channel level: a null-handler admission pass
// lands one outstanding, three queued, and the fifth cap-denied; the
// ruling passes then promote and rule one at a time.
resetFenceAskState();
promptLog.length = 0;
const ladderToken = randomUUID();
registerLiveChild(ladderToken, "ladder", "ladder dispatch", 70_000);
const ladderGrants = [];
const ladderDirs = ["/opt/ladder-1", "/opt/ladder-2", "/opt/ladder-3", "/opt/ladder-4", "/opt/ladder-5"];
const ladderFlows = ladderDirs.map((directory) => startFlow(ladderToken, directory, "read", ladderGrants));
await waitFor(() => requestIdsIn(tickRoot).length === 5);
const admitPass = await runTick({ handler: null, now: () => 70_100 });
check("the admission pass prompted nothing", admitPass.prompted, 0);
check("the admission pass denied exactly one by the cap", admitPass.servedDeny, 1);
check("the cap-denied ask never held its file", requestIdsIn(tickRoot).length, 4);
await runTick({ handler: makeHandler(true), now: () => 70_200 });
await runTick({ handler: makeHandler(true), now: () => 70_300 });
await runTick({ handler: makeHandler(true), now: () => 70_400 });
await runTick({ handler: makeHandler(true), now: () => 70_500 });
const ladderOutcomes = await Promise.all(ladderFlows);
const ladderDenied = ladderOutcomes.filter((outcome) => outcome.status === "denied");
const ladderApplied = ladderOutcomes.filter((outcome) => outcome.status === "applied");
check("four ladder asks applied through the promotion ladder", ladderApplied.length, 4);
check("exactly one ladder ask was denied", ladderDenied.length, 1);
check("the cap deny carries the cap via", ladderDenied[0] && ladderDenied[0].decision ? ladderDenied[0].decision.via : "none", "cap");
checkContains("the cap deny carries the policy reason", ladderDenied[0] ? ladderDenied[0].blockReason : "", ASK_CAP_DENY_REASON);
check("each ruling prompted exactly once", promptLog.length, 4);
check("the cap denial carried no grant", ladderGrants.length, 4);

// coalescing across children: both flows ride one prompt and both apply.
resetFenceAskState();
promptLog.length = 0;
const coToken1 = randomUUID();
const coToken2 = randomUUID();
registerLiveChild(coToken1, "co-one", "co one dispatch", 80_000);
registerLiveChild(coToken2, "co-two", "co two dispatch", 80_000);
const coGrants1 = [];
const coGrants2 = [];
const coFlow1 = startFlow(coToken1, "/opt/co-shared", "read", coGrants1);
const coFlow2 = startFlow(coToken2, "/opt/co-shared", "read", coGrants2);
await waitFor(() => requestIdsIn(tickRoot).length === 2);
await runTick({ handler: makeHandler(true), now: () => 80_100 });
const coOutcome1 = await coFlow1;
const coOutcome2 = await coFlow2;
check("the coalesced pair prompts once", promptLog.length, 1);
check("the host flow applied", coOutcome1.status, "applied");
check("the attached flow applied", coOutcome2.status, "applied");
check("both children hold the grant", hasGrantForChild(coToken2, "/opt/co-shared"), true);

// an unavailable handler drops the entry without deny memory; a null
// handler (no prompting surface) leaves the entry pending for staleness.
resetFenceAskState();
promptLog.length = 0;
const unToken = randomUUID();
registerLiveChild(unToken, "unavailable", "unavailable dispatch", 90_000);
const unFlow = startFlow(unToken, "/opt/unavailable", "read", []);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
const dropTick = await runTick({ handler: async () => null, now: () => 90_100 });
check("an unavailable ruling drops the entry", dropTick.dropped, 1);
const unOutcome = await unFlow;
check("the dropped ask's flow times out fail-closed", unOutcome.status, "timeout");
check("the drop leaves the directory re-askable", pendingRequestLocation(randomUUID()), null);
const reAskFlow = startFlow(unToken, "/opt/unavailable", "read", []);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
await runTick({ handler: makeHandler(true), now: () => 90_200 });
check("the re-ask prompts again instead of denying from memory", promptLog.length, 1);
await reAskFlow;
resetFenceAskState();
registerLiveChild(unToken, "unavailable", "unavailable dispatch", 90_000);
const pendFlow = startFlow(unToken, "/opt/pending", "read", []);
await waitFor(() => requestIdsIn(tickRoot).length === 1);
const pendTick = await runTick({ handler: null, now: () => 90_300 });
check("a null handler prompts nothing", pendTick.prompted, 0);
check("a null handler drops nothing", pendTick.dropped, 0);
check("the pending entry survives for staleness", requestIdsIn(tickRoot).length, 1);
await runTick({ handler: null, now: () => 90_300 + 1_500 });
check("staleness eventually evicts an unserved entry", requestIdsIn(tickRoot).length, 0);
const pendOutcome = await pendFlow;
check("the unserved ask's flow times out", pendOutcome.status, "timeout");

// orphan file sweeps: garbage in requests/ and stale responses go;
// young files and files with live ledger entries stay.
const garbageId = randomUUID();
fs.writeFileSync(path.join(tickRoot, REQUESTS_DIR_NAME, `${garbageId}.json`), "{not json");
fs.utimesSync(path.join(tickRoot, REQUESTS_DIR_NAME, `${garbageId}.json`), 0, 0);
const youngGarbageId = randomUUID();
fs.writeFileSync(path.join(tickRoot, REQUESTS_DIR_NAME, `${youngGarbageId}.json`), "{also not json");
const staleResponseId = randomUUID();
fs.writeFileSync(path.join(tickRoot, RESPONSES_DIR_NAME, `${staleResponseId}.json`), "{}");
fs.utimesSync(path.join(tickRoot, RESPONSES_DIR_NAME, `${staleResponseId}.json`), 0, 0);
const sweepTick = await runTick({ handler: null, now: () => 90_300 + 2_000 });
check("ancient unparseable request garbage is swept", fs.existsSync(path.join(tickRoot, REQUESTS_DIR_NAME, `${garbageId}.json`)), false);
check("young unparseable request garbage is left", fs.existsSync(path.join(tickRoot, REQUESTS_DIR_NAME, `${youngGarbageId}.json`)), true);
check("ancient response files are swept", fs.existsSync(path.join(tickRoot, RESPONSES_DIR_NAME, `${staleResponseId}.json`)), false);
fs.rmSync(tickRoot, { recursive: true, force: true });
resetFenceAskState();

// the F5 prompt title names the child, the resolved path, and the ask.
const titleText = askPromptTitle(
	createForwardedAsk({
		requestId: randomUUID(),
		childToken: randomUUID(),
		agentName: "spoofed-name",
		dispatchLabel: "wire label",
		toolName: "read",
		resolvedPath: "/opt/title-target",
		reason: "title fixture reason",
		askedAt: 100_000,
	}),
	{ requestId: randomUUID(), childToken: randomUUID(), agentName: "worker-registry", dispatchLabel: "registry label", directory: "/opt/title-target" },
);
checkContains("the prompt title names the tool", titleText, "read");
checkContains("the prompt title names the registry agent", titleText, "worker-registry");
checkContains("the prompt title names the registry dispatch label", titleText, "registry label");
checkContains("the prompt title names the resolved path", titleText, "/opt/title-target");
checkContains("the prompt title carries the ask evidence", titleText, "title fixture reason");
checkContains("the prompt title asks for the ruling", titleText, "Allow?");

// --- unit 1-3: the cross-process harness pin ----------------------
// A real node child process plays the child role against a real root
// the in-test tick serves; a second driver plays the nested middle:
// it mints its own root, serves it with the real proxy handler, and a
// grandchild flow inside the driver proxies up through the chain. The
// process boundary is the point: env provisioning, file handoff, and
// ledger scoping behave exactly as dispatched sessions experience.

const e2eRepoRoot = path.resolve(import.meta.dirname, "..");
async function runDriver(source, extraEnv, deadlineMs = 30_000) {
	const driverPath = path.join(os.tmpdir(), `fence-ask-driver-${randomUUID()}.mjs`);
	fs.writeFileSync(driverPath, source);
	try {
		const result = await new Promise((resolve) => {
			const child = spawn(process.execPath, [driverPath], {
				env: { ...process.env, ...extraEnv },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			const killer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("close", (code) => {
				clearTimeout(killer);
				resolve({ code, stdout, stderr });
			});
		});
		return { ...result, driverPath };
	} finally {
		fs.rmSync(driverPath, { force: true });
	}
}

// cross-process child: a real node process plays the dispatched child
// against a real root the in-test tick serves; the parent-side ledger
// records the grant for the dispatched token.
{
	resetFenceAskState();
	const procRoot = path.join(os.tmpdir(), `fence-ask-suite-proc-${randomUUID()}`);
	createForwardingRootDirs(procRoot);
	const procToken = randomUUID();
	registerLiveChild(procToken, "proc-child", "proc dispatch", 110_000);
	const procPrompt = [];
	const driverSource = `
const { forwardOutOfScopeAsk } = await import(${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "ask-channel.ts")).href)});
const outcome = await forwardOutOfScopeAsk({
	root: ${JSON.stringify(procRoot)},
	childToken: ${JSON.stringify(procToken)},
	toolName: "read",
	directory: "/opt/proc-target",
	reason: "proc fixture",
	identityAgentName: "driver",
	identityDispatchLabel: "proc",
	waitMs: 20000,
	pollMs: 10,
});
console.log(JSON.stringify({ status: outcome.status, via: outcome.decision ? outcome.decision.via : null }));
`;
	const driverRun = runDriver(driverSource, {}, 30_000);
	await waitFor(() => requestIdsIn(procRoot).length === 1);
	await serveForwardingRootTick({
		root: procRoot,
		handler: async (ask, provenance) => {
			procPrompt.push({ ask, provenance });
			return true;
		},
		now: () => 110_100,
		maxAge: 60_000,
	});
	const driverResult = await driverRun;
	check("the cross-process driver exited cleanly", driverResult.code, 0);
	const driverJson = JSON.parse(driverResult.stdout.trim().split("\n").pop());
	check("the cross-process driver applied", driverJson.status, "applied");
	check("the cross-process decision carries the user via", driverJson.via, "user");
	check(
		"the parent's ledger recorded the grant for the dispatched token",
		hasGrantForChild(procToken, "/opt/proc-target"),
		true,
	);
	check("the in-test tick prompted exactly once", procPrompt.length, 1);
	check(
		"the in-test prompt named the dispatched identity",
		procPrompt[0] ? procPrompt[0].provenance.agentName : "none",
		"proc-child",
	);
	fs.rmSync(procRoot, { recursive: true, force: true });
	resetFenceAskState();
}

// nested dispatch: the driver is the middle; its own minted root is
// served by the real server with the real proxy handler; the
// grandchild flow inside the driver proxies up to the test's root, and
// the grant binds the grandchild in the middle's ledger, never the
// middle's own verdicts.
{
	resetFenceAskState();
	const topRoot = path.join(os.tmpdir(), `fence-ask-suite-nested-${randomUUID()}`);
	createForwardingRootDirs(topRoot);
	const middleToken = randomUUID();
	registerLiveChild(middleToken, "middle-child", "middle dispatch", 120_000);
	const topPrompt = [];
	const nestedTickOptions = {
		root: topRoot,
		handler: async (ask, provenance) => {
			topPrompt.push({ ask, provenance });
			return true;
		},
		now: () => 120_100,
		maxAge: 60_000,
	};
	const driverSource = `
const ledgerPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "grant-ledger.ts")).href)};
const channelPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "ask-channel.ts")).href)};
const servePath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "serve.ts")).href)};
const { ensureForwardingRoot, registerLiveChild, appliedSelfGrants, grantsForChild } = await import(ledgerPath);
const { forwardOutOfScopeAsk } = await import(channelPath);
const { configureForwardingServer, ensureForwardingServer, childProxyHandler } = await import(servePath);
const grandchildToken = crypto.randomUUID();
const middleRoot = ensureForwardingRoot("driver-session", crypto.randomUUID());
configureForwardingServer({ resolveHandler: childProxyHandler, tickMs: 10 });
ensureForwardingServer();
registerLiveChild(grandchildToken, "nested-worker", "nested dispatch", 1);
const outcome = await forwardOutOfScopeAsk({
	root: middleRoot,
	childToken: grandchildToken,
	toolName: "write",
	directory: "/opt/nested-target",
	reason: "nested grandchild ask",
	identityAgentName: "nested-driver",
	identityDispatchLabel: "nested",
	waitMs: 20000,
	pollMs: 10,
	onGrant: () => {},
});
console.log(JSON.stringify({
	status: outcome.status,
	middleApplied: appliedSelfGrants().length,
	grandchildGrant: grantsForChild(grandchildToken).join(","),
	middleRoot,
}));
process.exit(0);
`;
	const driverPromise = runDriver(
		driverSource,
		{
			[CHILD_ASK_ROOT_ENV]: topRoot,
			[CHILD_ASK_TOKEN_ENV]: middleToken,
		},
		30_000,
	);
	const proxyAppeared = await waitFor(() => requestIdsIn(topRoot).length === 1, 20_000);
	await serveForwardingRootTick({ ...nestedTickOptions });
	const driverResult = await driverPromise;
	check("the nested driver exited cleanly", driverResult.code, 0);
	const nestedJson = JSON.parse(driverResult.stdout.trim().split("\n").pop());
	check("the grandchild flow applied through the chain", nestedJson.status, "applied");
	check("the middle's own verdict set stays empty", nestedJson.middleApplied, 0);
	check("the grant binds the grandchild in the middle's ledger", nestedJson.grandchildGrant, "/opt/nested-target");
	check("the proxy ask reached the top root", proxyAppeared !== null, true);
	check("the top prompted once for the middle's token", topPrompt.length, 1);
	check("the top prompt names the middle's registry identity", topPrompt[0] ? topPrompt[0].provenance.agentName : "none", "middle-child");
	check("the top prompt carries the proxy reason naming the grandchild", topPrompt[0] ? topPrompt[0].ask.reason.includes("nested-worker") : false, true);
	check("the top records the grant for the middle token only", hasGrantForChild(middleToken, "/opt/nested-target"), true);
	fs.rmSync(topRoot, { recursive: true, force: true });
	fs.rmSync(nestedJson.middleRoot, { recursive: true, force: true });
	resetFenceAskState();
}

// --- unit 1-3: the proxy handler composition ----------------------
// childProxyHandler is the middle's ruling surface: null without
// provisioning, and otherwise a forward-up flow under this process's
// own token with the grandchild named in the reason.

resetFenceAskState();
{
	const savedRoot = process.env[CHILD_ASK_ROOT_ENV];
	const savedToken = process.env[CHILD_ASK_TOKEN_ENV];
	delete process.env[CHILD_ASK_ROOT_ENV];
	delete process.env[CHILD_ASK_TOKEN_ENV];
	check("childProxyHandler without provisioning is null", childProxyHandler(), null);
	const proxyRoot = path.join(os.tmpdir(), `fence-ask-suite-proxy-${randomUUID()}`);
	createForwardingRootDirs(proxyRoot);
	const proxyToken = randomUUID();
	registerLiveChild(proxyToken, "proxy-mid", "proxy mid dispatch", 140_000);
	process.env[CHILD_ASK_ROOT_ENV] = proxyRoot;
	process.env[CHILD_ASK_TOKEN_ENV] = proxyToken;
	const proxyHandler = childProxyHandler({ pollMs: 10 });
	check("childProxyHandler with provisioning composes", typeof proxyHandler, "function");
	const proxyPrompt = [];
	const proxyAsk = createForwardedAsk({
		requestId: randomUUID(),
		childToken: randomUUID(),
		agentName: "grandchild-wire",
		dispatchLabel: "grandchild wire label",
		toolName: "read",
		resolvedPath: "/opt/proxy-x",
		reason: "grandchild evidence",
		askedAt: 140_000,
	});
	const proxyProvenance = {
		requestId: proxyAsk.requestId,
		childToken: randomUUID(),
		agentName: "nested-worker",
		dispatchLabel: "nested dispatch",
		directory: "/opt/proxy-x",
	};
	const grantRuling = proxyHandler(proxyAsk, proxyProvenance);
	await waitFor(() => requestIdsIn(proxyRoot).length === 1);
	await serveForwardingRootTick({
		root: proxyRoot,
		handler: async (ask, provenance) => {
			proxyPrompt.push({ ask, provenance });
			return true;
		},
		now: () => 140_100,
		maxAge: 60_000,
	});
	check("the proxy grant resolves true", await grantRuling, true);
	check("the proxy ask rode the middle's token", proxyPrompt[0] ? proxyPrompt[0].provenance.agentName : "none", "proxy-mid");
	checkContains("the proxy reason names the grandchild", proxyPrompt[0] ? proxyPrompt[0].ask.reason : "", "nested-worker");
	checkContains("the proxy reason names the directory", proxyPrompt[0] ? proxyPrompt[0].ask.reason : "", "/opt/proxy-x");
	const denyAsk = createForwardedAsk({
		...proxyAsk,
		requestId: randomUUID(),
		resolvedPath: "/opt/proxy-y",
	});
	const denyProvenance = { ...proxyProvenance, requestId: denyAsk.requestId, directory: "/opt/proxy-y" };
	const denyRuling = proxyHandler(denyAsk, denyProvenance);
	await waitFor(() => requestIdsIn(proxyRoot).length === 1);
	await serveForwardingRootTick({
		root: proxyRoot,
		handler: async () => false,
		now: () => 140_200,
		maxAge: 60_000,
	});
	check("the proxy deny resolves false", await denyRuling, false);
	if (typeof savedRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = savedRoot;
	if (typeof savedToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = savedToken;
	fs.rmSync(proxyRoot, { recursive: true, force: true });
}
resetFenceAskState();

// --- seam review 22 COR-1: the proxy hop threads denial provenance --
// The wire's via enum exists to keep a cap denial apart from the
// user's word, and the ledger's cap contract records nothing for a
// cap denial because it judges the child's cadence, never the
// directory. The middle's proxy handler therefore resolves a top
// user-class denial as the plain boolean false (the user's word; deny
// memory as before) and a top cap denial as the structured denial
// carrying the via and reason, so the ledger below the hop writes the
// honest block reason without poisoning its own deny memory.

resetFenceAskState();
{
	const savedRoot = process.env[CHILD_ASK_ROOT_ENV];
	const savedToken = process.env[CHILD_ASK_TOKEN_ENV];
	const shapeTopRoot = path.join(os.tmpdir(), `fence-ask-suite-shape-top-${randomUUID()}`);
	createForwardingRootDirs(shapeTopRoot);
	const shapeMiddleToken = randomUUID();
	registerLiveChild(shapeMiddleToken, "shape-middle", "shape dispatch", 165_000);
	process.env[CHILD_ASK_ROOT_ENV] = shapeTopRoot;
	process.env[CHILD_ASK_TOKEN_ENV] = shapeMiddleToken;
	const shapeProxy = childProxyHandler({ pollMs: 10 });
	const shapeAskFor = (directory) =>
		createForwardedAsk({
			requestId: randomUUID(),
			childToken: randomUUID(),
			agentName: "shape-grandchild",
			dispatchLabel: "shape grandchild label",
			toolName: "read",
			resolvedPath: directory,
			reason: "shape fixture ask",
			askedAt: 165_100,
		});
	const shapeProvenanceFor = (wireAsk, directory) => ({
		requestId: wireAsk.requestId,
		childToken: wireAsk.childToken,
		agentName: "shape-worker",
		dispatchLabel: "shape dispatch",
		directory,
	});
	for (let i = 0; i < ASK_OUTSTANDING_CAP + ASK_QUEUE_CAPACITY; i++) {
		admitChildAsk(randomUUID(), shapeMiddleToken, `/opt/shape-fill-${i}`, 165_000 + i);
	}
	const capShapeAsk = shapeAskFor("/opt/shape-cap-target");
	const capShapeRuling = shapeProxy(capShapeAsk, shapeProvenanceFor(capShapeAsk, "/opt/shape-cap-target"));
	await waitFor(() => requestIdsIn(shapeTopRoot).length === 1);
	await serveForwardingRootTick({
		root: shapeTopRoot,
		handler: async () => true,
		now: () => 165_150,
		maxAge: 60_000,
	});
	checkDeep("a top cap denial resolves the structured denial", await capShapeRuling, {
		answer: false,
		via: "cap",
		reason: ASK_CAP_DENY_REASON,
	});
	expireStaleAsks(400_000);
	const userShapeAsk = shapeAskFor("/opt/shape-user-target");
	const userShapeRuling = shapeProxy(userShapeAsk, shapeProvenanceFor(userShapeAsk, "/opt/shape-user-target"));
	await waitFor(() => requestIdsIn(shapeTopRoot).length === 1);
	await serveForwardingRootTick({
		root: shapeTopRoot,
		handler: async () => false,
		now: () => 165_250,
		maxAge: 60_000,
	});
	check("a top user denial resolves the plain false", await userShapeRuling, false);
	const sdShapeAsk = shapeAskFor("/opt/shape-sd-target");
	const sdShapeRuling = shapeProxy(sdShapeAsk, shapeProvenanceFor(sdShapeAsk, "/opt/shape-sd-target"));
	const sdShapeId = await waitFor(() => requestIdsIn(shapeTopRoot)[0] ?? null);
	writeForwardedDecision(
		shapeTopRoot,
		createForwardedDecision({
			requestId: sdShapeId,
			childToken: shapeMiddleToken,
			decision: "deny",
			grantedRoot: null,
			via: "session-deny",
			reason: ASK_SESSION_DENY_REASON,
			decidedAt: 165_300,
		}),
	);
	check("a top session-deny crossing resolves the plain false", await sdShapeRuling, false);
	if (typeof savedRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = savedRoot;
	if (typeof savedToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = savedToken;
	fs.rmSync(shapeTopRoot, { recursive: true, force: true });
}
resetFenceAskState();
// The ledger-side contract, pinned directly: a denial ruling that
// carries the cap provenance judges the child's cadence at the hop
// above, so it writes its honest via and reason but records nothing,
// while user-class provenance (the user's word, or the remembered
// form of one) records the deny memory as before.
{
	const denialChildOne = randomUUID();
	const denialChildTwo = randomUUID();
	const denialChildThree = randomUUID();
	const denialChildFour = randomUUID();
	const denialChildFive = randomUUID();
	registerLiveChild(denialChildOne, "denial-one", "denial one dispatch", 3000);
	registerLiveChild(denialChildTwo, "denial-two", "denial two dispatch", 3000);
	registerLiveChild(denialChildThree, "denial-three", "denial three dispatch", 3000);
	registerLiveChild(denialChildFour, "denial-four", "denial four dispatch", 3000);
	registerLiveChild(denialChildFive, "denial-five", "denial five dispatch", 3000);
	const capDeniedDir = path.join(fixtureDir, "denial", "cap-cross");
	const capDeniedReq = randomUUID();
	admitChildAsk(capDeniedReq, denialChildOne, capDeniedDir, 3000);
	const capRuling = resolveChildAsk(capDeniedReq, false, 3100, { via: "cap", reason: ASK_CAP_DENY_REASON });
	check("the structured cap refusal resolves", capRuling.kind, "resolved");
	check("the crossed cap denial writes the cap via", capRuling.decisions[0].via, "cap");
	check("the crossed cap denial writes the cap reason", capRuling.decisions[0].reason, ASK_CAP_DENY_REASON);
	check("a cap denial records no deny memory", getFenceAskState().sessionWideDenied.has(capDeniedDir), false);
	check(
		"the directory a cap denial refused is askable again",
		admitChildAsk(randomUUID(), denialChildTwo, capDeniedDir, 3200).kind,
		"outstanding",
	);
	const userDeniedDir = path.join(fixtureDir, "denial", "user-cross");
	const userDeniedReq = randomUUID();
	admitChildAsk(userDeniedReq, denialChildThree, userDeniedDir, 3300);
	const userRuling = resolveChildAsk(userDeniedReq, false, 3400, { via: "user", reason: ASK_USER_DENY_REASON });
	check("the structured user refusal resolves", userRuling.kind, "resolved");
	check("the crossed user denial writes the user via", userRuling.decisions[0].via, "user");
	check("a user denial records the deny memory", getFenceAskState().sessionWideDenied.has(userDeniedDir), true);
	check(
		"the directory a user denial refused denies from memory",
		admitChildAsk(randomUUID(), denialChildFour, userDeniedDir, 3500).kind,
		"denied-dedup",
	);
	const sdDeniedDir = path.join(fixtureDir, "denial", "sd-cross");
	const sdDeniedReq = randomUUID();
	admitChildAsk(sdDeniedReq, denialChildFive, sdDeniedDir, 3600);
	const sdRuling = resolveChildAsk(sdDeniedReq, false, 3700, { via: "session-deny", reason: ASK_SESSION_DENY_REASON });
	check("a relayed session-deny refusal resolves", sdRuling.kind, "resolved");
	check("a relayed session-deny refusal records the deny memory", getFenceAskState().sessionWideDenied.has(sdDeniedDir), true);
}
resetFenceAskState();

// nested dispatch COR-1 e2e: the driver is the middle at a capped
// top; the first grandchild ask is cap-denied at the top, and after
// the top's capacity frees, the re-ask from a later grandchild must
// cross again and prompt, because the cap denial wrote no deny memory
// in the middle.
{
	resetFenceAskState();
	const corTopRoot = path.join(os.tmpdir(), `fence-ask-suite-cor1-${randomUUID()}`);
	createForwardingRootDirs(corTopRoot);
	const corMiddleToken = randomUUID();
	registerLiveChild(corMiddleToken, "cor1-middle", "cor1 dispatch", 170_000);
	for (let i = 0; i < ASK_OUTSTANDING_CAP + ASK_QUEUE_CAPACITY; i++) {
		admitChildAsk(randomUUID(), corMiddleToken, `/opt/cor1-fill-${i}`, 170_000 + i);
	}
	const corTopPrompt = [];
	const corTopTickOptions = {
		root: corTopRoot,
		handler: async (ask, provenance) => {
			corTopPrompt.push({ ask, provenance });
			return true;
		},
		now: () => 170_500,
		maxAge: 60_000,
	};
	const driverSource = `
const ledgerPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "grant-ledger.ts")).href)};
const channelPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "ask-channel.ts")).href)};
const servePath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "serve.ts")).href)};
const { registerLiveChild, ensureForwardingRoot, getFenceAskState, appliedSelfGrants, grantsForChild } = await import(ledgerPath);
const { forwardOutOfScopeAsk } = await import(channelPath);
const { configureForwardingServer, ensureForwardingServer, childProxyHandler } = await import(servePath);
const firstToken = crypto.randomUUID();
const secondToken = crypto.randomUUID();
const thirdToken = crypto.randomUUID();
const fourthToken = crypto.randomUUID();
const middleRoot = ensureForwardingRoot("cor1-driver-session", crypto.randomUUID());
configureForwardingServer({ resolveHandler: childProxyHandler, tickMs: 10 });
ensureForwardingServer();
registerLiveChild(firstToken, "cor1-grandchild-one", "cor1 first dispatch", 1);
registerLiveChild(secondToken, "cor1-grandchild-two", "cor1 second dispatch", 1);
registerLiveChild(thirdToken, "cor1-grandchild-three", "cor1 third dispatch", 1);
registerLiveChild(fourthToken, "cor1-grandchild-four", "cor1 fourth dispatch", 1);
const forwardAt = (directory, childToken) => forwardOutOfScopeAsk({
	root: middleRoot,
	childToken,
	toolName: "write",
	directory,
	reason: "cor1 grandchild ask",
	identityAgentName: "cor1-driver",
	identityDispatchLabel: "cor1",
	waitMs: 20000,
	pollMs: 10,
	onGrant: () => {},
});
const first = await forwardAt("/opt/cor1-target", firstToken);
const memoryAfterFirst = getFenceAskState().sessionWideDenied.size;
const second = await forwardAt("/opt/cor1-target", secondToken);
const memoryAfterSecond = getFenceAskState().sessionWideDenied.size;
const third = await forwardAt("/opt/cor1-user-target", thirdToken);
const memoryAfterThird = getFenceAskState().sessionWideDenied.size;
const fourth = await forwardAt("/opt/cor1-user-target", fourthToken);
console.log(JSON.stringify({
	firstStatus: first.status,
	firstVia: first.decision ? first.decision.via : null,
	firstReason: first.blockReason,
	memoryAfterFirst,
	secondStatus: second.status,
	secondVia: second.decision ? second.decision.via : null,
	memoryAfterSecond,
	thirdStatus: third.status,
	thirdVia: third.decision ? third.decision.via : null,
	memoryAfterThird,
	fourthStatus: fourth.status,
	fourthVia: fourth.decision ? fourth.decision.via : null,
	middleApplied: appliedSelfGrants().length,
	secondGrant: grantsForChild(secondToken).join(","),
	middleRoot,
}));
process.exit(0);
`;
	const corDriverPromise = runDriver(
		driverSource,
		{
			[CHILD_ASK_ROOT_ENV]: corTopRoot,
			[CHILD_ASK_TOKEN_ENV]: corMiddleToken,
		},
		30_000,
	);
	await waitFor(() => requestIdsIn(corTopRoot).length === 1);
	await serveForwardingRootTick({ ...corTopTickOptions });
	expireStaleAsks(400_000);
	await waitFor(() => requestIdsIn(corTopRoot).length === 1);
	await serveForwardingRootTick({ ...corTopTickOptions, now: () => 170_600 });
	await waitFor(() => requestIdsIn(corTopRoot).length === 1);
	await serveForwardingRootTick({
		...corTopTickOptions,
		now: () => 170_700,
		handler: async (ask, provenance) => {
			corTopPrompt.push({ ask, provenance });
			return false;
		},
	});
	const corDriverResult = await corDriverPromise;
	check("the cor1 driver exited cleanly", corDriverResult.code, 0);
	const corJson = JSON.parse(corDriverResult.stdout.trim().split("\n").pop());
	check("the capped first grandchild ask is denied", corJson.firstStatus, "denied");
	check("the crossed cap denial names the cap provenance", corJson.firstVia, "cap");
	checkContains("the crossed cap denial reason names the ask cap", corJson.firstReason, ASK_CAP_DENY_REASON);
	check("the middle holds no deny memory after the cap crossing", corJson.memoryAfterFirst, 0);
	check("the re-ask after the cap clears applies", corJson.secondStatus, "applied");
	check("the re-ask's grant crosses as the user's word", corJson.secondVia, "user");
	check("the re-ask's grant binds the later grandchild", corJson.secondGrant, "/opt/cor1-target");
	check("the middle's own verdict set stays empty", corJson.middleApplied, 0);
	check("the grant crossing recorded no middle deny memory", corJson.memoryAfterSecond, 0);
	check("the cap denial prompted nothing and the two crossings prompted once each", corTopPrompt.length, 2);
	check("the top user denial crosses and denies", corJson.thirdStatus, "denied");
	check("the crossed user denial names the user provenance", corJson.thirdVia, "user");
	check("the middle records the deny memory for the user crossing", corJson.memoryAfterThird, 1);
	check("the re-ask after a user denial denies from memory without crossing", corJson.fourthStatus, "denied");
	check("the memory denial carries the session-deny provenance", corJson.fourthVia, "session-deny");
	fs.rmSync(corTopRoot, { recursive: true, force: true });
	fs.rmSync(corJson.middleRoot, { recursive: true, force: true });
	resetFenceAskState();
}

// --- unit 1-4 DC-2: the spawn-site default proxy resolver ------------
// A provisioned process starts serving through childProxyHandler the
// moment it dispatches (ensureForwardingServer at its own spawn site),
// before and regardless of any session_start configuration: a one-shot
// json middle's session_start delivery must not be load-bearing for
// the nested channel (review 17 DC-2). A top without provisioning
// keeps the null default, so session_start's UI layering stays the
// only change there.

resetFenceAskState();
{
	const savedRoot = process.env[CHILD_ASK_ROOT_ENV];
	const savedToken = process.env[CHILD_ASK_TOKEN_ENV];
	const defaultRoot = ensureForwardingRoot("dc2-default-suite", randomUUID());
	const defaultToken = randomUUID();
	registerLiveChild(defaultToken, "dc2-middle", "dc2 dispatch", 150_000);
	process.env[CHILD_ASK_ROOT_ENV] = defaultRoot;
	process.env[CHILD_ASK_TOKEN_ENV] = defaultToken;
	try {
		configureForwardingServer({ resolveHandler: null });
		ensureForwardingServer();
		const defaultResolver = globalThis.__piFenceAskServer.resolveHandler;
		check("the spawn-site start installed a resolver without session_start", typeof defaultResolver, "function");
		const defaultSurface = defaultResolver ? defaultResolver() : null;
		check("the default resolver serves the proxy role for a provisioned process", typeof defaultSurface, "function");
		const probeAsk = createForwardedAsk({
			requestId: randomUUID(),
			childToken: randomUUID(),
			agentName: "dc2-wire",
			dispatchLabel: "dc2 wire label",
			toolName: "read",
			resolvedPath: "/opt/dc2-probe",
			reason: "dc2 probe evidence",
			askedAt: 150_000,
		});
		const probeRuling = defaultSurface(probeAsk, {
			requestId: probeAsk.requestId,
			childToken: defaultToken,
			agentName: "dc2-registry",
			dispatchLabel: "dc2 registry label",
			directory: "/opt/dc2-probe",
		});
		await waitFor(() => requestIdsIn(defaultRoot).length === 1);
		await serveForwardingRootTick({ root: defaultRoot, handler: async () => true, now: () => 150_100, maxAge: 60_000 });
		check("the default proxy surface forwarded under the process token", await probeRuling, true);
	} finally {
		stopForwardingServer({ removeRoot: true });
		if (typeof savedRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = savedRoot;
		else delete process.env[CHILD_ASK_ROOT_ENV];
		if (typeof savedToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = savedToken;
		else delete process.env[CHILD_ASK_TOKEN_ENV];
	}
}
resetFenceAskState();
{
	const savedRoot = process.env[CHILD_ASK_ROOT_ENV];
	const savedToken = process.env[CHILD_ASK_TOKEN_ENV];
	delete process.env[CHILD_ASK_ROOT_ENV];
	delete process.env[CHILD_ASK_TOKEN_ENV];
	const toplessRoot = ensureForwardingRoot("dc2-topless-suite", randomUUID());
	try {
		configureForwardingServer({ resolveHandler: null });
		ensureForwardingServer();
		const toplessResolver = globalThis.__piFenceAskServer.resolveHandler;
		check("a top without provisioning keeps the null default", toplessResolver ? toplessResolver() : null, null);
	} finally {
		stopForwardingServer({ removeRoot: true });
		if (typeof savedRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = savedRoot;
		if (typeof savedToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = savedToken;
	}
	fs.rmSync(toplessRoot, { recursive: true, force: true });
}
resetFenceAskState();
{
	const topRoot = path.join(os.tmpdir(), `fence-ask-suite-dc2-${randomUUID()}`);
	createForwardingRootDirs(topRoot);
	const middleToken = randomUUID();
	registerLiveChild(middleToken, "dc2-middle-child", "dc2 dispatch", 160_000);
	const topPrompt = [];
	const driverSource = `
const ledgerPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "grant-ledger.ts")).href)};
const channelPath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "ask-channel.ts")).href)};
const servePath = ${JSON.stringify(pathToFileURL(path.join(e2eRepoRoot, "extensions", "fence-ask", "serve.ts")).href)};
const { ensureForwardingRoot, registerLiveChild } = await import(ledgerPath);
const { forwardOutOfScopeAsk } = await import(channelPath);
const { ensureForwardingServer } = await import(servePath);
const grandchildToken = crypto.randomUUID();
const middleRoot = ensureForwardingRoot("dc2-driver-session", crypto.randomUUID());
ensureForwardingServer();
registerLiveChild(grandchildToken, "dc2-worker", "dc2 nested dispatch", 1);
const outcome = await forwardOutOfScopeAsk({
	root: middleRoot,
	childToken: grandchildToken,
	toolName: "read",
	directory: "/opt/dc2-target",
	reason: "dc2 grandchild ask",
	identityAgentName: "dc2-driver",
	identityDispatchLabel: "dc2",
	waitMs: 20000,
	pollMs: 10,
	onGrant: () => {},
});
console.log(JSON.stringify({ status: outcome.status }));
process.exit(0);
`;
	const driverPromise = runDriver(
		driverSource,
		{
			[CHILD_ASK_ROOT_ENV]: topRoot,
			[CHILD_ASK_TOKEN_ENV]: middleToken,
		},
		30_000,
	);
	const proxyAppeared = await waitFor(() => requestIdsIn(topRoot).length === 1, 20_000);
	await serveForwardingRootTick({
		root: topRoot,
		handler: async (ask, provenance) => {
			topPrompt.push({ ask, provenance });
			return true;
		},
		now: () => 160_100,
		maxAge: 60_000,
	});
	const driverResult = await driverPromise;
	check("the dc2 driver exited cleanly", driverResult.code, 0);
	const dc2Json = JSON.parse(driverResult.stdout.trim().split("\n").pop());
	check("the default proxy served the nested chain without session_start", dc2Json.status, "applied");
	check("the proxy ask reached the top root", proxyAppeared !== null, true);
	check("the top prompted once for the dc2 middle", topPrompt.length, 1);
	fs.rmSync(topRoot, { recursive: true, force: true });
}
resetFenceAskState();

// --- unit 1-4 DC-1: bound-aware admit ordering -----------------------
// Serial prompting is the accepted posture (batching one Yes across N
// asks would coarsen the per-ask provenance discipline), so the tick
// walks request files oldest-first: under concurrent children the
// longest-waiting ask surfaces first, which buys back the widest
// liveness margin the serial shape allows. The env-derived serving
// staleness bound rides the same block: raising PISCOPE_ASK_WAIT_MS
// extends the children's patience and the host lifetime together, so
// the documented multi-child knob stays coherent (review 17 S-1).

{
	const savedWait = process.env[ASK_WAIT_ENV];
	delete process.env[ASK_WAIT_ENV];
	check("the serving staleness bound defaults to the locked bound", servingMaxAgeMs(), 120_000);
	process.env[ASK_WAIT_ENV] = "300000";
	check("the serving staleness bound follows the env override", servingMaxAgeMs(), 300_000);
	process.env[ASK_WAIT_ENV] = "not-a-number";
	check("a garbage override falls back to the locked bound", servingMaxAgeMs(), 120_000);
	if (typeof savedWait === "string") process.env[ASK_WAIT_ENV] = savedWait;
	else delete process.env[ASK_WAIT_ENV];
}
{
	const orderRoot = path.join(os.tmpdir(), `fence-ask-suite-order-${randomUUID()}`);
	createForwardingRootDirs(orderRoot);
	const oldToken = randomUUID();
	const youngToken = randomUUID();
	registerLiveChild(oldToken, "order-old", "older dispatch", 170_000);
	registerLiveChild(youngToken, "order-young", "younger dispatch", 170_000);
	const oldId = randomUUID();
	const youngId = randomUUID();
	writeForwardedAsk(orderRoot, {
		requestId: youngId,
		childToken: youngToken,
		agentName: "order-young",
		dispatchLabel: "younger dispatch",
		toolName: "read",
		resolvedPath: "/opt/order-young",
		reason: "younger ask",
		askedAt: 170_200,
	});
	writeForwardedAsk(orderRoot, {
		requestId: oldId,
		childToken: oldToken,
		agentName: "order-old",
		dispatchLabel: "older dispatch",
		toolName: "read",
		resolvedPath: "/opt/order-old",
		reason: "older ask",
		askedAt: 170_000,
	});
	const oldPath = path.join(orderRoot, "requests", `${oldId}.json`);
	const youngPath = path.join(orderRoot, "requests", `${youngId}.json`);
	fs.utimesSync(oldPath, new Date(170_000), new Date(170_000));
	fs.utimesSync(youngPath, new Date(170_200), new Date(170_200));
	const promptOrder = [];
	await serveForwardingRootTick({
		root: orderRoot,
		handler: async (ask) => {
			promptOrder.push(ask.resolvedPath);
			return true;
		},
		now: () => 170_300,
		maxAge: 60_000,
	});
	check("the tick prompted both asks once", promptOrder.length, 2);
	check("the oldest ask surfaced first", promptOrder[0], "/opt/order-old");
	check("the younger ask surfaced second", promptOrder[1], "/opt/order-young");
	fs.rmSync(orderRoot, { recursive: true, force: true });
}
resetFenceAskState();

// --- unit 1-3: the serving server lifecycle --------------------------
// The server is the process-global timer wrapper: idempotent start,
// tick-driven sweeps, and a stop that clears the timer and removes the
// root this process created (the session_shutdown obligation).

resetFenceAskState();
{
	const serverRoot = ensureForwardingRoot("server-suite", randomUUID());
	configureForwardingServer({ resolveHandler: () => null, tickMs: 20 });
	ensureForwardingServer();
	check("the server created the minted root", fs.existsSync(serverRoot), true);
	check("the created root carries the 0700 mode", fs.statSync(serverRoot).mode & 0o777, 0o700);
	ensureForwardingServer();
	stopForwardingServer({ removeRoot: true });
	check("the stop removed the created root", fs.existsSync(serverRoot), false);
	check("a stop without a start is a no-op", stopForwardingServer({ removeRoot: true }), undefined);
}
resetFenceAskState();

// --- unit 1-3: the live entry point ----------------------------------
// The entry is the loadable factory (the incident rule's entry-point
// shape): session_start configures the per-tick ruling-surface
// resolver with the documented role selection, session_shutdown stops
// the server and removes the root this process created. The resolver
// is read back through the globalThis-converged server handle, the
// same object the tick consumes.

const entryModule = await import("../extensions/fence-ask/index.ts");
check("the fence-ask entry default export is a factory function", typeof entryModule.default, "function");
const entryRegistered = [];
entryModule.default({
	on(name, handler) {
		entryRegistered.push({ name, handler });
	},
});
check("the entry registers exactly two handlers", entryRegistered.length, 2);
check("the entry registers on session_start", entryRegistered[0] ? entryRegistered[0].name : "none", "session_start");
check("the entry registers on session_shutdown", entryRegistered[1] ? entryRegistered[1].name : "none", "session_shutdown");

resetFenceAskState();
{
	const entryServerRoot = ensureForwardingRoot("entry-suite", randomUUID());
	const entryUiCalls = [];
	const entryUiCtx = {
		hasUI: true,
		ui: {
			select: async (title, choices) => {
				entryUiCalls.push({ title, choices });
				return "Yes";
			},
		},
	};
	const savedEntryRoot = process.env[CHILD_ASK_ROOT_ENV];
	const savedEntryToken = process.env[CHILD_ASK_TOKEN_ENV];
	const savedEntryWait = process.env[ASK_WAIT_ENV];
	process.env[ASK_WAIT_ENV] = "150";
	try {
		// role selection 1: a provisioned process proxies up regardless of
		// UI. The resolver's returned surface must be the proxy: invoking
		// it writes a request file into the provisioning root and never
		// prompts the local UI.
		process.env[CHILD_ASK_ROOT_ENV] = entryServerRoot;
		process.env[CHILD_ASK_TOKEN_ENV] = randomUUID();
		await entryRegistered[0].handler({}, entryUiCtx);
		const provisionedResolver = globalThis.__piFenceAskServer.resolveHandler();
		check("the entry resolver returns a surface for a provisioned process", typeof provisionedResolver, "function");
		const roleProbe = provisionedResolver(
			createForwardedAsk({
				requestId: randomUUID(),
				childToken: randomUUID(),
				agentName: "role-wire",
				dispatchLabel: "role wire label",
				toolName: "read",
				resolvedPath: "/opt/role-probe",
				reason: "role probe evidence",
				askedAt: 310_000,
			}),
			{ requestId: randomUUID(), childToken: randomUUID(), agentName: "role-registry", dispatchLabel: "role registry label", directory: "/opt/role-probe" },
		);
		await waitFor(() => requestIdsIn(entryServerRoot).length === 1);
		check("the provisioned surface proxies without prompting the local UI", entryUiCalls.length, 0);
		check("the abandoned proxy flow times out fail-closed", await roleProbe, null);
		check("the proxy flow's timed-out request file is gone", requestIdsIn(entryServerRoot).length, 0);

		// role selection 2: a session UI prompts through the captured ctx
		delete process.env[CHILD_ASK_ROOT_ENV];
		delete process.env[CHILD_ASK_TOKEN_ENV];
		await entryRegistered[0].handler({}, entryUiCtx);
		const uiResolver = globalThis.__piFenceAskServer.resolveHandler();
		check("the entry resolver returns a prompting surface for a UI session", typeof uiResolver, "function");
		const uiAsk = createForwardedAsk({
			requestId: randomUUID(),
			childToken: randomUUID(),
			agentName: "entry-wire",
			dispatchLabel: "entry wire label",
			toolName: "read",
			resolvedPath: "/opt/entry-x",
			reason: "entry fixture evidence",
			askedAt: 300_000,
		});
		const uiProvenance = { requestId: uiAsk.requestId, childToken: uiAsk.childToken, agentName: "entry-registry", dispatchLabel: "entry registry label", directory: "/opt/entry-x" };
		const uiAnswer = uiResolver(uiAsk, uiProvenance);
		check("the UI ruling prompts exactly once", entryUiCalls.length, 1);
		checkContains("the UI ruling names the registry agent", entryUiCalls[0] ? entryUiCalls[0].title : "", "entry-registry");
		checkContains("the UI ruling names the directory", entryUiCalls[0] ? entryUiCalls[0].title : "", "/opt/entry-x");
		checkDeep("the UI ruling offers Yes and No", entryUiCalls[0] ? entryUiCalls[0].choices : [], ["Yes", "No"]);
		check("a Yes ruling resolves true", await uiAnswer, true);

		// role selection 3: neither surface pends for staleness
		await entryRegistered[0].handler({}, { hasUI: false, ui: undefined });
		check("the entry resolver returns null without any surface", globalThis.__piFenceAskServer.resolveHandler(), null);

		// session_shutdown stops the server and removes the created root
		configureForwardingServer({ resolveHandler: () => null });
		ensureForwardingServer();
		check("the shutdown fixture started the server", globalThis.__piFenceAskServer.timer !== null, true);
		await entryRegistered[1].handler({}, entryUiCtx);
		check("the session shutdown cleared the timer", globalThis.__piFenceAskServer.timer, null);
		check("the session shutdown removed the created root", fs.existsSync(entryServerRoot), false);
	} finally {
		if (typeof savedEntryRoot === "string") process.env[CHILD_ASK_ROOT_ENV] = savedEntryRoot;
		else delete process.env[CHILD_ASK_ROOT_ENV];
		if (typeof savedEntryToken === "string") process.env[CHILD_ASK_TOKEN_ENV] = savedEntryToken;
		else delete process.env[CHILD_ASK_TOKEN_ENV];
		if (typeof savedEntryWait === "string") process.env[ASK_WAIT_ENV] = savedEntryWait;
		else delete process.env[ASK_WAIT_ENV];
		stopForwardingServer({ removeRoot: true });
		resetFenceAskState();
	}
}
resetFenceAskState();

// ---------------------------------------------------------------------

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
