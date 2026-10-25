/**
 * Navigator view component
 *
 * The keyboard-driven view over every live dispatch, hosted as a
 * full-width, top-anchored overlay: ctx.ui.custom with the overlay
 * option floats the component over the transcript and editor, pinned
 * to row 0 at the terminal's full width, and on terminals of three
 * rows and up the view renders exactly the terminal's height every
 * frame (its header and hints lines around the pane body, padded to
 * the body budget), so it is effectively full screen while open and
 * its content-derived height always meets the overlay's maxHeight
 * with no silent truncation. Below three rows the one-row floor
 * keeps the frame at three lines and the overlay's maxHeight is the
 * safety clamp that truncates it. Being an overlay is also what
 * routes the fullscreen viewport scroll keys here: pi's alt-screen
 * handler defers pageUp/pageDown/home/end to a focused overlay, so
 * the scroll keys work in both terminal modes. The editor keeps its
 * buffer untouched beneath the overlay; done() hides the overlay and
 * returns focus to the editor.
 *
 * A left tree pane of rows produced by the pure flatten function in
 * navigator.ts, a right detail pane streaming the selected agent's
 * activity, a header line carrying the tool-noise filter state, and
 * a hints line at the bottom; there is no box border because while
 * open the view is the whole screen, not a floating card. Reads the
 * shared dispatch state on a poll interval (doom-overlay pattern:
 * interval plus requestRender, cleared in dispose) and renders
 * through the theme with the fleet glyph conventions. Strictly
 * read-only: the fixed v1 keys move the cursor, collapse or expand,
 * page the detail pane, and toggle tool-noise visibility; nothing
 * steers a dispatch. Escape resolves done(undefined), which closes
 * the overlay and restores the editor.
 *
 * The tool-noise toggle hides the file-reading tool calls (read,
 * grep, find, ls) so the default detail pane leads with thinking and
 * assistant text; ctrl+t and ctrl+t's cycle alias ctrl+o flip it,
 * matched through the injected KeybindingsManager against pi's
 * app.tree.filter action ids (user remaps honored, the TreeSelector
 * precedent) with raw matchesKey fallbacks.
 */

import type { KeybindingsManager, Theme, TUI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, type KeyId, type Keybinding, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HStack, Text, VStack } from "@earendil-works/pi-tui";
import { filterActivityEntries } from "./activity-filter.ts";
import { statusGlyph, type DetachedJobSnapshot, type DispatchRegistry } from "../subagent/registry.ts";
import {
	BLANK_LINE_KEY,
	HEADER_LINE_KEY,
	PLACEHOLDER_LINE_KEY,
	RESULT_LINE_KEY,
	SCROLL_NEW_INDICATOR,
	USAGE_LINE_KEY,
	type DetailLine,
	type DetailScrollState,
	activityLineKey,
	createDetailScrollState,
	detailWindow,
	fieldLineKey,
	memberLineKey,
	pageStepRows,
	scrollDetailBy,
	scrollDetailTo,
	stabilizeDetailScroll,
	viewBodyRows,
} from "./detail-scroll.ts";
import {
	buildNavigatorTasks,
	createExpansionState,
	flattenNavigatorTree,
	moveCursor,
	nextTaskRow,
	resolveDetailModel,
	toggleNavigatorRow,
	type NavigatorExpansionState,
	type NavigatorRow,
	type NavigatorTaskView,
} from "./navigator.ts";
import { GLYPH_COLORS } from "./strip.ts";

/** Poll cadence: re-read the shared dispatch state and re-render. */
export const NAVIGATOR_POLL_INTERVAL_MS = 300;

export interface NavigatorSources {
	registry: DispatchRegistry;
	detachedJobs: DetachedJobSnapshot[];
}

const TREE_PANE_MIN_WIDTH = 26;
const DETAIL_PANE_MIN_WIDTH = 30;
const PANE_GAP = 3;

const HINTS_LINE = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · ctrl+t tools · esc close";

/** Marker prefixing a thinking line, so thought reads as thought and not as streamed output. */
const THINKING_MARKER = "…";

