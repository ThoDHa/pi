/**
 * Navigator view's pure model
 *
 * The tree and detail-pane logic for the navigator view: task
 * views assembled from the dispatch registry plus detached-job
 * snapshots, a flatten/visibility function turning views plus
 * expansion state into renderable rows, cursor helpers for the fixed
 * v1 in-view keys, and the detail-pane model resolver. The view
 * component in view.ts renders these rows and models through the
 * theme; this module owns no presentation.
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * pin the tree behavior directly.
 */

import { resolveTaskLabel } from "./labels.ts";
import {
	type ActivityMessage,
	type DetachedJobSnapshot,
	type DispatchActivityEntry,
	type DispatchAgentNode,
	type DispatchMode,
	type DispatchRegistry,
	type DispatchResultSnapshot,
	type DispatchThinkingEntry,
	type DispatchUsageSnapshot,
	type StatusGlyphName,
	extractThinkingEntries,
	formatDuration,
	formatTokenCount,
	formatUsageSummary,
	isRoundLive,
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
	/** Recent full-text thinking blocks for the detail pane, oldest first, capped like the activity log. */
	thinkingLog: DispatchThinkingEntry[];
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
		thinkingLog: node.thinkingLog ?? [],
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
 * (lazy node creation) and renders no agent children. The list is
 * partitioned live-first (running tasks above settled ones, stable
 * within each group) so active work leads the tree the way the strip
 * orders its lines.
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
				// A round with no published nodes yet (lazy pickup) is live:
				// it takes the running glyph and a 0s duration instead of
				// aggregating to done over an empty agent list.
				glyph: round.agents.length === 0 ? "running" : aggregateGlyph(agents),
				summary: roundSummary(agents),
				live: isRoundLive(round),
				durationText: formatDuration(round.agents.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0),
				agents,
			};
		});
		const allAgents = rounds.flatMap((round) => round.agents);
		const finishTimes = allAgents.map((agent) => agent.finishedAt ?? now);
		const taskGlyph = aggregateGlyph(allAgents);
		const taskLive = rounds.some((round) => round.live);
		views.push({
			id: task.id,
			source: "registry",
			label: resolveTaskLabel(task.prompt) || "(detached)",
			mode: task.mode,
			live: taskLive,
			// A live task never carries a settled glyph (done, failed, or
			// mixed) even while all its started agents have settled (the
			// zero-agent pickup window): liveness dominates.
			glyph: taskLive && taskGlyph !== "running" ? "running" : taskGlyph,
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

	return [...views.filter((view) => view.live), ...views.filter((view) => !view.live)];
}

/** Expansion state the view owns across polls: collapsed tasks and the user's sticky round expand/collapse overrides. */
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
 * Flatten task views into the visible rows the view renders.
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
	thinking: DispatchThinkingEntry[];
	usageText: string | undefined;
	resultText: string | undefined;
	/** Agent models only: the selected run's registration window, scoping the t keybinding's transcript lookup to that run. */
	runWindow?: TranscriptRunWindow;
}

function emptyDetailModel(): NavigatorDetailModel {
	return { kind: "empty", title: "", statusText: "", fields: [], members: [], activity: [], thinking: [], usageText: undefined, resultText: undefined, runWindow: undefined };
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
 * timestamped activity log, the shared usage summary, the final
 * result text, and the run window (the agent's startedAt/finishedAt
 * when both are finite) that scopes the t keybinding's transcript
 * lookup to that run. Task and round targets carry summary fields
 * plus one member line per child round or agent. A missing row,
 * unknown task, or unresolvable ref yields the empty model.
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
		const runWindow =
			agent.finishedAt !== undefined && Number.isFinite(agent.startedAt) && Number.isFinite(agent.finishedAt)
				? { startedAt: agent.startedAt, finishedAt: agent.finishedAt }
				: undefined;
		return {
			kind: "agent",
			title: agent.name,
			statusText: agent.status,
			fields,
			members: [],
			activity: agent.activityLog,
			thinking: agent.thinkingLog,
			usageText: agent.usage ? formatUsageSummary(agent.usage) || undefined : undefined,
			resultText: agentResultText(agent),
			runWindow,
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
			thinking: [],
			usageText: undefined,
			resultText: undefined,
			runWindow: undefined,
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
		thinking: [],
		usageText: undefined,
		resultText: undefined,
		runWindow: undefined,
	};
}

