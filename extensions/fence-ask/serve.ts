/**
 * fence-ask serving server: the process-global timer over the channel
 * tick, plus the nested-dispatch proxy composition
 *
 * The server is the live serving loop (unit FENCE-1-3): the spawn site
 * calls ensureForwardingServer right after minting the forwarding
 * root, which creates the tree at mode 0700 and starts the tick; the
 * extension entry (fence-ask/index.ts) configures the ruling surface
 * at session_start and stops the server at session_shutdown, removing
 * the root this process created. The handle converges on globalThis
 * (the jiti fresh-instance rule, registry.ts precedent): the spawn
 * site, the entry factory, and suites each get fresh module instances,
 * so module-level state would fork the timer from the stopper.
 *
 * Role selection: the ruling surface is resolved per tick. When this
 * process itself is a dispatched child (the ask-channel env keys are
 * set), childProxyHandler serves as the surface and proxies unresolved
 * asks UP through the ordinary child-ask channel under this process's
 * own token; the grandchild's identity and evidence ride the reason
 * field as display content, and the prompt provenance at the top names
 * the middle's registry identity (advisor memo F5 holds at every hop).
 * When the process has a session UI, the entry factory wires ctx.ui
 * with askPromptTitle. When neither surface exists, entries pend and
 * the staleness bound evicts them, so every downstream ask fails
 * closed on its own wait bound.
 *
 * Nested dispatch (report 13 DC-1): the proxy composition is the
 * designed fold. A grandchild's ask reaches the user through exactly
 * one proxy hop per level: middle admits (its ledger knows the
 * grandchild token it registered), proxies up under its own token, the
 * top rules, the middle resolves the grandchild locally and writes the
 * grandchild's decision. Grants bind per child at every hop (reading
 * b): a proxy grant lands in the middle's ledger for the grandchild
 * token and never in the middle's own verdict set. The middle's token
 * caps at 1 outstanding + 3 queue at the top no matter how many
 * grandchildren proxy through it, so prompt pressure stays bounded per
 * dispatched child. Chain latency is serial by construction: each hop
 * carries its own wait bound, and a hop that times out drops its local
 * entry without deny memory, so the downstream asker fails closed on
 * its own bound and may re-ask.
 *
 * Residuals stated, not claimed away: a child killed without its
 * shutdown path (SIGKILL, hard timeout) leaks its minted root under
 * the tmpdir subtree until tmp reaping; the leak is bounded in size
 * and carries no authority once its tokens are released at the
 * spawning parent. The timer is unref'd so a headless session exits
 * when its work drains rather than on the channel's account.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	ASK_WAIT_ENV,
	MAX_REASON_LENGTH,
	POLL_INTERVAL_MS,
	resolveAskWaitMs,
} from "./ask-wire.ts";
import { ASK_HOST_STALE_MS, currentForwardingRoot } from "./grant-ledger.ts";
import {
	childProvisioningFromEnv,
	createForwardingRootDirs,
	forwardOutOfScopeAsk,
	serveForwardingRootTick,
} from "./ask-channel.ts";
import type { AskRulingHandler } from "./ask-channel.ts";

/** Spacing between serving sweeps while a server runs. */
export const SERVE_TICK_MS = 500;

/** One server handle: config, timer, re-entrancy guard, created root. */
interface ForwardingServerHandle {
	/** The per-tick ruling-surface resolver the entry factory wires. */
	resolveHandler: (() => AskRulingHandler | null) | null;
	/** Sweep spacing. */
	tickMs: number;
	/** The running interval, null when stopped or never started. */
	timer: ReturnType<typeof setInterval> | null;
	/** True while a sweep (possibly awaiting a ruling) is in flight. */
	serving: boolean;
	/** The root this process created at start; the shutdown removes it. */
	createdRoot: string | null;
}

declare global {
	// Language-level escape required by the cross-extension contract: pi
	// gives every extension entrypoint a fresh module instance (jiti,
	// moduleCache: false), so the timer handle must live on globalThis,
	// which no module system scopes.
	var __piFenceAskServer: ForwardingServerHandle | undefined;
}

