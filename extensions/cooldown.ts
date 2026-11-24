/**
 * Cooldown extension: auto-recover a session from provider usage-limit
 * errors. First target: GLM via z.ai, HTTP 429 with body code 1308 (the
 * 5-hour plan limit). Core's retry governor already classifies 1308 as
 * non-retryable, so those turns fail fast into this extension's hands:
 * on `message_end` with an assistant error whose body matches a
 * configured provider's limit pattern, parse the reset timestamp in the
 * provider's fixed UTC offset, arm an unrefed timer for reset + buffer,
 * persist the pending wait via appendEntry, and at fire time resume the
 * work by sending the configured resume prompt (plain send when idle,
 * `followUp` while busy). While the wait pends, a minute-tick countdown
 * refreshes the footer status with the remaining wait under the entry's
 * own `cooldown:<name>` status key, so concurrent waits render
 * independently; the tick interval
 * shares the fire timer's lifecycle, so every site that clears the timer
 * (fire, cancel, retire, cap, restart drop, shutdown) clears the tick
 * too. A repeat limit error on a resumed turn re-arms
 * from the fresh reset time with carried attempt counts until
 * maxResumeAttempts, then gives up with an error notify and stays
 * stopped until a successful turn re-enables auto-recovery.
 *
 * Two boundaries are accepted by design: a 1308 while the summarizer
 * compacts the session surfaces as session_compact_failed instead of
 * message_end, so it never arms a cooldown, and detection assumes
 * message_end fires only for main-loop assistant messages. The fixed
 * per-provider utcOffsetMinutes is exact for fixed-offset clocks like
 * z.ai's UTC+8; the trigger to revisit the offset mechanism is the
 * first DST-observing provider entry in cooldown.json.
 *
 * Provider rules live in the cooldown.json sidecar next to this file,
 * read at factory time so every /reload re-reads it. Waits survive
 * restart and reload through the persisted entry: on session_start the
 * newest cooldown entry re-arms when resumeOnRestart is true (future
 * deadline) or resumes immediately (past deadline), and that arm/fire
 * step is guarded to interactive surfaces (tui, rpc) so an opted-in
 * headless run stays inert. With the default resumeOnRestart: false the
 * deadline is dropped with a notify and the session start waits for the
 * user; the drop is persisted as a superseding cancelled record (as is
 * a fork's past-deadline drop and an unknown-entry-name wait) so a
 * later /reload cannot re-adjudicate the entry under its bypass and
 * fire what the gate withheld. Reload always re-arms a still-waiting
 * entry (the armed timer would have fired on its own; reload merely
 * replaces it), and fork re-arms future deadlines but never fires a
 * past deadline into the freshly forked branch. A newest entry in any
 * state other
 * than "waiting" (fired/cancelled/capped/resolved) means no action, so
 * an already-fired resume never fires twice. A successful assistant
 * message from a configured provider retires that provider's pending
 * wait and disabled mark. /cooldown shows or cancels the pending wait;
 * /cooldown-simulate feeds a synthetic error through the real detection
 * path.
 *
 * pi imports are type-only and runtime imports are node built-ins, so
 * the test suite runs this module under plain node.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ENTRY_TYPE = "cooldown";
const STATUS_KEY = "cooldown";
export const DEFAULT_RESUME_PROMPT = "The provider usage-limit window has reset. Continue the pending work from where it stopped.";

/** Footer status key for one entry's countdown segment; per-entry keys keep concurrent waits from flip-flopping a shared slot. */
export function statusKeyFor(entryName: string): string {
	return `${STATUS_KEY}:${entryName}`;
}

const MINUTE_MS = 60_000;
const TIMEOUT_CAP_MS = 2 ** 31 - 1;
const MAX_OFFSET_MINUTES = 840;
const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const TOP_DEFAULTS = { defaultBufferMinutes: 2, maxResumeAttempts: 5, resumeOnRestart: false } as const;

/** One pending recovery: which provider entry, the parsed deadline, how many resumes it already used, and the errored model pinned at arm time. */
export interface CooldownState {
	entryName: string;
	resetAtMs: number;
	fireAtMs: number;
	attempts: number;
	/** The errored model id captured from the arming message; retirement requires this model's success when present, entry-scoped retirement when absent. */
	model?: string;
	/** Runtime-only provenance: the wait was armed by the debug simulate path. Never persisted; a wait read from persistence is always real. */
	simulated?: boolean;
}

export interface ResolvedProviderEntry {
	name: string;
	match: { provider: string; model?: string };
	/** match.model compiled once at validation time so per-message paths never rebuild a RegExp; absent when match.model is absent. */
	modelMatcher?: RegExp;
	errorPattern: RegExp;
	resetTimePattern: RegExp;
	utcOffsetMinutes: number;
	bufferMinutes: number;
	resumePrompt: string;
}

