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
 * activity plus its full-text thinking (a live section fed by the
 * dispatch registry's bounded thinkingLog), a header line carrying
 * the tool-noise filter state, and a hints line at the bottom; there is
 * no box border because while
 * open the view is the whole screen, not a floating card. Reads the
 * shared dispatch state on a poll interval (doom-overlay pattern:
 * interval plus requestRender, cleared in dispose) and renders
 * through the theme with the fleet glyph conventions. Strictly
 * read-only over dispatches: the fixed v1 keys move the cursor,
 * collapse or expand, page the detail pane, toggle tool-noise
 * visibility, and open the selected finished agent's full thinking
 * from the session transcript (t, streamed line by line behind a
 * loading note so no press ever blocks on disk), and in fullscreen
 * mode the mouse wheel scrolls the detail pane through the same scroll
 * model; nothing steers a dispatch.
 *
 * In fullscreen mode pi's alt-screen dispatcher offers normalized
 * wheel events to the overlay, coordinates localized to the view's
 * box, carrying a signed wheelDelta already scaled by the stack's
 * scroll acceleration (negative up, positive down, multiplied by five
 * under alt), so the wheel consumes the delta natively instead of
 * counting discrete notches and stays consistent with how the
 * transcript's own ScrollView accelerates. handleMouse clamps the
 * delta to a per-event ceiling and feeds it through the same
 * scrollDetailBy as the paging keys, claiming every wheel with
 * { handled: true }: wheel the overlay leaves unhandled falls through
 * to the transcript ScrollView beneath, which while the view is open
 * is fully covered and must not scroll invisibly. Clicks and every
 * non-wheel event pass through unclaimed, and regular mode never
 * parses mouse at all, so the scroll keys remain the only scroll path
 * there. Escape and a second press of the open key resolve
 * done(undefined), which closes the overlay and restores the editor.
 *
 * The tool-noise toggle hides the file-reading tool calls (read,
 * grep, find, ls) so the default detail pane leads with thinking and
 * assistant text; ctrl+t and ctrl+t's cycle alias ctrl+o flip it,
 * matched through the injected KeybindingsManager against pi's
 * app.tree.filter action ids (user remaps honored, the TreeSelector
 * precedent) with raw matchesKey fallbacks.
 */

import type { KeybindingsManager, Theme, TUI } from "@earendil-works/pi-coding-agent";
import { createReadStream, fstatSync } from "node:fs";
import { createInterface } from "node:readline";
import { CURSOR_MARKER, type Focusable, type KeyId, type Keybinding, type TuiMouseEvent, type TuiMouseEventResult, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { HStack, Text, VStack } from "@earendil-works/pi-tui";
import { filterActivityEntries } from "./activity-filter.ts";
import { statusGlyph, type DetachedJobSnapshot, type DispatchRegistry, type DispatchThinkingEntry } from "../subagent/registry.ts";
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
	createTranscriptThinkingScanner,
	flattenNavigatorTree,
	moveCursor,
	nextTaskRow,
	resolveDetailModel,
	toggleNavigatorRow,
	type NavigatorExpansionState,
	type NavigatorRow,
	type NavigatorTaskView,
	type TranscriptThinkingLookup,
} from "./navigator.ts";
import { GLYPH_COLORS } from "./strip.ts";

/** Poll cadence: re-read the shared dispatch state and re-render. */
export const NAVIGATOR_POLL_INTERVAL_MS = 300;

export interface NavigatorSources {
	registry: DispatchRegistry;
	detachedJobs: DetachedJobSnapshot[];
	/**
	 * The configured open key the view closes on: a press of it beside
	 * escape resolves done(undefined), the same close escape produces,
	 * so the key that opens the overlay toggles it. Wired from the
	 * entry's resolved viewer keys so a remapped key closes what it
	 * opened.
	 */
	navigatorKey: KeyId;
	/**
	 * Resolves the current session's .jsonl path for the t keybinding's
	 * transcript read; absent or undefined-yielding means no transcript
	 * is trackable and t renders a note instead. Wired from the
	 * shortcut handler's ctx.sessionManager.getSessionFile().
	 */
	sessionFile?: () => string | undefined;
	/**
	 * Streams the transcript file line by line for the t keybinding:
	 * called with the session file path, a per-line callback, and an
	 * abort signal, resolving when the read completed and rejecting when
	 * it failed; the view feeds the lines into its scanner and lands
	 * only if the read was not aborted meanwhile. Absent means the
	 * default readline-over-createReadStream reader runs; the navigator
	 * suites inject a deterministic reader instead.
	 */
	readTranscriptLines?: (file: string, onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
}

const TREE_PANE_MIN_WIDTH = 26;
const DETAIL_PANE_MIN_WIDTH = 30;
const PANE_GAP = 3;

const HINTS_LINE = "↑/↓ move · ←/→ collapse/expand · tab next task · pgup/pgdn scroll · ctrl+t tools · t thinking · esc close";

/**
 * Per-event wheel ceiling in detail lines: above the stack's largest
 * accelerated delta (its six-line velocity peak times the alt
 * fivefold multiplier), so real events pass unclamped while a
 * pathological one cannot move the window further than one maximum
 * wheel. Accepted limit: the ceiling assumes the default "auto"
 * setting, so with a numeric fullscreenWheelScrollLines above 6 (the
 * alt multiplier is five) one wheel scrolls the transcript beyond 30
 * lines while the navigator still clamps here; the "auto" peak
 * (6 * 5 = 30) equals the ceiling and is unaffected.
 */
export const WHEEL_MAX_DELTA_LINES = 30;

/** Marker prefixing a thinking line, so thought reads as thought and not as streamed output. */
const THINKING_MARKER = "…";

/** Label heading the live thinking section below the activity log. */
const THINKING_SECTION_LABEL = "thinking · live";

/** Label heading the transcript reading view the t keybinding opens. */
const TRANSCRIPT_SECTION_LABEL = "full thinking · transcript · t to return";

/** Note rendered when the transcript cannot be read (no tracking, no file). */
const TRANSCRIPT_UNAVAILABLE_NOTE = "session transcript unavailable";

/** Note rendered under the transcript label while the streamed read is in flight. */
const TRANSCRIPT_LOADING_NOTE = "reading transcript…";

/** Note when the transcript holds no record for the agent: the record is absent, not the thinking. */
const TRANSCRIPT_NO_RECORD_NOTE = "no transcript record for this agent";

/** The no-record note when the agent's live buffer holds thinking: the buffer stands in for the missing record. */
const TRANSCRIPT_NO_RECORD_LIVE_NOTE = `${TRANSCRIPT_NO_RECORD_NOTE}; showing live buffer`;

/** Note when the agent's transcript record exists but holds no thinking: the record's emptiness, named without denying the record. */
const TRANSCRIPT_RECORD_NO_THINKING_NOTE = "this agent's transcript record holds no thinking";

/** The found-but-thinkingless note when the agent's live buffer holds thinking: the buffer stands in for the thinkingless record. */
const TRANSCRIPT_RECORD_NO_THINKING_LIVE_NOTE = `${TRANSCRIPT_RECORD_NO_THINKING_NOTE}; showing live buffer`;

/** Identity key of the live section's label as retained by either transcript empty state, distinct from the transcript label's key so scroll stabilization never anchors one as the other. */
const TRANSCRIPT_EMPTY_STATE_LIVE_LABEL_KEY = "thinking-empty-live-label";

/** Identity key of the thinking section's label line: a structural slot like the pane's other static lines. */
const THINKING_LABEL_LINE_KEY = "thinking-label";

/** Identity key of the transcript view's loading note, stable across polls so scroll stabilization never reacts to it. */
const TRANSCRIPT_LOADING_LINE_KEY = "thinking-loading";

const BLANK_DETAIL_LINE: DetailLine = { text: "", key: BLANK_LINE_KEY };

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The default transcript reader behind the t keybinding: readline over
 * a read stream yields the file line by line (and a torn trailing line
 * still yields, failing the scanner's parse guard exactly as the
 * whole-string split did), so no press ever allocates the file as one
 * string or blocks the UI thread for the whole read. The feed is
 * capped at the file's byte length observed when the stream opens: a
 * line whose content reaches past that length is never fed and the
 * reader closes early at the cap, so the lookup resolves exactly the
 * snapshot a synchronous read at open would have seen and records
 * appended while the read is in flight never compete. The abort signal
 * closes the stream mid-read; an aborted read resolves (the view drops
 * its result by the abort handle) and a failed open or read rejects,
 * which the view lands on its unavailable note.
 */
function streamTranscriptLines(file: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const input = createReadStream(file, { encoding: "utf8" });
		const reader = createInterface({ input, crlfDelay: Infinity });
		let settled = false;
		let failure: unknown;
		let limit = Number.POSITIVE_INFINITY;
		let consumed = 0;
		input.on("open", () => {
			limit = fstatSync(input.fd).size;
		});
		const close = () => {
			reader.close();
			input.destroy();
		};
		const settle = (outcome?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (outcome === undefined) resolve();
			else reject(outcome);
		};
		function onAbort() {
			close();
		}
		signal.addEventListener("abort", onAbort, { once: true });
		reader.on("line", (line) => {
			const bytes = Buffer.byteLength(line, "utf8");
			if (consumed + bytes > limit) {
				close();
				return;
			}
			consumed += bytes + 1;
			onLine(line);
			if (consumed >= limit) close();
		});
		// reader.close() inside an error handler emits close synchronously,
		// so the close handler settles with the recorded failure; the
		// error handlers' own settle calls are then idempotent backstops.
		reader.on("close", () => settle(failure));
		reader.on("error", (error) => {
			failure = error;
			close();
			settle(error);
		});
		input.on("error", (error) => {
			failure = error;
			close();
			settle(error);
		});
	});
}

