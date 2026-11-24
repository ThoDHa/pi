/**
 * fence-ask grant ledger: per-child grants, session-wide dedup, and
 * the spam-cap admission machine
 *
 * FENCE-1's parent-side state for forwarded asks, three maps over one
 * shared state object:
 *
 * - liveChildren: the spawn-token registry (Decision Log D3). The
 *   subagent extension registers each child at spawn with the uuid v4
 *   token it generated; admitChildAsk refuses asks from any other
 *   token, so a process the parent did not spawn cannot prompt the
 *   user. releaseChild retires a token (child exit) and drops its
 *   pending asks; its grants stay.
 * - grantsByChild: per-child grant records (child token, directory,
 *   granted-at, via, source). Property 3 lives here: a directory granted for
 *   child A is visible to child A's checks and invisible to child B's;
 *   child B rides only its own records. Every record carries source
 *   "child-ask": its authority is a forwarded ask the user approved.
 * - parentOwnGrants: the parent session's own interactive Yes records
 *   (property 1's inheritance source, advisor memo F1). The parent is
 *   not a child, so its records bind no token (empty childToken);
 *   ONLY these records compose into a spawned child's inherited scope.
 *   A child-ask grant dedups at ask time and never composes silently
 *   into another child's scope (the settled reading-b reconciliation:
 *   sibling grants dedup at ASK time, never inherit).
 * - sessionWideGranted: the session-scoped directory-dedup index, fed
 *   by every grant source (child-ask approvals and parent-own grants
 *   alike). Property 4 lives here: once ANY grant for a directory
 *   exists in this session, a DIFFERENT child asking for the same
 *   directory is granted through admitChildAsk's dedup outcome without
 *   a new user round-trip, and the grant is recorded for the asking
 *   child too. The index answers asks only; inheritance reads
 *   parentOwnGrants, never this index.
 * - sessionWideDenied: the session-scoped denial memory (advisor memo
 *   F6). A user refusal records the directory, and every later ask for
 *   it is denied from memory with the session-deny provenance, no new
 *   prompt and no cap slot consumed: one user No costs one prompt, not
 *   one prompt per re-ask. A grant rules first when both exist (a
 *   parent-own grant after a denial is the user's later word); a cap
 *   denial records nothing, because it judges the child's cadence, not
 *   the directory.
 *
 * Memory is in-process and process-lifetime (locked with the user,
 * sign-off Q3): grants die with the parent process, so there are no
 * stale grants, no grant files, and no ledger cleanup beyond the
 * forwarding root itself. "Same session" maps to process lifetime by
 * decision.
 *
 * Admission runs the locked spam-cap policy (sign-off Q5): at most
 * ASK_OUTSTANDING_CAP outstanding ask per child, a second ask for a
 * directory already pending anywhere in the session coalesces onto
 * that pending entry (across children: child B asking child A's
 * pending directory attaches to it and learns the decision when the
 * user answers, never auto-granting off A's unanswered ask), further
 * distinct directories queue up to ASK_QUEUE_CAPACITY, and beyond the
 * cap the ask is denied with the policy reason before any prompt.
 * resolveChildAsk applies the user's answer to the outstanding ask and
 * every coalesced attachment, records the grants, and promotes the
 * next queued entry into the outstanding slot.
 *
 * A parent-side staleness bound (advisor memo F3) keeps a zombie entry
 * from holding a directory hostage: expireStaleAsks sweeps entries
 * older than ASK_HOST_STALE_MS (default: the child wait bound, past
 * which the asker has stopped listening), and admitChildAsk re-hosts a
 * stale directory instead of coalescing onto a dead entry, so a kill
 * -9 child costs one wait bound, not the rest of the session.
 *
 * The state converges on globalThis via getFenceAskState(): pi
 * evaluates each extension entrypoint's modules in a fresh jiti
 * instance (moduleCache: false), so module-level state would exist
 * twice, and the fence, the subagent extension, and the serving loop
 * must share one ledger; extensions/subagent/registry.ts is the
 * established in-repo precedent. resetFenceAskState clears in place so
 * references held across extensions stay valid.
 *
 * Dependency-free by design (only node:path plus ask-wire types) so
 * plain-node suites exercise the machine directly.
 */

import * as path from "node:path";
import { DEFAULT_ASK_WAIT_MS } from "./ask-wire.ts";
import type { DecisionVia, ForwardedDecision } from "./ask-wire.ts";

