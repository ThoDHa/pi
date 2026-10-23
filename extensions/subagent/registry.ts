/**
 * Active-dispatch registry
 *
 * Extension-scope live state for the blocking dispatch paths of the
 * subagent tool, shaped task -> dispatch round -> agent node. The
 * ambient strip consumes it now and the navigator (checkpoint 2)
 * consumes the same landed shape; evolution after landing is additive
 * only. Detached jobs are not published here: they stay readable
 * through their jobs registry's live job.status.
 *
 * Dependency-free by design (no pi imports) so plain-node suites can
 * exercise the lifecycle directly.
 */

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
	label: string;
	mode: DispatchMode;
	/** The dispatch prompt text the label was resolved from. */
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
	startTask(input: { mode: DispatchMode; prompt: string; label: string; now?: number }): DispatchTaskNode;
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
				label: input.label,
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
