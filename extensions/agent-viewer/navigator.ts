/**
 * Navigator overlay's pure model
 *
 * The tree and detail-pane logic for the navigator overlay: task
 * views assembled from the dispatch registry plus detached-job
 * snapshots, a flatten/visibility function turning views plus
 * expansion state into renderable rows, cursor helpers for the fixed
 * v1 in-overlay keys, and the detail-pane model resolver. The overlay
 * component in overlay.ts renders these rows and models through the
 * theme; this module owns no presentation.
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * pin the tree behavior directly.
 */

import { resolveTaskLabel } from "./labels.ts";
import {
	type DetachedJobSnapshot,
	type DispatchActivityEntry,
	type DispatchAgentNode,
	type DispatchMode,
	type DispatchRegistry,
	type DispatchResultSnapshot,
	type DispatchUsageSnapshot,
	type StatusGlyphName,
	formatDuration,
	formatTokenCount,
	formatUsageSummary,
} from "../subagent/registry.ts";

/** Locates one agent in the shared dispatch state, so the detail pane can re-read it live on every poll. */
export interface NavigatorAgentRef {
	source: "registry" | "detached";
	/** Registry: task id. Detached: job id. */
	ownerId: string;
	/** Registry agents only: the round holding the agent. */
	roundIndex?: number;
	slot: number;
}

export interface NavigatorAgentView {
	name: string;
	status: "running" | "done" | "failed";
	step?: number;
	startedAt: number;
	finishedAt?: number;
	activity?: string;
	/** Recent streamed activity for the detail pane, oldest first. */
	activityLog: DispatchActivityEntry[];
	model?: string;
	cwd?: string;
	usage?: DispatchUsageSnapshot;
	result?: DispatchResultSnapshot;
	durationText: string;
	ref: NavigatorAgentRef;
}

export interface NavigatorRoundView {
	index: number;
	glyph: StatusGlyphName;
	summary: string;
	live: boolean;
	durationText: string;
	agents: NavigatorAgentView[];
}

export interface NavigatorTaskView {
	id: string;
	source: "registry" | "detached";
	label: string;
	mode: DispatchMode;
	live: boolean;
	glyph: StatusGlyphName;
	durationText: string;
	rounds: NavigatorRoundView[];
	agents: NavigatorAgentView[];
}

function aggregateGlyph(agents: NavigatorAgentView[]): StatusGlyphName {
	if (agents.some((agent) => agent.status === "running")) return "running";
	const failed = agents.filter((agent) => agent.status === "failed").length;
	if (failed === 0) return "done";
	return failed === agents.length ? "failed" : "mixed";
}

function roundSummary(agents: NavigatorAgentView[]): string {
	const done = agents.filter((agent) => agent.status === "done").length;
	const failed = agents.filter((agent) => agent.status === "failed").length;
	return failed > 0 ? `${done}/${agents.length} done, ${failed} failed` : `${done}/${agents.length} done`;
}

/** One agent's view model shared by the registry and detached branches: the field mapping is identical, only the ref and the duration fallback end differ. */
function agentView(node: DispatchAgentNode, ref: NavigatorAgentRef, fallbackEnd: number): NavigatorAgentView {
	return {
		name: node.agent,
		status: node.status,
		step: node.step,
		startedAt: node.startedAt,
		finishedAt: node.finishedAt,
		activity: node.lastActivity,
		activityLog: node.activity ?? [],
		model: node.model,
		cwd: node.cwd,
		usage: node.usage,
		result: node.result,
		durationText: formatDuration((node.finishedAt ?? fallbackEnd) - node.startedAt),
		ref,
	};
}

/**
 * Assemble the navigator's task views: one view per registry task
 * (task -> rounds -> agents, completed rounds collapsed to summaries,
 * the live round flagged) plus one per detached-job snapshot (the job
 * is the task node, its agents hang directly off it, glyphs keyed off
 * job.status). Labels resolve through the shared EXT-1-2 heuristic at
 * render time. Snapshots predating the per-agent wiring (no `agents`
 * array) fall back to agentNames children keyed off job.status; a
 * present-but-empty `agents` array means nothing has started yet
 * (lazy node creation) and renders no agent children.
 */
