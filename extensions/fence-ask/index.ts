/**
 * fence-ask entry point: the live extension surface (unit FENCE-1-3)
 *
 * The package's other modules are inert libraries; this file is the
 * entry pi's loader discovers under the extensions directory one level
 * deep, so its default export must stay a factory or every session's
 * startup fails. Two registrations:
 *
 * - session_start configures the serving loop's per-tick ruling-surface
 *   resolver (configureForwardingServer) with the documented role
 *   selection: a process carrying ask-channel provisioning is a
 *   dispatched middle and proxies unresolved asks up through its own
 *   token (childProxyHandler), so nested dispatch composes within the
 *   wire contracts and caps stay bounded per hop; a session with UI
 *   prompts through the captured ctx.ui with askPromptTitle, whose
 *   provenance comes from the ledger's registry-bound lookup; a
 *   process with neither surface resolves null, so outstanding entries
 *   pend and the staleness bound evicts them, and every downstream
 *   asker fails closed on its own wait bound. The resolver is read per
 *   tick, so the role tracks the current process env and UI, not the
 *   session_start snapshot.
 *
 * - session_shutdown stops the server and removes the forwarding root
 *   this process created at its first spawn (stopForwardingServer),
 *   the teardown half of the 0700 tree lifecycle. A SIGKILL'd process
 *   skips this path and leaks a bounded, authority-free tree for tmp
 *   reaping; the residual is stated in serve.ts, not claimed away.
 *
 * The parent-own grant recorder stays in workspace-fence's interactive
 * Yes branch (unit 1-2): this entry never records grants, because a
 * child-ask ruling belongs to the ledger's child-ask source and never
 * composes into another process's silent scope (the settled reading b).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askPromptTitle, childProvisioningFromEnv } from "./ask-channel.ts";
import { childProxyHandler, configureForwardingServer, stopForwardingServer } from "./serve.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		configureForwardingServer({
			resolveHandler: () => {
				if (childProvisioningFromEnv() !== null) return childProxyHandler();
				if (!ctx.hasUI) return null;
				return async (ask, provenance) => {
					const choice = await ctx.ui.select(askPromptTitle(ask, provenance), ["Yes", "No"]);
					return choice === "Yes";
				};
			},
		});
	});
	pi.on("session_shutdown", () => {
		stopForwardingServer({ removeRoot: true });
	});
}
