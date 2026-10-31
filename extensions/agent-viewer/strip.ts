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

import { aggregateSettledGlyph, dispatchCountText, resolveTaskLabel } from "./labels.ts";
import {
	type DetachedJobSnapshot,
	type DispatchAgentNode,
	type DispatchRegistry,
	type DispatchRoundNode,
	formatDuration,
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
	activity?: string;
	durationText: string;
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
	/** The task's own outcome glyph: running while live, the settled aggregation otherwise; the Completed line aggregates this field over the settled views. */
	glyph: StatusGlyphName;
	/** Settled views' entries are a model-level contract only: renderStripLines reads settled views' glyph and length only. */
	entries: StripEntry[];
}

/** Glyph-to-color conventions shared with the navigator view's panes (same extension, one map). */
export const GLYPH_COLORS: Record<StatusGlyphName, StripColor> = {
	running: "warning",
	done: "success",
	failed: "error",
	mixed: "warning",
};

function agentEntryLine(entry: StripAgentEntry): StripLine {
	const segments: StripSegment[] = [
		{ text: statusGlyph(entry.glyph), color: GLYPH_COLORS[entry.glyph] },
		{ text: ` ${entry.name}`, color: "toolTitle", bold: true },
	];
	if (entry.activity) segments.push({ text: ` · ${entry.activity}`, color: "dim" });
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
 * before the settled group, and the settled views collapse to one
 * Completed line (aggregated glyph, dispatch count) closing the
 * content; the hint line is always last; when content exceeds maxLines
 * minus the overflow and hint reservations, the tail is summarized as
 * one "+N more" line (N = omitted content lines), which cuts finished
 * content first because live content leads.
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
	const settled = tasks.filter((task) => !task.live);
	if (settled.length > 0) {
		const glyph = aggregateSettledGlyph(settled);
		lines.push({
			segments: [
				{ text: statusGlyph(glyph), color: GLYPH_COLORS[glyph] },
				{ text: " Completed", color: "accent", bold: true },
				{ text: ` · ${dispatchCountText(settled.length)}`, color: "dim" },
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
		activity: agent.lastActivity,
		durationText: formatDuration((agent.finishedAt ?? now) - agent.startedAt),
	};
}

/** A settled task's outcome glyph over its rounds' agent nodes: done when none failed, failed when all failed, mixed otherwise. */
function aggregateNodeGlyph(nodes: readonly DispatchAgentNode[]): StatusGlyphName {
	const failed = nodes.filter((node) => node.status === "failed").length;
	if (failed === 0) return "done";
	return failed === nodes.length ? "failed" : "mixed";
}

/**
 * Assemble the strip's task views from the blocking-path dispatch
 * registry plus the detached jobs registry. Task labels resolve from
 * the prompt at render time, falling back to the detached jobs'
 * "(detached)" wording when the resolution comes up empty so a task
 * header never renders bare; a finished round of a
 * live task collapses to one round entry; within a task, live rounds'
 * agent entries lead so the budget's tail cut spares live content; a
 * live view carries the running glyph and a settled view the
 * aggregation of its agents' outcomes. A
 * detached job becomes one task view labeled through the same
 * resolveTaskLabel heuristic as blocking tasks, falling back to
 * "(detached)" when the resolution comes up empty. Its per-slot
 * agent nodes (the EXT-1-3 wiring) stream per-agent
 * glyph, activity, and duration onto the strip when the snapshot
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
		views.push({
			label: resolveTaskLabel(task.prompt) || "(detached)",
			mode: task.mode,
			live,
			glyph: live ? "running" : aggregateNodeGlyph(task.rounds.flatMap((round) => round.agents)),
			entries,
		});
	}

	for (const job of jobs) {
		const fallbackEnd = job.finishedAt ?? now;
		const entries: StripAgentEntry[] = job.agents
			? job.agents.map((node) => agentEntry(node, fallbackEnd))
			: job.agentNames.map((name) => ({ kind: "agent", name, glyph: job.status, durationText: formatDuration(fallbackEnd - job.startedAt) }));
		views.push({
			label: resolveTaskLabel(job.taskPreview) || "(detached)",
			mode: job.mode,
			live: job.status === "running",
			glyph: job.status,
			entries,
		});
	}
	return views;
}