/**
 * The t keybinding's transcript reading state: the agent it was opened
 * for, its full uncapped thinking streamed from the parent session
 * .jsonl behind a loading state, and which phase the read is in. The
 * press starts the streamed read and renders the loading note until
 * the read lands (or is aborted: re-press toggles off, a cursor move
 * or dispose aborts, and an abandoned read never lands). The landed
 * snapshot is kept across polls (the transcript is append-only, so a
 * completed result is stable); moving the cursor or pressing t again
 * leaves it. Both empty states are honest about which side holds
 * nothing: no transcript record for the agent (the finished detached
 * case, whose empty subagent toolResult carries no per-agent results)
 * or a matching record with no thinking parts (an agent that finished
 * without reasoning); either keeps the live buffer's thinking section
 * visible beneath its note when the buffer is non-empty.
 */
interface TranscriptThinkingState {
	agent: string;
	state: "loading" | "loaded" | "found-empty" | "empty" | "unavailable";
	entries: DispatchThinkingEntry[];
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
	private transcript: TranscriptThinkingState | null = null;
	/** Abort handle of the active transcript read; null while no read is in flight. The single active-read slot. */
	private transcriptRead: AbortController | null = null;
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
		this.abortTranscriptRead();
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

	/** Re-anchor the detail window when the selection identity changes: a different row is different content, so a held window cannot carry over. The change also aborts any in-flight transcript read, so it can never land for the row left behind. */
	private adoptSelection(id: string | null): void {
		if (id !== this.selectedId) {
			this.abortTranscriptRead();
			this.scroll = createDetailScrollState();
			this.transcript = null;
		}
		this.selectedId = id;
	}