/**
 * Locked spam cap (sign-off Q5): at most one outstanding ask per
 * child, embodied by the single outstanding slot of ChildPendingAsks.
 */
export const ASK_OUTSTANDING_CAP = 1;

/**
 * Locked spam cap (sign-off Q5): how many distinct-directory asks may
 * queue behind a child's outstanding ask; beyond it, deny.
 */
export const ASK_QUEUE_CAPACITY = 3;

/** Deny reason for asks beyond the per-child cap. */
export const ASK_CAP_DENY_REASON = `denied by the ask cap: this child already carries ${ASK_OUTSTANDING_CAP} outstanding ask and a full ${ASK_QUEUE_CAPACITY}-ask queue; they must resolve before another directory is admitted`;

/**
 * Parent-side staleness bound (advisor memo F3): a pending ask older
 * than the child wait bound can no longer reach its asker (the child
 * treated the channel as unavailable and blocked fail-closed), so the
 * entry serves nobody and only holds its directory hostage. Defaults
 * to the child wait bound; the serving loop may pass its own maxAge.
 */
export const ASK_HOST_STALE_MS = DEFAULT_ASK_WAIT_MS;

/** Grant reason when the dedup shortcut answers without a new prompt. */
export const ASK_SESSION_DEDUP_REASON = "granted without a new prompt: the directory is already granted for this session";

/** Grant reason when the parent session's user answered Yes. */
export const ASK_USER_GRANT_REASON = "granted by the parent session's user";

/** Deny reason when the parent session's user answered anything but Yes. */
export const ASK_USER_DENY_REASON = "declined by the parent session's user";

/** Deny reason when the ledger answers from the session's denial memory. */
export const ASK_SESSION_DENY_REASON = "denied without a new prompt: the parent session's user already declined this directory";

/** The via recorded on a grant record: grants never carry a deny provenance. */
export type GrantVia = Exclude<DecisionVia, "cap" | "session-deny">;

/** Where a grant's authority came from (advisor memo F1 amendment). */
export type GrantSource = "parent-own" | "child-ask";

/** Parent-issued identity of one live child process. */
export interface ChildIdentity {
	/** The dispatching agent's fleet name (provenance for prompts). */
	agentName: string;
	/** The dispatch label beside the agent name. */
	dispatchLabel: string;
	/** Epoch ms the token was issued (parent clock). */
	issuedAt: number;
}

/** One directory granted to one child, or to the parent session itself. */
export interface GrantRecord {
	/** The child the grant binds to (property 3: per-child scoping); empty for parent-own records, which bind no child. */
	childToken: string;
	/** The granted directory, resolved form as the ask carried it. */
	directory: string;
	/** Epoch ms the grant was recorded (parent clock). */
	grantedAt: number;
	/** Who produced the grant: the user's answer or the session dedup. */
	via: GrantVia;
	/** parent-own: the parent's own interactive Yes; child-ask: an approved forwarded ask. */
	source: GrantSource;
}

/** Another request attached to a pending ask for the same directory. */
export interface CoalescedAsk {
	/** The attached request's wire id (its own response file key). */
	requestId: string;
	/** The attached asking child's spawn token. */
	childToken: string;
}

/** One admitted-but-unresolved ask slot (outstanding or queued). */
export interface PendingAsk {
	/** The asking child's wire request id (its response file key). */
	requestId: string;
	/** The asking child's spawn token. */
	childToken: string;
	/** The directory the ask seeks; the coalescing key. */
	directory: string;
	/** Epoch ms the ask was admitted (parent clock). */
	askedAt: number;
	/** Coalesced asks (other request ids) sharing this entry's fate. */
	coalesced: CoalescedAsk[];
}

/** One child's admission state: the slot before the user, plus its queue. */
export interface ChildPendingAsks {
	/** The single ask currently awaiting the user's decision, if any. */
	outstanding: PendingAsk | null;
	/** Distinct-directory asks waiting behind the outstanding slot. */
	queue: PendingAsk[];
}

