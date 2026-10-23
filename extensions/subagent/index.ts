/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Every mode also supports detach: true, which registers the dispatch in a
 * session-scoped job registry, returns job IDs immediately, and delivers
 * results later via the jobs tool or a wake on completion.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type CustomMessageEntryDraft,
	type ExtensionAPI,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { releasePromptDir, writePromptToTempFile } from "./prompt-temp.ts";
import {
	extractLastActivity,
	formatDuration,
	getSharedDispatchState,
	statusGlyph,
	type DetachedJobSnapshot,
	type DispatchRegistry,
} from "./registry.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60 * 1000;
const SUBAGENT_HARD_TIMEOUT_MS = resolveHardTimeoutMs();
const MAX_RUNNING_DETACHED_JOBS = 4;
const JOBS_WAIT_DEFAULT_TIMEOUT_S = 120;
const JOBS_WAIT_MAX_TIMEOUT_S = 900;
const JOB_ERROR_PREVIEW_CHARS = 200;
const JOB_RESULT_CUSTOM_TYPE = "subagent-job-result";
const FAILED_TASK_STOP_REASON = "timeout";

// SUBAGENT_TIMEOUT_MS raises the per-child hard timeout for legitimately
// long single-child work; it is floored at the default so the env var
// stays raise-only and the no-infinite-hang guarantee keeps holding, and
// capped at 2^31-1 ms because Node collapses a larger setTimeout delay
// to 1 ms, which would kill every child as an instant bogus timeout.
function resolveHardTimeoutMs(): number {
	const raw = Number(process.env.SUBAGENT_TIMEOUT_MS);
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_HARD_TIMEOUT_MS;
	return Math.min(Math.max(raw, DEFAULT_HARD_TIMEOUT_MS), 2_147_483_647);
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

interface JobStatusSnapshot {
	id: string;
	mode: DetachedJob["mode"];
	agents: string[];
	status: JobStatus;
	collected: boolean;
	elapsedMs: number;
}

interface JobWaitSnapshot extends JobStatusSnapshot {
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === FAILED_TASK_STOP_REASON
	);
}

/**
 * Publish one streaming or final result snapshot into the dispatch
 * registry (exitCode -1 = still running). The blocking single,
 * parallel, and chain paths call this from their update callbacks and
 * after each agent completes, keeping the ambient strip live.
 */
function syncRegistryAgent(
	registry: DispatchRegistry,
	taskId: string,
	roundIndex: number,
	slot: number,
	result: SingleResult | undefined,
): void {
	if (!result) return;
	const finished = result.exitCode !== -1;
	registry.updateAgent(taskId, roundIndex, slot, {
		status: !finished ? "running" : isFailedResult(result) ? "failed" : "done",
		lastActivity: extractLastActivity(result.messages),
		usage: { ...result.usage },
		result: { exitCode: result.exitCode, stopReason: result.stopReason, errorMessage: result.errorMessage },
		finishedAt: finished ? Date.now() : undefined,
	});
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate?: OnUpdateCallback,
	makeDetails?: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // -1 = still running
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate && makeDetails) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: { ...process.env, PI_MANAGER_MODE: "off" },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						// After the hard timeout fired, residual buffered lines from the
						// dying child must not overwrite the timeout classification, or
						// a killed run presents a mid-run stopReason and classifies done.
						if (currentResult.stopReason !== FAILED_TASK_STOP_REASON) {
							if (msg.stopReason) currentResult.stopReason = msg.stopReason;
							if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						}
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			const hardTimeout = setTimeout(() => {
				currentResult.stopReason = FAILED_TASK_STOP_REASON;
				currentResult.errorMessage = `Subagent run exceeded the ${formatDuration(SUBAGENT_HARD_TIMEOUT_MS)} hard timeout and was killed`;
				killProc();
			}, SUBAGENT_HARD_TIMEOUT_MS);

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				clearTimeout(hardTimeout);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				clearTimeout(hardTimeout);
				resolve(1);
			});

			if (signal) {
				const killOnAbort = () => {
					wasAborted = true;
					killProc();
				};
				if (signal.aborted) killOnAbort();
				else signal.addEventListener("abort", killOnAbort, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptDir) releasePromptDir(tmpPromptDir);
	}
}