export interface ResolvedConfig {
	defaultBufferMinutes: number;
	maxResumeAttempts: number;
	resumeOnRestart: boolean;
	resumePrompt: string;
	providers: ResolvedProviderEntry[];
}

export type ConfigResult = { ok: true; config: ResolvedConfig } | { ok: false; problems: string[] };

/** Structural view of the message fields detection needs; AssistantMessage satisfies it. */
export interface LimitErrorMessage {
	role: string;
	stopReason?: string;
	errorMessage?: string;
	provider?: string;
	model?: string;
}

export type ArmDecision =
	| { action: "ignore" }
	| { action: "parse_failed"; entry: ResolvedProviderEntry }
	| { action: "cap_reached"; entry: ResolvedProviderEntry; attempts: number }
	| { action: "arm"; entry: ResolvedProviderEntry; state: CooldownState; extended: boolean };

export type RestartDecision =
	| { action: "none" }
	| { action: "drop"; state: CooldownState; gate: "resumeOnRestart" | "fork" }
	| { action: "rearm"; state: CooldownState }
	| { action: "resume_now"; state: CooldownState };

export interface CooldownExtensionOptions {
	configPath?: string;
	/** Countdown refresh period in milliseconds; defaults to one minute. */
	tickMs?: number;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function countCaptureGroups(source: string): number {
	const probe = new RegExp(`${source}|`, "i").exec("");
	return probe ? probe.length - 1 : 0;
}

function compilePattern(source: unknown, label: string, problems: string[]): RegExp | undefined {
	if (!nonEmptyString(source)) {
		problems.push(`${label} must be a non-empty regex source string`);
		return undefined;
	}
	try {
		return new RegExp(source, "i");
	} catch {
		problems.push(`${label} does not compile as a regex: ${JSON.stringify(source)}`);
		return undefined;
	}
}

/**
 * Validate a parsed cooldown config document and resolve per-entry
 * overrides into concrete values. Collects every problem across all
 * fields rather than stopping at the first, so one pass reports the full
 * repair list; any problem makes the whole config invalid and the
 * extension inert.
 */
export function validateCooldownConfig(raw: unknown): ConfigResult {
	const problems: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, problems: ["cooldown config root must be a JSON object"] };
	}
	const root = raw as Record<string, unknown>;

	let defaultBufferMinutes = TOP_DEFAULTS.defaultBufferMinutes;
	if (root.defaultBufferMinutes !== undefined) {
		if (!isFiniteNumber(root.defaultBufferMinutes) || root.defaultBufferMinutes < 0) {
			problems.push(`defaultBufferMinutes must be a finite number >= 0, got ${JSON.stringify(root.defaultBufferMinutes)}`);
		} else {
			defaultBufferMinutes = root.defaultBufferMinutes;
		}
	}

	let maxResumeAttempts = TOP_DEFAULTS.maxResumeAttempts;
	if (root.maxResumeAttempts !== undefined) {
		if (!isFiniteNumber(root.maxResumeAttempts) || !Number.isInteger(root.maxResumeAttempts) || root.maxResumeAttempts < 1) {
			problems.push(`maxResumeAttempts must be an integer >= 1, got ${JSON.stringify(root.maxResumeAttempts)}`);
		} else {
			maxResumeAttempts = root.maxResumeAttempts;
		}
	}

	let resumeOnRestart = TOP_DEFAULTS.resumeOnRestart;
	if (root.resumeOnRestart !== undefined) {
		if (typeof root.resumeOnRestart !== "boolean") {
			problems.push(`resumeOnRestart must be a boolean, got ${JSON.stringify(root.resumeOnRestart)}`);
		} else {
			resumeOnRestart = root.resumeOnRestart;
		}
	}

	let resumePrompt = DEFAULT_RESUME_PROMPT;
	if (root.resumePrompt !== undefined) {
		if (!nonEmptyString(root.resumePrompt)) {
			problems.push("resumePrompt must be a non-empty string when present");
		} else {
			resumePrompt = root.resumePrompt;
		}
	}

	const providers: ResolvedProviderEntry[] = [];
	const names = new Set<string>();
	const rawProviders = root.providers;
	if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
		problems.push("providers must be a non-empty array");
	} else {
		rawProviders.forEach((rawEntry, index) => {
			const label = `providers[${index}]`;
			if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
				problems.push(`${label} must be an object`);
				return;
			}
			const entry = rawEntry as Record<string, unknown>;
			let name: string | undefined;
			if (!nonEmptyString(entry.name)) {
				problems.push(`${label}.name must be a non-empty string`);
			} else if (names.has(entry.name)) {
				problems.push(`${label}.name duplicates an earlier entry name: ${entry.name}`);
			} else {
				name = entry.name;
				names.add(entry.name);
			}
			const entryLabel = name === undefined ? label : `${label} (${name})`;
			const match = entry.match;
			let provider: string | undefined;
			let model: string | undefined;
			if (typeof match !== "object" || match === null || Array.isArray(match)) {
				problems.push(`${entryLabel}.match must be an object with a provider field`);
			} else {
				const matchRecord = match as Record<string, unknown>;
				if (!nonEmptyString(matchRecord.provider)) {
					problems.push(`${entryLabel}.match.provider must be a non-empty string`);
				} else {
					provider = matchRecord.provider;
				}
				if (matchRecord.model !== undefined) {
					if (!nonEmptyString(matchRecord.model)) {
						problems.push(`${entryLabel}.match.model must be a non-empty string when present`);
					} else {
						model = matchRecord.model;
					}
				}
			}
			const errorPattern = compilePattern(entry.errorPattern, `${entryLabel}.errorPattern`, problems);
			const resetTimePattern = compilePattern(entry.resetTimePattern, `${entryLabel}.resetTimePattern`, problems);
			if (resetTimePattern !== undefined && typeof entry.resetTimePattern === "string" && countCaptureGroups(entry.resetTimePattern) < 1) {
				problems.push(`${entryLabel}.resetTimePattern must contain at least one capture group for the reset timestamp`);
			}
			let utcOffsetMinutes: number | undefined;
			if (!isFiniteNumber(entry.utcOffsetMinutes) || Math.abs(entry.utcOffsetMinutes) > MAX_OFFSET_MINUTES) {
				problems.push(`${entryLabel}.utcOffsetMinutes must be a finite number within ±${MAX_OFFSET_MINUTES}, got ${JSON.stringify(entry.utcOffsetMinutes)}`);
			} else {
				utcOffsetMinutes = entry.utcOffsetMinutes;
			}
			let bufferMinutes = defaultBufferMinutes;
			if (entry.bufferMinutes !== undefined) {
				if (!isFiniteNumber(entry.bufferMinutes) || entry.bufferMinutes < 0) {
					problems.push(`${entryLabel}.bufferMinutes must be a finite number >= 0 when present, got ${JSON.stringify(entry.bufferMinutes)}`);
				} else {
					bufferMinutes = entry.bufferMinutes;
				}
			}
			let entryResumePrompt = resumePrompt;
			if (entry.resumePrompt !== undefined) {
				if (!nonEmptyString(entry.resumePrompt)) {
					problems.push(`${entryLabel}.resumePrompt must be a non-empty string when present`);
				} else {
					entryResumePrompt = entry.resumePrompt;
				}
			}
			if (name !== undefined && provider !== undefined && errorPattern !== undefined && resetTimePattern !== undefined && utcOffsetMinutes !== undefined) {
				providers.push({
					name,
					match: model === undefined ? { provider } : { provider, model },
					modelMatcher: model === undefined ? undefined : compileModelGlob(model),
					errorPattern,
					resetTimePattern,
					utcOffsetMinutes,
					bufferMinutes,
					resumePrompt: entryResumePrompt,
				});
			}
		});
	}

	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, config: { defaultBufferMinutes, maxResumeAttempts, resumeOnRestart, resumePrompt, providers } };
}

