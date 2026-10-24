/**
 * Condensed Footer Extension
 *
 * Replaces the built-in 3-line footer with a single line:
 *
 *   ~/cwd (branch) Ⓜ extension-statuses    ⏳N ↑in ↓out $cost 45k/200k 45.3% model[:thinking]
 *
 * The right segment is flushed against the terminal's right edge. When the
 * two segments no longer fit at the current width, pieces drop in this
 * order: extension statuses, model, cost, the used/window fragment (the
 * percent alone stays), output tokens, branch, the jobs marker. `/footer`
 * toggles back to the built-in footer and re-installs this one. The toggle
 * records a user preference that later session starts respect, so a restored
 * built-in footer survives `/new` instead of being replaced again.
 *
 * While detached jobs run, the marker reads ⏳J·A: J is the subagent
 * extension's detached jobs still running and A their running agents
 * (a parallel dispatch is one job with many agents). Both counts are read
 * fresh from the shared dispatch state on every frame; a 500 ms render poll
 * keeps them live between session entries and is cleared on dispose.
 *
 * The formatters mirror the built-in footer's, whose module the package
 * exports map blocks from importing, so they are carried here.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getSharedDispatchState, statusGlyph, type DetachedJobSnapshot } from "./subagent/registry.ts";

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
	contextTokens: number | null;
	contextWindow: number | null;
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
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
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
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
	runningJobs: number;
	runningAgents: number;
	modelId: string | null;
	/** Thinking level to append as `:level`; null when the model lacks reasoning. */
	thinkingLevel: string | null;
}

export type FooterColor = "dim" | "muted" | "accent" | "error" | "warning";
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
 * Accumulate token/cost totals and context usage for the footer. The scan
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

	const usage = source.getContextUsage();
	const stats: FooterStats = {
		inputTokens: totals.input,
		outputTokens: totals.output,
		cost: totals.cost,
		contextTokens: usage?.tokens ?? null,
		contextWindow: usage?.contextWindow ?? null,
		contextPercent: usage?.percent ?? null,
	};
	cache.sessionManager = sessionManager;
	cache.sessionId = sessionId;
	cache.leafId = leafId;
	cache.entryCount = entryCount;
	cache.modelId = modelId;
	cache.stats = stats;
	return stats;
}

export const JOB_POLL_INTERVAL_MS = 500;

/** Running detached jobs and the agents running inside them. */
export interface DetachedFleetCounts {
	jobs: number;
	agents: number;
}

/**
 * Count the detached-job snapshots whose job-level status is still running,
 * plus the agents running inside those jobs. Per running job the agent count
 * walks the live per-slot nodes and counts status "running"; a snapshot from
 * before the nodes exist (lazy/empty `agents`) falls back to `agentNames`,
 * and with neither source it counts as 1, so detail-less jobs stay visible.
 * Done and failed jobs contribute to neither count.
 */
export function countDetachedFleet(jobs: readonly DetachedJobSnapshot[]): DetachedFleetCounts {
	let runningJobs = 0;
	let runningAgents = 0;
	for (const job of jobs) {
		if (job.status !== "running") continue;
		runningJobs++;
		if (job.agents?.length) {
			for (const agent of job.agents) {
				if (agent.status === "running") runningAgents++;
			}
		} else if (job.agentNames?.length) {
			runningAgents += job.agentNames.length;
		} else {
			runningAgents++;
		}
	}
	return { jobs: runningJobs, agents: runningAgents };
}

/** Start the render poll that carries running-jobs changes to frames between session entries. */
export function startFooterJobPolling(
	tui: { requestRender(): void },
	intervalMs: number = JOB_POLL_INTERVAL_MS,
): ReturnType<typeof setInterval> {
	return setInterval(() => tui.requestRender(), intervalMs);
}

const MIN_SEGMENT_GAP = 2;

/** `used/window percent` (e.g. `45k/200k 45.3%`), `?/200k ?` post-compaction, bare percent without a window. */
function formatContextCluster(
	tokens: number | null,
	window: number | null,
	percent: number | null,
	includeWindow: boolean,
): string {
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	if (!includeWindow || window === null) return percentText;
	const used = tokens === null ? "?" : formatTokens(tokens);
	return `${used}/${formatTokens(window)} ${percentText}`;
}

