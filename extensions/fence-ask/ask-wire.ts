/**
 * fence-ask wire: the child-parent ask-forwarding message contract
 *
 * FENCE-1's ask channel lets a headless child session surface an
 * out-of-scope access ask to its dispatching parent (which holds the
 * user channel) and receive the decision. This module is the pure
 * contract half of the channel: the message shapes both sides
 * exchange, their validators, serializers, the forwarding-directory
 * layout, the child-provisioning env keys, and the timing bounds. It
 * performs no I/O: the child's write-request/poll-response loop and
 * the parent's serving watcher consume it (unit FENCE-1-3), and the
 * spawn wiring composes from it (unit FENCE-1-2).
 *
 * Channel shape (Decision Log D1): file-based request/response under a
 * per-parent-session forwarding root. Each child writes one JSON
 * request file into requests/ named after its request id and polls
 * responses/ for the same-named decision file; the parent session owns
 * the root and serves it. Request ids are uuid v4 strings the asking
 * child generates; response filenames echo the request id, and
 * encodePathSegment/askFileName are the one name encoding both sides
 * share.
 *
 * Child provisioning contract: the spawn site passes the forwarding
 * root path in PISCOPE_ASK_FORWARDING_ROOT and the child's spawn token
 * in PISCOPE_ASK_CHILD_TOKEN; childProvisioningEnv is the pinned
 * fragment the subagent extension merges into the child's spawn env
 * (unit FENCE-1-2). The token is a uuid v4 issued by the parent's
 * subagent extension and registered in the grant ledger
 * (grant-ledger.ts) before the child starts; the serving loop admits
 * only asks carrying a token it issued, and a root path embedding the
 * parent session id plus a random component closes guessed-path
 * injection. Consumer obligations for FENCE-1-3: create the forwarding
 * root with mode 0700, because an other-user-readable root would
 * publish every request's token, paths, and provenance; and treat the
 * env chain as leaked by design, because the subagent spawn composes
 * the parent env wholesale, so the root path and the token ride every
 * grandchild's env through the plain spawn chain. The honest residual:
 * parent, children, and every descendant process run as one OS user,
 * so there is no integrity wall against hostile same-user code at all
 * (/proc/<pid>/environ is same-user readable, and the env chain hands
 * descendants the root and token outright). Keeping other users out
 * rests on the 0700 obligation, not on this module; against accidents
 * and processes that have not learned the root, the unguessable root
 * path and the token registry are the working tiers. Stated, not
 * claimed away.
 *
 * Policy bounds locked at execution sign-off: a child waits at most
 * DEFAULT_ASK_WAIT_MS (120 seconds) for its decision, overridable
 * through PISCOPE_ASK_WAIT_MS where resolveAskWaitMs treats an absent
 * or unusable override as the default; polls space POLL_INTERVAL_MS
 * apart (the GPS ParentAuthorizer calibration anchor). A missing
 * decision file after the wait bound means no authority ruled, never
 * user-denied, and the child blocks fail-closed.
 *
 * Degraded-seal invariant: a child whose release seal is degraded
 * blocks, never forwards (Decision Log D5, locked with the user). The
 * wire carries no seal field by design: the forward decision belongs
 * to the fence's branch, and degraded machinery must not manufacture
 * channel evidence.
 *
 * Decision semantics: grant or deny. A grant names the granted root
 * (the directory the ask sought). via records who decided: "user" (the
 * parent session's user answered the prompt), "session-dedup" (the
 * directory was already granted this session, so the ledger granted
 * without a new user round-trip), "session-deny" (the directory was
 * already denied by the user this session, so the ledger denied
 * without a new prompt; advisor memo F6's deny-memory fix), or "cap"
 * (denied by the per-child spam-cap policy before any prompt). The
 * pairing is validated: cap and session-deny pair only with deny,
 * session-dedup only with grant.
 *
 * Grant-key contract (advisor memo F2, review DC1): the ledger keys
 * grants and dedup on the directory grantScopeDirectory derives from
 * the fence's escaping candidate, form-aware (re-review 08 SEC-1): a
 * candidate that names or resolves to an existing directory keys
 * itself, so approving a directory ask grants exactly what was asked
 * (asking /opt/tools grants /opt/tools, never /opt); a file-form
 * candidate keys its parent directory; an unresolved write-ahead tail
 * keys the realpath of its not-yet-existing parent directory spelled
 * under the deepest existing ancestor, falling back to that literal
 * dirname when it does not resolve; the root path keys itself and no
 * branch derives above it. Every granted root reaches an allowed-root
 * set only through expandGrantedRoot's literal-plus-realpath dual
 * forms, the same shape parseExtraRoots gives configured roots. Both
 * rules are consumer obligations for FENCE-1-2 and FENCE-1-3; the
 * write-ahead env-round-trip gap and its pre-create remedy are
 * documented on grantScopeDirectory.
 *
 * Dependency-free by design (only node:path) so plain-node suites
 * exercise the contract directly, matching subagent/registry.ts.
 */