/** Filename of the untracked local override resolved beside the tracked default config. */
const LOCAL_CONFIG_FILENAME = "cooldown.local.json";

/**
 * Read and validate the config sidecar at filePath. Missing file, invalid
 * JSON, and schema problems all come back as ok: false with a problem
 * list; callers fail safe by staying inert.
 */
export function loadCooldownConfig(filePath: string): ConfigResult {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, problems: [`cooldown config: cannot read ${filePath}: ${reason}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, problems: [`cooldown config: ${filePath} is not valid JSON: ${reason}`] };
	}
	return validateCooldownConfig(raw);
}

/**
 * Load the effective config for a tracked default path: a
 * cooldown.local.json beside it, when present, is the entire config —
 * valid replaces the tracked default wholesale with no field merge,
 * invalid (unreadable, broken JSON, schema problems) leaves the caller
 * inert with problems naming the local path, and an absent local file
 * loads the tracked default exactly as before. An explicit configPath
 * bypasses this lookup entirely, so tests and pointed setups stay
 * deterministic; the local file itself stays untracked by the
 * extensions default-deny gitignore.
 */
export function loadCooldownConfigWithLocalOverride(defaultPath: string): ConfigResult {
	const localPath = path.join(path.dirname(defaultPath), LOCAL_CONFIG_FILENAME);
	let text: string;
	try {
		text = readFileSync(localPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return loadCooldownConfig(defaultPath);
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, problems: [`cooldown config: cannot read ${localPath}: ${reason}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, problems: [`cooldown config: ${localPath} is not valid JSON: ${reason}`] };
	}
	const result = validateCooldownConfig(raw);
	if (result.ok) return result;
	return { ok: false, problems: result.problems.map((problem) => `${localPath}: ${problem}`) };
}