/**
 * Lay the footer out as exactly one line no wider than `width`: left segment
 * (cwd, branch, statuses) and right segment (jobs marker, tokens, cost,
 * context cluster, model) joined by enough padding to flush the right
 * segment against the edge. When they cannot coexist, pieces drop in order
 * statuses, model, cost, the used/window fragment, output, branch, jobs, and
 * the result is width-truncated as a final floor. Cwd, input tokens, and the
 * percent never drop.
 *
 * `fg` receives "dim", "muted", "accent", "error", and "warning": statuses
 * pass through with their owner's colors, the jobs marker warns while jobs
 * run, the context cluster turns warning above 70% and error above 90%
 * (muted otherwise), the model takes the theme's accent, branch and token
 * counts are muted, and cwd is dim.
 */
export function layoutFooterLine(input: FooterLineInput, width: number, fg: FooterFg): string {
	const statuses = input.statuses.map(sanitizeStatusText).filter((text) => text.length > 0).join(" ") || null;
	const branch = input.branch ? `(${input.branch})` : null;
	const up = input.inputTokens > 0 ? `↑${formatTokens(input.inputTokens)}` : null;
	const down = input.outputTokens > 0 ? `↓${formatTokens(input.outputTokens)}` : null;
	const cost = input.cost > 0 ? `$${input.cost.toFixed(3)}` : null;
	const jobs = input.runningJobs > 0 ? `${statusGlyph("running")}${input.runningJobs}·${input.runningAgents}` : null;
	const model =
		input.modelId === null ? "no-model" : input.thinkingLevel ? `${input.modelId}:${input.thinkingLevel}` : input.modelId;

	let leftStatuses = statuses;
	let leftBranch = branch;
	let rightJobs = jobs;
	let rightUp = up;
	let rightDown = down;
	let rightCost = cost;
	let showWindow = true;
	let rightModel = model;

	const leftPlain = (): string => [input.cwd, leftBranch, leftStatuses].filter((part) => part !== null).join(" ");
	const clusterPlain = (): string =>
		formatContextCluster(input.contextTokens, input.contextWindow, input.contextPercent, showWindow);
	const rightPlain = (): string =>
		[rightJobs, rightUp, rightDown, rightCost, clusterPlain(), rightModel].filter((part) => part !== null).join(" ");
	const fits = (): boolean => visibleWidth(leftPlain()) + MIN_SEGMENT_GAP + visibleWidth(rightPlain()) <= width;

	if (!fits()) {
		for (const drop of [
			() => (leftStatuses = null),
			() => (rightModel = null),
			() => (rightCost = null),
			() => (showWindow = false),
			() => (rightDown = null),
			() => (leftBranch = null),
			() => (rightJobs = null),
		]) {
			drop();
			if (fits()) break;
		}
	}

	const leftParts = [fg("dim", input.cwd)];
	if (leftBranch !== null) leftParts.push(fg("muted", leftBranch));
	if (leftStatuses !== null) leftParts.push(leftStatuses);
	const rightParts: string[] = [];
	if (rightJobs !== null) rightParts.push(fg("warning", rightJobs));
	if (rightUp !== null) rightParts.push(fg("muted", rightUp));
	if (rightDown !== null) rightParts.push(fg("muted", rightDown));
	if (rightCost !== null) rightParts.push(fg("muted", rightCost));
	const clusterColor: FooterColor =
		input.contextPercent === null
			? "muted"
			: input.contextPercent > 90
				? "error"
				: input.contextPercent > 70
					? "warning"
					: "muted";
	rightParts.push(fg(clusterColor, clusterPlain()));
	if (rightModel !== null) rightParts.push(fg("accent", rightModel));

	const left = leftParts.join(" ");
	const right = rightParts.join(" ");
	const gap = " ".repeat(Math.max(MIN_SEGMENT_GAP, width - visibleWidth(left) - visibleWidth(right)));
	return truncateToWidth(left + gap + right, width);
}

export default function (pi: ExtensionAPI) {
	let preference: boolean | null = null;

	const install = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const cache = createFooterStatsCache();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const poll = startFooterJobPolling(tui);
			return {
				dispose() {
					unsubscribe();
					clearInterval(poll);
				},
				render(width: number): string[] {
					const stats = collectFooterStats(ctx, cache);
					const fleet = countDetachedFleet(getSharedDispatchState().detachedJobs);
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
								contextTokens: stats.contextTokens,
								contextWindow: stats.contextWindow,
								contextPercent: stats.contextPercent,
								runningJobs: fleet.jobs,
								runningAgents: fleet.agents,
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