import * as path from "node:path";

/**
 * The per-child ask wait bound: how long a child's forwarded ask may
 * stay unanswered before the child treats the channel as unavailable
 * and blocks fail-closed. Locked at execution sign-off (120 seconds).
 */
export const DEFAULT_ASK_WAIT_MS = 120_000;

/**
 * Env override for the wait bound, parsed by resolveAskWaitMs; an
 * absent or unusable value keeps the default.
 */
export const ASK_WAIT_ENV = "PISCOPE_ASK_WAIT_MS";

/** Spacing between response polls while a child waits on its ask. */
export const POLL_INTERVAL_MS = 250;

/** Child env key carrying the parent session's forwarding root path. */
export const CHILD_ASK_ROOT_ENV = "PISCOPE_ASK_FORWARDING_ROOT";

/** Child env key carrying the child's spawn token. */
export const CHILD_ASK_TOKEN_ENV = "PISCOPE_ASK_CHILD_TOKEN";

/**
 * Child provisioning env fragment builder (unit FENCE-1-2). Merges
 * these two pairs into the child's spawn env alongside PI_MANAGER_MODE
 * and the composed PISCOPE_EXTRA_ROOTS.
 */
export interface ChildProvisioning {
	/** The uuid v4 spawn token the parent issued and registered. */
	childToken: string;
	/** The parent session's forwarding root path. */
	forwardingRoot: string;
}

/**
 * The child env fragment for one dispatch: the forwarding root under
 * CHILD_ASK_ROOT_ENV and the spawn token under CHILD_ASK_TOKEN_ENV,
 * exactly the two keys the child-side loop reads. Trusted in-process
 * caller (the subagent extension's spawn site); a defect throws, so a
 * wiring bug fails the dispatch loudly instead of shipping a child
 * that cannot ask or that would pollute the parent's serving root
 * with unvalidated values.
 */
export function childProvisioningEnv(provisioning: ChildProvisioning): Record<string, string> {
	if (!isUuidV4(provisioning?.childToken)) {
		throw new TypeError("child provisioning token must be a uuid v4 string");
	}
	if (!isValidForwardingRoot(provisioning?.forwardingRoot)) {
		throw new TypeError("child provisioning forwarding root must be an absolute normalized path");
	}
	return {
		[CHILD_ASK_ROOT_ENV]: provisioning.forwardingRoot,
		[CHILD_ASK_TOKEN_ENV]: provisioning.childToken,
	};
}

/** Requests subdirectory under a forwarding root (GPS layout). */
export const REQUESTS_DIR_NAME = "requests";

/** Responses subdirectory under a forwarding root (GPS layout). */
export const RESPONSES_DIR_NAME = "responses";

/** Forwarded message file suffix inside requests/ and responses/. */
export const ASK_FILE_SUFFIX = ".json";

/** Bound for the tool name field. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Bound for agentName and dispatchLabel. */
export const MAX_IDENTITY_LENGTH = 256;

