/**
 * Active-dispatch registry and shared dispatch state
 *
 * Extension-scope live state for the blocking dispatch paths of the
 * subagent tool, shaped task -> dispatch round -> agent node, plus
 * replace-by-id snapshots of detached jobs published alongside it.
 * This module is the shared contract between the subagent extension
 * (which publishes both) and the agent-viewer extension (which renders
 * them): pi evaluates each entrypoint's modules in a fresh instance,
 * so module-level state would exist twice — the one state object both
 * sides read converges on globalThis via getSharedDispatchState(),
 * which is process-lifetime and survives session reload. Reset and
 * clearing happen in place (registry.reset(), array.length = 0) so
 * references held across extensions stay valid.
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * exercise the lifecycle directly.
 */

declare global {
	// Language-level escape required by the cross-extension contract: pi
	// gives every extension entrypoint a fresh module instance (jiti,
	// moduleCache: false), so the shared dispatch state must live on
	// globalThis, which no module system scopes.
	var __piSubagentDispatchState: SharedDispatchState | undefined;
}

export type DispatchMode = "single" | "parallel" | "chain";

export type DispatchAgentStatus = "running" | "done" | "failed";

export interface DispatchUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns: number;
}

export interface DispatchResultSnapshot {
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
}

export interface DispatchAgentNode {
	agent: string;
	/** 1-based step index for chain rounds. */
	step?: number;
	status: DispatchAgentStatus;
	startedAt: number;
	finishedAt?: number;
	/** Plain-text description of the agent's most recent streamed activity. */
	lastActivity?: string;
	usage?: DispatchUsageSnapshot;
	result?: DispatchResultSnapshot;
}

export interface DispatchRoundNode {
	/** 1-based round index within the task (chain steps are rounds). */
	index: number;
	agents: DispatchAgentNode[];
}

export interface DispatchTaskNode {
	id: string;
	mode: DispatchMode;
	/** The dispatch prompt text the display label is resolved from (viewer-side, at render time). */
	prompt: string;
	startedAt: number;
	rounds: DispatchRoundNode[];
}

export interface DispatchAgentUpdate {
	status?: DispatchAgentStatus;
	lastActivity?: string;
	usage?: DispatchUsageSnapshot;
	result?: DispatchResultSnapshot;
	finishedAt?: number;
}

export interface DispatchRegistry {
	startTask(input: { mode: DispatchMode; prompt: string; now?: number }): DispatchTaskNode;
	/**
	 * Append a round with one running agent node per slot. Throws on an
	 * unknown task id: rounds are only ever started on a task this
	 * registry created, and a silent no-op would strand the dispatch
	 * untracked.
	 */
	startRound(taskId: string, agents: Array<{ agent: string; step?: number }>, now?: number): DispatchRoundNode;
	/** Merge the defined fields of the update into the targeted agent node; unknown ids are ignored. */
	updateAgent(taskId: string, roundIndex: number, slot: number, update: DispatchAgentUpdate): void;
	/** Mark every still-running agent of the task failed (abort/dispatch-error cleanup). */
	failRunningAgents(taskId: string, now?: number): void;
	getTask(taskId: string): DispatchTaskNode | undefined;
	tasks(): DispatchTaskNode[];
	/** Drop all state (session replacement). Ids restart from task-1. */
	reset(): void;
}

/**
 * Create an empty registry. One instance serves one extension
 * instance; reset it on session_start alongside the jobs registry.
 */
export function createDispatchRegistry(): DispatchRegistry {
	const tasksById = new Map<string, DispatchTaskNode>();
	let nextTaskId = 1;

	const findAgent = (taskId: string, roundIndex: number, slot: number) => {
		const round = tasksById.get(taskId)?.rounds.find((candidate) => candidate.index === roundIndex);
		return round?.agents[slot];
	};

	return {
		startTask(input) {
			const task: DispatchTaskNode = {
				id: `task-${nextTaskId++}`,
				mode: input.mode,
				prompt: input.prompt,
				startedAt: input.now ?? Date.now(),
				rounds: [],
			};
			tasksById.set(task.id, task);
			return task;
		},

		startRound(taskId, agents, now) {
			const task = tasksById.get(taskId);
			if (!task) throw new Error(`startRound: unknown task id ${taskId}`);
			const round: DispatchRoundNode = {
				index: task.rounds.length + 1,
				agents: agents.map((slot) => ({
					agent: slot.agent,
					step: slot.step,
					status: "running",
					startedAt: now ?? Date.now(),
				})),
			};
			task.rounds.push(round);
			return round;
		},

		updateAgent(taskId, roundIndex, slot, update) {
			const agent = findAgent(taskId, roundIndex, slot);
			if (!agent) return;
			if (update.status !== undefined) agent.status = update.status;
			if (update.lastActivity !== undefined) agent.lastActivity = update.lastActivity;
			if (update.usage !== undefined) agent.usage = update.usage;
			if (update.result !== undefined) agent.result = update.result;
			if (update.finishedAt !== undefined) agent.finishedAt = update.finishedAt;
		},

		failRunningAgents(taskId, now) {
			const task = tasksById.get(taskId);
			if (!task) return;
			for (const round of task.rounds) {
				for (const agent of round.agents) {
					if (agent.status !== "running") continue;
					agent.status = "failed";
					agent.finishedAt = now ?? Date.now();
				}
			}
		},

		getTask(taskId) {
			return tasksById.get(taskId);
		},

		tasks() {
			return Array.from(tasksById.values());
		},

		reset() {
			tasksById.clear();
			nextTaskId = 1;
		},
	};
}