/**
 * Inclusive slack in milliseconds around a run's startedAt–finishedAt
 * interval when matching a result slot's message-timestamp span to
 * it: the registry stamps and the transcript's message timestamps are
 * same-machine unix-ms clocks, but a slot's first and last messages
 * land within milliseconds of the registry's pickup and completion
 * stamps rather than inside them exactly, so a run's own span can sit
 * just outside the bare interval. Far below real dispatch durations,
 * so sibling slots finishing within the slack are the only residual
 * ambiguity.
 */
export const TRANSCRIPT_WINDOW_TOLERANCE_MS = 2_000;

/** A finished agent run's registration interval in unix ms. */
export interface TranscriptRunWindow {
	startedAt: number;
	finishedAt: number;
}

export interface TranscriptThinkingLookup {
	/** Whether the latest matching subagent toolResult carries a result slot for `agentName` at all. */
	found: boolean;
	/** The matching record's full-text thinking entries, oldest first; empty when not found or found-but-thinkingless. */
	entries: DispatchThinkingEntry[];
}

/** The incremental transcript lookup the streamed t read feeds line by line and the whole-string API wraps. */
export interface TranscriptThinkingScanner {
	/** Consume the next transcript line in file order: lines that fail parse or shape are skipped. */
	feed(line: string): void;
	/** Resolve the lookup over every fed line so far. */
	finish(): TranscriptThinkingLookup;
}

/**
 * A result slot's message-timestamp span: the smallest and largest
 * finite numeric timestamps across the slot's messages, or undefined
 * when no message carries one, which disqualifies the slot from a
 * windowed match. A slot whose messages all share one timestamp has
 * first === last.
 */
function transcriptSlotSpan(messages: ActivityMessage[]): { first: number; last: number } | undefined {
	let first: number | undefined;
	let last: number | undefined;
	for (const message of messages) {
		const timestamp = message.timestamp;
		if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
		if (first === undefined || timestamp < first) first = timestamp;
		if (last === undefined || timestamp > last) last = timestamp;
	}
	return first === undefined ? undefined : { first, last };
}

/**
 * A finished agent's full thinking, read incrementally out of the
 * parent session transcript for the t keybinding: lines are fed in
 * file order and
 * the latest subagent toolResult whose details.results[] carries a
 * result for `agentName` wins (the file is append-only, so completed
 * results are stable, and one agent dispatched twice resolves to its
 * newest run). With a `window`, every matching result slot carries
 * its own span, its messages' first and last finite numeric
 * timestamps, and a slot competes when that span lies inside the
 * inclusive range [startedAt - TRANSCRIPT_WINDOW_TOLERANCE_MS,
 * finishedAt + TRANSCRIPT_WINDOW_TOLERANCE_MS] on both endpoints; the
 * last record in file order holding a competing slot wins, and within
 * it the competing slot with the highest span end (last in file order
 * on ties), so same-name slots inside one parallel record and earlier
 * steps of a chain round resolve their own runs even though their
 * shared record timestamp is stamped at dispatch completion. When no
 * slot competes, or no window is passed, every matching record
 * competes under the session-latest rule and the winning record's
 * last matching slot in file order is used, so a window miss resolves
 * exactly as the two-argument lookup does. File order stays the
 * record-level rule and timestamps never reorder records: they gate a
 * slot's eligibility and break ties within one record, and a record
 * whose slots carry no finite message timestamps simply contributes
 * no competing slot and degrades to the fallback.
 * That result's messages yield one uncapped full-text
 * entry per thinking part, oldest first, mirroring the live buffer's
 * entry shape. Lines that fail to parse are skipped: the file is
 * being appended live, so a torn trailing line is normal and must
 * never block the completed results before it. Only subagent
 * toolResults are considered; other tools' results and results
 * without thinking parts contribute nothing. Before parsing, lines
 * without the serialized tool name's substring "subagent" are
 * skipped: every subagent toolResult's line carries it (JSON.stringify
 * never escapes those ASCII letters), so the scan's parse cost tracks
 * subagent lines instead of the whole session, and the filter can only
 * skip, never match (a false positive merely falls through to the
 * parse and shape checks below).
 * finish() returns whether a matching record exists at all plus that
 * record's thinking: found=false when nothing matches (unknown agent,
 * no subagent results, no lines fed), found=true with empty entries
 * when the latest matching record holds no thinking parts (an agent
 * that finished without reasoning), so the viewer can name the
 * record's emptiness instead of denying the record exists.
 */