/** Bound for the ask reason and any decision reason. */
export const MAX_REASON_LENGTH = 4096;

/** Bound for resolvedPath and grantedRoot (PATH_MAX-sized). */
export const MAX_PATH_LENGTH = 4096;

/** Who decided a forwarded ask, as recorded on the wire. */
export type DecisionVia = "user" | "session-dedup" | "session-deny" | "cap";

/** The decision a forwarded ask received. */
export type DecisionKind = "grant" | "deny";

/**
 * Child -> parent forwarded ask: one out-of-scope access request the
 * child wants its parent session's user to rule on. Pure data; the
 * child serializes it into requests/ under the forwarding root. Every
 * field is child-serialized and therefore untrusted display input on
 * the parent side; the parent's prompt takes its PROVENANCE from the
 * ledger's promptProvenanceForRequest (registry identity plus the
 * admitted directory key), never from these fields.
 */
export interface ForwardedAsk {
	/** uuid v4 the asking child generates; names the request and response files. */
	requestId: string;
	/** uuid v4 spawn token issued by the parent's subagent extension. */
	childToken: string;
	/**
	 * Child-asserted fleet name (display-at-most: the parent surfaces
	 * promptProvenanceForRequest's registry identity as provenance,
	 * never this field).
	 */
	agentName: string;
	/** Child-asserted dispatch label (display-at-most, as agentName). */
	dispatchLabel: string;
	/**
	 * The gated tool whose call asked: path tools and bash alike, so
	 * the bash ask branch routes through this one channel shape
	 * (sign-off Q6) without a second wire.
	 */
	toolName: string;
	/**
	 * The grant-scope directory the ask seeks: the forward branch
	 * derives it from the fence's escaping candidate with
	 * grantScopeDirectory (the pinned grant-key rule).
	 */
	resolvedPath: string;
	/**
	 * Child-serialized ask evidence rendered in the prompt body
	 * (display content, not provenance; the registry identity and the
	 * ledger directory carry the provenance).
	 */
	reason: string;
	/** Epoch ms the child created the ask (child clock; ordering only). */
	askedAt: number;
}

/**
 * Parent -> child decision on one forwarded ask, echoing the request
 * identity so the child honors only responses to requests it created.
 */
export interface ForwardedDecision {
	/** Echoes ForwardedAsk.requestId. */
	requestId: string;
	/** Echoes the asking child's token. */
	childToken: string;
	decision: DecisionKind;
	/** The granted directory when decision is "grant"; null on deny. */
	grantedRoot: string | null;
	via: DecisionVia;
	/** Actionable text, especially on deny (user refusal, cap policy). */
	reason: string;
	/** Epoch ms the parent decided (parent clock). */
	decidedAt: number;
}

/**
 * uuid v4 shape: our ids come only from crypto.randomUUID, so the
 * pattern pins version 4 and the RFC variant bits, lowercase.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUuidV4(value: unknown): value is string {
	return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isEpochMs(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBoundedAbsolutePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PATH_LENGTH &&
		path.isAbsolute(value)
	);
}

/**
 * The first structural defect of a candidate ForwardedAsk, or null
 * when the value is a valid ask. Backs isValidForwardedAsk (null means
 * valid) and createForwardedAsk (a defect throws); not exported
 * because the validators and the throw messages carry the same text.
 */