/** The whole ledger, converged on globalThis. */
export interface FenceAskState {
	/** Directory -> epoch ms first granted this session; insertion order preserved. */
	sessionWideGranted: Map<string, number>;
	/** Directory -> the session's recorded denial (advisor memo F6). */
	sessionWideDenied: Map<string, { deniedAt: number; via: DecisionVia }>;
	/** Child token -> that child's grant records, all source "child-ask". */
	grantsByChild: Map<string, GrantRecord[]>;
	/** The parent session's own grants (property 1's inheritance source), in grant order. */
	parentOwnGrants: GrantRecord[];
	/** Child token -> identity, for tokens the parent issued. */
	liveChildren: Map<string, ChildIdentity>;
	/** Child token -> its admission state. */
	pendingByChild: Map<string, ChildPendingAsks>;
}

/** What admitChildAsk decided to do with one incoming ask. */
export type AdmitOutcome =
	| { kind: "refused-unknown-child" }
	| { kind: "granted-dedup"; decision: ForwardedDecision }
	| { kind: "denied-dedup"; decision: ForwardedDecision }
	| { kind: "outstanding" }
	| { kind: "queued"; position: number }
	| { kind: "coalesced"; canonicalRequestId: string }
	| { kind: "denied-cap"; decision: ForwardedDecision };

/** What resolveChildAsk produced for one answered ask. */
export type ResolveOutcome =
	| { kind: "unknown" }
	| { kind: "not-outstanding" }
	| { kind: "resolved"; decisions: ForwardedDecision[]; grants: GrantRecord[] };

/**
 * The four root sources of a child spawn, plus the two working
 * directories the Q4 ruling compares. Every array arrives already
 * validated and absolute from its producer (parseFenceConfig,
 * parseExtraRoots dual forms, the ledger's resolved grant records), so
 * the composer only unions, dedups, and orders.
 */
export interface InheritedRootsInput {
	/** The parent's tracked config roots (parseFenceConfig output). */
	configRoots: string[];
	/** The parent's local overlay roots. */
	overlayRoots: string[];
	/** The parent's own PISCOPE_EXTRA_ROOTS (parseExtraRoots output). */
	envRoots: string[];
	/**
	 * The parent's own grants: parentGrantedDirectories(). Parent-own
	 * records only: a child-ask grant dedups at ask time and never
	 * composes into another child's silent scope (advisor memo F1, the
	 * settled reading-b reconciliation of properties 1 and 3).
	 */
	parentGrantRoots: string[];
	/** The parent session's working directory. */
	parentSessionCwd: string;
	/** The cwd the child is dispatched into. */
	dispatchCwd: string;
}

declare global {
	// Language-level escape required by the cross-extension contract: pi
	// gives every extension entrypoint a fresh module instance (jiti,
	// moduleCache: false), so the shared ledger must live on globalThis,
	// which no module system scopes.
	var __piFenceAskState: FenceAskState | undefined;
}

/**
 * The shared grant ledger, converged on globalThis. Safe to call from
 * every module instance: the first evaluation creates the object
 * (`??=`) and every later one returns it, so the fence, the subagent
 * extension, and the serving loop hold one ledger. Clearing happens in
 * place (resetFenceAskState), never by replacement, so references held
 * across extensions stay valid.
 */
export function getFenceAskState(): FenceAskState {
	globalThis.__piFenceAskState ??= {
		sessionWideGranted: new Map(),
		sessionWideDenied: new Map(),
		grantsByChild: new Map(),
		parentOwnGrants: [],
		liveChildren: new Map(),
		pendingByChild: new Map(),
	};
	return globalThis.__piFenceAskState;
}

/**
 * Clear every ledger map in place, keeping the state object's
 * identity. Suite isolation hook: production grants live for the
 * process lifetime (Q3) and nothing in production resets them.
 */
export function resetFenceAskState(): void {
	const state = getFenceAskState();
	state.sessionWideGranted.clear();
	state.sessionWideDenied.clear();
	state.grantsByChild.clear();
	state.parentOwnGrants.length = 0;
	state.liveChildren.clear();
	state.pendingByChild.clear();
}

/**
 * Register one child process as live under a freshly issued spawn
 * token (the subagent extension, at spawn). Re-registration with the
 * same token replaces the identity in place; tokens are single-use by
 * contract, so a duplicate call is a caller bug that stays visible
 * rather than being refused silently.
 */
export function registerLiveChild(
	childToken: string,
	agentName: string,
	dispatchLabel: string,
	now: number = Date.now(),
): void {
	getFenceAskState().liveChildren.set(childToken, { agentName, dispatchLabel, issuedAt: now });
}