	/** Abort the active transcript read and free its slot, so its landing is dropped by the abort-handle guard. */
	private abortTranscriptRead(): void {
		this.transcriptRead?.abort();
		this.transcriptRead = null;
	}

	/** Toggle tool-noise visibility and re-anchor: filtering reshapes the line list, so a held window could point past the new tail. */
	private toggleToolNoise(): void {
		this.showToolNoise = !this.showToolNoise;
		this.scroll = createDetailScrollState();
		this.tui.requestRender();
	}

	/**
	 * Toggle the t keybinding's transcript reading view for the selected
	 * agent. A finished agent (done or failed) streams its full thinking
	 * from the current session .jsonl via the injected sessionFile and
	 * readTranscriptLines sources: uncapped, the selected run's window
	 * matching first and the session-latest matching subagent toolResult
	 * winning when no record falls inside the window. The press never
	 * touches disk synchronously: it renders the loading note and
	 * returns, the read's lines feed the shared scanner, and the landed
	 * result swaps the note for the terminal state. Re-press toggles off
	 * and aborts; a cursor move (adoptSelection) and dispose abort too,
	 * and an aborted read never lands. A running agent, a task or round
	 * row, or an already-open view is a no-op or toggles off; a missing
	 * source, undefined path, or failed read renders the unavailable
	 * note instead of throwing. An empty read renders a note naming
	 * which side holds nothing (no record for the agent, the
	 * finished-detached case, or a matching record with no thinking
	 * parts) and keeps the live buffer's thinking section visible
	 * beneath it when the buffer is non-empty. Opening or closing
	 * re-anchors the detail window: both swap the whole pane body.
	 */
	private toggleTranscriptThinking(): void {
		if (this.transcript) {
			this.abortTranscriptRead();
			this.transcript = null;
			this.scroll = createDetailScrollState();
			this.tui.requestRender();
			return;
		}
		const selected = this.rows.find((row) => row.id === this.selectedId) ?? null;
		const model = resolveDetailModel(selected, this.tasks);
		if (model.kind !== "agent" || model.statusText === "running") return;
		const agent = model.title;
		const sessionFile = this.sources.sessionFile?.();
		this.scroll = createDetailScrollState();
		if (!sessionFile) {
			this.transcript = { agent, state: "unavailable", entries: [] };
			this.tui.requestRender();
			return;
		}
		const read = new AbortController();
		this.transcriptRead = read;
		this.transcript = { agent, state: "loading", entries: [] };
		this.tui.requestRender();
		const scanner = createTranscriptThinkingScanner(agent, model.runWindow);
		(this.sources.readTranscriptLines ?? streamTranscriptLines)(sessionFile, (line) => scanner.feed(line), read.signal).then(
			() => this.landTranscriptRead(read, scanner.finish()),
			() => this.landTranscriptRead(read, undefined),
		);
	}