interface DispatchStep {
	agent: string;
	task: string;
	cwd?: string;
}

// Pre-flight validation shared by the detach and blocking-parallel paths:
// rejects an oversized parallel fan-out and, aggregating across all steps
// before anything spawns, unknown agent names. Returns null when the steps
// are dispatchable.
function validateDispatchSteps(
	mode: "single" | "parallel" | "chain",
	steps: DispatchStep[],
	agents: AgentConfig[],
): { message: string; isError: boolean } | null {
	if (mode === "parallel" && steps.length > MAX_PARALLEL_TASKS) {
		return { message: `Too many parallel tasks (${steps.length}). Max is ${MAX_PARALLEL_TASKS}.`, isError: false };
	}
	const unknownNames = [
		...new Set(steps.filter((step) => !agents.some((agent) => agent.name === step.agent)).map((step) => step.agent)),
	];
	if (unknownNames.length > 0) {
		const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
		return { message: `Unknown agent(s): ${unknownNames.join(", ")}. Available agents: ${available}.`, isError: true };
	}
	return null;
}

type JobStatus = "running" | "done" | "failed";

interface DetachedJob {
	id: string;
	mode: "single" | "parallel" | "chain";
	agentNames: string[];
	taskPreview: string;
	status: JobStatus;
	results: SingleResult[];
	/** Final outputs stay in the registry until collected via jobs wait or the completion wake. */
	collected: boolean;
	error?: string;
	startedAt: number;
	finishedAt?: number;
	readonly done: Promise<void>;
	readonly abort: AbortController;
	readonly resolveDone: () => void;
}

function createDetachedJob(id: string, mode: DetachedJob["mode"], steps: DispatchStep[]): DetachedJob {
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const taskPreview = steps[0]?.task.replace(/\s+/g, " ").slice(0, 80) ?? "";
	return {
		id,
		mode,
		agentNames: [...new Set(steps.map((step) => step.agent))],
		taskPreview,
		status: "running",
		results: [],
		collected: false,
		startedAt: Date.now(),
		done,
		abort: new AbortController(),
		resolveDone,
	};
}

/**
 * Publish the job's current state into the shared detached-job
 * snapshots, replace-by-id, so the viewer extension renders detached
 * jobs off live status without the jobs Map (whose collection and
 * wake semantics stay private to this extension) crossing the
 * extension boundary. Called at job creation and again at settle.
 * Aborted jobs are skipped: abortion only happens in session
 * teardown, whose session_start clears the shared array, and the
 * killed child settles seconds later — republishing then would
 * re-add a ghost of the dead session, the same race the completion
 * wake's registry-membership check guards.
 */
function publishDetachedJobSnapshot(job: DetachedJob): void {
	if (job.abort.signal.aborted) return;
	const { detachedJobs } = getSharedDispatchState();
	const snapshot: DetachedJobSnapshot = {
		id: job.id,
		mode: job.mode,
		status: job.status,
		agentNames: [...job.agentNames],
		taskPreview: job.taskPreview,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
	};
	const existing = detachedJobs.findIndex((candidate) => candidate.id === job.id);
	if (existing >= 0) detachedJobs[existing] = snapshot;
	else detachedJobs.push(snapshot);
}