export function createTranscriptThinkingScanner(agentName: string, window?: TranscriptRunWindow): TranscriptThinkingScanner {
	let best: DispatchThinkingEntry[] | undefined;
	let windowed: DispatchThinkingEntry[] | undefined;
	const windowStart = window !== undefined ? window.startedAt - TRANSCRIPT_WINDOW_TOLERANCE_MS : Number.NaN;
	const windowEnd = window !== undefined ? window.finishedAt + TRANSCRIPT_WINDOW_TOLERANCE_MS : Number.NaN;
	return {
		feed(line: string): void {
			if (!line.includes("subagent")) return;
			let entry: {
				type?: unknown;
				message?: { role?: unknown; details?: { results?: unknown } };
			};
			try {
				entry = JSON.parse(line);
			} catch {
				return;
			}
			if (entry?.type !== "message" || entry.message?.role !== "toolResult") return;
			if ((entry.message as { toolName?: unknown }).toolName !== "subagent") return;
			const results = entry.message.details?.results;
			if (!Array.isArray(results)) return;
			for (let i = results.length - 1; i >= 0; i--) {
				const candidate = results[i] as { agent?: unknown; messages?: unknown } | undefined;
				if (candidate?.agent !== agentName || !Array.isArray(candidate.messages)) continue;
				const next = extractThinkingEntries(candidate.messages as ActivityMessage[], Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
				best = next;
				break;
			}
			if (window === undefined) return;
			let recordBest: { entries: DispatchThinkingEntry[]; spanEnd: number } | undefined;
			for (let i = results.length - 1; i >= 0; i--) {
				const candidate = results[i] as { agent?: unknown; messages?: unknown } | undefined;
				if (candidate?.agent !== agentName || !Array.isArray(candidate.messages)) continue;
				const messages = candidate.messages as ActivityMessage[];
				const span = transcriptSlotSpan(messages);
				if (span === undefined || span.first < windowStart || span.last > windowEnd) continue;
				if (recordBest === undefined || span.last > recordBest.spanEnd) {
					recordBest = {
						entries: extractThinkingEntries(messages, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
						spanEnd: span.last,
					};
				}
			}
			if (recordBest !== undefined) windowed = recordBest.entries;
		},
		finish(): TranscriptThinkingLookup {
			const winner = window !== undefined ? (windowed ?? best) : best;
			return { found: winner !== undefined, entries: winner ?? [] };
		},
	};
}

/**
 * Whole-string form of the transcript thinking lookup: splits `jsonl`
 * into lines and feeds them through createTranscriptThinkingScanner,
 * so the string API and the streamed read share one implementation
 * and stay byte-identical by construction. See the scanner factory
 * above for the full matching semantics.
 */
export function extractTranscriptThinking(jsonl: string, agentName: string, window?: TranscriptRunWindow): TranscriptThinkingLookup {
	const scanner = createTranscriptThinkingScanner(agentName, window);
	for (const line of jsonl.split("\n")) scanner.feed(line);
	return scanner.finish();
}
