/**
 * fence-ask channel: the filesystem half of the forwarded-ask channel
 *
 * Unit FENCE-1-3's consumer obligations over the pure contracts in
 * ask-wire.ts and grant-ledger.ts, in one fs-bearing module:
 *
 * - createForwardingRootDirs creates the forwarding root, requests/,
 *   and responses/ at mode 0700, discharging the F4 obligation (an
 *   other-user-readable root would publish every request's token,
 *   paths, and provenance). The server calls it once per process at
 *   the first spawn; nothing else creates channel directories.
 * - writeForwardedAsk / writeForwardedDecision are the atomic writes:
 *   each body lands through a temporary file and a rename, so the
 *   other side never reads a half-written message. Both validate
 *   through the wire constructors and throw on programmer error.
 * - readForwardedDecision is the child's echo-checked decision read:
 *   missing file, unparseable body, or a mismatched echo all return
 *   null and the caller keeps waiting. The echo check is the accident
 *   guard, not integrity (the ask-wire header carries the same-user
 *   residual).
 * - forwardOutOfScopeAsk is the child-side flow the fence's headless
 *   branch and the nested proxy both run: write the ask, poll within
 *   the wait bound, and resolve into applied (onGrant fired once),
 *   denied, timeout, or failed, each non-applied outcome carrying the
 *   actionable fail-closed reason naming the tool, the directory, and
 *   the closed posture. A timeout removes the request file best-
 *   effort; a consumed decision file is removed best-effort. The
 *   reason field is truncated to the wire bound; the identity fields
 *   are display-at-most and the parent's prompt never trusts them.
 * - serveForwardingRootTick is one parent-side sweep: expire stale
 *   hosts first (their files go with them), sweep orphaned files by
 *   age, then walk the request files oldest-first (review 17 DC-1:
 *   prompting is serial, so the longest-waiting ask surfaces first;
 *   the accepted residual and the multi-child knob are stated in
 *   docs/workspace-fence.md). Admittance runs once per id
 *   (pendingRequestLocation): an unknown id admits, an outstanding id
 *   rules through the injected handler (registry-bound provenance in,
 *   boolean ruling or null out), queued and coalesced ids wait, and a
 *   null handler pends entries for staleness instead of dropping
 *   them. Rulings resolve through resolveChildAsk and write one
 *   decision per involved request id; a null ruling (no authority) is
 *   a dropChildAsk eviction with no deny memory, because no authority
 *   ruled. Refused unknown children get silence and a deleted file:
 *   an unregistered identity burns its own wait bound fail-closed.
 * - askPromptTitle composes the ctx.ui prompt title from the ask and
 *   the provenance, naming the child, the dispatch label, the resolved
 *   path, and the ask evidence, ending in the Allow? question.
 *
 * Nested dispatch (report 13 DC-1, designed within the wire
 * contracts): a dispatched child that dispatches its own children
 * mints and serves its own root (serve.ts starts the server there)
 * and proxies unresolved grandchild asks UP through the ordinary
 * child-ask channel under its own token (childProxyHandler in
 * serve.ts). The top prompts once per proxied ask with the middle's
 * registry identity; the grandchild's identity and evidence ride the
 * reason field as display content; the resulting grant binds the
 * grandchild in the middle's ledger and never touches the middle's
 * own verdict set. Caps stay bounded per hop: the middle's token
 * carries 1 outstanding + 3 queue at the top regardless of how many
 * grandchildren proxy through it. The pass-through alternative (the
 * grandchild writing straight into the top's root) was rejected: the
 * top's ledger does not know the grandchild token, and a cross-
 * process registration surface would multiply the prompt caps.
 *
 * Same-user wall (stated, not claimed away): every function here is
 * honest file I/O under the tmpdir subtree both fence sides already
 * allow. Any same-user process that learns the root can forge requests
 * or responses; the 0700 mode, the unguessable root name, and the
 * token registry raise the cost against accidents and processes that
 * have not learned the root, and no integrity wall is claimed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
	ASK_FILE_SUFFIX,
	CHILD_ASK_ROOT_ENV,
	CHILD_ASK_TOKEN_ENV,
	MAX_REASON_LENGTH,
	POLL_INTERVAL_MS,
	askFileName,
	createForwardedAsk,
	createForwardedDecision,
	decisionMatchesRequest,
	forwardingRequestsDir,
	forwardingResponsesDir,
	isValidForwardingRoot,
	parseForwardedAsk,
	parseForwardedDecision,
	serializeForwardedAsk,
	serializeForwardedDecision,
} from "./ask-wire.ts";
import type { ForwardedAsk, ForwardedDecision } from "./ask-wire.ts";
import {
	ASK_HOST_STALE_MS,
	admitChildAsk,
	dropChildAsk,
	expireStaleAsks,
	pendingRequestLocation,
	promptProvenanceForRequest,
	resolveChildAsk,
} from "./grant-ledger.ts";
import type { AskPromptProvenance } from "./grant-ledger.ts";

/** The default wait between response polls inside the child flow. */
const FLOW_POLL_MS = POLL_INTERVAL_MS;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function atomicWriteFileSync(filePath: string, body: string): void {
	const tmp = `${filePath}.tmp-${randomUUID()}`;
	fs.writeFileSync(tmp, body);
	fs.renameSync(tmp, filePath);
}