/**
 * Compile a model glob pattern into its anchored matcher. Every
 * non-star byte is escaped, so an exact pattern compiles to its own
 * literal and full-string equality falls out of the same builder.
 */
function compileModelGlob(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/**
 * Does a configured model pattern match a model id? Absent pattern
 * matches everything; a pattern without "*" is an exact id match;
 * otherwise each "*" is a wildcard segment.
 */
export function matchesEntryModel(pattern: string | undefined, model: string | undefined): boolean {
	if (pattern === undefined) return true;
	if (model === undefined) return false;
	return compileModelGlob(pattern).exec(model) !== null;
}

/**
 * Per-message counterpart of matchesEntryModel consulting the entry's
 * validation-time matcher; falls back to the pure form for entries not
 * built by validateCooldownConfig (hand-built test entries).
 */
function entryModelMatches(entry: Pick<ResolvedProviderEntry, "match" | "modelMatcher">, model: string | undefined): boolean {
	if (entry.modelMatcher === undefined) return matchesEntryModel(entry.match.model, model);
	return model !== undefined && entry.modelMatcher.exec(model) !== null;
}

/** First config entry whose provider and optional model pattern match, in config order. */
export function findCooldownEntry(config: ResolvedConfig, provider: string | undefined, model: string | undefined): ResolvedProviderEntry | undefined {
	if (provider === undefined) return undefined;
	return config.providers.find((entry) => entry.match.provider === provider && entryModelMatches(entry, model));
}

/**
 * Extract the reset timestamp (capture group 1) from a matched error
 * text and interpret it as wall-clock time in the entry's fixed UTC
 * offset. Returns undefined for a non-matching pattern, a malformed
 * stamp, or an impossible calendar date rather than rolling over.
 */
export function parseResetEpochMs(entry: Pick<ResolvedProviderEntry, "resetTimePattern" | "utcOffsetMinutes">, errorText: string): number | undefined {
	const match = entry.resetTimePattern.exec(errorText);
	const stamp = match?.[1];
	if (stamp === undefined) return undefined;
	const parts = STAMP_PATTERN.exec(stamp);
	if (parts === null) return undefined;
	const year = Number(parts[1]);
	const month = Number(parts[2]);
	const day = Number(parts[3]);
	const hour = Number(parts[4]);
	const minute = Number(parts[5]);
	const second = Number(parts[6]);
	if (month < 1 || month > 12) return undefined;
	if (year < 100) return undefined;
	if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
	if (hour > 23 || minute > 59 || second > 59) return undefined;
	return Date.UTC(year, month - 1, day, hour, minute, second) - entry.utcOffsetMinutes * MINUTE_MS;
}

/**
 * Decide what a finished assistant message means for cooldown arming.
 * Only an assistant error whose body matches a configured entry's limit
 * pattern arms anything; the armed deadline never shortens while still
 * pending (a later reset extends it, an earlier one keeps the current
 * deadline), a stale deadline is replaced outright, and attempts
 * exhausted at maxResumeAttempts report cap_reached instead of arming.
 */
export function planCooldownArm(config: ResolvedConfig, message: LimitErrorMessage, current: CooldownState | undefined, nowMs: number): ArmDecision {
	if (message.role !== "assistant" || message.stopReason !== "error" || typeof message.errorMessage !== "string") return { action: "ignore" };
	const entry = findCooldownEntry(config, message.provider, message.model);
	if (entry === undefined) return { action: "ignore" };
	if (!entry.errorPattern.test(message.errorMessage)) return { action: "ignore" };
	if (current !== undefined && current.attempts >= config.maxResumeAttempts) {
		return { action: "cap_reached", entry, attempts: current.attempts };
	}
	const resetAtMs = parseResetEpochMs(entry, message.errorMessage);
	if (resetAtMs === undefined) return { action: "parse_failed", entry };
	const candidateFireAtMs = resetAtMs + entry.bufferMinutes * MINUTE_MS;
	const pendingCurrent = current !== undefined && current.entryName === entry.name && current.fireAtMs >= nowMs ? current : undefined;
	if (pendingCurrent !== undefined && candidateFireAtMs < pendingCurrent.fireAtMs) {
		return { action: "arm", entry, state: pendingCurrent, extended: false };
	}
	const extended = pendingCurrent !== undefined && candidateFireAtMs > pendingCurrent.fireAtMs;
	return {
		action: "arm",
		entry,
		extended,
		state: {
			entryName: entry.name,
			resetAtMs,
			fireAtMs: candidateFireAtMs,
			attempts: current !== undefined && current.entryName === entry.name ? current.attempts : 0,
			...(message.model !== undefined ? { model: message.model } : {}),
		},
	};
}

/**
 * Restart decision table for a persisted cooldown entry: no entry means
 * no action. Reload bypasses resumeOnRestart in both directions (the
 * armed timer would have fired on its own; reload merely replaces it),
 * fork keeps only the future-deadline half of that bypass (a past
 * deadline drops with the fork gate instead of firing into a freshly
 * forked branch), startup/new/resume follow resumeOnRestart (a false
 * value drops the pending wait, the session start waits for the user);
 * otherwise a future deadline re-arms and a past deadline resumes
 * immediately, both carrying the attempt count. A drop decision is a
 * final answer, not a per-reason re-adjudication: callers must persist
 * a superseding cancelled record so later reasons cannot undo it.
 */
export function planRestartResume(persisted: CooldownState | undefined, resumeOnRestart: boolean, nowMs: number, reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup"): RestartDecision {
	if (persisted === undefined) return { action: "none" };
	if (reason === "reload") return persisted.fireAtMs > nowMs ? { action: "rearm", state: persisted } : { action: "resume_now", state: persisted };
	if (reason === "fork") return persisted.fireAtMs > nowMs ? { action: "rearm", state: persisted } : { action: "drop", state: persisted, gate: "fork" };
	if (!resumeOnRestart) return { action: "drop", state: persisted, gate: "resumeOnRestart" };
	if (persisted.fireAtMs > nowMs) return { action: "rearm", state: persisted };
	return { action: "resume_now", state: persisted };
}

	/** Parse a persisted cooldown record into a pending wait; undefined for anything that is not a real (non-simulated, well-formed) waiting record. */
function persistedStateFrom(data: unknown): CooldownState | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (record.state !== "waiting") return undefined;
	if (record.simulated === true) return undefined;
	const { entryName, resetAtMs, fireAtMs, attempts } = record;
	if (!nonEmptyString(entryName) || !isFiniteNumber(resetAtMs) || !isFiniteNumber(fireAtMs) || !isFiniteNumber(attempts)) return undefined;
	return {
		entryName,
		resetAtMs,
		fireAtMs,
		attempts,
		...(nonEmptyString(record.model) ? { model: record.model } : {}),
	};
}

