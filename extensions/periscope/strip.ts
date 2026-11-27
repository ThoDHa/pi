/**
 * Ambient strip rendering
 *
 * Pure rendering layer for the dispatch strip widget: the assembly of
 * strip task views from the dispatch registry and the detached jobs
 * registry, with labels resolved from the task prompt at render time,
 * and the strip's self-managed line budget (live tasks prioritized,
 * the navigator-key hint line always last, overflow summarized as
 * "+N more"). The widget component in index.ts maps the returned
 * segments through theme.fg. The glyph and duration helpers both
 * surfaces render from live in the shared contract module
 * (../subagent/registry.ts).
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * pin the budget and glyph behavior directly.
 */

import { aggregateSettledGlyph, resolveTaskDisplayLabel } from "./labels.ts";
import {
	type DetachedJobSnapshot,
	type DispatchAgentNode,
	type DispatchRegistry,
	type DispatchRoundNode,
	formatDuration,
	formatThinkingLevel,
	isRoundLive,
	statusGlyph,
	type StatusGlyphName,
} from "../subagent/registry.ts";

/** Strip widget line budget. Content lines are capped at maxLines minus the overflow and hint reservations. */
export const STRIP_MAX_LINES = 12;

export type StripColor = "muted" | "dim" | "accent" | "warning" | "success" | "error" | "toolTitle";

export interface StripSegment {
	text: string;
	color?: StripColor;
	bold?: boolean;
}

export interface StripLine {
	segments: StripSegment[];
}

export interface StripAgentEntry {
	kind: "agent";
	name: string;
	glyph: "running" | "done" | "failed";
	durationText: string;
	/** Pi ThinkingLevel value the agent runs at, when the node recorded one; absent renders nothing (pre-wiring records). */
	thinkingLevel?: string;
}

export interface StripRoundEntry {
	kind: "round";
	label: string;
	glyph: StatusGlyphName;
	summary: string;
	durationText: string;
}

export type StripEntry = StripAgentEntry | StripRoundEntry;

export interface StripTaskView {
	label: string;
	mode: string;
	live: boolean;
	/** The task's own outcome glyph: running while live, the settled aggregation otherwise; each settled summary line renders it. */
	glyph: StatusGlyphName;
	/** The view's settle time: a registry task's latest finite agent finish, a detached job's finishedAt, null when neither carries a finite timestamp. Settled views order the settled block by it, newest first; a view without one keeps its exact insertion slot; live views carry it unread. */
	settledAt: number | null;
	/** Task start to its latest finish (now while live); rendered on the settled summary line. */
	durationText: string;
	/** Settled views' entries are a model-level contract only: renderStripLines reads settled views' glyph, label, and durationText only. */
	entries: StripEntry[];
}

/** Glyph-to-color conventions shared with the navigator view's panes (same extension, one map). */
export const GLYPH_COLORS: Record<StatusGlyphName, StripColor> = {
	running: "warning",
	done: "success",
	failed: "error",
	mixed: "warning",
};

/** A settled view whose task carries a finite settle time. */
interface TimestampedTaskView extends StripTaskView {
	settledAt: number;
}

function hasSettleTime(view: StripTaskView): view is TimestampedTaskView {
	return view.settledAt !== null;
}

/**
 * Order the settled block newest-first by settle time. A view without
 * a finite settle time keeps its exact insertion slot: the timestamped
 * views fill the remaining slots newest first around it, so the
 * stamp-less view neither drifts nor blocks its neighbors' order.
 */
function orderSettledViews(tasks: StripTaskView[]): StripTaskView[] {
	const timestamped = tasks.filter(hasSettleTime);
	timestamped.sort((a, b) => b.settledAt - a.settledAt);
	const ordered: StripTaskView[] = [];
	let nextTimestamped = 0;
	for (const task of tasks) {
		if (hasSettleTime(task)) ordered.push(timestamped[nextTimestamped++]);
		else ordered.push(task);
	}
	return ordered;
}