const BLANK_DETAIL_LINE: DetailLine = { text: "", key: BLANK_LINE_KEY };

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class NavigatorView implements Focusable {
	/** Focusable interface - set by TUI when focus changes. */
	focused = false;

	private tasks: NavigatorTaskView[] = [];
	private rows: NavigatorRow[] = [];
	private expansion: NavigatorExpansionState = createExpansionState();
	private selectedId: string | null = null;
	private selectedIndex = 0;
	private scroll: DetailScrollState = createDetailScrollState();
	private showToolNoise = false;
	private interval: ReturnType<typeof setInterval> | null = null;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly sources: NavigatorSources;
	private readonly done: (result: undefined) => void;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, sources: NavigatorSources, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.sources = sources;
		this.done = done;
		this.refresh();
		this.interval = setInterval(() => {
			this.refresh();
			this.tui.requestRender();
		}, NAVIGATOR_POLL_INTERVAL_MS);
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** TUI invalidation hook: no cached render state, every render rebuilds rows from the shared state. */
	invalidate(): void {}

	/** Re-read the shared dispatch state, keeping the cursor on its row (or clamped) across rebuilds. */
	private refresh(): void {
		this.tasks = buildNavigatorTasks(this.sources.registry, this.sources.detachedJobs, Date.now());
		this.rows = flattenNavigatorTree(this.tasks, this.expansion);
		if (this.rows.length === 0) {
			this.selectedIndex = 0;
			this.adoptSelection(null);
			return;
		}
		const stillVisible = this.selectedId !== null && this.rows.some((row) => row.id === this.selectedId);
		if (!stillVisible) {
			this.selectedIndex = Math.min(this.selectedIndex, this.rows.length - 1);
			this.adoptSelection(this.rows[this.selectedIndex].id);
			return;
		}
		this.selectedIndex = this.rows.findIndex((row) => row.id === this.selectedId);
	}

	private select(index: number): void {
		const row = this.rows[index];
		if (!row) return;
		this.selectedIndex = index;
		this.adoptSelection(row.id);
	}

	/** Re-anchor the detail window when the selection identity changes: a different row is different content, so a held window cannot carry over. */
	private adoptSelection(id: string | null): void {
		if (id !== this.selectedId) this.scroll = createDetailScrollState();
		this.selectedId = id;
	}

	/** Toggle tool-noise visibility and re-anchor: filtering reshapes the line list, so a held window could point past the new tail. */
	private toggleToolNoise(): void {
		this.showToolNoise = !this.showToolNoise;
		this.scroll = createDetailScrollState();
		this.tui.requestRender();
	}

	/**
	 * Match a key against a pi action id through the injected manager
	 * (user remaps honored), falling back to the raw key when the
	 * manager does not fire, so the toggle works against a manager
	 * built without the app.tree.filter ids too.
	 */
	private matchesAction(data: string, action: Keybinding, fallbackKey: KeyId): boolean {
		return this.keybindings.matches(data, action) || matchesKey(data, fallbackKey);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) {
			this.select(moveCursor(this.rows, this.selectedIndex, -1));
			return;
		}
		if (matchesKey(data, "down")) {
			this.select(moveCursor(this.rows, this.selectedIndex, 1));
			return;
		}
		if (matchesKey(data, "tab")) {
			this.select(nextTaskRow(this.rows, this.selectedIndex, 1));
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.select(nextTaskRow(this.rows, this.selectedIndex, -1));
			return;
		}
		if (matchesKey(data, "left")) {
			this.toggleRow(false);
			return;
		}
		if (matchesKey(data, "right")) {
			this.toggleRow(true);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.pageDetail(-1);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.pageDetail(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.jumpDetail(0);
			return;
		}
		if (matchesKey(data, "end")) {
			this.jumpDetail(Number.POSITIVE_INFINITY);
			return;
		}
		if (this.matchesAction(data, "app.tree.filter.noTools", "ctrl+t")) {
			this.toggleToolNoise();
			return;
		}
		if (this.matchesAction(data, "app.tree.filter.cycleForward", "ctrl+o")) {
			this.toggleToolNoise();
			return;
		}
	}

	/** left collapses, right expands; the row semantics live in the pure toggleNavigatorRow (suite-pinned), the component only dispatches keys and re-reads. */
	private toggleRow(expand: boolean): void {
		const row = this.rows[this.selectedIndex];
		if (!row) return;
		toggleNavigatorRow(this.expansion, row, expand);
		this.refresh();
	}

	/** Page the detail pane one viewport (minus its overlap line) up or down; the tail-following state lives in the pure DetailScrollState. */
	private pageDetail(direction: -1 | 1): void {
		const viewport = this.detailViewportRows(viewBodyRows(this.tui.terminal.rows));
		scrollDetailBy(this.scroll, direction * pageStepRows(viewport), this.detailKeys(), viewport);
	}

	/** Jump the detail pane to a line index (clamped; Infinity lands on the tail). */
	private jumpDetail(target: number): void {
		const viewport = this.detailViewportRows(viewBodyRows(this.tui.terminal.rows));
		scrollDetailTo(this.scroll, target, this.detailKeys(), viewport);
	}

	/**
	 * Detail-pane viewport rows for the current frame: the body budget
	 * minus the row the tree's +N more clip occupies while the tree
	 * overflows, so the window and its indicator always fit the rows
	 * the frame actually shows. A scroll computed against a shorter
	 * tree runs on the stale larger budget until the next render's
	 * clamp, self-correcting within one poll.
	 */
	private detailViewportRows(bodyRows: number): number {
		return this.rows.length > bodyRows ? bodyRows - 1 : bodyRows;
	}

	private detailKeys(): string[] {
		return this.renderDetailLines().map((line) => line.key);
	}

	private renderTreeRow(row: NavigatorRow): string {
		const theme = this.theme;
		const selected = row.id === this.selectedId;
		const indent = "  ".repeat(row.depth);
		const cursor = selected ? "▸ " : "  ";
		const glyph = theme.fg(GLYPH_COLORS[row.glyph], statusGlyph(row.glyph));
		const label =
			row.kind === "task"
				? theme.fg("accent", theme.bold(row.label))
				: theme.fg("toolTitle", row.kind === "round" ? theme.bold(row.label) : row.label);
		const detail = row.detail ? theme.fg("muted", ` · ${row.detail}`) : "";
		const activity = row.activity ? theme.fg("dim", ` · ${row.activity}`) : "";
		const line = `${indent}${cursor}${glyph} ${label}${detail}${activity}`;
		return selected && this.focused ? line + CURSOR_MARKER : line;
	}

	private renderDetailLines(): DetailLine[] {
		const theme = this.theme;
		const selected = this.rows.find((row) => row.id === this.selectedId) ?? null;
		const model = resolveDetailModel(selected, this.tasks);
		if (model.kind === "empty") return [{ text: theme.fg("muted", "No dispatches yet"), key: PLACEHOLDER_LINE_KEY }];
		const lines: DetailLine[] = [];
		const titleGlyph = theme.fg(GLYPH_COLORS[selected.glyph], statusGlyph(selected.glyph));
		lines.push({
			text: `${titleGlyph} ${theme.fg("toolTitle", theme.bold(model.title))} ${theme.fg("muted", model.statusText)}`,
			key: HEADER_LINE_KEY,
		});
		for (const field of model.fields) {
			lines.push({
				text: `${theme.fg("muted", `${field.label}:`)} ${theme.fg("dim", field.value)}`,
				key: fieldLineKey(field.label),
			});
		}
		if (model.members.length > 0) {
			lines.push(BLANK_DETAIL_LINE);
			for (const [memberIndex, member] of model.members.entries()) {
				lines.push({
					text: `${theme.fg(GLYPH_COLORS[member.glyph], statusGlyph(member.glyph))} ${theme.fg("toolTitle", member.label)} ${theme.fg("muted", `· ${member.detail}`)}`,
					key: memberLineKey(memberIndex),
				});
			}
		}
		const activity = filterActivityEntries(model.activity, this.showToolNoise);
		if (activity.length > 0) {
			lines.push(BLANK_DETAIL_LINE);
			for (const entry of activity) {
				const clock = theme.fg("muted", entry.at ? formatClock(entry.at) : "--:--:--");
				if (entry.kind === "thinking") {
					lines.push({ text: `${clock} ${theme.fg("dim", `${THINKING_MARKER} ${entry.text}`)}`, key: activityLineKey(entry) });
				} else {
					lines.push({
						text: `${clock} ${theme.fg(entry.kind === "toolCall" ? "toolOutput" : "dim", entry.text)}`,
						key: activityLineKey(entry),
					});
				}
			}
		}
		if (model.usageText) {
			lines.push(BLANK_DETAIL_LINE, { text: theme.fg("muted", model.usageText), key: USAGE_LINE_KEY });
		}
		if (model.resultText) {
			const failed = model.resultText.startsWith("failed");
			lines.push({
				text: theme.fg(failed ? "error" : "success", `${failed ? "✗" : "✓"} ${model.resultText}`),
				key: RESULT_LINE_KEY,
			});
		}
		return lines;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const bodyWidth = Math.max(TREE_PANE_MIN_WIDTH + PANE_GAP + DETAIL_PANE_MIN_WIDTH, width);
		const treeW = Math.max(TREE_PANE_MIN_WIDTH, Math.floor(bodyWidth * 0.44));
		const detailW = bodyWidth - treeW - PANE_GAP;

		const bodyRows = viewBodyRows(this.tui.terminal.rows);
		const treeRows = this.rows.map((row) => this.renderTreeRow(row));
		const omitted = Math.max(0, treeRows.length - bodyRows);
		const viewport = this.detailViewportRows(bodyRows);
		const detailLines = this.renderDetailLines();
		const keys = detailLines.map((line) => line.key);
		stabilizeDetailScroll(this.scroll, keys, viewport);
		const visible = detailWindow(this.scroll, keys, viewport);
		const detailTexts = detailLines.slice(visible.start, visible.end).map((line) => line.text);
		if (visible.newOutput) detailTexts.push(theme.fg("muted", SCROLL_NEW_INDICATOR));

		const body = new HStack(
			[
				{ component: new VStack(treeRows.map((line) => new Text(line, 0, 0))), basis: treeW },
				{ component: new VStack(detailTexts.map((line) => new Text(line, 0, 0))), basis: detailW },
			],
			{ gap: PANE_GAP, align: "start" },
		).render(bodyWidth);
		// Fixed full-height frame: the body region pads to the viewport
		// every render, and the pad lives here rather than on the pane
		// line lists because pi-tui's Text renders empty text as zero
		// lines, so blank list entries would not pad a VStack.
		const clipped = body.slice(0, viewport);
		while (clipped.length < viewport) clipped.push("");
		if (omitted > 0) clipped.push(theme.fg("muted", `… +${omitted} more`));

		const filterState = this.showToolNoise ? "tools shown" : "tools hidden";
		const header = `${theme.fg("accent", theme.bold("Navigator"))} ${theme.fg("muted", `· ${filterState} · ctrl+t`)}`;
		return [header, ...clipped, theme.fg("muted", HINTS_LINE)].map((line) => truncateToWidth(line, width));
	}
}
