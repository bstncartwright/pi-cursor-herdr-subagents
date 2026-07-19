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
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function joinStats(parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => !!part).join(" · ");
}

function compactControlStrip(value: string, maxCodePoints = PREVIEW_CODE_POINTS): string {
	const clean = sanitizeOutputLine(value)
		.replace(/\s+/g, " ")
		.trim();
	const points = Array.from(clean);
	if (points.length <= maxCodePoints) return clean;
	return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}

/** Remove terminal-control and bidi-control sequences while preserving ordinary line spacing. */
function sanitizeOutputLine(value: string): string {
	return value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

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
	const label = spawnTaskLabel(safe.task_name);
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
		default:
			return { icon: "●", color: "dim" };
	}
}

function usageLabel(backend: string, metrics: unknown): string {
	if (backend !== "pi") return "usage —";
	const cloned = clonePiMetrics(metrics);
	if (!cloned) return "usage —";
	return `usage ${formatCompactTokens(cloned.totalTokens)}`;
}

function completionStatsLine(details: CompletionRenderDetails): string {
	const backend = asNonemptyString(details.backend) ?? "?";
	const model = asNonemptyString(details.model);
	const thinking = backend === "pi" ? asNonemptyString(details.thinking) : undefined;
	const isolation = asNonemptyString(details.isolation);
	const isolationSignal = isolation && isolation !== "shared" ? isolation : undefined;
	const duration = typeof details.durationMs === "number" && Number.isFinite(details.durationMs)
		? formatDurationMs(details.durationMs)
		: undefined;
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
	const displayStatus = asNonemptyString(details.agentStatus) ?? asNonemptyString(details.status) ?? "completed";
	const { icon, color } = completionStatusStyle(displayStatus);
	const name = asNonemptyString(details.agentName) ?? "Subagent";
	const lines = [
		`${theme.fg(color, icon)} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", displayStatus)}`,
		theme.fg("dim", completionStatsLine(details)),
	];

	const output = boundedOutputText(details);
	if (options.expanded) {
		const all = output.length ? output.split("\n") : [];
		const visible = all.slice(0, EXPANDED_OUTPUT_LINES);
		if (!visible.length) lines.push(theme.fg("dim", "  ⎿  No output"));
		else {
			for (const line of visible) lines.push(theme.fg("customMessageText", `  ${sanitizeOutputLine(line)}`));
			const omitted = all.length - visible.length;
			if (omitted > 0) lines.push(theme.fg("muted", `  … ${omitted} more lines`));
		}
	} else {
		const preview = firstNonemptyPreview(output);
		lines.push(theme.fg("dim", `  ⎿  ${preview || "No output"}`));
	}

	if (options.expanded && details.truncated === true && asNonemptyString(details.fullOutputPath)) {
		lines.push(theme.fg("muted", asNonemptyString(details.fullOutputPath)!));
	}

	return lines.join("\n");
}