function agentEntryLine(entry: StripAgentEntry): StripLine {
	const segments: StripSegment[] = [
		{ text: statusGlyph(entry.glyph), color: GLYPH_COLORS[entry.glyph] },
		{ text: ` ${entry.name}`, color: "toolTitle", bold: true },
	];
	const level = formatThinkingLevel(entry.thinkingLevel);
	if (level) segments.push({ text: ` · ${level}`, color: "muted" });
	segments.push({ text: ` · ${entry.durationText}`, color: "muted" });
	return { segments };
}

function roundEntryLine(entry: StripRoundEntry): StripLine {
	return {
		segments: [
			{ text: statusGlyph(entry.glyph), color: GLYPH_COLORS[entry.glyph] },
			{ text: ` ${entry.label}`, color: "toolTitle", bold: true },
			{ text: ` · ${entry.summary}`, color: "dim" },
			{ text: ` · ${entry.durationText}`, color: "muted" },
		],
	};
}

/**
 * Render the strip's lines under the line budget. Live tasks render
 * before the settled group, and each settled dispatch renders one
 * summary line of its own (its own outcome glyph, its summary label,
 * its duration) closing the content; the settled group orders
 * newest-first by settle time, so the budget's tail cut drops the
 * oldest settled lines first while live content still leads; the hint
 * line is always last; when content exceeds maxLines minus the
 * overflow and hint reservations, the tail is summarized as one
 * "+N more" line (N = omitted content lines).
 */
export function renderStripLines(
	tasks: StripTaskView[],
	options: { hint: string; maxLines?: number },
): StripLine[] {
	const hintLine: StripLine = { segments: [{ text: options.hint, color: "muted" }] };
	if (tasks.length === 0) {
		return [{ segments: [{ text: "No active dispatches", color: "muted" }] }, hintLine];
	}

	const lines: StripLine[] = [];
	for (const task of tasks) {
		if (!task.live) continue;
		lines.push({
			segments: [
				{ text: task.label, color: "accent", bold: true },
				{ text: ` · ${task.mode}`, color: "muted" },
			],
		});
		for (const entry of task.entries) {
			lines.push(entry.kind === "agent" ? agentEntryLine(entry) : roundEntryLine(entry));
		}
	}
	const settled = orderSettledViews(tasks.filter((task) => !task.live));
	for (const task of settled) {
		lines.push({
			segments: [
				{ text: statusGlyph(task.glyph), color: GLYPH_COLORS[task.glyph] },
				{ text: ` ${task.label}`, color: "accent", bold: true },
				{ text: ` · ${task.durationText}`, color: "muted" },
			],
		});
	}

	const maxContent = Math.max(1, (options.maxLines ?? STRIP_MAX_LINES) - 2);
	if (lines.length <= maxContent) return [...lines, hintLine];
	const omitted = lines.length - maxContent;
	return [...lines.slice(0, maxContent), { segments: [{ text: `+${omitted} more`, color: "muted" }] }, hintLine];
}

function roundStatus(round: DispatchRoundNode): StatusGlyphName {
	const failed = round.agents.filter((agent) => agent.status === "failed").length;
	if (failed === 0) return "done";
	return failed === round.agents.length ? "failed" : "mixed";
}

function roundSummary(round: DispatchRoundNode): string {
	const done = round.agents.filter((agent) => agent.status === "done").length;
	const failed = round.agents.filter((agent) => agent.status === "failed").length;
	return failed > 0 ? `${done}/${round.agents.length} done, ${failed} failed` : `${done}/${round.agents.length} done`;
}

function collapsedRoundEntry(round: DispatchRoundNode, now: number): StripRoundEntry {
	const starts = round.agents.map((agent) => agent.startedAt);
	const ends = round.agents.map((agent) => agent.finishedAt ?? now);
	return {
		kind: "round",
		label: `round ${round.index}`,
		glyph: roundStatus(round),
		summary: roundSummary(round),
		durationText: formatDuration(Math.max(...ends) - Math.min(...starts)),
	};
}

