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
 */

import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
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
	childIdentity,
	composeInheritedExtraRoots,
	expireStaleAsks,
	getFenceAskState,
	grantsForChild,
	hasGrantForChild,
	isLiveChild,
	isSessionGranted,
	outstandingAskForChild,
	parentGrantedDirectories,
	pendingAskCountForChild,
	promptProvenanceForRequest,
	recordParentGrant,
	releaseChild,
	resetFenceAskState,
	resolveChildAsk,
	registerLiveChild,
	sessionGrantedDirectories,
} from "../extensions/fence-ask/grant-ledger.ts";

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

// ---------------------------------------------------------------------

const passed = total - failed;
console.log(`\n${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
