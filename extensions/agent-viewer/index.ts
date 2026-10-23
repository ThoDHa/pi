/**
 * Agent Viewer - ambient observation surfaces for subagent dispatches
 *
 * A standalone extension (auto-discovered from its own directory
 * under extensions/, no settings.json edits) that owns everything
 * user-facing about dispatch observation: the toggleable dispatch
 * strip above the editor, its hotkey registration from the
 * `subagentViewer` settings block, and the task-label heuristic. The
 * navigator overlay (checkpoint 2) joins the surfaces here and
 * registers the navigator key the strip's hint line already names.
 *
 * This extension owns no dispatch state: the strip polls the shared
 * dispatch state the subagent extension publishes into, converged on
 * globalThis by registry.ts's getSharedDispatchState() (pi evaluates
 * each entrypoint's modules in a fresh instance, so module-level
 * state would never be shared). The registry and detached-job
 * snapshots are reset by the subagent extension on session_start,
 * which owns their lifecycle; this side only resets viewer-local UI
 * state.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { getSharedDispatchState, type DetachedJobSnapshot, type DispatchRegistry } from "../subagent/registry.ts";
import { NavigatorOverlay } from "./overlay.ts";
import { buildStripTasks, renderStripLines, STRIP_MAX_LINES } from "./strip.ts";

const STRIP_WIDGET_KEY = "subagent-dispatch-strip";
const STRIP_POLL_INTERVAL_MS = 500;
// Hardcoded defaults so both hotkeys work with no `subagentViewer`
// settings block present; both are unused in pi's built-in keybindings
// (checked against docs/keybindings.md at pi 1.4.0).
const DEFAULT_STRIP_KEY = "alt+s";
const DEFAULT_NAVIGATOR_KEY = "alt+n";

interface StripWidgetSources {
	registry: DispatchRegistry;
	detachedJobs: DetachedJobSnapshot[];
	stripKey: string;
	navigatorKey: string;
}

/**
 * Build the ambient strip widget component: a poll-and-render loop
 * (doom-overlay pattern) that re-renders from the shared dispatch
 * state on an interval, plus a dispose that clears the interval
 * (setWidget also calls dispose when the widget is hidden or
 * cleared). Lines render through the theme with the blocking path's
 * glyph conventions and are truncated to the viewport width; the
 * strip owns its line budget via renderStripLines, so pi's
 * string-array widget cap never applies.
 */
function createStripWidget(tui: TUI, theme: Theme, sources: StripWidgetSources): Component & { dispose(): void } {
	let interval: ReturnType<typeof setInterval> | null = null;
	const renderLines = (width: number): string[] => {
		const views = buildStripTasks(sources.registry, sources.detachedJobs, Date.now());
		const stripLines = renderStripLines(views, {
			hint: `${sources.navigatorKey} navigator · ${sources.stripKey} hide`,
			maxLines: STRIP_MAX_LINES,
		});
		return stripLines.map((line) =>
			truncateToWidth(
				line.segments
					.map((segment) => {
						const text = segment.bold ? theme.bold(segment.text) : segment.text;
						return segment.color ? theme.fg(segment.color, text) : text;
					})
					.join(""),
				width,
			),
		);
	};
	interval = setInterval(() => tui.requestRender(), STRIP_POLL_INTERVAL_MS);
	return {
		render(width: number) {
			return renderLines(width);
		},
		invalidate() {},
		dispose() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
	};
}

/**
 * A settings value is accepted as a shortcut key only when it is a
 * non-blank string; anything else falls back to the hardcoded default
 * so a malformed block can never leave the surfaces unbound.
 */
function resolveShortcutKey(value: unknown, fallback: KeyId): KeyId {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().toLowerCase();
	return trimmed.length > 0 ? (trimmed as KeyId) : fallback;
}

interface ViewerKeys {
	stripKey: KeyId;
	navigatorKey: KeyId;
}

/**
 * Resolve the two hotkeys from the extension-owned `subagentViewer`
 * settings block. The namespace is not part of pi's Settings type
 * (unknown top-level settings keys survive end-to-end), so the block
 * is read through a validated structural cast. registerShortcut is
 * load-time with no settings-change event, so a changed key binds
 * after /reload.
 */
function readViewerKeys(settings: ReturnType<ExtensionAPI["getSettings"]>): ViewerKeys {
	const block = (settings as { subagentViewer?: { stripKey?: unknown; navigatorKey?: unknown } }).subagentViewer;
	return {
		stripKey: resolveShortcutKey(block?.stripKey, DEFAULT_STRIP_KEY),
		navigatorKey: resolveShortcutKey(block?.navigatorKey, DEFAULT_NAVIGATOR_KEY),
	};
}

export default function (pi: ExtensionAPI) {
	// Ambient strip: hidden until the first toggle; the next toggle
	// hides it again. getSettings and registerShortcut are action
	// methods that throw during extension loading, so the hotkeys are
	// resolved and registered on session_start, which pi emits before
	// the editor's shortcut setup on both startup and /reload. A
	// changed subagentViewer key therefore binds after /reload.
	let stripVisible = false;
	// Double-open guard for the navigator: while the overlay is showing,
	// a second open-key press must not stack a second ctx.ui.custom.
	let navigatorOpen = false;
	const registerViewerShortcuts = () => {
		const viewerKeys = readViewerKeys(pi.getSettings());
		pi.registerShortcut(viewerKeys.stripKey, {
			description: "Toggle the subagent dispatch strip",
			handler: (ctx) => {
				stripVisible = !stripVisible;
				if (!stripVisible) {
					ctx.ui.setWidget(STRIP_WIDGET_KEY, undefined);
					return;
				}
				const shared = getSharedDispatchState();
				ctx.ui.setWidget(
					STRIP_WIDGET_KEY,
					(tui, theme) =>
						createStripWidget(tui, theme, {
							registry: shared.registry,
							detachedJobs: shared.detachedJobs,
							stripKey: viewerKeys.stripKey,
							navigatorKey: viewerKeys.navigatorKey,
						}),
					{
						placement: "aboveEditor",
					},
				);
			},
		});
		pi.registerShortcut(viewerKeys.navigatorKey, {
			description: "Open the subagent navigator overlay",
			handler: async (ctx) => {
				if (navigatorOpen) return;
				navigatorOpen = true;
				try {
					const shared = getSharedDispatchState();
					await ctx.ui.custom(
						(tui, theme, _keybindings, done) =>
							new NavigatorOverlay(tui, theme, {
								registry: shared.registry,
								detachedJobs: shared.detachedJobs,
								navigatorKey: viewerKeys.navigatorKey,
							}, done),
						{ overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } },
					);
				} finally {
					navigatorOpen = false;
				}
			},
		});
	};

	pi.on("session_start", async () => {
		// Session invalidation cleared the widget (disposing the poll
		// interval), so visibility resets with the rest of the session
		// state and the next toggle shows the strip against the new
		// session. The navigator cannot outlive the session either; the
		// guard resets with it.
		stripVisible = false;
		navigatorOpen = false;
		registerViewerShortcuts();
	});
}