function persistedEntryName(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const name = (data as Record<string, unknown>).entryName;
	return nonEmptyString(name) ? name : undefined;
}

function isCooldownEntry(entry: unknown): entry is { type: string; customType: string; data: unknown } {
	const record = entry as { type?: string; customType?: string } | undefined;
	return record !== undefined && record.type === "custom" && record.customType === ENTRY_TYPE;
}

/**
 * Scan a persisted branch for still-pending waits, newest-decides per
 * entry name: the last cooldown record carrying a readable entryName
 * decides that name, and the name contributes a pending wait only when
 * that deciding record is a real waiting entry. Tombstones,
 * fired/capped/resolved records, simulated waits, and malformed records
 * all decide their own name as no-wait, keeping the single-slot scan's
 * double-fire and durability guarantees per name; a record with no
 * readable entryName is unattributable and cannot decide any name.
 * Returns the waits in branch order so restart adjudication and its
 * notifies stay deterministic.
 */
export function collectPendingWaits(entries: readonly unknown[]): CooldownState[] {
	const decided = new Map<string, CooldownState | undefined>();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isCooldownEntry(entry)) continue;
		const name = persistedEntryName(entry.data);
		if (name === undefined || decided.has(name)) continue;
		decided.set(name, persistedStateFrom(entry.data));
	}
	const waits: CooldownState[] = [];
	const emitted = new Set<string>();
	for (const entry of entries) {
		if (!isCooldownEntry(entry)) continue;
		const name = persistedEntryName(entry.data);
		if (name === undefined || emitted.has(name)) continue;
		emitted.add(name);
		const state = decided.get(name);
		if (state !== undefined) waits.push(state);
	}
	return waits;
}