/**
 * Create the forwarding root and its requests/ and responses/
 * subdirectories at mode 0700 (the F4 consumer obligation). Idempotent:
 * an existing tree is tolerated and nothing is chmod'ed, because the
 * server creates the tree once per process before any child exists.
 */
export function createForwardingRootDirs(root: string): void {
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	fs.mkdirSync(forwardingRequestsDir(root), { recursive: true, mode: 0o700 });
	fs.mkdirSync(forwardingResponsesDir(root), { recursive: true, mode: 0o700 });
}

/** Atomically write one validated ask into requests/. */
export function writeForwardedAsk(root: string, ask: ForwardedAsk): void {
	const valid = createForwardedAsk(ask);
	const name = askFileName(valid.requestId);
	if (name === null) throw new TypeError("forwarded ask request id must be a uuid v4 string");
	atomicWriteFileSync(path.join(forwardingRequestsDir(root), name), serializeForwardedAsk(valid));
}

/** Atomically write one validated decision into responses/. */
export function writeForwardedDecision(root: string, decision: ForwardedDecision): void {
	const valid = createForwardedDecision(decision);
	const name = askFileName(valid.requestId);
	if (name === null) throw new TypeError("forwarded decision request id must be a uuid v4 string");
	atomicWriteFileSync(path.join(forwardingResponsesDir(root), name), serializeForwardedDecision(valid));
}

function readFileSyncOrNull(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

/**
 * Read and echo-check the decision for one request: the response file
 * named after the request id, wire-parsed, honoring only decisions
 * whose echo fields match this child's this request. Anything else
 * (missing file, bad body, foreign echo) returns null.
 */
export function readForwardedDecision(
	root: string,
	requestId: string,
	childToken: string,
): ForwardedDecision | null {
	const name = askFileName(requestId);
	if (name === null) return null;
	const text = readFileSyncOrNull(path.join(forwardingResponsesDir(root), name));
	if (text === null) return null;
	const decision = parseForwardedDecision(text);
	if (decision === null) return null;
	return decisionMatchesRequest(decision, requestId, childToken) ? decision : null;
}

/** The uuid request ids currently sitting in requests/. */
export function requestIdsIn(root: string): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(forwardingRequestsDir(root));
	} catch {
		return [];
	}
	const ids: string[] = [];
	for (const name of names) {
		if (!name.endsWith(ASK_FILE_SUFFIX)) continue;
		const id = name.slice(0, name.length - ASK_FILE_SUFFIX.length);
		if (askFileName(id) === name) ids.push(id);
	}
	return ids;
}

/** Best-effort removal of one request file; missing is fine. */
export function deleteAskFile(root: string, requestId: string): void {
	const name = askFileName(requestId);
	if (name === null) return;
	try {
		fs.unlinkSync(path.join(forwardingRequestsDir(root), name));
	} catch {
		// The sweep or the eviction path may already have removed it.
	}
}