export function buildNavigatorTasks(registry: DispatchRegistry, jobs: Iterable<DetachedJobSnapshot>, now: number): NavigatorTaskView[] {
	const views: NavigatorTaskView[] = [];
	for (const task of registry.tasks()) {
		const rounds: NavigatorRoundView[] = task.rounds.map((round) => {
			const agents = round.agents.map((node, slot) => agentView(node, { source: "registry", ownerId: task.id, roundIndex: round.index, slot }, now));
			const starts = round.agents.map((agent) => agent.startedAt);
			const ends = round.agents.map((agent) => agent.finishedAt ?? now);
			return {
				index: round.index,
				glyph: aggregateGlyph(agents),
				summary: roundSummary(agents),
				live: agents.some((agent) => agent.status === "running"),
				durationText: formatDuration(Math.max(...ends) - Math.min(...starts)),
				agents,
			};
		});
		const allAgents = rounds.flatMap((round) => round.agents);
		const finishTimes = allAgents.map((agent) => agent.finishedAt ?? now);
		views.push({
			id: task.id,
			source: "registry",
			label: resolveTaskLabel(task.prompt) || "(detached)",
			mode: task.mode,
			live: allAgents.some((agent) => agent.status === "running"),
			glyph: aggregateGlyph(allAgents),
			durationText: formatDuration((finishTimes.length > 0 ? Math.max(...finishTimes) : now) - task.startedAt),
			rounds,
			agents: [],
		});
	}

	for (const job of jobs) {
		const nodes: readonly DispatchAgentNode[] = job.agents
			? job.agents
			: job.agentNames.map((name) => ({
					agent: name,
					status: job.status,
					startedAt: job.startedAt,
					finishedAt: job.finishedAt,
				}));
		const agents = nodes.map((node, slot) => agentView(node, { source: "detached", ownerId: job.id, slot }, job.finishedAt ?? now));
		views.push({
			id: job.id,
			source: "detached",
			label: resolveTaskLabel(job.taskPreview) || "(detached)",
			mode: job.mode,
			live: job.status === "running",
			glyph: job.status,
			durationText: formatDuration((job.finishedAt ?? now) - job.startedAt),
			rounds: [],
			agents,
		});
	}
	return views;
}

/** Expansion state the overlay owns across polls: collapsed tasks and the user's sticky round expand/collapse overrides. */
export interface NavigatorExpansionState {
	collapsedTasks: Set<string>;
	/** Round id -> expanded; a round without an override auto-expands while live and stays collapsed once completed. */
	roundOverrides: Map<string, boolean>;
}

export function createExpansionState(): NavigatorExpansionState {
	return { collapsedTasks: new Set(), roundOverrides: new Map() };
}

export interface NavigatorRow {
	kind: "task" | "round" | "agent";
	id: string;
	depth: 0 | 1 | 2;
	/** Index of the owning task view, for Tab navigation order. */
	taskOrder: number;
	taskId: string;
	live: boolean;
	glyph: StatusGlyphName;
	label: string;
	detail: string;
	activity?: string;
	roundIndex?: number;
	agentRef?: NavigatorAgentRef;
}

/**
 * Flatten task views into the visible rows the overlay renders.
 * Tasks render as header rows and hide their whole subtree when
 * collapsed. Rounds render as single glyph-line rows: a round is
 * expanded only while live or when the user overrode it, so completed
 * rounds collapse to their summary line and the live round
 * auto-expands; agent rows render under an expanded round. Detached
 * agents render directly under their task row.
 */