/** Whether this token belongs to a child the parent spawned and has not released. */
export function isLiveChild(childToken: string): boolean {
	return getFenceAskState().liveChildren.has(childToken);
}

/** The registered identity for a token, or undefined for an unknown one. */
export function childIdentity(childToken: string): ChildIdentity | undefined {
	return getFenceAskState().liveChildren.get(childToken);
}

/**
 * Retire a child's token (child exit): the token stops admitting asks
 * and its pending asks (outstanding, queue, and their coalesced
 * attachments) are dropped, so those children's polls run out to the
 * wait bound and read as no authority ruled. Grants survive: the
 * session memory is keyed by directory, not by liveness (Q3).
 */
export function releaseChild(childToken: string): void {
	const state = getFenceAskState();
	state.liveChildren.delete(childToken);
	state.pendingByChild.delete(childToken);
}

/** Whether a child holds a grant for exactly this directory (property 3). */
export function hasGrantForChild(childToken: string, directory: string): boolean {
	const grants = getFenceAskState().grantsByChild.get(childToken);
	return grants !== undefined && grants.some((grant) => grant.directory === directory);
}

/** The directories a child holds grants for, in grant order. */
export function grantsForChild(childToken: string): string[] {
	const grants = getFenceAskState().grantsByChild.get(childToken);
	return grants === undefined ? [] : grants.map((grant) => grant.directory);
}

/** Whether ANY grant for this directory exists this session (property 4). */
export function isSessionGranted(directory: string): boolean {
	return getFenceAskState().sessionWideGranted.has(directory);
}

/**
 * Record one parent-own grant (the fence's interactive Yes on the
 * parent's own behalf: property 1's producer, advisor memo F1). The
 * record joins parentOwnGrants, the only inheritance source, and feeds
 * the ask-dedup index like every grant source. Idempotent per
 * directory: re-recording returns the first record untouched.
 * Trusted in-process caller (the fence); the directory's canonical
 * form is the caller's obligation (grantScopeDirectory).
 */
export function recordParentGrant(directory: string, now: number = Date.now()): GrantRecord {
	const state = getFenceAskState();
	const existing = state.parentOwnGrants.find((grant) => grant.directory === directory);
	if (existing !== undefined) return existing;
	const record: GrantRecord = { childToken: "", directory, grantedAt: now, via: "user", source: "parent-own" };
	state.parentOwnGrants.push(record);
	if (!state.sessionWideGranted.has(directory)) state.sessionWideGranted.set(directory, now);
	return record;
}

/** Every parent-own granted directory, in grant order: the inheritance source. */
export function parentGrantedDirectories(): string[] {
	return getFenceAskState().parentOwnGrants.map((grant) => grant.directory);
}

/** Every session-wide granted directory, in first-grant order. */
export function sessionGrantedDirectories(): string[] {
	return [...getFenceAskState().sessionWideGranted.keys()];
}

/** The prompt provenance the parent surfaces for one forwarded ask. */
export interface AskPromptProvenance {
	/** The request whose provenance is bound (as looked up). */
	requestId: string;
	/** The asking child's spawn token. */
	childToken: string;
	/** The registry's agent name for that token, never a wire string. */
	agentName: string;
	/** The registry's dispatch label for that token, never a wire string. */
	dispatchLabel: string;
	/** The ledger's admitted directory key, never a wire string. */
	directory: string;
}

/**
 * The bound provenance for the parent-side prompt (advisor memo F5):
 * the serving loop constructs what it surfaces from THIS lookup, whose
 * identity fields come from the spawn registry (childIdentity) and
 * whose directory is the ledger's admitted key. The wire's
 * agentName and dispatchLabel are child-asserted display-at-most and
 * are never provenance: a token-holding process can claim any name on
 * the wire, but the prompt names the child the parent actually
 * spawned. Resolves outstanding hosts, queued entries, and coalesced
 * attachments (an attachment binds its own child under the host
 * directory); an unknown id has none (null).
 */