/** Best-effort removal of one response file; missing is fine. */
export function deleteDecisionFile(root: string, requestId: string): void {
	const name = askFileName(requestId);
	if (name === null) return;
	try {
		fs.unlinkSync(path.join(forwardingResponsesDir(root), name));
	} catch {
		// The child may have consumed and removed it already.
	}
}

/** The child provisioning the spawn env carries, validated, or null. */
export function childProvisioningFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): { root: string; token: string } | null {
	const root = env[CHILD_ASK_ROOT_ENV];
	const token = env[CHILD_ASK_TOKEN_ENV];
	if (typeof root !== "string" || !isValidForwardingRoot(root)) return null;
	if (typeof token !== "string" || token.length === 0) return null;
	return { root, token };
}

/** One child-side forward flow's resolution. */
export type ForwardFlowOutcome =
	| { status: "applied"; decision: ForwardedDecision }
	| { status: "denied"; decision: ForwardedDecision; blockReason: string }
	| { status: "timeout"; blockReason: string }
	| { status: "failed"; blockReason: string };

/** Everything forwardOutOfScopeAsk needs from its caller. */
export interface ForwardFlowOptions {
	/** The forwarding root (env provisioning or the caller's root). */
	root: string;
	/** This child's spawn token. */
	childToken: string;
	/** The gated tool whose call asked (display on the parent prompt). */
	toolName: string;
	/** The derived grant-scope directory (the grant-key contract). */
	directory: string;
	/** The ask evidence rendered in the prompt body (truncated). */
	reason: string;
	/** Honest self-description, display-at-most on the parent side. */
	identityAgentName: string;
	/** Honest self-description, display-at-most on the parent side. */
	identityDispatchLabel: string;
	/** The bounded wait; the fence branch passes resolveAskWaitMs(env). */
	waitMs: number;
	/** Poll spacing; defaults to the GPS-calibrated bound. */
	pollMs?: number;
	/** Called once with the granted root when the ruling is a grant. */
	onGrant?: (grantedRoot: string) => void;
	/** Injectable pause for suites; defaults to a real timer. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Run one child-side forwarded ask to resolution: write the ask, poll
 * the bounded wait, honor only echo-matching decisions, and resolve
 * into applied, denied, timeout, or failed. Never throws: channel I/O
 * failures resolve into the failed outcome with the actionable
 * fail-closed reason, because the caller is a tool_call branch whose
 * contract is pass or block, never a crash.
 */
export async function forwardOutOfScopeAsk(options: ForwardFlowOptions): Promise<ForwardFlowOutcome> {
	const { root, childToken, toolName, directory, identityAgentName, identityDispatchLabel, waitMs } = options;
	const pollMs = options.pollMs ?? FLOW_POLL_MS;
	const pause = options.sleep ?? defaultSleep;
	const requestId = randomUUID();
	const reason = options.reason.slice(0, MAX_REASON_LENGTH);
	try {
		writeForwardedAsk(root, {
			requestId,
			childToken,
			agentName: identityAgentName,
			dispatchLabel: identityDispatchLabel,
			toolName,
			resolvedPath: directory,
			reason,
			askedAt: Date.now(),
		});
	} catch (error) {
		return {
			status: "failed",
			blockReason: `${toolName} blocked by the workspace-fence: the ask-forwarding channel is unusable for ${directory} under ${root}: ${describeError(error)}; the call fails closed`,
		};
	}
	const startedAt = performance.now();
	const deadline = startedAt + waitMs;
	while (performance.now() < deadline) {
		await pause(pollMs);
		const decision = readForwardedDecision(root, requestId, childToken);
		if (decision !== null) {
			deleteDecisionFile(root, requestId);
			if (decision.decision === "grant") {
				options.onGrant?.(decision.grantedRoot ?? directory);
				return { status: "applied", decision };
			}
			return {
				status: "denied",
				decision,
				blockReason: `${toolName} blocked by the workspace-fence: the forwarded ask for ${directory} was denied via ${decision.via}: ${decision.reason}; the call fails closed`,
			};
		}
	}
	deleteAskFile(root, requestId);
	return {
		status: "timeout",
		blockReason: `${toolName} blocked by the workspace-fence: the forwarded ask for ${directory} received no decision from the parent session within ${waitMs} ms; no authority ruled, so the call fails closed`,
	};
}

/** The ruling surface the serving tick calls for outstanding asks. */
export type AskRulingHandler = (
	ask: ForwardedAsk,
	provenance: AskPromptProvenance,
) => Promise<boolean | null>;

/** Everything one serving sweep needs from its caller. */
export interface TickOptions {
	/** The forwarding root to serve. */
	root: string;
	/**
	 * The ruling surface: boolean for answered, null for no authority
	 * (drops the entry without deny memory). Null handler means this
	 * process has no prompting surface: outstanding entries pend for
	 * the staleness bound instead of being ruled or dropped.
	 */
	handler: AskRulingHandler | null;
	/** Injectable clock; defaults to Date.now. */
	now?: () => number;
	/** The staleness bound; defaults to the locked host bound. */
	maxAge?: number;
}

/** What one serving sweep did, for pins and diagnostics. */
export interface TickSummary {
	prompted: number;
	resolved: number;
	dropped: number;
	refused: number;
	servedDedup: number;
	servedDeny: number;
	swept: number;
	unparseable: number;
}

/**
 * One parent-side sweep of the forwarding root: staleness first, then
 * orphan-file sweeps, then every request file through the admit-once
 * guard. Never throws on file-level surprises: unreadable and
 * unparseable files are skipped or dropped fail-closed, and the next
 * sweep self-heals.
 */
export async function serveForwardingRootTick(options: TickOptions): Promise<TickSummary> {
	const root = options.root;
	const nowMs = (options.now ?? Date.now)();
	const maxAge = options.maxAge ?? ASK_HOST_STALE_MS;
	const summary: TickSummary = {
		prompted: 0,
		resolved: 0,
		dropped: 0,
		refused: 0,
		servedDedup: 0,
		servedDeny: 0,
		swept: 0,
		unparseable: 0,
	};
	for (const evictedId of expireStaleAsks(nowMs, maxAge)) {
		deleteAskFile(root, evictedId);
	}
	const sweepAgeMs = maxAge * 2;
	sweepAgedRequestFiles(root, nowMs, sweepAgeMs, summary);
	sweepAgedResponseFiles(root, nowMs, sweepAgeMs, summary);
	// Bound-aware ordering (review 17 DC-1): prompting is serial, so the
	// walk surfaces the longest-waiting ask first; equal mtimes keep
	// readdir order, and unstatable files sort last rather than blocking
	// the sweep.
	const orderedRequests = requestIdsIn(root)
		.map((requestId) => {
			const name = askFileName(requestId);
			if (name === null) return { requestId, name, mtimeMs: Number.POSITIVE_INFINITY };
			try {
				return { requestId, name, mtimeMs: fs.statSync(path.join(forwardingRequestsDir(root), name)).mtimeMs };
			} catch {
				return { requestId, name, mtimeMs: Number.POSITIVE_INFINITY };
			}
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const { requestId, name } of orderedRequests) {
		const location = pendingRequestLocation(requestId);
		const text = readFileSyncOrNull(path.join(forwardingRequestsDir(root), name));
		if (text === null) continue;
		const ask = parseForwardedAsk(text);
		if (ask === null) {
			if (location === "outstanding") {
				// The ledger awaits a ruling the file can no longer describe:
				// drop it fail-closed rather than prompt without evidence.
				dropChildAsk(requestId);
				deleteAskFile(root, requestId);
				summary.unparseable++;
			}
			continue;
		}
		if (location === "outstanding") {
			await ruleOnOutstanding(options, ask, requestId, summary);
			continue;
		}
		if (location === "queued" || location === "coalesced") continue;
		const outcome = admitChildAsk(requestId, ask.childToken, ask.resolvedPath, nowMs);
		switch (outcome.kind) {
			case "refused-unknown-child":
				deleteAskFile(root, requestId);
				summary.refused++;
				break;
			case "granted-dedup":
				writeForwardedDecision(root, outcome.decision);
				deleteAskFile(root, requestId);
				summary.servedDedup++;
				break;
			case "denied-dedup":
			case "denied-cap":
				writeForwardedDecision(root, outcome.decision);
				deleteAskFile(root, requestId);
				summary.servedDeny++;
				break;
			case "coalesced":
			case "queued":
				break;
			case "outstanding":
				await ruleOnOutstanding(options, ask, requestId, summary);
				break;
		}
	}
	return summary;
}

/**
 * Rule on one outstanding entry through the injected handler, then
 * apply the answer through the ledger and write one decision per
 * involved request id. A null handler pends (staleness will evict);
 * a null answer drops without deny memory; a thrown handler answer is
 * treated as no authority, never as a denial.
 */
async function ruleOnOutstanding(
	options: TickOptions,
	ask: ForwardedAsk,
	requestId: string,
	summary: TickSummary,
): Promise<void> {
	if (options.handler === null) return;
	const provenance = promptProvenanceForRequest(requestId);
	if (provenance === null) return;
	summary.prompted++;
	let answer: boolean | null;
	try {
		answer = await options.handler(ask, provenance);
	} catch {
		answer = null;
	}
	if (answer === null) {
		dropChildAsk(requestId);
		deleteAskFile(options.root, requestId);
		summary.dropped++;
		return;
	}
	const outcome = resolveChildAsk(requestId, answer);
	if (outcome.kind !== "resolved") return;
	for (const decision of outcome.decisions) {
		try {
			writeForwardedDecision(options.root, decision);
		} catch {
			continue;
		}
		deleteAskFile(options.root, decision.requestId);
	}
	summary.resolved++;
}

/**
 * Remove request files with no ledger entry whose mtime exceeds the
 * sweep age: unparseable garbage, decisions already consumed by their
 * writer, and files whose entry was evicted elsewhere. Files with a
 * live ledger location (queued entries can outlive the sweep age)
 * never sweep.
 */
function sweepAgedRequestFiles(root: string, nowMs: number, sweepAgeMs: number, summary: TickSummary): void {
	for (const requestId of requestIdsIn(root)) {
		if (pendingRequestLocation(requestId) !== null) continue;
		const name = askFileName(requestId);
		if (name === null) continue;
		const filePath = path.join(forwardingRequestsDir(root), name);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(filePath).mtimeMs;
		} catch {
			continue;
		}
		if (nowMs - mtimeMs > sweepAgeMs) {
			try {
				fs.unlinkSync(filePath);
				summary.swept++;
			} catch {
				// Already gone.
			}
		}
	}
}

/** Remove response files older than the sweep age (the GC tier). */
function sweepAgedResponseFiles(root: string, nowMs: number, sweepAgeMs: number, summary: TickSummary): void {
	let names: string[];
	try {
		names = fs.readdirSync(forwardingResponsesDir(root));
	} catch {
		return;
	}
	for (const name of names) {
		const filePath = path.join(forwardingResponsesDir(root), name);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(filePath).mtimeMs;
		} catch {
			continue;
		}
		if (nowMs - mtimeMs > sweepAgeMs) {
			try {
				fs.unlinkSync(filePath);
				summary.swept++;
			} catch {
				// Already gone.
			}
		}
	}
}

/**
 * The ctx.ui prompt title for one forwarded ask (advisor memo F5):
 * provenance comes from the caller's registry-bound lookup, never from
 * the wire fields; the ask's own evidence rides the body. Mirrors the
 * fence's interactive title shape, ending in the Allow? question.
 */
export function askPromptTitle(ask: ForwardedAsk, provenance: AskPromptProvenance): string {
	return `⚠️ ${ask.toolName} outside the allowed scope, requested by child session ${provenance.agentName} (${provenance.dispatchLabel}):\n\n  ${provenance.directory}\n\n${ask.reason}\n\nAllow?`;
}