export function flattenNavigatorTree(tasks: NavigatorTaskView[], state: NavigatorExpansionState): NavigatorRow[] {
	const rows: NavigatorRow[] = [];
	tasks.forEach((task, taskOrder) => {
		const taskRowId = `t:${task.id}`;
		rows.push({
			kind: "task",
			id: taskRowId,
			depth: 0,
			taskOrder,
			taskId: task.id,
			live: task.live,
			glyph: task.glyph,
			label: task.label,
			detail: task.mode,
		});
		if (state.collapsedTasks.has(task.id)) return;

		if (task.source === "registry") {
			for (const round of task.rounds) {
				const roundRowId = `${taskRowId}:r${round.index}`;
				rows.push({
					kind: "round",
					id: roundRowId,
					depth: 1,
					taskOrder,
					taskId: task.id,
					live: round.live,
					glyph: round.glyph,
					label: `round ${round.index}`,
					detail: `${round.summary} · ${round.durationText}`,
					roundIndex: round.index,
				});
				const expanded = state.roundOverrides.get(roundRowId) ?? round.live;
				if (!expanded) continue;
				round.agents.forEach((agent, slot) => {
					rows.push({
						kind: "agent",
						id: `${roundRowId}:a${slot}`,
						depth: 2,
						taskOrder,
						taskId: task.id,
						live: agent.status === "running",
						glyph: agent.status,
						label: agent.name,
						detail: agent.durationText,
						activity: agent.activity,
						roundIndex: round.index,
						agentRef: agent.ref,
					});
				});
			}
		} else {
			task.agents.forEach((agent, slot) => {
				rows.push({
					kind: "agent",
					id: `${taskRowId}:a${slot}`,
					depth: 1,
					taskOrder,
					taskId: task.id,
					live: agent.status === "running",
					glyph: agent.status,
					label: agent.name,
					detail: agent.durationText,
					activity: agent.activity,
					agentRef: agent.ref,
				});
			});
		}
	});
	return rows;
}

/**
 * Apply the left/right key semantics for a row: collapsing a task
 * adds its raw id to collapsedTasks and expanding deletes it (the
 * flatten contract keys that set on raw task ids); a round toggle
 * stores the override under the row's namespaced id, overriding the
 * live-expanded/completed-collapsed default; agent rows are leaves
 * and a no-op.
 */
export function toggleNavigatorRow(state: NavigatorExpansionState, row: NavigatorRow, expand: boolean): void {
	if (row.kind === "task") {
		if (expand) state.collapsedTasks.delete(row.taskId);
		else state.collapsedTasks.add(row.taskId);
	} else if (row.kind === "round") {
		state.roundOverrides.set(row.id, expand);
	}
}

/** Move the cursor over visible rows, clamped to the first and last row. */
export function moveCursor(rows: NavigatorRow[], currentIndex: number, delta: number): number {
	if (rows.length === 0) return 0;
	return Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
}

/**
 * Jump to the next (direction 1) or previous (direction -1) task
 * header row, wrapping at the ends. Returns the current index when no
 * task row exists.
 */
export function nextTaskRow(rows: NavigatorRow[], currentIndex: number, direction: 1 | -1): number {
	const taskIndices = rows.flatMap((row, index) => (row.kind === "task" ? [index] : []));
	if (taskIndices.length === 0) return currentIndex;
	if (direction === 1) {
		const next = taskIndices.find((index) => index > currentIndex);
		return next ?? taskIndices[0];
	}
	const previous = [...taskIndices].reverse().find((index) => index < currentIndex);
	return previous ?? taskIndices[taskIndices.length - 1];
}

export interface NavigatorDetailField {
	label: string;
	value: string;
}

/** One summary line of a task or round target: a child round or agent. */
export interface NavigatorDetailMember {
	glyph: StatusGlyphName;
	label: string;
	detail: string;
}

export interface NavigatorDetailModel {
	kind: "agent" | "task" | "round" | "empty";
	title: string;
	statusText: string;
	fields: NavigatorDetailField[];
	members: NavigatorDetailMember[];
	activity: DispatchActivityEntry[];
	usageText: string | undefined;
	resultText: string | undefined;
}

function emptyDetailModel(): NavigatorDetailModel {
	return { kind: "empty", title: "", statusText: "", fields: [], members: [], activity: [], usageText: undefined, resultText: undefined };
}