export function promptProvenanceForRequest(requestId: string): AskPromptProvenance | null {
	const state = getFenceAskState();
	for (const pending of state.pendingByChild.values()) {
		const entries: PendingAsk[] = pending.outstanding === null ? [...pending.queue] : [pending.outstanding, ...pending.queue];
		for (const entry of entries) {
			const owner = entry.requestId === requestId
				? entry.childToken
				: entry.coalesced.find((attached) => attached.requestId === requestId)?.childToken;
			if (owner === undefined) continue;
			const identity = state.liveChildren.get(owner);
			if (identity === undefined) continue;
			return {
				requestId,
				childToken: owner,
				agentName: identity.agentName,
				dispatchLabel: identity.dispatchLabel,
				directory: entry.directory,
			};
		}
	}
	return null;
}

/** The child's single outstanding ask, or null when it has none. */
export function outstandingAskForChild(childToken: string): PendingAsk | null {
	const pending = getFenceAskState().pendingByChild.get(childToken);
	return pending === undefined ? null : pending.outstanding;
}

/**
 * How many of the child's own asks are in flight: the outstanding slot
 * plus its queue. Coalesced attachments do not count; they ride their
 * host's slot and belong to other request ids.
 */
export function pendingAskCountForChild(childToken: string): number {
	const pending = getFenceAskState().pendingByChild.get(childToken);
	if (pending === undefined) return 0;
	return pending.queue.length + (pending.outstanding === null ? 0 : 1);
}

function grantDecision(
	requestId: string,
	childToken: string,
	directory: string,
	via: GrantVia,
	reason: string,
	now: number,
): ForwardedDecision {
	return { requestId, childToken, decision: "grant", grantedRoot: directory, via, reason, decidedAt: now };
}

function denyDecision(
	requestId: string,
	childToken: string,
	via: DecisionVia,
	reason: string,
	now: number,
): ForwardedDecision {
	return { requestId, childToken, decision: "deny", grantedRoot: null, via, reason, decidedAt: now };
}

function ensureChildGrants(state: FenceAskState, childToken: string): GrantRecord[] {
	let grants = state.grantsByChild.get(childToken);
	if (grants === undefined) {
		grants = [];
		state.grantsByChild.set(childToken, grants);
	}
	return grants;
}

function ensureChildPending(state: FenceAskState, childToken: string): ChildPendingAsks {
	let pending = state.pendingByChild.get(childToken);
	if (pending === undefined) {
		pending = { outstanding: null, queue: [] };
		state.pendingByChild.set(childToken, pending);
	}
	return pending;
}

function findPendingHostByDirectory(state: FenceAskState, directory: string): PendingHostLocation | null {
	for (const pending of state.pendingByChild.values()) {
		if (pending.outstanding !== null && pending.outstanding.directory === directory) {
			return { pending, entry: pending.outstanding, queued: false };
		}
		const index = pending.queue.findIndex((queued) => queued.directory === directory);
		if (index !== -1) return { pending, entry: pending.queue[index], queued: true };
	}
	return null;
}

/** Where a same-directory pending ask lives inside the ledger. */
interface PendingHostLocation {
	/** The holding child's admission state. */
	pending: ChildPendingAsks;
	/** The pending entry itself (outstanding or queued). */
	entry: PendingAsk;
	/** Whether the entry sits in the queue rather than the outstanding slot. */
	queued: boolean;
}

/**
 * Drop one pending entry and its coalesced attachments from the
 * ledger, promoting the queue head when the outstanding slot vacates
 * (the release and staleness semantics share this shape: attachments
 * die with their host, and the queue keeps serving). Returns every
 * dead request id, host first then attachments.
 */
function evictPendingHost(location: PendingHostLocation): string[] {
	const evicted = [location.entry.requestId, ...location.entry.coalesced.map((attached) => attached.requestId)];
	if (location.queued) {
		location.pending.queue = location.pending.queue.filter((queued) => queued !== location.entry);
	} else {
		location.pending.outstanding = location.pending.queue.shift() ?? null;
	}
	return evicted;
}

function findOutstandingHostByRequestId(state: FenceAskState, requestId: string): PendingAsk | null {
	for (const pending of state.pendingByChild.values()) {
		const outstanding = pending.outstanding;
		if (outstanding === null) continue;
		if (outstanding.requestId === requestId) return outstanding;
		if (outstanding.coalesced.some((entry) => entry.requestId === requestId)) return outstanding;
	}
	return null;
}