/** Local clock rendering of a deadline for notify messages. */
export function formatResumeClock(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Remaining-wait rendering for the live countdown footer: hours+minutes above the hour, minutes below, "<1m" inside the final minute. */
export function formatCountdown(fireAtMs: number, nowMs: number): string {
	const remainingMinutes = Math.floor((fireAtMs - nowMs) / MINUTE_MS);
	if (remainingMinutes < 1) return "<1m";
	const hours = Math.floor(remainingMinutes / 60);
	const minutes = remainingMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default function cooldownExtension(pi: ExtensionAPI, options: CooldownExtensionOptions = {}): void {
	const configPath = options.configPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "cooldown.json");
	const loaded = options.configPath !== undefined ? loadCooldownConfig(configPath) : loadCooldownConfigWithLocalOverride(configPath);
	const config: ResolvedConfig | undefined = loaded.ok ? loaded.config : undefined;
	const problems = loaded.ok ? [] : loaded.problems;
	// A degenerate tickMs would arm a busy loop of status writes; keep the
	// countdown on the one-minute default instead.
	const tickMs = options.tickMs !== undefined && isFiniteNumber(options.tickMs) && options.tickMs > 0 ? options.tickMs : MINUTE_MS;
	const states = new Map<string, CooldownState>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const ticks = new Map<string, ReturnType<typeof setInterval>>();
	const disabled = new Set<string>();
	let sessionCtx: ExtensionContext | undefined;

	function entryByName(entryName: string): ResolvedProviderEntry | undefined {
		return config?.providers.find((entry) => entry.name === entryName);
	}

	/** Persist a superseding cancelled record; `gate` records which gate dropped the wait. */
	function persistCancelled(state: CooldownState, gate?: "resumeOnRestart" | "fork"): void {
		pi.appendEntry(ENTRY_TYPE, { state: "cancelled", entryName: state.entryName, fireAtMs: state.fireAtMs, attempts: state.attempts, ...(gate !== undefined ? { gate } : {}), cancelledAtMs: Date.now() });
	}

	function clearTimer(entryName: string): void {
		const timer = timers.get(entryName);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(entryName);
		}
		stopTick(entryName);
	}

	function clearAllTimers(): void {
		for (const entryName of [...timers.keys()]) clearTimer(entryName);
	}

	function startTick(entryName: string): void {
		if (ticks.has(entryName)) return;
		const tick = setInterval(() => updateStatus(entryName), tickMs);
		tick.unref?.();
		ticks.set(entryName, tick);
	}

	function stopTick(entryName: string): void {
		const tick = ticks.get(entryName);
		if (tick !== undefined) {
			clearInterval(tick);
			ticks.delete(entryName);
		}
	}

	function armTimer(entryName: string): void {
		clearTimer(entryName);
		const state = states.get(entryName);
		if (state === undefined || sessionCtx === undefined) return;
		const delay = Math.max(0, state.fireAtMs - Date.now());
		const timeout =
			delay > TIMEOUT_CAP_MS
				? setTimeout(() => armTimer(entryName), TIMEOUT_CAP_MS)
				: setTimeout(() => fireResume(entryName), delay);
		timeout.unref?.();
		timers.set(entryName, timeout);
		if (sessionCtx.hasUI) startTick(entryName);
	}

	function updateStatus(entryName: string): void {
		const ctx = sessionCtx;
		const state = states.get(entryName);
		if (ctx === undefined || state === undefined || config === undefined || !ctx.hasUI) return;
		ctx.ui.setStatus(statusKeyFor(entryName), `⏳ ${entryName} in ${formatCountdown(state.fireAtMs, Date.now())} · ${state.attempts}/${config.maxResumeAttempts} resumes used`);
	}

	function fireResume(entryName: string): void {
		const ctx = sessionCtx;
		const state = states.get(entryName);
		const entry = entryByName(entryName);
		if (ctx === undefined || state === undefined || entry === undefined || config === undefined) return;
		clearTimer(entryName);
		state.attempts += 1;
		// The send deliberately precedes the persisted "fired" record: a crash
		// between the two replays the resume (at-least-once) instead of
		// silently losing it.
		if (ctx.isIdle()) pi.sendUserMessage(entry.resumePrompt);
		else pi.sendUserMessage(entry.resumePrompt, { deliverAs: "followUp" });
		pi.appendEntry(ENTRY_TYPE, { state: "fired", entryName, resetAtMs: state.resetAtMs, fireAtMs: state.fireAtMs, attempts: state.attempts, resumedAtMs: Date.now() });
		if (ctx.hasUI) {
			ctx.ui.notify(`cooldown: ${entryName} limit window reset; resuming automatically (attempt ${state.attempts}/${config.maxResumeAttempts})`, "info");
			ctx.ui.setStatus(statusKeyFor(entryName), undefined);
		}
	}

	function handleLimitError(ctx: ExtensionContext, message: LimitErrorMessage, simulated = false): void {
		if (config === undefined) return;
		// Arming is guarded to interactive surfaces (tui, rpc) so a headless
		// print/json run neither persists waits nor fires resumes.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		const prefix = simulated ? "cooldown (simulated): " : "cooldown: ";
		const entry = findCooldownEntry(config, message.provider, message.model);
		if (entry === undefined) {
			if (simulated && ctx.hasUI) ctx.ui.notify(`${prefix}the error text matched no configured provider entry; nothing armed`, "info");
			return;
		}
		if (disabled.has(entry.name)) {
			if (ctx.hasUI) {
				ctx.ui.notify(simulated
					? `${prefix}auto-recovery for ${entry.name} is disabled until the next successful turn; nothing armed`
					: `cooldown: ${entry.name} usage limit reached again; auto-recovery stays disabled until the next successful turn`, "info");
			}
			return;
		}
		const decision = planCooldownArm(config, message, states.get(entry.name), Date.now());
		if (decision.action === "ignore") {
			if (simulated && ctx.hasUI) ctx.ui.notify(`${prefix}the error text matched no configured provider limit pattern; nothing armed`, "info");
			return;
		}
		if (decision.action === "parse_failed") {
			if (ctx.hasUI) ctx.ui.notify(`${prefix}matched ${decision.entry.name} usage-limit error but the reset timestamp did not parse; no auto-resume`, "warning");
			return;
		}
		if (decision.action === "cap_reached") {
			clearTimer(entry.name);
			states.delete(entry.name);
			disabled.add(entry.name);
			pi.appendEntry(ENTRY_TYPE, { state: "capped", entryName: entry.name, attempts: decision.attempts, cappedAtMs: Date.now() });
			if (ctx.hasUI) {
				ctx.ui.setStatus(statusKeyFor(entry.name), undefined);
				ctx.ui.notify(`${prefix}${entry.name} recovery stopped after ${decision.attempts} resume attempts; continue manually (a successful turn re-enables auto-recovery)`, "error");
			}
			return;
		}
		states.set(entry.name, decision.state);
		decision.state.simulated = simulated;
		armTimer(entry.name);
		pi.appendEntry(ENTRY_TYPE, {
			state: "waiting",
			entryName: entry.name,
			resetAtMs: decision.state.resetAtMs,
			fireAtMs: decision.state.fireAtMs,
			attempts: decision.state.attempts,
			...(decision.state.model !== undefined ? { model: decision.state.model } : {}),
			...(simulated ? { simulated: true } : {}),
		});
		if (ctx.hasUI) {
			const move = decision.extended ? "limit window moved; now waiting" : "usage limit reached; waiting";
			ctx.ui.notify(`${prefix}${entry.name} ${move} until ${formatResumeClock(decision.state.fireAtMs)}, then resuming automatically`, decision.extended ? "info" : "warning");
			updateStatus(entry.name);
		}
	}

	function retirePendingWait(ctx: ExtensionContext, message: LimitErrorMessage): void {
		if (config === undefined || typeof message.provider !== "string") return;
		for (const entry of config.providers) {
			if (entry.match.provider !== message.provider || !entryModelMatches(entry, message.model)) continue;
			const pending = states.get(entry.name);
			const wasDisabled = disabled.has(entry.name);
			if (pending === undefined && !wasDisabled) continue;
			if (pending !== undefined && pending.model !== undefined && pending.model !== message.model) continue;
			if (pending !== undefined) {
				clearTimer(entry.name);
				states.delete(entry.name);
			}
			disabled.delete(entry.name);
			pi.appendEntry(ENTRY_TYPE, { state: "resolved", entryName: entry.name, resolvedAtMs: Date.now() });
			if (ctx.hasUI) {
				ctx.ui.setStatus(statusKeyFor(entry.name), undefined);
				ctx.ui.notify(`cooldown: session is processing again; pending ${entry.name} wait retired`, "info");
			}
		}
	}

	pi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		clearAllTimers();
		states.clear();
		disabled.clear();
		if (config === undefined) {
			if (ctx.hasUI) ctx.ui.notify(`cooldown extension is disabled: ${problems.join("; ")}`, "error");
			return;
		}
		// Reload bypasses resumeOnRestart in both directions: the armed timer
		// would have fired on its own had /reload not replaced it, so re-arm or
		// resume-now restores exactly the behavior the process would have
		// exhibited. Fork gets the future-deadline half only: re-arming is
		// visible and cancellable, but an immediate fire into a freshly forked
		// branch is the surprise the user ruled against; startup, new, and
		// resume stay fully gated by resumeOnRestart.
		for (const state of collectPendingWaits(ctx.sessionManager.getBranch())) {
			const decision = planRestartResume(state, config.resumeOnRestart, Date.now(), event.reason);
			if (decision.action === "none") continue;
			const entry = entryByName(decision.state.entryName);
			if (entry === undefined) {
				persistCancelled(decision.state);
				if (ctx.hasUI) ctx.ui.notify(`cooldown: persisted wait for "${decision.state.entryName}" matches no configured provider entry; dropping it`, "warning");
				continue;
			}
			if (decision.action === "drop") {
				// The gate's outcome is persisted as a superseding tombstone so a
				// later /reload cannot re-adjudicate this entry under its bypass and
				// fire what the gate withheld. The notify path stays available in
				// every mode: it is how a headless run still records the drop.
				persistCancelled(decision.state, decision.gate);
				if (ctx.hasUI) {
					ctx.ui.setStatus(statusKeyFor(decision.state.entryName), undefined);
					const gateNote = decision.gate === "fork" ? "not auto-resumed into a freshly forked session" : "not auto-resumed (resumeOnRestart: false)";
					ctx.ui.notify(`cooldown: pending ${decision.state.entryName} wait from the previous session is ${gateNote}; deadline was ${formatResumeClock(decision.state.fireAtMs)}; send a message to continue`, "info");
				}
				continue;
			}
			// Arming or firing on the restart path is guarded to interactive
			// surfaces (tui, rpc) so an opted-in headless run stays inert, matching
			// the "wait for me" ruling for one-shot processes; the persisted wait
			// itself stays untouched.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") continue;
			states.set(entry.name, decision.state);
			armTimer(entry.name);
			if (decision.action === "rearm") {
				updateStatus(entry.name);
				if (ctx.hasUI) ctx.ui.notify(`cooldown: re-armed pending ${entry.name} wait from the previous session; resuming at ${formatResumeClock(decision.state.fireAtMs)}`, "info");
				continue;
			}
			if (ctx.hasUI) ctx.ui.notify(`cooldown: pending ${entry.name} wait from the previous session is past its deadline; resuming now`, "info");
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (config === undefined) return;
		sessionCtx = ctx;
		const message = event.message;
		if (message.role !== "assistant") return;
		// AgentMessage's custom variants keep this union from narrowing on role alone; read only the assistant fields through the AssistantMessage view.
		const assistant = message as AssistantMessage;
		const limitMessage: LimitErrorMessage = { role: assistant.role, stopReason: assistant.stopReason, errorMessage: assistant.errorMessage, provider: assistant.provider, model: assistant.model };
		if (limitMessage.stopReason === "error") {
			if (typeof limitMessage.errorMessage === "string") handleLimitError(ctx, limitMessage);
			return;
		}
		if (limitMessage.stopReason === "aborted" || limitMessage.stopReason === undefined) return;
		retirePendingWait(ctx, limitMessage);
	});

	pi.on("session_shutdown", () => {
		clearAllTimers();
		states.clear();
		disabled.clear();
		sessionCtx = undefined;
	});

	function requireConfig(ctx: ExtensionCommandContext): boolean {
		if (config !== undefined) return true;
		if (ctx.hasUI) ctx.ui.notify("cooldown extension is disabled: invalid config", "error");
		return false;
	}

	function showStatus(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		if (states.size === 0) {
			const suffix = disabled.size > 0 ? ` (auto-recovery disabled for ${[...disabled].join(", ")} until the next successful turn)` : "";
			ctx.ui.notify(`cooldown: no pending usage-limit wait${suffix}`, "info");
			return;
		}
		for (const [entryName, state] of states) {
			ctx.ui.notify(`cooldown: ${entryName} is waiting until ${formatResumeClock(state.fireAtMs)}, then resuming automatically (attempt ${state.attempts + 1}/${config?.maxResumeAttempts} next)`, "info");
		}
	}

	function cancelPending(ctx: ExtensionCommandContext): void {
		if (states.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("cooldown: nothing to cancel", "info");
			return;
		}
		for (const [entryName, state] of states) {
			clearTimer(entryName);
			persistCancelled(state);
			if (ctx.hasUI) ctx.ui.setStatus(statusKeyFor(entryName), undefined);
		}
		states.clear();
		if (ctx.hasUI) {
			ctx.ui.notify("cooldown: cancelled the pending usage-limit wait(s)", "info");
		}
	}

	pi.registerCommand("cooldown", {
		description: "Show or cancel the pending usage-limit cooldown",
		handler: async (args, ctx) => {
			if (!requireConfig(ctx)) return;
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "cancel") {
				cancelPending(ctx);
				return;
			}
			if (arg === "") {
				showStatus(ctx);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("cooldown: use '/cooldown' for status or '/cooldown cancel' to abort the pending wait", "info");
		},
	});

	pi.registerCommand("cooldown-simulate", {
		description: "Debug: run a synthetic provider-limit error through the real cooldown detection path",
		handler: async (args, ctx) => {
			if (!requireConfig(ctx)) return;
			const raw = (args ?? "").trim();
			if (raw === "") {
				if (ctx.hasUI) ctx.ui.notify("cooldown-simulate: pass the provider error text, optionally prefixed with a provider entry name", "info");
				return;
			}
			let text = raw;
			let entry = config.providers[0];
			const separator = raw.indexOf(" ");
			const firstToken = separator === -1 ? raw : raw.slice(0, separator);
			const named = config.providers.find((candidate) => candidate.name === firstToken);
			if (named !== undefined) {
				entry = named;
				text = separator === -1 ? "" : raw.slice(separator + 1).trim();
			}
			if (text === "") {
				if (ctx.hasUI) ctx.ui.notify("cooldown-simulate: pass the provider error text after the entry name", "info");
				return;
			}
			const live = states.get(entry.name);
			if (live !== undefined && live.simulated !== true) {
				if (ctx.hasUI) ctx.ui.notify(`cooldown-simulate: ${entry.name} already holds a live usage-limit wait; simulating would move the real deadline, so cancel it first with /cooldown cancel`, "warning");
				return;
			}
			handleLimitError(ctx, { role: "assistant", stopReason: "error", errorMessage: text, provider: entry.match.provider, model: entry.match.model }, true);
		},
	});
}
