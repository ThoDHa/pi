/**
 * Condensed Footer Extension
 *
 * Replaces the built-in 3-line footer with a single line:
 *
 *   ~/cwd (branch) Ⓜ extension-statuses    ↑in ↓out $cost N% model[:thinking]
 *
 * The right segment is flushed against the terminal's right edge. When the
 * two segments no longer fit at the current width, pieces drop in this
 * order: extension statuses, model, cost, output tokens, branch. `/footer`
 * toggles back to the built-in footer and re-installs this one. The toggle
 * records a user preference that later session starts respect, so a restored
 * built-in footer survives `/new` instead of being replaced again.
 *
 * The formatters mirror the built-in footer's, whose module the package
 * exports map blocks from importing, so they are carried here.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Token/byte usage shape the footer reads off session entries. */
export interface FooterUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

/** Flat view of the session entries whose usage the footer accumulates. */
export interface FooterEntry {
	type: string;
	usage?: FooterUsage;
	message?: { role: string; usage?: FooterUsage };
}

interface FooterUsageTotals {
	input: number;
	output: number;
	cost: number;
}

export interface FooterStats {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	contextPercent: number | null;
}

/** The slice of ExtensionContext the stats collector needs. */
export interface FooterStatsSource {
	sessionManager: {
		getEntries(): FooterEntry[];
		getSessionId(): string;
		getLeafId(): string | null;
		getEntryCount(): number;
	};
	getContextUsage(): { percent: number | null } | undefined;
	model: { id: string } | undefined;
}

/** Single-slot memo for the whole-session usage scan, keyed like the built-in footer. */
export interface FooterStatsCache {
	sessionManager: FooterStatsSource["sessionManager"] | undefined;
	sessionId: string | undefined;
	leafId: string | null | undefined;
	entryCount: number | undefined;
	modelId: string | undefined;
	stats: FooterStats | undefined;
}

export interface FooterLineInput {
	cwd: string;
	branch: string | null;
	statuses: readonly string[];
	inputTokens: number;
	outputTokens: number;
	cost: number;
	contextPercent: number | null;
	modelId: string | null;
	/** Thinking level to append as `:level`; null when the model lacks reasoning. */
	thinkingLevel: string | null;
}

export type FooterColor = "dim" | "error" | "warning";
export type FooterFg = (color: FooterColor, text: string) => string;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function shortenCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function entryUsage(entry: FooterEntry): FooterUsage | undefined {
	if (entry.usage) return entry.usage;
	const message = entry.message;
	if (message?.usage && (message.role === "assistant" || message.role === "toolResult")) return message.usage;
	return undefined;
}

export function createFooterStatsCache(): FooterStatsCache {
	return {
		sessionManager: undefined,
		sessionId: undefined,
		leafId: undefined,
		entryCount: undefined,
		modelId: undefined,
		stats: undefined,
	};
}

/**
 * Accumulate token/cost totals and context percent for the footer. The scan
 * walks the whole session and the footer renders every frame, so results are
 * memoized per (session, leaf, entry count, model) and recomputed only when
 * one of those moves.
 */
export function collectFooterStats(source: FooterStatsSource, cache: FooterStatsCache): FooterStats {
	const sessionManager = source.sessionManager;
	const sessionId = sessionManager.getSessionId();
	const leafId = sessionManager.getLeafId();
	const entryCount = sessionManager.getEntryCount();
	const modelId = source.model?.id;
	const cached = cache.stats;
	if (
		cached &&
		cache.sessionManager === sessionManager &&
		cache.sessionId === sessionId &&
		cache.leafId === leafId &&
		cache.entryCount === entryCount &&
		cache.modelId === modelId
	) {
		return cached;
	}

	const totals: FooterUsageTotals = { input: 0, output: 0, cost: 0 };
	for (const entry of sessionManager.getEntries()) {
		const usage = entryUsage(entry);
		if (!usage) continue;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cost += usage.cost.total;
	}

	const stats: FooterStats = {
		inputTokens: totals.input,
		outputTokens: totals.output,
		cost: totals.cost,
		contextPercent: source.getContextUsage()?.percent ?? null,
	};
	cache.sessionManager = sessionManager;
	cache.sessionId = sessionId;
	cache.leafId = leafId;
	cache.entryCount = entryCount;
	cache.modelId = modelId;
	cache.stats = stats;
	return stats;
}