function serverHandle(): ForwardingServerHandle {
	globalThis.__piFenceAskServer ??= {
		resolveHandler: null,
		tickMs: SERVE_TICK_MS,
		timer: null,
		serving: false,
		createdRoot: null,
	};
	return globalThis.__piFenceAskServer;
}

/**
 * Wire the ruling-surface resolver the per-tick role selection uses.
 * Call once per session from the extension entry's session_start; a
 * later call replaces the resolver in place.
 */
export function configureForwardingServer(config: {
	resolveHandler: () => AskRulingHandler | null;
	tickMs?: number;
}): void {
	const handle = serverHandle();
	handle.resolveHandler = config.resolveHandler;
	handle.tickMs = config.tickMs ?? SERVE_TICK_MS;
}

/**
 * Start the serving loop for this process's minted forwarding root:
 * create the tree at mode 0700 and begin the sweeps. Idempotent; a
 * no-op before the first spawn (no minted root) and safe to call from
 * every spawn site. Sweeps overlap guard through the serving flag, and
 * the timer is unref'd so it never holds a draining process open.
 */
export function ensureForwardingServer(): void {
	const handle = serverHandle();
	if (handle.timer !== null) return;
	const root = currentForwardingRoot();
	if (root === null) return;
	createForwardingRootDirs(root);
	handle.createdRoot = root;
	handle.timer = setInterval(() => {
		if (handle.serving) return;
		const current = currentForwardingRoot();
		if (current === null) return;
		const handler = handle.resolveHandler === null ? null : handle.resolveHandler();
		handle.serving = true;
		void serveForwardingRootTick({ root: current, handler, maxAge: ASK_HOST_STALE_MS })
			.catch(() => {})
			.finally(() => {
				handle.serving = false;
			});
	}, handle.tickMs);
	handle.timer.unref?.();
}

/**
 * Stop the serving loop and optionally remove the root this process
 * created (the session_shutdown obligation). Stopping twice, or
 * stopping without a start, is a no-op.
 */
export function stopForwardingServer(options?: { removeRoot?: boolean }): void {
	const handle = serverHandle();
	if (handle.timer !== null) {
		clearInterval(handle.timer);
		handle.timer = null;
	}
	handle.serving = false;
	if (options?.removeRoot === true && handle.createdRoot !== null) {
		try {
			fs.rmSync(handle.createdRoot, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; a stuck file stays for tmp reaping.
		}
		handle.createdRoot = null;
	}
}

/**
 * The ruling surface for a dispatched child that serves its own root:
 * proxy each unresolved ask up through the ordinary child-ask channel
 * under this process's own spawn token, with the asking grandchild's
 * registry identity and evidence composed into the reason field
 * (display content; the top's provenance names the middle). Grant
 * resolves true, deny resolves false, and anything else (timeout,
 * channel failure) resolves null: no authority ruled, so the tick
 * drops the local entry without deny memory and the downstream asker
 * fails closed on its own bound. Null when this process carries no
 * ask-channel provisioning (it is a top, not a middle).
 */
export function childProxyHandler(options?: {
	waitMs?: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
}): AskRulingHandler | null {
	const provisioning = childProvisioningFromEnv();
	if (provisioning === null) return null;
	const waitMs = options?.waitMs ?? resolveAskWaitMs(process.env[ASK_WAIT_ENV]);
	const pollMs = options?.pollMs ?? POLL_INTERVAL_MS;
	const pause = options?.sleep;
	return async (ask, provenance) => {
		const composedReason = `forwarded nested ask from child ${provenance.agentName} (${provenance.dispatchLabel}) for ${provenance.directory}: ${ask.reason}`.slice(
			0,
			MAX_REASON_LENGTH,
		);
		const outcome = await forwardOutOfScopeAsk({
			root: provisioning.root,
			childToken: provisioning.token,
			toolName: ask.toolName,
			directory: ask.resolvedPath,
			reason: composedReason,
			identityAgentName: `pid-${process.pid}`,
			identityDispatchLabel: path.basename(process.cwd()),
			waitMs,
			pollMs,
			sleep: pause,
		});
		if (outcome.status === "applied") return true;
		if (outcome.status === "denied") return false;
		return null;
	};
}
