/**
 * Pure Pi presentation for spawn_agent call/result and automatic completion follow-ups.
 * Uses only semantic theme tokens — never hardcoded ANSI/colors.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { AgentMetrics } from "./turn-manifest.ts";

export type MessageTheme = Pick<Theme, "fg" | "bold">;

export interface SpawnCallArgs {
	task_name?: unknown;
	backend?: unknown;
	agent_type?: unknown;
	message?: unknown;
	/** Present on some call shapes; never rendered. */
	prompt?: unknown;
}

export interface SpawnResultDetails {
	agent_name?: unknown;
	backend?: unknown;
	model?: unknown;
	thinking?: unknown;
	isolation?: unknown;
	agent_type?: unknown;
	status?: unknown;
}

export interface SpawnRenderResult {
	isError?: boolean;
	details?: SpawnResultDetails | null;
}

export interface CompletionFollowUpDetails {
	agentName: string;
	backend: string;
	status: string;
	agentStatus: string;
	terminalReason?: string;
	turnId?: string;
	model: string;
	thinking?: string;
	isolation: string;
	durationMs: number;
	metrics?: AgentMetrics;
	output: string;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface CompletionRenderDetails {
	agentName?: unknown;
	backend?: unknown;
	status?: unknown;
	agentStatus?: unknown;
	model?: unknown;
	thinking?: unknown;
	isolation?: unknown;
	durationMs?: unknown;
	metrics?: unknown;
	output?: unknown;
	truncated?: unknown;
	fullOutputPath?: unknown;
}

const PREVIEW_CODE_POINTS = 100;
const EXPANDED_OUTPUT_LINES = 30;

/** Safe terminal display primitive shared by message and tool cards. */
export function safeDisplayText(value: unknown, max: number, fallback = "—"): string {
	if (typeof value !== "string") return fallback;
	const clean = value
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ").trim();
	if (!clean) return fallback;
	const points = Array.from(clean); const cap = Math.max(0, Math.floor(max));
	return points.length <= cap ? clean : cap < 2 ? "…" : `${points.slice(0, cap - 1).join("")}…`;
}
const COMPLETION_STATUS = new Set(["queued", "starting", "running", "completed", "failed", "interrupted", "paused", "closed"]);
const COMPLETION_BACKEND = new Set(["pi", "cursor"]);
const COMPLETION_ISOLATION = new Set(["shared", "worktree"]);
const COMPLETION_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function completionEnum(value: unknown, values: Set<string>): string { return typeof value === "string" && values.has(value) ? value : "—"; }

/** Compact token counts for muted usage stats (matches Pi footer's shape). */
export function formatCompactTokens(count: number): string {
	if (!Number.isFinite(count) || count < 0) return "—";
	if (count < 1_000) return String(Math.floor(count));
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Duration for completion stats: `18s`, `1:05`, or `ms` under one second. */
export function formatDurationMs(ms: number): string {
	const safe = Math.max(0, Math.floor(ms));
	if (safe < 1_000) return `${safe}ms`;
	const seconds = Math.floor(safe / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function computeDurationMs(info: {
	startedAt?: number;
	createdAt: number;
	completedAt?: number;
}): number {
	const end = info.completedAt ?? info.createdAt;
	const start = info.startedAt ?? info.createdAt;
	return Math.max(0, end - start);
}

/** Canonicalized-ish `/task` label; robust when args are missing or invalid. */
export function spawnTaskLabel(taskName: unknown): string {
	if (typeof taskName !== "string") return "/?";
	const trimmed = taskName.trim().replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}` : "/?";
}

function asNonemptyString(value: unknown): string | undefined {
	const text = safeDisplayText(value, 120, ""); return text || undefined;
}

function joinStats(parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => !!part).join(" · ");
}

function compactControlStrip(value: string, maxCodePoints = PREVIEW_CODE_POINTS): string {
	return safeDisplayText(value, maxCodePoints, "");
}

/** Safe one-line rendering while preserving callers' line boundaries. */
function sanitizeOutputLine(value: unknown): string { return safeDisplayText(value, 400, ""); }

function firstNonemptyPreview(output: string): string {
	for (const line of output.split("\n")) {
		const preview = compactControlStrip(line);
		if (preview) return preview;
	}
	return "";
}

function clonePiMetrics(metrics: unknown): AgentMetrics | undefined {
	if (!metrics || typeof metrics !== "object") return undefined;
	const value = metrics as Record<string, unknown>;
	const numberFields = ["sampledAt", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "compactionCount"] as const;
	const cloned: Record<string, number> = {};
	for (const key of numberFields) {
		const raw = value[key];
		if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
		cloned[key] = raw;
	}
	let contextUsage: AgentMetrics["contextUsage"];
	if (value.contextUsage !== undefined) {
		if (!value.contextUsage || typeof value.contextUsage !== "object") return undefined;
		const context = value.contextUsage as Record<string, unknown>;
		const tokens = context.tokens;
		const contextWindow = context.contextWindow;
		const percent = context.percent;
		if (!(tokens === null || (typeof tokens === "number" && Number.isFinite(tokens)))) return undefined;
		if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) return undefined;
		if (!(percent === null || (typeof percent === "number" && Number.isFinite(percent)))) return undefined;
		contextUsage = { tokens: tokens as number | null, contextWindow, percent: percent as number | null };
	}
	return {
		sampledAt: cloned.sampledAt!,
		inputTokens: cloned.inputTokens!,
		outputTokens: cloned.outputTokens!,
		cacheReadTokens: cloned.cacheReadTokens!,
		cacheWriteTokens: cloned.cacheWriteTokens!,
		totalTokens: cloned.totalTokens!,
		cost: cloned.cost!,
		compactionCount: cloned.compactionCount!,
		...(contextUsage ? { contextUsage } : {}),
	};
}

export function buildCompletionFollowUpDetails(input: {
	agentName: string;
	mailStatus: string;
	agentStatus: string;
	terminalReason?: string;
	turnId?: string;
	backend: string;
	model: string;
	thinking?: string;
	isolation: string;
	startedAt?: number;
	createdAt: number;
	completedAt?: number;
	metrics?: AgentMetrics;
	output: string;
	truncated: boolean;
	fullOutputPath?: string;
}): CompletionFollowUpDetails {
	const details: CompletionFollowUpDetails = {
		agentName: input.agentName,
		backend: input.backend,
		status: input.mailStatus,
		agentStatus: input.agentStatus,
		model: input.model,
		isolation: input.isolation,
		durationMs: computeDurationMs(input),
		output: input.output,
		truncated: input.truncated,
	};
	if (input.terminalReason !== undefined) details.terminalReason = input.terminalReason;
	if (input.turnId !== undefined) details.turnId = input.turnId;
	if (input.backend === "pi" && input.thinking !== undefined) details.thinking = input.thinking;
	if (input.backend === "pi") {
		const metrics = clonePiMetrics(input.metrics);
		if (metrics) details.metrics = metrics;
	}
	if (input.fullOutputPath) details.fullOutputPath = input.fullOutputPath;
	return details;
}

/** Keys permitted on automatic completion follow-up details (explicit allowlist). */
export const COMPLETION_FOLLOW_UP_DETAIL_KEYS = [
	"agentName",
	"backend",
	"status",
	"agentStatus",
	"terminalReason",
	"turnId",
	"model",
	"thinking",
	"isolation",
	"durationMs",
	"metrics",
	"output",
	"truncated",
	"fullOutputPath",
] as const;

export function renderSpawnCall(args: SpawnCallArgs | null | undefined, theme: MessageTheme): string {
	const safe = args ?? {};
	const label = safeDisplayText(spawnTaskLabel(safe.task_name), 64, "/?");
	const backend = asNonemptyString(safe.backend) ?? "?";
	const agentType = asNonemptyString(safe.agent_type);
	let text = `${theme.fg("toolTitle", "▸")} ${theme.fg("accent", label)} ${theme.fg("dim", `[${backend}]`)}`;
	if (agentType) text += ` ${theme.fg("dim", agentType)}`;
	return text;
}

export function renderSpawnResult(result: SpawnRenderResult | null | undefined, theme: MessageTheme): string {
	if (result?.isError) return theme.fg("error", "✗ Spawn failed");
	const details = result?.details ?? {};
	const backend = asNonemptyString(details.backend) ?? "?";
	const model = asNonemptyString(details.model);
	const thinking = backend === "pi" ? asNonemptyString(details.thinking) : undefined;
	const isolation = asNonemptyString(details.isolation);
	const stats = joinStats([
		backend,
		model,
		thinking ? `thinking ${thinking}` : undefined,
		isolation,
	]);
	return `${theme.fg("dim", "  ⎿  Queued in background")}\n${theme.fg("dim", `  ${stats}`)}`;
}

function completionStatusStyle(status: string): { icon: string; color: ThemeColor } {
	switch (status) {
		case "completed":
			return { icon: "✓", color: "success" };
		case "failed":
			return { icon: "✗", color: "error" };
		case "interrupted":
		case "paused":
		case "closed":
			return { icon: "■", color: "muted" };
		case "queued":
		case "starting":
		case "running":
			return { icon: "●", color: "dim" };
		default:
			return { icon: "■", color: "muted" };
	}
}

function usageLabel(backend: string, metrics: unknown): string {
	if (backend !== "pi") return "usage —";
	const cloned = clonePiMetrics(metrics);
	if (!cloned) return "usage —";
	return `usage ${formatCompactTokens(cloned.totalTokens)}`;
}

function completionStatsLine(details: CompletionRenderDetails): string {
	const backend = completionEnum(details.backend, COMPLETION_BACKEND);
	const model = safeDisplayText(details.model, 96);
	const thinking = backend === "pi" ? completionEnum(details.thinking, COMPLETION_THINKING) : undefined;
	const isolation = completionEnum(details.isolation, COMPLETION_ISOLATION);
	const isolationSignal = isolation !== "shared" ? isolation : undefined;
	const duration = typeof details.durationMs === "number" && Number.isFinite(details.durationMs) && details.durationMs >= 0
		? formatDurationMs(details.durationMs)
		: "—";
	return joinStats([
		backend,
		model,
		thinking ? `thinking ${thinking}` : undefined,
		isolationSignal,
		usageLabel(backend, details.metrics),
		duration,
	]);
}

function boundedOutputText(details: CompletionRenderDetails | undefined): string {
	return typeof details?.output === "string" ? details.output : "";
}

export function renderCompletionMessage(
	message: { details?: CompletionRenderDetails | null; content?: unknown },
	options: { expanded?: boolean },
	theme: MessageTheme,
): string {
	const details = message.details ?? {};
	const displayStatus = completionEnum(details.agentStatus, COMPLETION_STATUS) !== "—" ? completionEnum(details.agentStatus, COMPLETION_STATUS) : completionEnum(details.status, COMPLETION_STATUS);
	const { icon, color } = completionStatusStyle(displayStatus);
	const name = safeDisplayText(details.agentName, 64, "Subagent");
	const lines = [
		`${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", displayStatus)}`,
		theme.fg("dim", `  ⎿  ${completionStatsLine(details)}`),
	];

	const output = boundedOutputText(details);
	if (options.expanded) {
		const all = output.length ? output.split("\n") : [];
		const visible = all.slice(0, EXPANDED_OUTPUT_LINES);
		if (!visible.length) lines.push(theme.fg("dim", "  ⎿  No output"));
		else {
			for (const line of visible) lines.push(theme.fg("customMessageText", `  ⎿  ${sanitizeOutputLine(line) || "—"}`));
			const omitted = all.length - visible.length;
			if (omitted > 0) lines.push(theme.fg("muted", `  ⎿  … ${omitted} more lines`));
		}
	} else {
		const preview = firstNonemptyPreview(output);
		lines.push(theme.fg("dim", `  ⎿  ${preview || "No output"}`));
	}


	return lines.join("\n");
}