function forwardedAskDefect(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "forwarded ask is not an object";
	}
	const ask = value as Record<string, unknown>;
	if (!isUuidV4(ask.requestId)) return "requestId must be a uuid v4 string";
	if (!isUuidV4(ask.childToken)) return "childToken must be a uuid v4 string";
	if (!isBoundedText(ask.agentName, MAX_IDENTITY_LENGTH)) {
		return `agentName must be a non-empty string of at most ${MAX_IDENTITY_LENGTH} characters`;
	}
	if (!isBoundedText(ask.dispatchLabel, MAX_IDENTITY_LENGTH)) {
		return `dispatchLabel must be a non-empty string of at most ${MAX_IDENTITY_LENGTH} characters`;
	}
	if (!isBoundedText(ask.toolName, MAX_TOOL_NAME_LENGTH)) {
		return `toolName must be a non-empty string of at most ${MAX_TOOL_NAME_LENGTH} characters`;
	}
	if (!isBoundedAbsolutePath(ask.resolvedPath)) {
		return `resolvedPath must be an absolute path of at most ${MAX_PATH_LENGTH} characters`;
	}
	if (!isBoundedText(ask.reason, MAX_REASON_LENGTH)) {
		return `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`;
	}
	if (!isEpochMs(ask.askedAt)) return "askedAt must be a positive integer epoch ms";
	return null;
}

/**
 * The first structural defect of a candidate ForwardedDecision, or
 * null when the value is a valid decision. Also pins the via/decision
 * pairing: cap is a deny-only provenance and session-dedup a
 * grant-only one, so a mispaired decision cannot masquerade as a
 * different authority's ruling.
 */
function forwardedDecisionDefect(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "forwarded decision is not an object";
	}
	const decision = value as Record<string, unknown>;
	if (!isUuidV4(decision.requestId)) return "requestId must be a uuid v4 string";
	if (!isUuidV4(decision.childToken)) return "childToken must be a uuid v4 string";
	if (decision.decision !== "grant" && decision.decision !== "deny") {
		return 'decision must be "grant" or "deny"';
	}
	if (decision.via !== "user" && decision.via !== "session-dedup" && decision.via !== "session-deny" && decision.via !== "cap") {
		return 'via must be "user", "session-dedup", "session-deny", or "cap"';
	}
	if (decision.via === "cap" && decision.decision !== "deny") {
		return 'via "cap" pairs only with decision "deny"';
	}
	if (decision.via === "session-dedup" && decision.decision !== "grant") {
		return 'via "session-dedup" pairs only with decision "grant"';
	}
	if (decision.via === "session-deny" && decision.decision !== "deny") {
		return 'via "session-deny" pairs only with decision "deny"';
	}
	if (decision.decision === "grant") {
		if (!isBoundedAbsolutePath(decision.grantedRoot)) {
			return "a grant carries the granted absolute path";
		}
	} else if (decision.grantedRoot !== null) {
		return "a deny carries grantedRoot null";
	}
	if (!isBoundedText(decision.reason, MAX_REASON_LENGTH)) {
		return `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`;
	}
	if (!isEpochMs(decision.decidedAt)) return "decidedAt must be a positive integer epoch ms";
	return null;
}

/** Whether a candidate value is a structurally valid forwarded ask. */
export function isValidForwardedAsk(value: unknown): value is ForwardedAsk {
	return forwardedAskDefect(value) === null;
}

/** Whether a candidate value is a structurally valid forwarded decision. */
export function isValidForwardedDecision(value: unknown): value is ForwardedDecision {
	return forwardedDecisionDefect(value) === null;
}

/**
 * Build a validated ask from trusted in-process fields (the fence's
 * forward branch). A programmer error throws; the file-parse path is
 * parseForwardedAsk, which never throws.
 */
export function createForwardedAsk(fields: ForwardedAsk): ForwardedAsk {
	const defect = forwardedAskDefect(fields);
	if (defect !== null) throw new TypeError(defect);
	return { ...fields };
}

/**
 * Build a validated decision from trusted in-process fields (the
 * serving loop). A programmer error throws; the file-parse path is
 * parseForwardedDecision, which never throws.
 */
export function createForwardedDecision(fields: ForwardedDecision): ForwardedDecision {
	const defect = forwardedDecisionDefect(fields);
	if (defect !== null) throw new TypeError(defect);
	return { ...fields };
}

/** Serialize an ask to its JSON file body. */
export function serializeForwardedAsk(ask: ForwardedAsk): string {
	return JSON.stringify(ask);
}

