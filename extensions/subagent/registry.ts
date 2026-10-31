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
	/** Recent streamed activity, oldest first, capped at ACTIVITY_LOG_MAX entries. */
	activity?: DispatchActivityEntry[];
	/** Recent full-text thinking blocks, oldest first, capped at THINKING_LOG_MAX_BLOCKS / THINKING_LOG_MAX_BYTES. */
	thinkingLog?: DispatchThinkingEntry[];
	/** Model id the agent runs with, when known. */
	model?: string;
	/** Effective working directory of the agent process, when known. */
	cwd?: string;
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
	activity?: DispatchActivityEntry[];
	thinkingLog?: DispatchThinkingEntry[];
	model?: string;
	cwd?: string;
	usage?: DispatchUsageSnapshot;
	result?: DispatchResultSnapshot;
	finishedAt?: number;
}

/**
 * One streamed activity entry: a text snippet, a tool call, or a
 * thinking snippet, stamped with the source message's timestamp.
 * `text` carries the shared one-line description (the same shapes the
 * strip renders), `name` and `args` preserve the raw tool call for
 * the navigator's detail pane. Entries are produced by
 * extractActivityLog and rendered by both extensions read-only.
 */
export interface DispatchActivityEntry {
	at: number;
	kind: "text" | "toolCall" | "thinking";
	text: string;
	name?: string;
	args?: Record<string, unknown>;
}

/** Upper bound on per-agent activity entries kept in the shared state. */
export const ACTIVITY_LOG_MAX = 50;

/**
 * One full-text thinking block retained for the navigator's thinking
 * view: the complete, untruncated thinking text of one content part,
 * stamped with the source message's timestamp (0 when it carries
 * none). Unlike the activity log's one-line snippets, `text` is
 * bounded only by the THINKING_LOG caps.
 */
export interface DispatchThinkingEntry {
	at: number;
	text: string;
}

/** Upper bound on per-agent thinking blocks kept in the shared state. */
export const THINKING_LOG_MAX_BLOCKS = 20;

/** Upper bound on the UTF-8 byte total of an agent's retained thinking blocks. */
export const THINKING_LOG_MAX_BYTES = 64 * 1024;

export interface DispatchRegistry {
	startTask(input: { mode: DispatchMode; prompt: string; now?: number }): DispatchTaskNode;
	/**
	 * Append a round with one running agent node per slot. Throws on an
	 * unknown task id: rounds are only ever started on a task this
	 * registry created, and a silent no-op would strand the dispatch
	 * untracked. An empty roster opens a lazy round that fills via
	 * startAgent, and that roster MUST be followed by same-tick
	 * pickups: isRoundLive counts a zero-agent round as live, so a
	 * round left empty at rest renders live forever on both surfaces,
	 * and no settle escape exists by design.
	 */
	startRound(taskId: string, agents: Array<{ agent: string; step?: number }>, now?: number): DispatchRoundNode;
	/**
	 * Append one running agent node to a round at the moment its slot is
	 * picked up — the lazy publication pattern for dispatch paths that
	 * open a round with an empty roster (startRound(taskId, [])), so
	 * each node's startedAt is its own agent's start and never-picked-up
	 * slots leave no nodes. The slot must equal the round's current node
	 * count: pickups append in slot order, which keeps the
	 * slot-indexed lookup in updateAgent valid. Throws on an unknown
	 * task id or round (same rule as startRound: a silent no-op would
	 * strand the dispatch untracked) and on an out-of-order slot.
	 */
	startAgent(taskId: string, roundIndex: number, slot: number, input: { agent: string; step?: number }, now?: number): DispatchAgentNode;
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

		startAgent(taskId, roundIndex, slot, input, now) {
			const task = tasksById.get(taskId);
			if (!task) throw new Error(`startAgent: unknown task id ${taskId}`);
			const round = task.rounds.find((candidate) => candidate.index === roundIndex);
			if (!round) throw new Error(`startAgent: unknown round ${roundIndex} on ${taskId}`);
			if (slot !== round.agents.length) {
				throw new Error(`startAgent: out-of-order slot ${slot} on ${taskId} round ${roundIndex} (expected ${round.agents.length})`);
			}
			const node: DispatchAgentNode = {
				agent: input.agent,
				step: input.step,
				status: "running",
				startedAt: now ?? Date.now(),
			};
			round.agents.push(node);
			return node;
		},