function agentEntry(agent: DispatchAgentNode, now: number): StripAgentEntry {
	return {
		kind: "agent",
		name: agent.agent,
		glyph: agent.status,
		durationText: formatDuration((agent.finishedAt ?? now) - agent.startedAt),
		thinkingLevel: agent.thinkingLevel,
	};
}

/**
 * Assemble the strip's task views from the blocking-path dispatch
 * registry plus the detached jobs registry. Task labels resolve from
 * the prompt at render time through the summary chain (the task-file
 * citation's id plus slug, then the fleet-reference/first-words
 * heuristic), falling back to the detached jobs'
 * "(detached)" wording when the resolution comes up empty so a task
 * header never renders bare; a finished round of a
 * live task collapses to one round entry; within a task, live rounds'
 * agent entries lead so the budget's tail cut spares live content; a
 * live view carries the running glyph and a settled view the
 * aggregation of its agents' outcomes, and every view derives its
 * durationText the way the navigator's task view does (registry tasks
 * from task start to the latest agent finish, now while live; detached
 * jobs from start to finishedAt, now while running). Every view also
 * carries its settle time (a registry task's latest finite agent
 * finish, a detached job's finishedAt, null when neither exists),
 * which orders the settled block newest-first at render time. A
 * detached job becomes one task view labeled through the same
 * summary chain as blocking tasks. Its per-slot
 * agent nodes (the EXT-1-3 wiring) stream per-agent
 * glyph and duration onto the strip when the snapshot
 * carries them (an empty array means nothing has started yet and
 * renders no entries); snapshots without the array fall back to one
 * entry per agent name keyed off job.status.
 */
export function buildStripTasks(
	registry: DispatchRegistry,
	jobs: Iterable<DetachedJobSnapshot>,
	now: number,
): StripTaskView[] {
	const views: StripTaskView[] = [];
	for (const task of registry.tasks()) {
		const liveRounds = task.rounds.filter(isRoundLive);
		const live = liveRounds.length > 0;
		const finishedRounds = task.rounds.filter((round) => !isRoundLive(round));
		const entries: StripEntry[] = [];
		for (const round of liveRounds) {
			for (const agent of round.agents) entries.push(agentEntry(agent, now));
		}
		for (const round of finishedRounds) entries.push(collapsedRoundEntry(round, now));
		const allAgents = task.rounds.flatMap((round) => round.agents);
		const finishTimes = allAgents.map((agent) => agent.finishedAt ?? now);
		const finishStamps = allAgents
			.map((agent) => agent.finishedAt)
			.filter((stamp): stamp is number => typeof stamp === "number");
		views.push({
			label: resolveTaskDisplayLabel(task.prompt),
			mode: task.mode,
			live,
			glyph: live ? "running" : aggregateSettledGlyph(allAgents.map((agent) => ({ glyph: agent.status }))),
			settledAt: finishStamps.length > 0 ? Math.max(...finishStamps) : null,
			durationText: formatDuration((finishTimes.length > 0 ? Math.max(...finishTimes) : now) - task.startedAt),
			entries,
		});
	}

	for (const job of jobs) {
		const fallbackEnd = job.finishedAt ?? now;
		const entries: StripAgentEntry[] = job.agents
			? job.agents.map((node) => agentEntry(node, fallbackEnd))
			: job.agentNames.map((name) => ({ kind: "agent", name, glyph: job.status, durationText: formatDuration(fallbackEnd - job.startedAt) }));
		views.push({
			label: resolveTaskDisplayLabel(job.taskPreview),
			mode: job.mode,
			live: job.status === "running",
			glyph: job.status,
			settledAt: typeof job.finishedAt === "number" ? job.finishedAt : null,
			durationText: formatDuration(fallbackEnd - job.startedAt),
			entries,
		});
	}
	return views;
}