	/**
	 * Land a finished transcript read, dropping it unless it is still the
	 * active read: the single slot is keyed by the read's abort handle,
	 * and every discard path (re-press, selection change, dispose,
	 * supersession) aborts and clears the slot before the landing can
	 * run. A failed read lands on the unavailable note, parity with the
	 * synchronous catch it replaces.
	 */
	private landTranscriptRead(read: AbortController, lookup?: TranscriptThinkingLookup): void {
		if (this.transcriptRead !== read) return;
		this.transcriptRead = null;
		if (this.transcript?.state !== "loading") return;
		if (lookup === undefined) {
			this.transcript = { agent: this.transcript.agent, state: "unavailable", entries: [] };
		} else {
			this.transcript = {
				agent: this.transcript.agent,
				state: !lookup.found ? "empty" : lookup.entries.length > 0 ? "loaded" : "found-empty",
				entries: lookup.entries,
			};
		}
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
		if (matchesKey(data, "escape") || matchesKey(data, this.sources.navigatorKey)) {
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
		if (matchesKey(data, "t")) {
			this.toggleTranscriptThinking();
			return;
		}
	}

	/**
	 * Wheel input from pi's fullscreen overlay dispatch: claim every
	 * wheel ({ handled: true }), scrolling the detail pane by the signed
	 * wheelDelta clamped to WHEEL_MAX_DELTA_LINES, with the keyboard
	 * path's semantics via scrollDetailBy; non-wheel events return
	 * undefined so clicks and drags pass through unclaimed.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		const rawDelta = typeof event.wheelDelta === "number" && Number.isFinite(event.wheelDelta) ? event.wheelDelta : 0;
		const delta = Math.max(-WHEEL_MAX_DELTA_LINES, Math.min(WHEEL_MAX_DELTA_LINES, Math.trunc(rawDelta)));
		const viewport = this.detailViewport();
		scrollDetailBy(this.scroll, delta, this.detailKeys(), viewport);
		return { handled: true };
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
		const viewport = this.detailViewport();
		scrollDetailBy(this.scroll, direction * pageStepRows(viewport), this.detailKeys(), viewport);
	}

	/** Jump the detail pane to a line index (clamped; Infinity lands on the tail). */
	private jumpDetail(target: number): void {
		const viewport = this.detailViewport();
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

	/** Detail-pane viewport rows for the current terminal frame. */
	private detailViewport(): number {
		return this.detailViewportRows(viewBodyRows(this.tui.terminal.rows));
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
			row.kind === "task" || row.kind === "umbrella"
				? theme.fg("accent", theme.bold(row.label))
				: theme.fg("toolTitle", row.kind === "round" ? theme.bold(row.label) : row.label);
		const detail = row.detail ? theme.fg("muted", ` · ${row.detail}`) : "";
		const activity = row.activity ? theme.fg("dim", ` · ${row.activity}`) : "";
		const line = `${indent}${cursor}${glyph} ${label}${detail}${activity}`;
		return selected && this.focused ? line + CURSOR_MARKER : line;
	}

	/**
	 * Full-text thinking blocks as pane lines: one line per source line
	 * of each block (so the window stays reachable inside long blocks
	 * and page steps stay small), styled thinkingText italic like the
	 * main TUI's visible thinking. Blank source lines render a zero-width
	 * space so paragraph breaks survive pi-tui's empty-text-is-zero-rows
	 * rule. Line keys carry the block's timestamp, size, and head so an
	 * evicted block's keys vanish with it (a held window rests instead
	 * of drifting), and italic falls back to plain when the theme stub
	 * lacks it, the suites' minimal themes being fg/bold only.
	 */
	private thinkingLines(entries: readonly DispatchThinkingEntry[]): DetailLine[] {
		const theme = this.theme;
		const lines: DetailLine[] = [];
		for (const [entryIndex, entry] of entries.entries()) {
			const head = entry.text.slice(0, 32);
			const sourceLines = entry.text.split("\n");
			for (const [lineIndex, text] of sourceLines.entries()) {
				const styled = text.trim() ? theme.italic?.(theme.fg("thinkingText", text)) ?? theme.fg("thinkingText", text) : "\u200b";
				lines.push({
					text: styled,
					key: `thinking:${entry.at}:${entry.text.length}:${head}:${entryIndex}:${lineIndex}`,
				});
			}
		}
		return lines;
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
		if (this.transcript && this.transcript.agent === model.title && model.kind === "agent") {
			lines.push({ text: theme.fg("muted", TRANSCRIPT_SECTION_LABEL), key: THINKING_LABEL_LINE_KEY });
			if (this.transcript.state === "loading") {
				lines.push({ text: theme.fg("muted", TRANSCRIPT_LOADING_NOTE), key: TRANSCRIPT_LOADING_LINE_KEY });
			} else if (this.transcript.state === "loaded") {
				lines.push(...this.thinkingLines(this.transcript.entries));
			} else if (this.transcript.state === "empty" || this.transcript.state === "found-empty") {
				const notes =
					this.transcript.state === "empty"
						? { plain: TRANSCRIPT_NO_RECORD_NOTE, live: TRANSCRIPT_NO_RECORD_LIVE_NOTE }
						: { plain: TRANSCRIPT_RECORD_NO_THINKING_NOTE, live: TRANSCRIPT_RECORD_NO_THINKING_LIVE_NOTE };
				const hasLiveBuffer = model.thinking.length > 0;
				lines.push({ text: theme.fg("muted", hasLiveBuffer ? notes.live : notes.plain), key: "thinking-empty" });
				if (hasLiveBuffer) {
					lines.push(BLANK_DETAIL_LINE);
					lines.push({ text: theme.fg("muted", THINKING_SECTION_LABEL), key: TRANSCRIPT_EMPTY_STATE_LIVE_LABEL_KEY });
					lines.push(...this.thinkingLines(model.thinking));
				}
			} else {
				lines.push({ text: theme.fg("muted", TRANSCRIPT_UNAVAILABLE_NOTE), key: "thinking-unavailable" });
			}
			return lines;
		}
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
		if (model.thinking.length > 0) {
			lines.push(BLANK_DETAIL_LINE);
			lines.push({ text: theme.fg("muted", THINKING_SECTION_LABEL), key: THINKING_LABEL_LINE_KEY });
			lines.push(...this.thinkingLines(model.thinking));
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
		const viewport = this.detailViewport();
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