		updateAgent(taskId, roundIndex, slot, update) {
			const agent = findAgent(taskId, roundIndex, slot);
			if (!agent) return;
			mergeAgentUpdate(agent, update);
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
 * Merge the defined fields of the update into an agent node in place;
 * undefined update fields never clobber node fields. Both publishers
 * share this merge: the blocking paths via
 * DispatchRegistry.updateAgent, the detached wiring directly on its
 * slot nodes.
 */
export function mergeAgentUpdate(node: DispatchAgentNode, update: DispatchAgentUpdate): void {
	if (update.status !== undefined) node.status = update.status;
	if (update.lastActivity !== undefined) node.lastActivity = update.lastActivity;
	if (update.activity !== undefined) node.activity = update.activity;
	if (update.thinkingLog !== undefined) node.thinkingLog = update.thinkingLog;
	if (update.model !== undefined) node.model = update.model;
	if (update.cwd !== undefined) node.cwd = update.cwd;
	if (update.usage !== undefined) node.usage = update.usage;
	if (update.result !== undefined) node.result = update.result;
	if (update.finishedAt !== undefined) node.finishedAt = update.finishedAt;
}

/**
 * Live state of one detached job, published replace-by-id into the
 * shared state at job creation, on every per-agent streaming update,
 * and at settle. Carries exactly what the render surfaces read (the
 * jobs Map itself stays private to the subagent extension); the
 * per-slot `agents` nodes join additively for EXT-1-3, so snapshots
 * published before that wiring (still alive on globalThis across a
 * /reload) may omit them and render surfaces fall back to
 * agentNames. Nodes are created lazily at step start, so an empty
 * `agents` array means nothing has started yet rather than a legacy
 * snapshot.
 */
export interface DetachedJobSnapshot {
	id: string;
	mode: DispatchMode;
	status: DispatchAgentStatus;
	agentNames: string[];
	/** The assignment's full first-step task text, line breaks preserved (registry parity); single-line status surfaces derive their compact form through formatTaskPreview. */
	taskPreview: string;
	startedAt: number;
	finishedAt?: number;
	/** Per-dispatch-slot live nodes; slot order matches the job's steps. */
	agents?: DispatchAgentNode[];
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

/**
 * Insert or replace a detached-job snapshot by id: an unseen id is
 * appended, a known id replaces its snapshot in place, keeping the
 * array's identity and the snapshot's position (references held
 * across extensions and across session reloads stay valid).
 */
export function upsertDetachedJobSnapshot(detachedJobs: DetachedJobSnapshot[], snapshot: DetachedJobSnapshot): void {
	const existing = detachedJobs.findIndex((candidate) => candidate.id === snapshot.id);
	if (existing >= 0) detachedJobs[existing] = snapshot;
	else detachedJobs.push(snapshot);
}

/**
 * Whether a round still has work in flight: any running agent, or a
 * round whose agent nodes have not been published yet (the lazy
 * pickup pattern startAgent implements, where a round opens empty and
 * fills at worker pickup). Both render surfaces partition rounds with
 * this predicate so a zero-agent round renders as a live round with
 * no entries instead of collapsing to a finished summary.
 */
export function isRoundLive(round: DispatchRoundNode): boolean {
	return round.agents.length === 0 || round.agents.some((agent) => agent.status === "running");
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

/** Token-count formatting shared by the usage surfaces: plain under 1k, one decimal under 10k, rounded kilo under 1M, one-decimal mega beyond. */
export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Plain-text usage summary shared by the dispatch surfaces: the
 * non-zero parts of a usage snapshot (turns, input, output, cache
 * read/write, cost, context) rendered without theme styling so both
 * extensions and the plain-node suites produce identical text. Empty
 * string when nothing streamed yet.
 */
export function formatUsageSummary(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokenCount(usage.contextTokens)}`);
	return parts.join(" ");
}

const TASK_PREVIEW_MAX_CHARS = 80;

/**
 * One-line task form for single-line status surfaces (the jobs tool's
 * status line): runs of whitespace, including newlines and tabs,
 * collapse to single spaces, then the line is capped at
 * TASK_PREVIEW_MAX_CHARS. Pure, so plain-node suites pin it directly;
 * the detached snapshot's taskPreview field itself stays the raw full
 * text so multi-line surfaces keep the assignment's true shape.
 */
export function formatTaskPreview(task: string): string {
	return task.replace(/\s+/g, " ").slice(0, TASK_PREVIEW_MAX_CHARS);
}

/** Structural subset of a streamed message, so pi message types satisfy it without an import. */
export interface ActivityMessage {
	role: string;
	/** Unix ms the message streamed, when the source carries one. */
	timestamp?: number;
	content: Array<{
		type: string;
		text?: string;
		/** Thinking text; redacted blocks carry only a signature. */
		thinking?: string;
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

/**
 * Full recent activity across a result's messages for the navigator's
 * detail pane: one entry per activity-bearing content part of every
 * assistant message, in stream order, each stamped with its message
 * timestamp (0 when the source carries none) and, for tool calls, the
 * raw name and arguments beside the shared one-line description.
 * Thinking parts emit thinking entries collapsed like text; redacted
 * thinking blocks carry only a signature and contribute nothing.
 * Capped at the most recent ACTIVITY_LOG_MAX entries so a long run
 * cannot grow the shared state without bound: the cap is collected
 * by walking the stream in reverse and stopping once the cap is
 * full, so the scan cost tracks the cap rather than the run length;
 * the output is byte-identical to the full forward walk it replaced
 * (pinned by the identity suite).
 */
export function extractActivityLog(messages: ActivityMessage[]): DispatchActivityEntry[] {
	const collected: DispatchActivityEntry[] = [];
	for (let i = messages.length - 1; i >= 0 && collected.length < ACTIVITY_LOG_MAX; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const at = message.timestamp ?? 0;
		for (let j = message.content.length - 1; j >= 0 && collected.length < ACTIVITY_LOG_MAX; j--) {
			const part = message.content[j];
			if (part.type === "text" && part.text?.trim()) {
				collected.push({ at, kind: "text", text: truncateActivity(part.text) });
			} else if (part.type === "toolCall" && part.name) {
				collected.push({
					at,
					kind: "toolCall",
					text: describeToolCall(part.name, part.arguments ?? {}),
					name: part.name,
					args: part.arguments,
				});
			} else if (part.type === "thinking" && part.thinking?.trim()) {
				collected.push({ at, kind: "thinking", text: truncateActivity(part.thinking) });
			}
		}
	}
	return collected.reverse();
}

/**
 * Full-text thinking blocks across a result's messages, oldest first,
 * one entry per non-blank thinking content part, each stamped with its
 * message timestamp (0 when the source carries none) and kept whole:
 * no truncation, no whitespace collapsing. Capped at the most recent
 * `maxBlocks` blocks and `maxBytes` UTF-8 bytes of text. The byte cap
 * drops whole older blocks, never slices a block, and the newest
 * block is always retained even when it alone exceeds the cap, so a
 * run of one giant block cannot blank the view. The cap walk proceeds
 * newest-first and stops once a bound is full, so the scan cost
 * tracks the caps rather than the run length. `Infinity` disables a
 * bound; the transcript reader uses that to load a finished agent's
 * full thinking uncapped.
 */
export function extractThinkingEntries(messages: ActivityMessage[], maxBlocks: number, maxBytes: number): DispatchThinkingEntry[] {
	const collected: DispatchThinkingEntry[] = [];
	let bytes = 0;
	for (let i = messages.length - 1; i >= 0 && collected.length < maxBlocks; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const at = message.timestamp ?? 0;
		for (let j = message.content.length - 1; j >= 0 && collected.length < maxBlocks; j--) {
			const part = message.content[j];
			if (part.type !== "thinking" || !part.thinking?.trim()) continue;
			const partBytes = Buffer.byteLength(part.thinking, "utf8");
			if (collected.length > 0 && bytes + partBytes > maxBytes) return collected.reverse();
			collected.push({ at, text: part.thinking });
			bytes += partBytes;
		}
	}
	return collected.reverse();
}

/**
 * The shared state's per-agent thinking buffer: the most recent
 * THINKING_LOG_MAX_BLOCKS full-text thinking blocks within
 * THINKING_LOG_MAX_BYTES, fed from the same streaming message lists
 * the activity log reads. Full bodies would be unbounded memory in
 * the shared state, so the live view renders these and the finished
 * agent's complete thinking comes from the session transcript
 * instead.
 */
export function extractThinkingLog(messages: ActivityMessage[]): DispatchThinkingEntry[] {
	return extractThinkingEntries(messages, THINKING_LOG_MAX_BLOCKS, THINKING_LOG_MAX_BYTES);
}
