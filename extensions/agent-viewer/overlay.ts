/**
 * Navigator overlay component
 *
 * The keyboard-driven overlay over every live dispatch: a left tree
 * pane of rows produced by the pure flatten function in navigator.ts,
 * a right detail pane streaming the selected agent's activity, and a
 * footer of keybind hints. Reads the shared dispatch state on a poll
 * interval (doom-overlay pattern: interval plus requestRender, cleared
 * in dispose) and renders through the theme with the fleet glyph
 * conventions. Strictly read-only: the fixed v1 keys move the cursor,
 * collapse or expand, and page the detail pane; nothing steers a
 * dispatch. Escape resolves done(undefined), which pi turns into
 * closing the overlay.
 */

import type { Theme, TUI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HStack, Text, VStack } from "@earendil-works/pi-tui";
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
	overlayBodyRows,
	pageStepRows,
	scrollDetailBy,
	scrollDetailTo,
	stabilizeDetailScroll,
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

const FOOTER_HINTS = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · esc close";

const BLANK_DETAIL_LINE: DetailLine = { text: "", key: BLANK_LINE_KEY };

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export class NavigatorOverlay implements Focusable {
	/** Focusable interface - set by TUI when focus changes. */
	focused = false;

	private tasks: NavigatorTaskView[] = [];
	private rows: NavigatorRow[] = [];
	private expansion: NavigatorExpansionState = createExpansionState();
	private selectedId: string | null = null;
	private selectedIndex = 0;
	private scroll: DetailScrollState = createDetailScrollState();
	private interval: ReturnType<typeof setInterval> | null = null;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly sources: NavigatorSources;
	private readonly done: (result: undefined) => void;

	constructor(tui: TUI, theme: Theme, sources: NavigatorSources, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
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
		const viewport = this.detailViewportRows(overlayBodyRows(this.tui.terminal.rows));
		scrollDetailBy(this.scroll, direction * pageStepRows(viewport), this.detailKeys(), viewport);
	}

	/** Jump the detail pane to a line index (clamped; Infinity lands on the tail). */
	private jumpDetail(target: number): void {
		const viewport = this.detailViewportRows(overlayBodyRows(this.tui.terminal.rows));
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
		if (model.activity.length > 0) {
			lines.push(BLANK_DETAIL_LINE);
			for (const entry of model.activity) {
				const clock = theme.fg("muted", entry.at ? formatClock(entry.at) : "--:--:--");
				lines.push({
					text: `${clock} ${theme.fg(entry.kind === "toolCall" ? "toolOutput" : "dim", entry.text)}`,
					key: activityLineKey(entry),
				});
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
		const innerW = Math.max(TREE_PANE_MIN_WIDTH + PANE_GAP + DETAIL_PANE_MIN_WIDTH, width - 2);
		const treeW = Math.max(TREE_PANE_MIN_WIDTH, Math.floor(innerW * 0.44));
		const detailW = innerW - treeW - PANE_GAP;

		const bodyRows = overlayBodyRows(this.tui.terminal.rows);
		const treeRows = this.rows.map((row) => this.renderTreeRow(row));
		const detailLines = this.renderDetailLines();
		const keys = detailLines.map((line) => line.key);
		const viewport = this.detailViewportRows(bodyRows);
		stabilizeDetailScroll(this.scroll, keys, viewport);
		const visible = detailWindow(this.scroll, keys, viewport);
		const detailTexts = detailLines.slice(visible.start, visible.end).map((line) => line.text);
		if (visible.newOutput) detailTexts.push(theme.fg("muted", SCROLL_NEW_INDICATOR));

		const omitted = Math.max(0, treeRows.length - bodyRows);
		const body = new HStack(
			[
				{ component: new VStack(treeRows.map((line) => new Text(line, 0, 0))), basis: treeW },
				{ component: new VStack(detailTexts.map((line) => new Text(line, 0, 0))), basis: detailW },
			],
			{ gap: PANE_GAP, align: "start" },
		).render(innerW);
		const clipped = omitted > 0 ? body.slice(0, bodyRows - 1) : body;
		if (omitted > 0) clipped.push(theme.fg("muted", `… +${omitted} more`));

		const pad = (text: string, target: number) => text + " ".repeat(Math.max(0, target - visibleWidth(text)));
		const border = theme.fg("border", "─".repeat(innerW));
		const lines: string[] = [theme.fg("border", `╭${border}╮`)];
		for (const bodyLine of clipped) {
			const padded = pad(truncateToWidth(bodyLine, innerW), innerW);
			lines.push(`${theme.fg("border", "│")}${padded}${theme.fg("border", "│")}`);
		}
		const hints = FOOTER_HINTS;
		lines.push(`${theme.fg("border", "│")}${pad(truncateToWidth(theme.fg("muted", hints), innerW), innerW)}${theme.fg("border", "│")}`);
		lines.push(theme.fg("border", `╰${border}╯`));
		return lines;
	}
}