async function runDetachedJob(
	job: DetachedJob,
	steps: DispatchStep[],
	agents: AgentConfig[],
	dispatchDefaults: DispatchDefaults,
	defaultCwd: string,
	onJobFinished: (job: DetachedJob) => void,
): Promise<void> {
	try {
		let results: SingleResult[];
		if (job.mode === "parallel") {
			results = await mapWithConcurrencyLimit(steps, MAX_CONCURRENCY, (step) =>
				runSingleAgent(defaultCwd, dispatchDefaults, agents, step.agent, step.task, step.cwd, undefined, job.abort.signal),
			);
		} else if (job.mode === "chain") {
			results = [];
			let previousOutput = "";
			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
				const result = await runSingleAgent(
					defaultCwd,
					dispatchDefaults,
					agents,
					step.agent,
					taskWithContext,
					step.cwd,
					i + 1,
					job.abort.signal,
				);
				results.push(result);
				if (isFailedResult(result)) break;
				previousOutput = getFinalOutput(result.messages);
			}
		} else {
			const step = steps[0];
			results = [
				await runSingleAgent(defaultCwd, dispatchDefaults, agents, step.agent, step.task, step.cwd, undefined, job.abort.signal),
			];
		}
		job.results = results;
		job.status = results.some(isFailedResult) ? "failed" : "done";
	} catch (error) {
		job.status = "failed";
		job.error = error instanceof Error ? error.message : String(error);
	} finally {
		job.finishedAt = Date.now();
		publishDetachedJobSnapshot(job);
		job.resolveDone();
		onJobFinished(job);
	}
}

function jobElapsed(job: DetachedJob, now: number = Date.now()): string {
	return formatDuration((job.finishedAt ?? now) - job.startedAt);
}

function jobSnapshot(job: DetachedJob): JobStatusSnapshot {
	return {
		id: job.id,
		mode: job.mode,
		agents: job.agentNames,
		status: job.status,
		collected: job.collected,
		elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
	};
}

function jobResultSummary(job: DetachedJob): string {
	if (job.results.length === 0) return job.error || "(no output)";
	return job.results
		.map((r) => {
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(getResultOutput(r))}`;
		})
		.join("\n\n---\n\n");
}

function jobResultMessage(job: DetachedJob): string {
	const status = job.status === "failed" ? "failed" : "completed";
	return `${statusGlyph(job.status)} Detached subagent job ${job.id} (${job.agentNames.join(", ")}, ${job.mode}) ${status}:\n\n${jobResultSummary(job)}`;
}

function formatJobStatusLine(job: DetachedJob): string {
	const state = job.status === "running" ? `running ${jobElapsed(job)}` : `ran ${jobElapsed(job)}`;
	let line = `${statusGlyph(job.status)} ${job.id} [${job.status}] ${job.agentNames.join(", ")} (${job.mode}): ${state}; task: ${job.taskPreview || "..."}`;
	if (job.status === "running") return line;
	line += job.collected ? "; collected" : "; output ready, collect with jobs wait";
	if (job.status === "failed" && job.error) line += `; error: ${job.error.slice(0, JOB_ERROR_PREVIEW_CHARS)}`;
	return line;
}

const activeJobRegistries = new Set<Map<string, DetachedJob>>();

// Best-effort orphan prevention: "exit" handlers run synchronously, so the
// SIGTERM is still delivered at shutdown (the SIGKILL fallback is not).
process.on("exit", () => {
	for (const registry of activeJobRegistries) {
		for (const job of registry.values()) {
			if (job.status === "running") job.abort.abort();
		}
	}
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	detach: Type.Optional(
		Type.Boolean({
			description:
				'Run in the background: returns job IDs immediately instead of waiting. Collect results later with the jobs tool (status/wait); finished results are also delivered automatically as soon as the job finishes. Agents whose frontmatter sets "detach: false" reject detached dispatch. Default: false.',
			default: false,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const JobsParams = Type.Object({
	action: StringEnum(["status", "wait"] as const, {
		description:
			'Status returns per-job state without blocking. Wait blocks until the jobs finish (or the timeout elapses), then returns final outputs and marks them collected.',
	}),
	id: Type.Optional(Type.String({ description: 'Job ID such as "job-1". Omit to cover all detached jobs in this session.' })),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds to wait before returning (action "wait"). Default ${JOBS_WAIT_DEFAULT_TIMEOUT_S}, max ${JOBS_WAIT_MAX_TIMEOUT_S}.`,
		}),
	),
});