function hasQueuedRequestId(state: FenceAskState, requestId: string): boolean {
	for (const pending of state.pendingByChild.values()) {
		for (const queued of pending.queue) {
			if (queued.requestId === requestId) return true;
			if (queued.coalesced.some((entry) => entry.requestId === requestId)) return true;
		}
	}
	return false;
}

/**
 * Admit one incoming forwarded ask (the serving loop, after wire
 * validation): refuse unknown tokens outright, answer from the session
 * dedup without a prompt when the directory is already granted, deny
 * from the session's denial memory without a prompt when the user
 * already refused it (grant ruling first: a parent-own grant after a
 * denial is the user's later word), coalesce onto any pending ask for
 * the same directory, otherwise fill this child's outstanding slot,
 * its queue, or the cap denial in that order. A pending host older
 * than ASK_HOST_STALE_MS is evicted first (advisor memo F3: a kill -9
 * child with no exit hook leaves a zombie entry; the stale host loses
 * the directory and the new ask is admitted fresh, so no directory
 * carries a permanent wait-bound tax). granted-dedup, denied-dedup,
 * and denied-cap outcomes carry the ready-to-write wire decision;
 * outstanding and queued outcomes tell the serving loop whether to
 * prompt now or wait.
 */
export function admitChildAsk(
	requestId: string,
	childToken: string,
	directory: string,
	now: number = Date.now(),
): AdmitOutcome {
	const state = getFenceAskState();
	if (!state.liveChildren.has(childToken)) return { kind: "refused-unknown-child" };
	if (state.sessionWideGranted.has(directory)) {
		if (!hasGrantForChild(childToken, directory)) {
			ensureChildGrants(state, childToken).push({
				childToken,
				directory,
				grantedAt: now,
				via: "session-dedup",
				source: "child-ask",
			});
		}
		return {
			kind: "granted-dedup",
			decision: grantDecision(requestId, childToken, directory, "session-dedup", ASK_SESSION_DEDUP_REASON, now),
		};
	}
	if (state.sessionWideDenied.has(directory)) {
		return {
			kind: "denied-dedup",
			decision: denyDecision(requestId, childToken, "session-deny", ASK_SESSION_DENY_REASON, now),
		};
	}
	const host = findPendingHostByDirectory(state, directory);
	if (host !== null) {
		if (now - host.entry.askedAt >= ASK_HOST_STALE_MS) {
			evictPendingHost(host);
		} else {
			host.entry.coalesced.push({ requestId, childToken });
			return { kind: "coalesced", canonicalRequestId: host.entry.requestId };
		}
	}
	const childPending = ensureChildPending(state, childToken);
	if (childPending.outstanding === null) {
		childPending.outstanding = { requestId, childToken, directory, askedAt: now, coalesced: [] };
		return { kind: "outstanding" };
	}
	if (childPending.queue.length < ASK_QUEUE_CAPACITY) {
		childPending.queue.push({ requestId, childToken, directory, askedAt: now, coalesced: [] });
		return { kind: "queued", position: childPending.queue.length };
	}
	return {
		kind: "denied-cap",
		decision: denyDecision(requestId, childToken, "cap", ASK_CAP_DENY_REASON, now),
	};
}

/**
 * Sweep the ledger's pending asks older than maxAge (advisor memo F3:
 * the parent-side stall bound). A pending entry older than the bound
 * can no longer reach its asker, so it is evicted with its coalesced
 * attachments and the queue promotes into a vacated outstanding slot;
 * resolution of any evicted id resolves unknown, exactly like a
 * released host. Queue entries are aged before slot promotion so the
 * promoted entry is itself within the bound. Returns every evicted
 * request id, hosts and attachments in eviction order, so the serving
 * loop can drop its bookkeeping for them. The serving loop runs this
 * on its watch tick; admitChildAsk additionally repairs only the
 * directory it is admitting against.
 */
export function expireStaleAsks(now: number = Date.now(), maxAge: number = ASK_HOST_STALE_MS): string[] {
	const state = getFenceAskState();
	const evicted: string[] = [];
	for (const pending of state.pendingByChild.values()) {
		const kept: PendingAsk[] = [];
		for (const queued of pending.queue) {
			if (now - queued.askedAt >= maxAge) evicted.push(...evictPendingHost({ pending, entry: queued, queued: true }));
			else kept.push(queued);
		}
		pending.queue = kept;
		if (pending.outstanding !== null && now - pending.outstanding.askedAt >= maxAge) {
			evicted.push(...evictPendingHost({ pending, entry: pending.outstanding, queued: false }));
		}
	}
	return evicted;
}