const MIN_SEGMENT_GAP = 2;

/**
 * Lay the footer out as exactly one line no wider than `width`: left segment
 * (cwd, branch, statuses) and right segment (tokens, cost, percent, model)
 * joined by enough padding to flush the right segment against the edge. When
 * they cannot coexist, pieces drop in order statuses, model, cost, output,
 * branch, and the result is width-truncated as a final floor.
 *
 * `fg` receives only "dim", "error", and "warning"; the percent turns warning
 * above 70% and error above 90%.
 */
export function layoutFooterLine(input: FooterLineInput, width: number, fg: FooterFg): string {
	const statuses = input.statuses.map(sanitizeStatusText).filter((text) => text.length > 0).join(" ") || null;
	const branch = input.branch ? `(${input.branch})` : null;
	const up = input.inputTokens > 0 ? `↑${formatTokens(input.inputTokens)}` : null;
	const down = input.outputTokens > 0 ? `↓${formatTokens(input.outputTokens)}` : null;
	const cost = input.cost > 0 ? `$${input.cost.toFixed(3)}` : null;
	const percent = input.contextPercent === null ? "?" : `${input.contextPercent.toFixed(1)}%`;
	const model =
		input.modelId === null ? "no-model" : input.thinkingLevel ? `${input.modelId}:${input.thinkingLevel}` : input.modelId;

	let leftStatuses = statuses;
	let leftBranch = branch;
	let rightUp = up;
	let rightDown = down;
	let rightCost = cost;
	let rightModel = model;

	const leftPlain = (): string => [input.cwd, leftBranch, leftStatuses].filter((part) => part !== null).join(" ");
	const rightPlain = (): string =>
		[rightUp, rightDown, rightCost, percent, rightModel].filter((part) => part !== null).join(" ");
	const fits = (): boolean => visibleWidth(leftPlain()) + MIN_SEGMENT_GAP + visibleWidth(rightPlain()) <= width;

	if (!fits()) {
		for (const drop of [
			() => (leftStatuses = null),
			() => (rightModel = null),
			() => (rightCost = null),
			() => (rightDown = null),
			() => (leftBranch = null),
		]) {
			drop();
			if (fits()) break;
		}
	}

	const left = leftPlain();
	const right = rightPlain();
	const gap = " ".repeat(Math.max(MIN_SEGMENT_GAP, width - visibleWidth(left) - visibleWidth(right)));
	const percentColor: FooterColor | null =
		input.contextPercent === null ? null : input.contextPercent > 90 ? "error" : input.contextPercent > 70 ? "warning" : null;
	const pre = [rightUp, rightDown, rightCost].filter((part) => part !== null).join(" ");
	const post = rightModel ?? "";
	const styledRight = percentColor
		? [pre && fg("dim", pre), fg(percentColor, percent), post && fg("dim", post)].filter(Boolean).join(" ")
		: fg("dim", right);
	return truncateToWidth(fg("dim", left) + gap + styledRight, width);
}

export default function (pi: ExtensionAPI) {
	let preference: boolean | null = null;

	const install = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const cache = createFooterStatsCache();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				render(width: number): string[] {
					const stats = collectFooterStats(ctx, cache);
					return [
						layoutFooterLine(
							{
								cwd: shortenCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
								branch: footerData.getGitBranch(),
								statuses: Array.from(footerData.getExtensionStatuses().entries())
									.sort(([a], [b]) => a.localeCompare(b))
									.map(([, text]) => text),
								inputTokens: stats.inputTokens,
								outputTokens: stats.outputTokens,
								cost: stats.cost,
								contextPercent: stats.contextPercent,
								modelId: ctx.model?.id ?? null,
								thinkingLevel: ctx.model?.reasoning ? (ctx.thinkingLevel ?? "off") : null,
							},
							width,
							(color, text) => theme.fg(color, text),
						),
					];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (preference === false) return;
		install(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle condensed one-line footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			preference = preference === false;
			if (preference) {
				install(ctx);
				ctx.ui.notify("Condensed footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored", "info");
			}
		},
	});
}