export default function (pi: ExtensionAPI) {
	const dispatchState = getSharedDispatchState();
	const dispatchRegistry = dispatchState.registry;
	const jobs = new Map<string, DetachedJob>();
	let nextJobId = 1;
	let shuttingDown = false;

	activeJobRegistries.add(jobs);

	const killRunningJobs = () => {
		for (const job of jobs.values()) {
			if (job.status === "running") job.abort.abort();
		}
	};

	// Completion wake: when a detached job finishes, deliver its result with one
	// triggered turn. The check defers to a macrotask so an in-flight jobs wait,
	// which collects in microtasks after resolveDone, keeps owning delivery for
	// the jobs it covers; the shared collected flag keeps delivery exactly once.
	// The registry-membership check drops jobs aborted for a cleared or replaced
	// session, and shuttingDown drops jobs aborted at shutdown, whose sendMessage
	// would otherwise start a ghost run on the dead session.
	const wakeOnCompletion = (job: DetachedJob) => {
		setTimeout(() => {
			if (shuttingDown || job.collected || jobs.get(job.id) !== job) return;
			job.collected = true;
			pi.sendMessage(
				{
					customType: JOB_RESULT_CUSTOM_TYPE,
					content: jobResultMessage(job),
					display: true,
					details: job.results,
				},
				{ triggerTurn: true },
			);
		}, 0);
	};

	pi.on("session_start", async () => {
		killRunningJobs();
		jobs.clear();
		dispatchRegistry.reset();
		// In-place clear: the viewer extension may hold a reference to
		// the shared snapshot array across the session boundary.
		dispatchState.detachedJobs.length = 0;
		nextJobId = 1;
		shuttingDown = false;
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		killRunningJobs();
		activeJobRegistries.delete(jobs);
	});

	// Settle-time fallback: completion normally delivers results via the wake,
	// but a job can land finished and uncollected here when completion races
	// settlement processing. The shared collected flag keeps delivery exactly
	// once; an empty or fully collected registry never continues.
	pi.on("agent_before_settle", async (event) => {
		const undelivered = Array.from(jobs.values()).filter((job) => job.status !== "running" && !job.collected);
		if (undelivered.length === 0) return {};

		for (const job of undelivered) job.collected = true;
		return {
			entries: [
				...event.entries,
				...undelivered.map(
					(job): CustomMessageEntryDraft => ({
						type: "custom_message",
						customType: JOB_RESULT_CUSTOM_TYPE,
						content: jobResultMessage(job),
						display: true,
						details: job.results,
					}),
				),
			],
			continue: event.outcome === "completed" ? true : undefined,
		};
	});

	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description: [
			"Inspect and collect detached subagent jobs started via the subagent tool's detach option.",
			'action "status" returns per-job state without blocking.',
			'action "wait" blocks until the jobs finish or the timeout elapses, then returns final outputs and marks them collected.',
			"Results persist in the session's job registry until collected or the session ends.",
		].join(" "),
		parameters: JobsParams,

		async execute(_toolCallId, params, signal) {
			if (jobs.size === 0) {
				return {
					content: [
						{
							type: "text",
							text: 'No detached subagent jobs in this session. Start one with the subagent tool and detach: true.',
						},
					],
					details: [] as JobStatusSnapshot[],
				};
			}

			let selected: DetachedJob[];
			if (params.id) {
				const job = jobs.get(params.id);
				if (!job) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown job id: ${params.id}. Known jobs: ${Array.from(jobs.keys()).join(", ")}.`,
							},
						],
						details: Array.from(jobs.values()).map(jobSnapshot),
						isError: true,
					};
				}
				selected = [job];
			} else {
				selected = Array.from(jobs.values());
			}

			if (params.action === "status") {
				return {
					content: [{ type: "text", text: `Detached subagent jobs:\n${selected.map(formatJobStatusLine).join("\n")}` }],
					details: selected.map(jobSnapshot),
				};
			}

			const timeoutSeconds = Math.min(
				Math.max(params.timeout ?? JOBS_WAIT_DEFAULT_TIMEOUT_S, 0),
				JOBS_WAIT_MAX_TIMEOUT_S,
			);
			const timeoutMs = timeoutSeconds * 1000;
			const unfinished = selected.filter((job) => job.status === "running");
			let timedOut = false;
			if (unfinished.length > 0) {
				let waitTimer: ReturnType<typeof setTimeout> | undefined;
				const outcome = await Promise.race([
					Promise.all(unfinished.map((job) => job.done)).then(() => "done" as const),
					new Promise<"timeout">((resolve) => {
						waitTimer = setTimeout(() => resolve("timeout"), timeoutMs);
					}),
					new Promise<"aborted">((resolve) => {
						if (signal) {
							if (signal.aborted) resolve("aborted");
							else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
						}
					}),
				]);
				if (waitTimer) clearTimeout(waitTimer);
				timedOut = outcome === "timeout";
			}

			const parts: string[] = [];
			const collectible = selected.filter((job) => job.status !== "running" && !job.collected);
			for (const job of collectible) job.collected = true;
			for (const job of collectible) {
				const status = job.status === "failed" ? "failed" : "completed";
				parts.push(`${statusGlyph(job.status)} job ${job.id} (${job.agentNames.join(", ")}) ${status}:\n\n${jobResultSummary(job)}`);
			}
			for (const job of selected.filter((candidate) => candidate.status !== "running" && !collectible.includes(candidate))) {
				const status = job.status === "failed" ? "failed" : "completed";
				parts.push(`${statusGlyph(job.status)} job ${job.id} (${job.agentNames.join(", ")}) ${status} (collected earlier; output not repeated)`);
			}
			const stillRunning = selected.filter((job) => job.status === "running");
			if (stillRunning.length > 0) {
				const list = stillRunning.map((job) => `${job.id} (${job.agentNames.join(", ")}, ${jobElapsed(job)})`).join(", ");
				parts.push(
					timedOut
						? `${statusGlyph("running")} Timed out after ${formatDuration(timeoutMs)} waiting for: ${list}. Call jobs wait again to keep waiting.`
						: `${statusGlyph("running")} Still running: ${list}. Call jobs wait again to collect outputs when they finish.`,
				);
			}
			return {
				content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
				details: selected.map((job): JobWaitSnapshot => ({
					...jobSnapshot(job),
					results: job.results,
				})),
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Set detach: true to run in the background: returns job IDs immediately; collect results with the jobs tool (status/wait). Agents whose frontmatter sets "detach: false" reject detached dispatch.',
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			const steps: DispatchStep[] = hasChain
				? params.chain!.map((step) => ({ agent: step.agent, task: step.task, cwd: step.cwd }))
				: hasTasks
					? params.tasks!.map((task) => ({ agent: task.agent, task: task.task, cwd: task.cwd }))
					: [{ agent: params.agent!, task: params.task!, cwd: params.cwd }];
			const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (params.detach) {
				const rejection = validateDispatchSteps(mode, steps, agents);
				if (rejection) {
					return {
						content: [{ type: "text", text: rejection.message }],
						details: makeDetails(mode)([]),
						isError: rejection.isError,
					};
				}

				const runningJobs = Array.from(jobs.values()).filter((job) => job.status === "running");
				if (runningJobs.length >= MAX_RUNNING_DETACHED_JOBS) {
					return {
						content: [
							{
								type: "text",
								text: `Too many running detached jobs (${runningJobs.length}). Max is ${MAX_RUNNING_DETACHED_JOBS}. Collect finished results with the jobs tool and wait for running jobs to finish before starting more.`,
							},
						],
						details: makeDetails(mode)([]),
						isError: true,
					};
				}

				const blockedNames = [
					...new Set(
						steps
							.filter((step) => agents.find((agent) => agent.name === step.agent)?.detach === false)
							.map((step) => step.agent),
					),
				];
				if (blockedNames.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Detached dispatch rejected: agent ${blockedNames.join(", ")} sets "detach: false" in its frontmatter. Dispatch ${blockedNames.length > 1 ? "them" : "it"} in blocking mode (omit detach) instead.`,
							},
						],
						details: makeDetails(mode)([]),
						isError: true,
					};
				}

				const job = createDetachedJob(`job-${nextJobId++}`, mode, steps);
				jobs.set(job.id, job);
				publishDetachedJobSnapshot(job);
				void runDetachedJob(job, steps, agents, dispatchDefaults, ctx.cwd, wakeOnCompletion);
				return {
					content: [
						{
							type: "text",
							text: `Detached subagent job ${job.id} started (${mode}: ${job.agentNames.join(", ")}). Collect results with the jobs tool (action "status" or "wait"); finished results are also delivered automatically as soon as the job finishes.`,
						},
					],
					details: makeDetails(mode)([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const taskNode = dispatchRegistry.startTask({
					mode: "chain",
					prompt: params.chain[0].task,
				});
				try {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
						const round = dispatchRegistry.startRound(taskNode.id, [{ agent: step.agent, step: i + 1 }]);

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback = (partial) => {
							// Combine completed results with current streaming result
							const currentResult = partial.details?.results[0];
							syncRegistryAgent(dispatchRegistry, taskNode.id, round.index, 0, currentResult);
							if (currentResult && onUpdate) {
								const allResults = [...results, currentResult];
								onUpdate({
									content: partial.content,
									details: makeDetails("chain")(allResults),
								});
							}
						};

						const result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
						);
						syncRegistryAgent(dispatchRegistry, taskNode.id, round.index, 0, result);
						results.push(result);

						const isError = isFailedResult(result);
						if (isError) {
							const errorMsg = getResultOutput(result);
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					return {
						content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				} finally {
					// Aborts and dispatch errors throw past the final sync; mark
					// any still-running agent failed so the strip never shows a
					// ghost hourglass. No-op when every agent already settled.
					dispatchRegistry.failRunningAgents(taskNode.id);
				}
			}

			if (params.tasks && params.tasks.length > 0) {
				const rejection = validateDispatchSteps("parallel", steps, agents);
				if (rejection) {
					return {
						content: [{ type: "text", text: rejection.message }],
						details: makeDetails("parallel")([]),
						isError: rejection.isError,
					};
				}

				const taskNode = dispatchRegistry.startTask({
					mode: "parallel",
					prompt: params.tasks[0].task,
				});
				const dispatchRound = dispatchRegistry.startRound(
					taskNode.id,
					params.tasks.map((task) => ({ agent: task.agent })),
				);
				try {
					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1, // -1 = still running
							messages: [],
							stderr: "",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter((r) => r.exitCode === -1).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [
									{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									syncRegistryAgent(dispatchRegistry, taskNode.id, dispatchRound.index, index, partial.details.results[0]);
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						syncRegistryAgent(dispatchRegistry, taskNode.id, dispatchRound.index, index, result);
						emitParallelUpdate();
						return result;
					});

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const output = truncateParallelOutput(getResultOutput(r));
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						return `### [${r.agent}] ${status}\n\n${output}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				} finally {
					// Aborts and dispatch errors throw past the final sync; mark
					// any still-running agent failed so the strip never shows a
					// ghost hourglass. No-op when every agent already settled.
					dispatchRegistry.failRunningAgents(taskNode.id);
				}
			}

			if (params.agent && params.task) {
				const taskNode = dispatchRegistry.startTask({
					mode: "single",
					prompt: params.task,
				});
				const dispatchRound = dispatchRegistry.startRound(taskNode.id, [{ agent: params.agent }]);
				try {
					const streamingUpdate: OnUpdateCallback = (partial) => {
						syncRegistryAgent(dispatchRegistry, taskNode.id, dispatchRound.index, 0, partial.details?.results[0]);
						onUpdate?.(partial);
					};
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						params.agent,
						params.task,
						params.cwd,
						undefined,
						signal,
						streamingUpdate,
						makeDetails("single"),
					);
					syncRegistryAgent(dispatchRegistry, taskNode.id, dispatchRound.index, 0, result);
					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
						details: makeDetails("single")([result]),
					};
				} finally {
					// Aborts and dispatch errors throw past the final sync; mark
					// any still-running agent failed so the strip never shows a
					// ghost hourglass. No-op when every agent already settled.
					dispatchRegistry.failRunningAgents(taskNode.id);
				}
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const detachLabel = args.detach ? theme.fg("warning", " detached") : "";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`) +
					detachLabel;
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`) +
					detachLabel;
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				detachLabel;
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = r.exitCode === -1;
				const isError = !isRunning && isFailedResult(r);
				const icon = isRunning ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const isRunning = details.results.some((r) => r.exitCode === -1);
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