/**
 * Apply the user's answer to one outstanding ask, addressed by its own
 * request id or by any coalesced attachment's id. Approval records the
 * session-wide grant plus a per-child record for every involved child
 * (host and attachments, deduped per child); refusal denies them all
 * and records the session's denial memory (advisor memo F6), so later
 * asks for the directory deny from memory instead of re-prompting.
 * Every involved request id receives its own wire decision echoing its
 * own id, so the serving loop writes one response per attached child.
 * The child's next queued ask, if any, promotes into the outstanding
 * slot. A queued id resolves only after promotion (not-outstanding); a
 * released, resolved, or never-admitted id resolves unknown.
 */
export function resolveChildAsk(
	requestId: string,
	approved: boolean,
	now: number = Date.now(),
): ResolveOutcome {
	const state = getFenceAskState();
	const host = findOutstandingHostByRequestId(state, requestId);
	if (host === null) {
		return hasQueuedRequestId(state, requestId) ? { kind: "not-outstanding" } : { kind: "unknown" };
	}
	const involved = [{ requestId: host.requestId, childToken: host.childToken }, ...host.coalesced];
	const decisions = involved.map((entry) =>
		approved
			? grantDecision(entry.requestId, entry.childToken, host.directory, "user", ASK_USER_GRANT_REASON, now)
			: denyDecision(entry.requestId, entry.childToken, "user", ASK_USER_DENY_REASON, now),
	);
	if (!approved && !state.sessionWideGranted.has(host.directory)) {
		state.sessionWideDenied.set(host.directory, { deniedAt: now, via: "user" });
	}
	const grants: GrantRecord[] = [];
	if (approved) {
		state.sessionWideGranted.set(host.directory, now);
		for (const entry of involved) {
			if (!hasGrantForChild(entry.childToken, host.directory)) {
				const record: GrantRecord = {
					childToken: entry.childToken,
					directory: host.directory,
					grantedAt: now,
					via: "user",
					source: "child-ask",
				};
				ensureChildGrants(state, entry.childToken).push(record);
				grants.push(record);
			}
		}
	}
	const pending = state.pendingByChild.get(host.childToken);
	if (pending !== undefined && pending.outstanding === host) {
		pending.outstanding = pending.queue.shift() ?? null;
	}
	return { kind: "resolved", decisions, grants };
}

/**
 * Property 1 as one pure function: compose the child's inherited
 * PISCOPE_EXTRA_ROOTS from the parent's granted scope. Order-stable,
 * deduplicated union in source order (tracked config, local overlay,
 * parent env, the parent's own ledger grants), then the parent session
 * cwd appended exactly when the dispatch cwd differs from it (sign-off
 * Q4: worktree children inherit the parent session cwd too; when the
 * cwds match, the child's own buildAllowedRoots already roots there).
 * The ledger source carries parent-own records only (parentGrantRoots
 * fed from parentGrantedDirectories()): another child's ask grant
 * dedups at ask time and never composes silently here (advisor memo
 * F1). Empty entries are skipped: an empty root would widen nothing
 * and parses as a skipped env segment anyway. Config and overlay ride
 * the env value deliberately: a child running from a different checkout
 * than the parent inherits the parent's full granted set, not merely
 * the sources its own module directory happens to carry.
 */
export function composeInheritedExtraRoots(input: InheritedRootsInput): string[] {
	const composed: string[] = [];
	const seen = new Set<string>();
	const add = (root: string): void => {
		if (root.length > 0 && !seen.has(root)) {
			seen.add(root);
			composed.push(root);
		}
	};
	for (const root of input.configRoots) add(root);
	for (const root of input.overlayRoots) add(root);
	for (const root of input.envRoots) add(root);
	for (const root of input.parentGrantRoots) add(root);
	const parentCwd = typeof input.parentSessionCwd === "string" ? input.parentSessionCwd : "";
	const dispatchCwd = typeof input.dispatchCwd === "string" ? input.dispatchCwd : "";
	if (parentCwd.length > 0 && dispatchCwd.length > 0 && path.resolve(dispatchCwd) !== path.resolve(parentCwd)) {
		add(parentCwd);
	}
	return composed;
}