/** Serialize a decision to its JSON file body. */
export function serializeForwardedDecision(decision: ForwardedDecision): string {
	return JSON.stringify(decision);
}

/**
 * Parse one request file body into a validated ask. The body is
 * external input: anything wrong (bad JSON, shape, bounds) returns
 * null and the caller refuses the request, fail closed, never throws.
 */
export function parseForwardedAsk(text: string): ForwardedAsk | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return isValidForwardedAsk(parsed) ? parsed : null;
}

/**
 * Parse one response file body into a validated decision, the same
 * fail-closed contract as parseForwardedAsk.
 */
export function parseForwardedDecision(text: string): ForwardedDecision | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	return isValidForwardedDecision(parsed) ? parsed : null;
}

/**
 * Whether a parsed decision answers THIS child's THIS request: both
 * echo fields must match, so a response written for another request or
 * another child is never honored (the child additionally honors only
 * decisions it read from its own responses directory). This is an
 * accident-and-mixup guard, NOT integrity: the request file publishes
 * both ids to any reader of requests/, so any same-user process can
 * forge a decision this check accepts perfectly. The same-user
 * residual in the module header carries that, which is why the root
 * is created 0700 and named unguessably.
 */
export function decisionMatchesRequest(
	decision: ForwardedDecision,
	requestId: string,
	childToken: string,
): boolean {
	return decision.requestId === requestId && decision.childToken === childToken;
}

/**
 * Resolve the child wait bound from its env override: a string of
 * decimal digits naming a positive integer is honored as ms; anything
 * else (absent, empty, signed, float, exponent, padded) keeps the
 * locked default. Strict digits: the override is set once by an
 * operator, never parsed out of untrusted text.
 */
export function resolveAskWaitMs(rawValue: string | undefined): number {
	if (typeof rawValue !== "string" || !/^[0-9]+$/.test(rawValue)) return DEFAULT_ASK_WAIT_MS;
	const parsed = Number(rawValue);
	return parsed > 0 ? parsed : DEFAULT_ASK_WAIT_MS;
}

/**
 * What the candidate names on the caller's fs at ask time: an
 * existing directory (possibly through a symlink), an existing
 * non-directory file, or nothing yet (the unresolved write-ahead
 * class). The integration boundary classifies (it has fs) and this
 * module applies the form-aware rule mechanically.
 */
export type AskCandidateForm = "directory" | "file" | "unresolved";

/**
 * The grant key for one forwarded ask, form-aware (advisor memo F2,
 * review DC1; re-review 08 SEC-1/DC-1: a directory ask keys itself,
 * because a parent-dir rule over directory asks would let one Yes on
 * `ls /opt/tools` grant /opt and one on a top-level directory grant
 * the root). Pinned here so FENCE-1-2 and FENCE-1-3 cannot each
 * invent a rule. The caller has fs and classifies the candidate
 * before calling: form "directory" passes the candidate's OWN
 * realpath (the ask IS for that directory; a symlinked directory
 * passes its physical realpath, so two lexical spellings of one
 * physical directory converge on one grant key and one prompt); form
 * "file" passes the lexical dirname's realpath; form "unresolved"
 * passes the realpath of the not-yet-existing parent directory
 * spelled under the deepest existing ancestor (the write-ahead
 * class). Pass null when that realpath fails; this function is
 * fs-free and falls back mechanically to the literal candidate for
 * the directory form (trailing separators stripped, so the key never
 * carries one) and to the literal dirname for the file and
 * unresolved forms. The directory fallback keys the candidate's
 * literal self, never its parent: a failed realpath must not shrink
 * the key one level up the tree. The root path keys itself under
 * every form, and no branch derives above it (path.dirname of an
 * absolute bounded path stays within the root).
 *
 * Normalization contract (consumer obligation for FENCE-1-3): every
 * derived key and every granted root MUST be expanded to its
 * literal-plus-realpath dual forms with expandGrantedRoot before
 * entering an allowed-root set, mirroring parseExtraRoots'
 * declaredRootForms; a single-form grant re-creates the
 * lexical-vs-realpath livelock where the dedup answers granted while
 * the verdict keeps asking.
 *
 * Known property-1 gap: a grant keyed to a not-yet-existing directory
 * (the write-ahead class) drops out of the composed env round-trip:
 * parseExtraRoots dual-forms each entry through its realpath and drops
 * entries whose realpath fails, so the child's scope silently lacks
 * the root while the parent's ledger still holds it. Named remedy: the
 * 1-3 integration pre-creates the granted directory before dispatch
 * (fs.mkdir recursive) or keeps such grants in-process only and
 * discloses the child-scope gap at the ask.
 */