/**
 * Live state of one detached job, published replace-by-id into the
 * shared state at job creation and settle. Carries exactly what the
 * render surfaces read (the jobs Map itself stays private to the
 * subagent extension); per-agent activity joins in EXT-1-3.
 */
export interface DetachedJobSnapshot {
	id: string;
	mode: DispatchMode;
	status: DispatchAgentStatus;
	agentNames: string[];
	taskPreview: string;
	startedAt: number;
	finishedAt?: number;
}

/** The one cross-extension channel: live dispatch state shared by the subagent and agent-viewer extensions. */
export interface SharedDispatchState {
	registry: DispatchRegistry;
	detachedJobs: DetachedJobSnapshot[];
}

/**
 * The shared dispatch state, converged on globalThis. Safe to call
 * from every module instance: the first evaluation creates the object
 * (`??=`) and every later one returns it, so both extensions hold one
 * registry and one snapshot list. Reset happens in place on
 * session_start (registry.reset(), array.length = 0), never by
 * replacement, so references held across extensions stay valid.
 */
export function getSharedDispatchState(): SharedDispatchState {
	globalThis.__piSubagentDispatchState ??= { registry: createDispatchRegistry(), detachedJobs: [] };
	return globalThis.__piSubagentDispatchState;
}

export type StatusGlyphName = "running" | "done" | "failed" | "mixed";

/**
 * The fleet glyph conventions shared with the blocking path's
 * ⏳/✓/✗ renderers. Lives here so the subagent extension's detached
 * surfaces and the viewer's strip render statuses identically.
 */
export function statusGlyph(status: StatusGlyphName): string {
	switch (status) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "mixed":
			return "◐";
	}
}

/**
 * Duration formatting shared by every dispatch surface: seconds under
 * a minute, minutes plus seconds under an hour, hours plus minutes
 * beyond.
 */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/** Structural subset of a streamed message, so pi message types satisfy it without an import. */
export interface ActivityMessage {
	role: string;
	content: Array<{
		type: string;
		text?: string;
		name?: string;
		arguments?: Record<string, unknown>;
		file_path?: unknown;
		path?: unknown;
		command?: unknown;
		pattern?: unknown;
	}>;
}

const ACTIVITY_MAX_WIDTH = 60;

function truncateActivity(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > ACTIVITY_MAX_WIDTH ? `${collapsed.slice(0, ACTIVITY_MAX_WIDTH)}…` : collapsed;
}

function firstString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Plain-text description of a tool call, mirroring the blocking path's formatToolCall shapes. */
function describeToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
			return `$ ${truncateActivity(firstString(args.command) ?? "...")}`;
		case "read":
			return `read ${truncateActivity(firstString(args.file_path ?? args.path) ?? "...")}`;
		case "write":
			return `write ${truncateActivity(firstString(args.file_path ?? args.path) ?? "...")}`;
		case "edit":
			return `edit ${truncateActivity(firstString(args.file_path ?? args.path) ?? "...")}`;
		case "grep":
			return `grep ${truncateActivity(firstString(args.pattern) ?? "")}`;
		case "find":
			return `find ${truncateActivity(firstString(args.pattern) ?? "")}`;
		default:
			return name;
	}
}

/**
 * Most recent streamed activity across a result's messages: the last
 * content part of the last assistant message that carries a text part
 * or a tool call. Returns undefined when nothing activity-bearing has
 * streamed yet.
 */
export function extractLastActivity(messages: ActivityMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const part = message.content[j];
			if (part.type === "text" && part.text?.trim()) return truncateActivity(part.text);
			if (part.type === "toolCall" && part.name) return describeToolCall(part.name, part.arguments ?? {});
		}
	}
	return undefined;
}