function agentResultText(agent: NavigatorAgentView): string | undefined {
	if (agent.status === "running") return undefined;
	if (agent.status === "done") return "completed";
	const stopReason = agent.result?.stopReason;
	return stopReason && stopReason !== "end" ? `failed (${stopReason})` : "failed";
}

function resolveAgentView(row: NavigatorRow, task: NavigatorTaskView): NavigatorAgentView | undefined {
	const ref = row.agentRef;
	if (!ref) return undefined;
	if (ref.source === "registry") {
		return task.rounds.find((round) => round.index === ref.roundIndex)?.agents[ref.slot];
	}
	return task.agents[ref.slot];
}

/**
 * Resolve the selected row into the model the detail pane renders.
 * Agent targets resolve through their tree ref and carry the status
 * header fields (step, model, cwd, tokens, error, duration), the
 * timestamped activity log, the shared usage summary, and the final
 * result text. Task and round targets carry summary fields plus one
 * member line per child round or agent. A missing row, unknown task,
 * or unresolvable ref yields the empty model.
 */
export function resolveDetailModel(row: NavigatorRow | null | undefined, tasks: NavigatorTaskView[]): NavigatorDetailModel {
	if (!row) return emptyDetailModel();
	const task = tasks.find((candidate) => candidate.id === row.taskId);
	if (!task) return emptyDetailModel();

	if (row.kind === "agent") {
		const agent = resolveAgentView(row, task);
		if (!agent) return emptyDetailModel();
		const fields: NavigatorDetailField[] = [];
		if (agent.step !== undefined) fields.push({ label: "step", value: String(agent.step) });
		if (agent.model) fields.push({ label: "model", value: agent.model });
		if (agent.cwd) fields.push({ label: "cwd", value: agent.cwd });
		if (agent.usage?.contextTokens) fields.push({ label: "tokens", value: formatTokenCount(agent.usage.contextTokens) });
		const errorMessage = agent.result?.errorMessage;
		if (errorMessage) fields.push({ label: "error", value: errorMessage });
		fields.push({ label: "duration", value: agent.durationText });
		return {
			kind: "agent",
			title: agent.name,
			statusText: agent.status,
			fields,
			members: [],
			activity: agent.activityLog,
			usageText: agent.usage ? formatUsageSummary(agent.usage) || undefined : undefined,
			resultText: agentResultText(agent),
		};
	}

	if (row.kind === "round") {
		const round = task.rounds.find((candidate) => candidate.index === row.roundIndex);
		if (!round) return emptyDetailModel();
		return {
			kind: "round",
			title: `round ${round.index}`,
			statusText: round.glyph,
			fields: [
				{ label: "mode", value: task.mode },
				{ label: "agents", value: String(round.agents.length) },
				{ label: "duration", value: round.durationText },
			],
			members: round.agents.map((agent) => ({
				glyph: agent.status,
				label: agent.name,
				detail: agent.activity ? `${agent.activity} · ${agent.durationText}` : agent.durationText,
			})),
			activity: [],
			usageText: undefined,
			resultText: undefined,
		};
	}

	return {
		kind: "task",
		title: task.label,
		statusText: task.glyph,
		fields: [
			{ label: "mode", value: task.mode },
			{ label: "duration", value: task.durationText },
			...(task.source === "registry"
				? [{ label: "rounds", value: String(task.rounds.length) }]
				: [{ label: "agents", value: String(task.agents.length) }]),
		],
		members:
			task.source === "registry"
				? task.rounds.map((round) => ({
						glyph: round.glyph,
						label: `round ${round.index}`,
						detail: `${round.summary} · ${round.durationText}`,
					}))
				: task.agents.map((agent) => ({
						glyph: agent.status,
						label: agent.name,
						detail: agent.activity ? `${agent.activity} · ${agent.durationText}` : agent.durationText,
					})),
		activity: [],
		usageText: undefined,
		resultText: undefined,
	};
}