export function grantScopeDirectory(
	candidate: string,
	form: AskCandidateForm,
	resolvedRealpath: string | null,
): string {
	if (!isBoundedAbsolutePath(candidate)) throw new TypeError("grant candidate must be an absolute bounded path");
	if (form !== "directory" && form !== "file" && form !== "unresolved") {
		throw new TypeError("form must be one of directory, file, unresolved");
	}
	if (resolvedRealpath !== null && !isBoundedAbsolutePath(resolvedRealpath)) {
		throw new TypeError("resolvedRealpath must be null or an absolute bounded path");
	}
	if (form === "directory") {
		if (resolvedRealpath !== null) return resolvedRealpath;
		return candidate.replace(/\/+$/, "") || "/";
	}
	return resolvedRealpath ?? path.dirname(candidate);
}

/**
 * The dual forms of one granted root: the literal granted spelling
 * plus its realpath when the caller's fs resolved it and it differs.
 * The pure half of the normalization contract (see
 * grantScopeDirectory): the integration boundary resolves the realpath
 * and passes null when it fails, keeping the fs out of this module.
 */
export function expandGrantedRoot(root: string, rootRealpath: string | null): string[] {
	if (!isBoundedAbsolutePath(root)) throw new TypeError("granted root must be an absolute bounded path");
	if (rootRealpath !== null && !isBoundedAbsolutePath(rootRealpath)) {
		throw new TypeError("rootRealpath must be null or an absolute bounded path");
	}
	if (rootRealpath === null || rootRealpath === root) return [root];
	return [root, rootRealpath];
}

/**
 * Percent-encode one forwarding-path component outside
 * [A-Za-z0-9._-] so session ids and nonces become one safe, stable,
 * reversible filename spelling both sides share. encodeURIComponent
 * leaves !'()* unescaped; those are escaped here too, so no remaining
 * character can split a component or form traversal syntax.
 */
export function encodePathSegment(raw: string): string {
	return encodeURIComponent(raw).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The requests directory under a forwarding root. */
export function forwardingRequestsDir(root: string): string {
	return path.join(root, REQUESTS_DIR_NAME);
}

/** The responses directory under a forwarding root. */
export function forwardingResponsesDir(root: string): string {
	return path.join(root, RESPONSES_DIR_NAME);
}

/**
 * The shared file name for one ask and its decision: the request id
 * with the JSON suffix, placed in requests/ and responses/
 * respectively. A non-uuid id names no file (null): the id is the only
 * sanctioned key, and refusing others keeps a crafted name from
 * leaving the forwarding directories.
 */
export function askFileName(requestId: string): string | null {
	return isUuidV4(requestId) ? `${requestId}${ASK_FILE_SUFFIX}` : null;
}

/**
 * Whether a forwarding root received over env is structurally safe to
 * use: non-empty, absolute, normalized (resolve round-trips it, so no
 * interior or trailing . or .. segments, no duplicate separators, no
 * trailing slash). The child trusts nothing else about the path;
 * reachability is the poll loop's concern, not the validator's.
 */
export function isValidForwardingRoot(root: unknown): root is string {
	return typeof root === "string" && root.length > 0 && path.isAbsolute(root) && path.resolve(root) === root;
}
