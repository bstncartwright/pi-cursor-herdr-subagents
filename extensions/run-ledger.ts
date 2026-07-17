/**
 * Pure, dependency-free contract for the private Run Ledger journal.  Writers may
 * feed untrusted runtime payloads to the normalizers below; journal records and
 * reduced state contain only bounded, terminal-safe summaries.
 */

export const RUN_LEDGER_VERSION = 2 as const;
export type RunLedgerVersion = 1 | 2;
export const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
export const DEFAULT_MAX_INPUT_LINES = 10_000;
export const MAX_PARSE_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PARSE_INPUT_LINES = 100_000;
export const MAX_SUMMARY_DEPTH = 5;
export const MAX_SUMMARY_KEYS = 24;
export const MAX_SUMMARY_ARRAY_LENGTH = 16;
export const MAX_SUMMARY_STRING_LENGTH = 400;
export const MAX_SERIALIZED_SUMMARY_LENGTH = 2_000;
export const MAX_THOUGHT_PREVIEW_LENGTH = 180;
export const MAX_RESPONSE_STATE_LENGTH = 8_000;

export type RunLedgerKind =
	| "run"
	| "runtime"
	| "task"
	| "phase"
	| "thought"
	| "response"
	| "tool-start"
	| "tool-update"
	| "tool-end"
	| "permission"
	| "error"
	| "completion"
	| "metrics"
	| "compaction";

export interface RunLedgerBase extends RunMetadata {
	v: RunLedgerVersion;
	seq: number;
	ts: number;
	turn: number;
	kind: RunLedgerKind;
}

export interface RunMetadata {
	agentName?: string;
	backend?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
}
export interface RunEvent extends RunLedgerBase, RunMetadata {
	kind: "run";
	runId: string;
	/** Original run creation time; `ts` remains the append time. */
	createdAt?: number;
	title?: string;
}
export interface RuntimeEvent extends RunLedgerBase, RunMetadata {
	kind: "runtime";
	state: string;
	detail?: string;
}
export interface TaskEvent extends RunLedgerBase {
	kind: "task";
	synopsis: string;
}
export interface PhaseEvent extends RunLedgerBase {
	kind: "phase";
	name: string;
	detail?: string;
}
/** `preview` is intentionally the only thought text admitted to the journal. */
export interface ThoughtEvent extends RunLedgerBase {
	kind: "thought";
	/** Explicitly marks a generated semantic thought preview. */
	previewKind: "heading" | "generic";
	preview: string;
	chunks?: number;
	characters?: number;
}
export interface ResponseEvent extends RunLedgerBase {
	kind: "response";
	text: string;
}
export interface ToolStartEvent extends RunLedgerBase {
	kind: "tool-start";
	id: string;
	name: string;
	inputSummary?: string;
	summaryFormat: "semantic-v1";
}
export interface ToolUpdateEvent extends RunLedgerBase {
	kind: "tool-update";
	id: string;
	status?: string;
	count?: number;
	summaryFormat: "semantic-v1";
}
export interface ToolEndEvent extends RunLedgerBase {
	kind: "tool-end";
	id: string;
	status?: string;
	resultPreview?: string;
	errorPreview?: string;
	summaryFormat: "semantic-v1";
}
export interface PermissionEvent extends RunLedgerBase {
	kind: "permission";
	status: string;
	summary: string;
}
export interface ErrorEvent extends RunLedgerBase {
	kind: "error";
	message: string;
	code?: string;
}
export interface CompletionEvent extends RunLedgerBase {
	kind: "completion";
	status: string;
	summary?: string;
}
export interface MetricsEvent extends RunLedgerBase {
	kind: "metrics";
	sampledAt: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }; compactionCount: number;
}
export interface CompactionEvent extends RunLedgerBase {
	kind: "compaction";
	state: "started" | "completed" | "aborted" | "failed";
	reason?: "manual" | "threshold" | "overflow";
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	willRetry?: boolean;
	/** Absolute count makes a bounded journal tail safe. */
	compactionCount: number;
}

export type RunLedgerEvent =
	| RunEvent
	| RuntimeEvent
	| TaskEvent
	| PhaseEvent
	| ThoughtEvent
	| ResponseEvent
	| ToolStartEvent
	| ToolUpdateEvent
	| ToolEndEvent
	| PermissionEvent
	| ErrorEvent
	| CompletionEvent
	| MetricsEvent
	| CompactionEvent;

export interface SummaryBounds {
	maxDepth?: number;
	maxKeys?: number;
	maxArrayLength?: number;
	maxStringLength?: number;
	maxSerializedLength?: number;
}

export interface ParseRunLedgerOptions {
	maxBytes?: number;
	maxLines?: number;
}
export interface ParseRunLedgerResult {
	events: RunLedgerEvent[];
	malformed: number;
	unsupported: number;
	truncated: boolean;
}

type JsonSummary = null | boolean | number | string | JsonSummary[] | { [key: string]: JsonSummary };

const SENSITIVE_KEY = /(?:pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|access[-_]?key|session(?:id)?)/i;
const BIDI_OR_DIRECTIONAL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const RESPONSE_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
// Include end-of-string so an interrupted OSC/DCS write cannot leave a control tail behind.
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const STRING_CONTROL = /(?:\x1b[PX^_])[\s\S]*?(?:\x1b\\|\x9c|$)/g;
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeTerminalOneLine(value: unknown): string {
	const text = typeof value === "string" ? value : value == null ? "" : String(value);
	return text
		.replace(OSC, "")
		.replace(STRING_CONTROL, "")
		.replace(CSI, "")
		.replace(/\r\n?|\n/g, " ")
		.replace(BIDI_OR_DIRECTIONAL, "")
		.replace(CONTROL, "")
		.replace(/\s+/g, " ");
}

function redactInlineSecrets(text: string): string {
	return text
		// Do this first: otherwise `Authorization: Bearer token` would redact only Bearer.
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
		.replace(/\b((?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|passwd|secret|token))\s*([=:])\s*([^\s,&;]+)/gi, "$1$2[REDACTED]");
}

/** Remove terminal escape/control/bidi sequences and make text safe for a one-line terminal field. */
export function sanitizeTerminalText(value: unknown, maxLength = MAX_SUMMARY_STRING_LENGTH): string {
	return truncate(sanitizeTerminalOneLine(value).trim(), maxLength);
}

/** Redact common inline secret forms before persisting human-readable command/output summaries. */
export function redactTextSecrets(value: unknown): string {
	return redactInlineSecrets(sanitizeTerminalText(value));
}

/**
 * Sanitize the settled response as one bounded terminal-safe record. Newlines
 * remain logical LF boundaries; tabs and other controls become spaces, while
 * ordinary spacing is retained.
 * Redacting the complete response prevents a secret split over stream deltas
 * from entering the journal.
 */
export function sanitizeResponseText(value: unknown, maxLength = MAX_RESPONSE_STATE_LENGTH): string {
	const text = typeof value === "string" ? value : value == null ? "" : String(value);
	const clean = text
		.replace(OSC, "")
		.replace(STRING_CONTROL, "")
		.replace(CSI, "")
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/\t/g, " ")
		.replace(BIDI_OR_DIRECTIONAL, "")
		.replace(RESPONSE_CONTROL, " ");
	return truncate(redactInlineSecrets(clean), maxLength);
}

function codePointLength(text: string): number { return Array.from(text).length; }

/** Truncate by Unicode code point so no surrogate pair can be split. */
function truncate(text: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	const points = Array.from(text);
	if (points.length <= maxLength) return text;
	return maxLength === 1 ? "…" : `${points.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

/** A recursive JSON-safe redactor with a global object-key budget. */
export function redactAndBound(value: unknown, bounds: SummaryBounds = {}): JsonSummary {
	const maxDepth = bounds.maxDepth ?? MAX_SUMMARY_DEPTH;
	const maxKeys = bounds.maxKeys ?? MAX_SUMMARY_KEYS;
	const maxArrayLength = bounds.maxArrayLength ?? MAX_SUMMARY_ARRAY_LENGTH;
	const maxStringLength = bounds.maxStringLength ?? MAX_SUMMARY_STRING_LENGTH;
	let remainingKeys = Math.max(0, maxKeys);
	const seen = new WeakSet<object>();

	const walk = (entry: unknown, depth: number): JsonSummary => {
		if (entry === null) return null;
		if (typeof entry === "string") return redactTextSecrets(truncate(entry, maxStringLength));
		if (typeof entry === "boolean") return entry;
		if (typeof entry === "number") return Number.isFinite(entry) ? entry : "[NON-FINITE]";
		if (typeof entry === "bigint") return "[BIGINT]";
		if (typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol") {
			return "[UNSUPPORTED]";
		}
		if (depth >= maxDepth) return "[DEPTH]";
		if (typeof entry !== "object") return "[UNSUPPORTED]";
		if (seen.has(entry)) return "[CIRCULAR]";
		seen.add(entry);
		if (Array.isArray(entry)) {
			const items = entry.slice(0, Math.max(0, maxArrayLength)).map((item) => walk(item, depth + 1));
			if (entry.length > maxArrayLength) items.push("[TRUNCATED]");
			return items;
		}
		const result: { [key: string]: JsonSummary } = {};
		for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
			if (remainingKeys-- <= 0) {
				result["…"] = "[KEYS]";
				break;
			}
			const safeKey = sanitizeTerminalText(key, maxStringLength) || "[EMPTY]";
			result[safeKey] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : walk(child, depth + 1);
		}
		return result;
	};
	return walk(value, 0);
}

/** Serialize only a bounded, redacted value. This is safe to store as a generic fallback summary. */
export function summarizeValue(value: unknown, bounds: SummaryBounds = {}): string {
	const maxSerializedLength = bounds.maxSerializedLength ?? MAX_SERIALIZED_SUMMARY_LENGTH;
	let serialized: string;
	try {
		serialized = JSON.stringify(redactAndBound(value, bounds));
	} catch {
		serialized = '"[UNSERIALIZABLE]"';
	}
	return truncate(serialized, maxSerializedLength);
}

function field(input: Record<string, unknown>, ...names: string[]): unknown {
	for (const name of names) if (name in input) return input[name];
	return undefined;
}

function textField(input: Record<string, unknown>, ...names: string[]): string | undefined {
	const candidate = field(input, ...names);
	return typeof candidate === "string" ? candidate : undefined;
}

const OPAQUE_COUNT_CAP = 100_000;
function opaqueCountLabel(length: number): string { return length >= OPAQUE_COUNT_CAP ? `≥${OPAQUE_COUNT_CAP} chars` : `${Math.max(0, length)} chars`; }

/** Return only a semantic shell label; never scan or retain arbitrary command arguments. */
function shellCommandSummary(value: unknown): string {
	if (typeof value !== "string") return "bash shell command · 0 chars";
	const size = value.length;
	const inspected = sanitizeTerminalText(value.slice(0, 256), 256);
	const safe = size <= 256 && (inspected.match(/^(?:npm|pnpm|yarn) (?:test|lint|build|run [A-Za-z0-9:_-]+)$/)
		?? inspected.match(/^git (?:status|diff|log)(?: --short)?$/));
	if (safe) return `bash ${safe[0]}`;
	const program = inspected.match(/^([A-Za-z0-9._-]+)/)?.[1] ?? "shell";
	return `bash ${program} command · ${opaqueCountLabel(size)}`;
}

/** Produce an allowlisted structural input summary, never a serialized argument payload. */
export function summarizeToolInput(name: unknown, input: unknown, bounds: SummaryBounds = {}): string {
	const tool = sanitizeTerminalText(name, 80).toLowerCase() || "tool";
	const args = record(input) ?? {};
	const path = redactTextSecrets(textField(args, "path", "file", "filename") ?? "");
	const limit = finiteNumber(field(args, "limit", "maxResults"));
	const suffix = limit === undefined ? "" : ` · limit ${Math.max(0, Math.floor(limit))}`;
	let summary: string;
	switch (tool) {
		case "read": summary = `read ${path || "(path unavailable)"}${suffix}`; break;
		case "write": {
			const contents = textField(args, "content", "contents", "text") ?? "";
			summary = `write ${path || "(path unavailable)"} · ${opaqueCountLabel(contents.length)}`;
			break;
		}
		case "edit": summary = `edit ${path || "(path unavailable)"}`; break;
		case "bash": summary = shellCommandSummary(field(args, "command", "cmd")); break;
		case "grep": summary = `grep${path ? ` in ${path}` : ""}${suffix}`; break;
		case "find": summary = `find ${path || "."}${suffix}`; break;
		case "ls": summary = `ls ${path || "."}${suffix}`; break;
		default: summary = `${tool} · input unavailable`; break;
	}
	return truncate(summary, bounds.maxSerializedLength ?? MAX_SERIALIZED_SUMMARY_LENGTH);
}

function structuralOutcome(value: unknown): string | undefined {
	const raw = record(value);
	if (!raw) return undefined;
	const parts: string[] = [];
	for (const key of ["exitCode", "exit_code", "status", "code"] as const) {
		const candidate = raw[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) parts.push(key === "exitCode" || key === "exit_code" ? `exit ${Math.floor(candidate)}` : `${key} ${Math.floor(candidate)}`);
		else if (key === "status" && typeof candidate === "string" && ["completed", "failed", "success", "error", "cancelled", "canceled", "running", "pending"].includes(candidate.toLowerCase())) parts.push(`status ${candidate.toLowerCase()}`);
	}
	for (const key of ["count", "lines", "lineCount", "bytes", "size"] as const) {
		const candidate = raw[key];
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) parts.push(`${key === "lineCount" ? "lines" : key} ${Math.floor(candidate)}`);
	}
	if (raw.truncated === true) parts.push("truncated");
	return parts.length ? parts.join(" · ") : undefined;
}

/** Persist only allowlisted tool outcome metadata or an O(1) opaque label. */
export function summarizeToolOutcome(value: unknown, isError = false, bounds: SummaryBounds = {}): string {
	const structural = structuralOutcome(value);
	if (structural) return truncate(structural, bounds.maxStringLength ?? MAX_SUMMARY_STRING_LENGTH);
	if (typeof value === "string") return `${isError ? "error" : "text"} output · ${opaqueCountLabel(value.length)}`;
	if (Array.isArray(value)) return `structured output · ${value.length >= OPAQUE_COUNT_CAP ? `≥${OPAQUE_COUNT_CAP}` : value.length} items`;
	return value == null ? `${isError ? "error" : "text"} output · 0 chars` : "structured output received";
}

/** Backward-compatible normal outcome helper. */
export function summarizeToolResult(value: unknown, bounds: SummaryBounds = {}): string {
	return summarizeToolOutcome(value, false, bounds);
}

/** A generated thought preview is the only thought text admitted to the journal. */
export function generatedThoughtPreview(value: unknown, maxLength = MAX_THOUGHT_PREVIEW_LENGTH): { previewKind: "heading" | "generic"; preview: string } | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const heading = value.match(/(?:^|\r?\n)\s*#\s+([^\r\n#][^\r\n]*)/m)?.[1]
		?? value.match(/(?:^|\r?\n)\s*\*\*([^*\r\n]+)\*\*/m)?.[1];
	if (!heading) return { previewKind: "generic", preview: "Working through details" };
	return { previewKind: "heading", preview: truncate(redactTextSecrets(heading), maxLength) || "Working through details" };
}

/** Convenience text-only form for callers that do not persist the event. */
export function thoughtPreview(value: unknown, maxLength = MAX_THOUGHT_PREVIEW_LENGTH): string {
	return generatedThoughtPreview(value, maxLength)?.preview ?? "";
}

function normalizeKind(value: unknown): RunLedgerKind | undefined {
	if (typeof value !== "string") return undefined;
	const kind = value.toLowerCase().replace(/_/g, "-");
	return ["run", "runtime", "task", "phase", "thought", "response", "tool-start", "tool-update", "tool-end", "permission", "error", "completion", "metrics", "compaction"].includes(kind)
		? (kind as RunLedgerKind)
		: undefined;
}

function metadata(raw: Record<string, unknown>): RunMetadata {
	const clean = (entry: unknown, limit = 200) => truncate(redactTextSecrets(entry), limit) || undefined;
	return {
		agentName: clean(raw.agentName ?? raw.agent_name, 120),
		backend: clean(raw.backend, 80),
		model: clean(raw.model, 160),
		thinking: clean(raw.thinking, 80),
		cwd: clean(raw.cwd, 300),
	};
}

/** Normalize an untrusted event into the v1, summary-only journal contract. */
export function normalizeRunLedgerEvent(value: unknown): RunLedgerEvent | undefined {
	const raw = record(value);
	const version = raw?.v ?? raw?.version;
	if (!raw || (version !== 1 && version !== RUN_LEDGER_VERSION)) return undefined;
	const kind = normalizeKind(raw.kind);
	const seq = nonnegativeSafeInteger(raw.seq);
	const ts = finiteNumber(raw.ts);
	const turn = nonnegativeSafeInteger(raw.turn);
	if (!kind || seq === undefined || ts === undefined || turn === undefined) return undefined;
	const base = { v: version as RunLedgerVersion, seq, ts, turn } as const;
	const clean = (entry: unknown, limit = MAX_SUMMARY_STRING_LENGTH) => truncate(redactTextSecrets(entry), limit);
	switch (kind) {
		case "run": {
			const runId = clean(field(raw, "runId", "id"), 120);
			const createdAt = finiteNumber(raw.createdAt ?? raw.created_at);
			return runId ? { ...base, kind, runId, createdAt, title: clean(raw.title, 200) || undefined, ...metadata(raw) } : undefined;
		}
		case "runtime": {
			const state = clean(raw.state, 80);
			return state ? { ...base, kind, state, detail: clean(raw.detail) || undefined, ...metadata(raw) } : undefined;
		}
		case "task": { const synopsis = clean(field(raw, "synopsis", "task")); return synopsis ? { ...base, kind, synopsis } : undefined; }
		case "phase": { const name = clean(field(raw, "name", "phase"), 120); return name ? { ...base, kind, name, detail: clean(raw.detail) || undefined } : undefined; }
		case "thought": {
			// Bare previews and text/content aliases are raw reasoning and are rejected.
			if (raw.previewKind !== "heading" && raw.previewKind !== "generic") return undefined;
			if (typeof raw.preview !== "string") return undefined;
			const preview = raw.previewKind === "generic" ? "Working through details" : truncate(redactTextSecrets(raw.preview), MAX_THOUGHT_PREVIEW_LENGTH) || "Working through details";
			const chunks = nonnegativeSafeInteger(raw.chunks);
			const characters = nonnegativeSafeInteger(raw.characters);
			return { ...base, kind, previewKind: raw.previewKind, preview, chunks: chunks && chunks > 0 ? chunks : 1, characters: characters ?? raw.preview.length };
		}
		case "response": {
			const text = sanitizeResponseText(field(raw, "text", "content", "chunk"));
			return text ? { ...base, kind, text } : undefined;
		}
		case "tool-start": {
			const id = clean(field(raw, "id", "toolId"), 160); const name = clean(field(raw, "name", "tool"), 120);
			if (!id || !name) return undefined;
			const inputSummary = raw.summaryFormat === "semantic-v1" && typeof raw.inputSummary === "string"
				? clean(raw.inputSummary) : summarizeToolInput(name, field(raw, "input", "arguments", "args"));
			return { ...base, kind, id, name, inputSummary, summaryFormat: "semantic-v1" };
		}
		case "tool-update": {
			const id = clean(field(raw, "id", "toolId"), 160);
			const count = nonnegativeSafeInteger(raw.count);
			return id ? { ...base, kind, id, status: clean(raw.status, 80) || undefined, count, summaryFormat: "semantic-v1" } : undefined;
		}
		case "tool-end": {
			const id = clean(field(raw, "id", "toolId"), 160); if (!id) return undefined;
			if (raw.summaryFormat === "semantic-v1") return { ...base, kind, id, status: clean(raw.status, 80) || undefined, resultPreview: typeof raw.resultPreview === "string" ? clean(raw.resultPreview) || undefined : undefined, errorPreview: typeof raw.errorPreview === "string" ? clean(raw.errorPreview) || undefined : undefined, summaryFormat: "semantic-v1" };
			const result = field(raw, "result", "output");
			const explicitError = field(raw, "error");
			const isError = raw.isError === true;
			const error = explicitError === undefined && isError ? result : explicitError;
			return { ...base, kind, id, status: clean(raw.status, 80) || (isError ? "failed" : undefined), resultPreview: isError || result === undefined ? undefined : summarizeToolOutcome(result), errorPreview: error === undefined ? undefined : summarizeToolOutcome(error, true), summaryFormat: "semantic-v1" };
		}
		case "permission": { const status = clean(raw.status, 80) || "pending"; const summary = clean(field(raw, "summary", "title", "message")); return summary || !permissionIsPending(status) ? { ...base, kind, status, summary } : undefined; }
		case "error": { const message = clean(field(raw, "message", "error")); return message ? { ...base, kind, message, code: clean(raw.code, 80) || undefined } : undefined; }
		case "completion": { const status = clean(raw.status, 80) || "completed"; return { ...base, kind, status, summary: clean(field(raw, "summary", "message")) || undefined }; }
		case "metrics": {
			if (version !== 2 || Object.keys(raw).some((key) => !["v", "version", "seq", "ts", "turn", "kind", "sampledAt", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "contextUsage", "compactionCount"].includes(key))) return undefined;
			const sampledAt = nonnegativeSafeInteger(raw.sampledAt), inputTokens = nonnegativeSafeInteger(raw.inputTokens), outputTokens = nonnegativeSafeInteger(raw.outputTokens), cacheReadTokens = nonnegativeSafeInteger(raw.cacheReadTokens), cacheWriteTokens = nonnegativeSafeInteger(raw.cacheWriteTokens), totalTokens = nonnegativeSafeInteger(raw.totalTokens), compactionCount = nonnegativeSafeInteger(raw.compactionCount); const cost = finiteNumber(raw.cost);
			let contextUsage: MetricsEvent["contextUsage"];
			if (raw.contextUsage !== undefined) { const context = record(raw.contextUsage); if (!context || Object.keys(context).some((key) => !["tokens", "contextWindow", "percent"].includes(key)) || !Object.prototype.hasOwnProperty.call(context, "tokens") || !Object.prototype.hasOwnProperty.call(context, "contextWindow") || !Object.prototype.hasOwnProperty.call(context, "percent") || (context.tokens !== null && nonnegativeSafeInteger(context.tokens) === undefined) || nonnegativeSafeInteger(context.contextWindow) === undefined || (context.percent !== null && (finiteNumber(context.percent) === undefined || (context.percent as number) < 0))) return undefined; contextUsage = { tokens: context.tokens as number | null, contextWindow: context.contextWindow as number, percent: context.percent as number | null }; }
			if ([sampledAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, compactionCount].some((entry) => entry === undefined) || cost === undefined || cost < 0) return undefined;
			return { ...base, kind, sampledAt: sampledAt!, inputTokens: inputTokens!, outputTokens: outputTokens!, cacheReadTokens: cacheReadTokens!, cacheWriteTokens: cacheWriteTokens!, totalTokens: totalTokens!, cost, ...(contextUsage ? { contextUsage } : {}), compactionCount: compactionCount! };
		}
		case "compaction": {
			if (version !== 2 || Object.keys(raw).some((key) => !["v", "version", "seq", "ts", "turn", "kind", "state", "reason", "tokensBefore", "estimatedTokensAfter", "willRetry", "compactionCount"].includes(key)) || !["started", "completed", "aborted", "failed"].includes(String(raw.state)) || (raw.reason !== undefined && !["manual", "threshold", "overflow"].includes(String(raw.reason)))) return undefined;
			const tokensBefore = raw.tokensBefore === undefined ? undefined : nonnegativeSafeInteger(raw.tokensBefore), estimatedTokensAfter = raw.estimatedTokensAfter === undefined ? undefined : nonnegativeSafeInteger(raw.estimatedTokensAfter), compactionCount = nonnegativeSafeInteger(raw.compactionCount);
			if (compactionCount === undefined || (raw.tokensBefore !== undefined && tokensBefore === undefined) || (raw.estimatedTokensAfter !== undefined && estimatedTokensAfter === undefined) || (raw.willRetry !== undefined && typeof raw.willRetry !== "boolean")) return undefined;
			return { ...base, kind, state: raw.state as CompactionEvent["state"], reason: raw.reason as CompactionEvent["reason"], tokensBefore, estimatedTokensAfter, willRetry: raw.willRetry === undefined ? undefined : raw.willRetry, compactionCount };
		}
	}
}

function boundedParseOption(value: unknown, fallback: number, maximum: number): number {
	const parsed = nonnegativeSafeInteger(value);
	return parsed === undefined ? fallback : Math.min(parsed, maximum);
}
function permissionIsPending(status: string): boolean { return /^(pending|requested|awaiting)$/i.test(status.trim()); }

/**
 * Parse append-only JSONL safely. Byte-bounded reads use the tail. If the tail
 * begins mid-record, only that invalid first fragment is discarded; an exact
 * line boundary (or a valid first record) is retained. `maxLines` keeps the
 * newest normalized records rather than the oldest source lines.
 */
export function parseRunLedgerJsonl(input: string, options: ParseRunLedgerOptions = {}): ParseRunLedgerResult {
	const maxBytes = boundedParseOption(options.maxBytes, DEFAULT_MAX_INPUT_BYTES, MAX_PARSE_INPUT_BYTES);
	const maxLines = boundedParseOption(options.maxLines, DEFAULT_MAX_INPUT_LINES, MAX_PARSE_INPUT_LINES);
	const bytes = Buffer.from(input, "utf8");
	const tailStart = Math.max(0, bytes.length - maxBytes);
	const truncatedByBytes = tailStart > 0;
	const bounded = truncatedByBytes ? bytes.subarray(tailStart).toString("utf8") : input;
	const lines = bounded.split("\n");
	if (truncatedByBytes && bytes[tailStart - 1] !== 0x0a) {
		const first = lines[0]?.trim() ?? "";
		let validFirst = false;
		if (first) {
			try { validFirst = normalizeRunLedgerEvent(JSON.parse(first) as unknown) !== undefined; } catch { /* partial tail */ }
		}
		if (!validFirst) lines.shift();
	}
	const finalPartial = !bounded.endsWith("\n");
	const allEvents: RunLedgerEvent[] = [];
	let malformed = 0; let unsupported = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim(); if (!line) continue;
		try {
			const parsed: unknown = JSON.parse(line); const event = normalizeRunLedgerEvent(parsed);
			if (event) allEvents.push(event);
			else if (!([1, RUN_LEDGER_VERSION] as unknown[]).includes(record(parsed)?.v ?? record(parsed)?.version)) unsupported++;
			else malformed++;
		} catch { if (!(finalPartial && index === lines.length - 1)) malformed++; }
	}
	const truncatedByLines = allEvents.length > maxLines;
	const events = maxLines === 0 ? [] : allEvents.slice(-maxLines);
	return { events, malformed, unsupported, truncated: truncatedByBytes || truncatedByLines };
}

export const parseLedgerJsonl = parseRunLedgerJsonl;

export interface ThoughtRow { kind: "thought"; seq: number; ts: number; turn: number; preview: string; chunks: number; characters: number; }
export interface ResponseRow { kind: "response"; seq: number; ts: number; turn: number; text: string; chunks: number; characters: number; }
export interface PhaseRow { kind: "phase"; seq: number; ts: number; turn: number; name: string; detail?: string; }
export interface ToolRow { kind: "tool"; seq: number; ts: number; turn: number; id: string; name: string; /** Immutable start context, never replaced by update/output text. */ inputSummary?: string; summary?: string; updateSummary?: string; status: string; resultPreview?: string; errorPreview?: string; endedAt?: number; durationMs?: number; }
export type LedgerTimelineRow = ThoughtRow | ResponseRow | PhaseRow | ToolRow;
export interface PinnedPermission { ts: number; turn: number; status: string; summary: string; }
export interface PinnedError { ts: number; turn: number; message: string; code?: string; }
export interface CompletionState { ts: number; turn: number; status: string; summary?: string; }
export interface LedgerMetrics { sampledAt: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }; compactionCount: number; }
export interface LedgerCompaction { ts: number; turn: number; state: "started" | "completed" | "aborted" | "failed"; reason?: "manual" | "threshold" | "overflow"; tokensBefore?: number; estimatedTokensAfter?: number; willRetry?: boolean; compactionCount: number; }
export interface RunLedgerState extends RunMetadata {
	runId?: string;
	title?: string;
	runtimeState?: string;
	runtimeDetail?: string;
	task?: string;
	turn: number;
	lastTs?: number;
	startedAt?: number;
	timeline: LedgerTimelineRow[];
	/** Map key is `turn\u0000id`; `ToolRow.id` remains the public rendered ID. */
	tools: ReadonlyMap<string, ToolRow>;
	permission?: PinnedPermission;
	error?: PinnedError;
	completion?: CompletionState;
	metrics?: LedgerMetrics;
	compaction?: LedgerCompaction;
	unknownToolEvents: number;
}

export function toolLedgerKey(turn: number, id: string): string { return `${turn}\u0000${id}`; }

export interface RunLedgerStateSeed extends RunMetadata {
	runId?: string;
	title?: string;
	runtimeState?: string;
	runtimeDetail?: string;
	task?: string;
	turn?: number;
	startedAt?: number;
	lastTs?: number;
	metrics?: LedgerMetrics;
}

function cloneSeedMetrics(value: unknown): LedgerMetrics | undefined {
	const raw = record(value); if (!raw || Object.keys(raw).some((key) => !["sampledAt", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "contextUsage", "compactionCount"].includes(key))) return undefined;
	const sampledAt = nonnegativeSafeInteger(raw.sampledAt), inputTokens = nonnegativeSafeInteger(raw.inputTokens), outputTokens = nonnegativeSafeInteger(raw.outputTokens), cacheReadTokens = nonnegativeSafeInteger(raw.cacheReadTokens), cacheWriteTokens = nonnegativeSafeInteger(raw.cacheWriteTokens), totalTokens = nonnegativeSafeInteger(raw.totalTokens), compactionCount = nonnegativeSafeInteger(raw.compactionCount), cost = finiteNumber(raw.cost);
	if ([sampledAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, compactionCount].some((value) => value === undefined) || cost === undefined || cost < 0) return undefined;
	let contextUsage: LedgerMetrics["contextUsage"];
	if (raw.contextUsage !== undefined) { const context = record(raw.contextUsage); if (!context || Object.keys(context).some((key) => !["tokens", "contextWindow", "percent"].includes(key)) || context.tokens === undefined || context.contextWindow === undefined || context.percent === undefined || (context.tokens !== null && nonnegativeSafeInteger(context.tokens) === undefined) || nonnegativeSafeInteger(context.contextWindow) === undefined || (context.percent !== null && (finiteNumber(context.percent) === undefined || (context.percent as number) < 0))) return undefined; contextUsage = { tokens: context.tokens as number | null, contextWindow: context.contextWindow as number, percent: context.percent as number | null }; }
	return { sampledAt: sampledAt!, inputTokens: inputTokens!, outputTokens: outputTokens!, cacheReadTokens: cacheReadTokens!, cacheWriteTokens: cacheWriteTokens!, totalTokens: totalTokens!, cost, ...(contextUsage ? { contextUsage } : {}), compactionCount: compactionCount! };
}
/** Seed the pure reducer from private viewer-info metadata when the run event aged out of a tail. */
export function createRunLedgerState(seed: RunLedgerStateSeed = {}): RunLedgerState {
	const clean = (value: unknown, limit = MAX_SUMMARY_STRING_LENGTH) => truncate(redactTextSecrets(value), limit) || undefined;
	return {
		runId: clean(seed.runId, 120), title: clean(seed.title, 200), runtimeState: clean(seed.runtimeState, 80), runtimeDetail: clean(seed.runtimeDetail),
		task: clean(seed.task), agentName: clean(seed.agentName, 120), backend: clean(seed.backend, 80), model: clean(seed.model, 160), thinking: clean(seed.thinking, 80), cwd: clean(seed.cwd, 300),
		turn: nonnegativeSafeInteger(seed.turn) ?? 0, metrics: cloneSeedMetrics(seed.metrics), startedAt: finiteNumber(seed.startedAt), lastTs: finiteNumber(seed.lastTs), timeline: [], tools: new Map(), unknownToolEvents: 0,
	};
}

function duration(start: number, end: number): number | undefined { return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined; }
function applyMetadata(state: RunLedgerState, event: RunMetadata): RunMetadata {
	return {
		agentName: event.agentName ?? state.agentName, backend: event.backend ?? state.backend,
		model: event.model ?? state.model, thinking: event.thinking ?? state.thinking, cwd: event.cwd ?? state.cwd,
	};
}

/** Immutable reducer. Tool lifecycle correlation is exclusively by turn plus stable ID. */
export function reduceRunLedger(state: RunLedgerState, event: RunLedgerEvent): RunLedgerState {
	const beginsCurrentTurn = event.turn > state.turn
		|| (event.turn === state.turn && state.runtimeState !== undefined && /^(starting|running)$/i.test(state.runtimeState)
			&& (event.kind === "runtime" || event.kind === "task" || event.kind === "phase"));
	const cleared = beginsCurrentTurn ? { ...state, completion: undefined, error: undefined, permission: undefined } : state;
	const timeline = cleared.timeline.slice(); const tools = new Map(cleared.tools);
	const base = { ...cleared, ...applyMetadata(cleared, event), timeline, tools, turn: Math.max(cleared.turn, event.turn), lastTs: event.ts, startedAt: cleared.startedAt ?? event.ts };
	switch (event.kind) {
		case "run": return { ...base, runId: event.runId, title: event.title, startedAt: state.startedAt ?? event.createdAt ?? event.ts };
		case "runtime": return { ...base, runtimeState: event.state, runtimeDetail: event.detail };
		case "task": return { ...base, task: event.synopsis };
		case "phase": timeline.push({ kind: "phase", seq: event.seq, ts: event.ts, turn: event.turn, name: event.name, detail: event.detail }); return base;
		case "thought": {
			const preview = truncate(redactTextSecrets(event.preview), MAX_THOUGHT_PREVIEW_LENGTH) || "Working through details";
			const previous = timeline.at(-1);
			if (previous?.kind === "thought" && previous.turn === event.turn) {
				timeline[timeline.length - 1] = { ...previous, chunks: previous.chunks + (event.chunks ?? 1), characters: previous.characters + (event.characters ?? codePointLength(event.preview)) };
			} else timeline.push({ kind: "thought", seq: event.seq, ts: event.ts, turn: event.turn, preview, chunks: event.chunks ?? 1, characters: event.characters ?? codePointLength(event.preview) });
			return base;
		}
		case "response": {
			const previous = timeline.at(-1);
			if (previous?.kind === "response" && previous.turn === event.turn) {
				timeline[timeline.length - 1] = { ...previous, text: truncate(`${previous.text}${event.text}`, MAX_RESPONSE_STATE_LENGTH), chunks: previous.chunks + 1, characters: previous.characters + codePointLength(event.text) };
			} else timeline.push({ kind: "response", seq: event.seq, ts: event.ts, turn: event.turn, text: truncate(event.text, MAX_RESPONSE_STATE_LENGTH), chunks: 1, characters: codePointLength(event.text) });
			return base;
		}
		case "tool-start": {
			const key = toolLedgerKey(event.turn, event.id);
			if (tools.has(key)) return { ...base, unknownToolEvents: state.unknownToolEvents + 1 };
			const row: ToolRow = { kind: "tool", seq: event.seq, ts: event.ts, turn: event.turn, id: event.id, name: event.name, inputSummary: event.inputSummary, summary: event.inputSummary, status: "running" };
			tools.set(key, row); timeline.push(row); return base;
		}
		case "tool-update": {
			const key = toolLedgerKey(event.turn, event.id); const row = tools.get(key);
			if (!row || row.endedAt !== undefined) return { ...base, unknownToolEvents: state.unknownToolEvents + 1 };
			const next = { ...row, status: event.status ?? row.status, updateSummary: event.count === undefined ? row.updateSummary : `updates ${event.count}` };
			tools.set(key, next); const index = timeline.indexOf(row); if (index >= 0) timeline[index] = next;
			return base;
		}
		case "tool-end": {
			const key = toolLedgerKey(event.turn, event.id); const row = tools.get(key);
			if (!row || row.endedAt !== undefined) return { ...base, unknownToolEvents: state.unknownToolEvents + 1 };
			const next = { ...row, status: event.status ?? (event.errorPreview ? "failed" : "completed"), resultPreview: event.resultPreview, errorPreview: event.errorPreview, endedAt: event.ts, durationMs: duration(row.ts, event.ts) };
			tools.set(key, next); const index = timeline.indexOf(row); if (index >= 0) timeline[index] = next;
			return base;
		}
		case "permission": return permissionIsPending(event.status) ? { ...base, permission: { ts: event.ts, turn: event.turn, status: event.status, summary: event.summary } } : { ...base, permission: undefined };
		case "error": return { ...base, error: { ts: event.ts, turn: event.turn, message: event.message, code: event.code } };
		case "completion":
			return cleared.completion?.turn === event.turn ? base : { ...base, permission: undefined, completion: { ts: event.ts, turn: event.turn, status: event.status, summary: event.summary } };
		case "metrics": return { ...base, metrics: { sampledAt: event.sampledAt, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens, totalTokens: event.totalTokens, cost: event.cost, ...(event.contextUsage ? { contextUsage: { ...event.contextUsage } } : {}), compactionCount: event.compactionCount } };
		case "compaction": return { ...base, compaction: { ts: event.ts, turn: event.turn, state: event.state, reason: event.reason, tokensBefore: event.tokensBefore, estimatedTokensAfter: event.estimatedTokensAfter, willRetry: event.willRetry, compactionCount: event.compactionCount } };
	}
}

export function reduceRunLedgerEvents(events: Iterable<RunLedgerEvent>, initial = createRunLedgerState()): RunLedgerState {
	let state = initial; for (const event of events) state = reduceRunLedger(state, event); return state;
}

export type RunLedgerRole = "identity" | "state" | "elapsed" | "turn" | "muted" | "task" | "timestamp" | "thought" | "response" | "tool" | "success" | "warning" | "error" | "completion";
export interface RunLedgerToken { role: RunLedgerRole; text: string; }
export interface RunLedgerLine { tokens: RunLedgerToken[]; }
export interface RunLedgerFrame { lines: RunLedgerLine[]; width: number; height: number; }
export interface RenderRunLedgerOptions { width: number; height: number; now?: number; }
export interface RunLedgerPresentationBlock { key: string; lines: RunLedgerLine[]; }
export interface RunLedgerPresentation { sticky: RunLedgerLine[]; blocks: RunLedgerPresentationBlock[]; footer?: RunLedgerLine; }
export const MAX_RESPONSE_RENDER_LINES = 3;

function line(...tokens: RunLedgerToken[]): RunLedgerLine { return { tokens: tokens.filter((token) => token.text).map((token) => ({ ...token })) }; }
function fitLine(width: number, ...tokens: RunLedgerToken[]): RunLedgerLine {
	let remaining = Math.max(0, width);
	return line(...tokens.map((token) => { const text = truncate(token.text, remaining); remaining -= codePointLength(text); return { ...token, text }; }));
}
export function renderRunLedgerText(frame: RunLedgerFrame): string { return frame.lines.map((row) => row.tokens.map((token) => token.text).join("")).join("\n"); }
export function formatLedgerElapsed(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1_000) return `${Math.floor(safe)}ms`;
	if (safe < 10_000) return `${(safe / 1_000).toFixed(1)}s`;
	const seconds = Math.floor(safe / 1000); const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
/** A timeline timestamp is elapsed from the run start, never the current-view age. */
export function formatLedgerRelativeTime(ts: number, startedAt: number): string { return `+${formatLedgerElapsed(ts - startedAt)}`; }
function fit(text: string, width: number): string { return truncate(text, Math.max(1, width)); }
function statusSymbol(status: string): string {
	if (/fail|error|denied|reject/i.test(status)) return "✕";
	if (/complete|success|allow/i.test(status)) return "✓";
	if (/pending|wait/i.test(status)) return "?";
	return "●";
}
function responseLines(row: ResponseRow, width: number, startedAt: number): RunLedgerLine[] {
	const stamp = `${formatLedgerRelativeTime(row.ts, startedAt)} `;
	const prefix = "Response · "; const continuation = "  ↳ ";
	const firstWidth = Math.max(1, width - codePointLength(stamp) - codePointLength(prefix));
	const restWidth = Math.max(1, width - codePointLength(continuation));
	const chunks: Array<{ text: string; width: number; first: boolean }> = [];
	let truncated = false;
	const logicalLines = row.text.split("\n");
	outer: for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex++) {
		const chars = Array.from(logicalLines[lineIndex]!);
		do {
			if (chunks.length >= MAX_RESPONSE_RENDER_LINES) { truncated = true; break outer; }
			const first = chunks.length === 0;
			const available = first ? firstWidth : restWidth;
			chunks.push({ text: chars.splice(0, available).join(""), width: available, first });
		} while (chars.length);
	}
	if (truncated && chunks.length) {
		const last = chunks[chunks.length - 1]!;
		last.text = truncate(`${last.text}…`, last.width);
	}
	return chunks.map((chunk) => chunk.first
		? fitLine(width, { role: "timestamp", text: stamp }, { role: "response", text: `${prefix}${chunk.text}` })
		: fitLine(width, { role: "response", text: `${continuation}${chunk.text}` }));
}
function timelineLines(row: LedgerTimelineRow, width: number, startedAt: number): RunLedgerLine[] {
	const time = `${formatLedgerRelativeTime(row.ts, startedAt)} `;
	if (row.kind === "thought") return [line({ role: "timestamp", text: time }, { role: "thought", text: fit(`Thought · ${row.preview}`, width - codePointLength(time)) })];
	if (row.kind === "response") return responseLines(row, width, startedAt);
	if (row.kind === "phase") return [line({ role: "timestamp", text: time }, { role: "muted", text: fit(`Phase · ${row.name}${row.detail ? ` · ${row.detail}` : ""}`, width - codePointLength(time)) })];
	let context = row.inputSummary ?? row.summary ?? row.name;
	const prefix = `${row.name} `;
	if (context.toLowerCase().startsWith(prefix.toLowerCase())) context = context.slice(prefix.length);
	const activeDetail = row.endedAt === undefined ? row.updateSummary : row.errorPreview ?? row.resultPreview;
	const lifecycle = `${statusSymbol(row.status)} ${row.name}${context ? ` · ${context}` : ""} · ${row.status}${row.durationMs === undefined ? "" : ` · ${formatLedgerElapsed(row.durationMs)}`}${activeDetail ? ` · ${activeDetail}` : ""}`;
	return [line({ role: "timestamp", text: time }, { role: "tool", text: fit(`Tool · ${lifecycle}`, width - codePointLength(time)) })];
}

/** Build stable semantic blocks for tail rendering and native block-wise scrolling. */
export function buildRunLedgerPresentation(state: RunLedgerState, options: { width: number; now?: number }): RunLedgerPresentation {
	const width = Math.max(1, Math.floor(options.width));
	const requestedNow = options.now ?? state.lastTs ?? 0;
	const terminalRuntime = /^(?:completed|failed|interrupted|closed|cancelled|canceled)$/i.test(state.runtimeState ?? "");
	const elapsedAt = state.completion?.ts ?? (terminalRuntime ? state.lastTs ?? requestedNow : requestedNow);
	const elapsed = state.startedAt === undefined ? "0:00" : formatLedgerElapsed(elapsedAt - state.startedAt);
	const identity = state.agentName || state.title || state.runId || "Run Ledger"; const status = state.completion?.status ?? state.runtimeState ?? "running";
	const mode = width >= 100 ? "wide" : width >= 65 ? "medium" : "narrow";
	const header = mode === "wide"
		? fitLine(width, { role: "identity", text: `RUN ${fit(identity, 34)}` }, { role: "muted", text: " · " }, { role: "state", text: status }, { role: "muted", text: " · " }, { role: "elapsed", text: elapsed }, { role: "muted", text: " · turn " }, { role: "turn", text: String(state.turn) })
		: mode === "medium"
			? fitLine(width, { role: "identity", text: `RUN ${fit(identity, 24)}` }, { role: "muted", text: " · " }, { role: "state", text: status }, { role: "muted", text: " · " }, { role: "elapsed", text: elapsed }, { role: "muted", text: " · T" }, { role: "turn", text: String(state.turn) })
			: fitLine(width, { role: "identity", text: fit(identity, Math.max(1, width - 22)) }, { role: "muted", text: " · " }, { role: "state", text: status }, { role: "muted", text: " · " }, { role: "elapsed", text: elapsed }, { role: "muted", text: " · T" }, { role: "turn", text: String(state.turn) });
	const footer = state.completion ? line({ role: "completion", text: fit(`Completed · ${state.completion.status}${state.completion.summary ? ` · ${state.completion.summary}` : ""}`, width) }) : undefined;
	const fixed: RunLedgerLine[] = [header];
	if (state.permission) fixed.push(line({ role: "warning", text: fit(`Permission · ${state.permission.status} · ${state.permission.summary}`, width) }));
	if (state.error) fixed.push(line({ role: "error", text: fit(`Error${state.error.code ? ` ${state.error.code}` : ""} · ${state.error.message}`, width) }));
	if (state.task) fixed.push(line({ role: "task", text: fit(`Task · ${state.task}`, width) }));
	const compactionCount = Math.max(state.metrics?.compactionCount ?? 0, state.compaction?.compactionCount ?? 0);
	const context = state.metrics?.contextUsage?.tokens == null
		? "—"
		: `${state.metrics.contextUsage.tokens}/${state.metrics.contextUsage.contextWindow}${state.metrics.contextUsage.percent == null ? "" : ` ${Math.round(state.metrics.contextUsage.percent * 10) / 10}%`}`;
	const usage = state.backend === "cursor" ? "usage — · context — · compactions —" : state.metrics ? `usage ${state.metrics.totalTokens} · context ${context} · compactions ${compactionCount}` : state.compaction ? `usage — · context — · compactions ${compactionCount}` : undefined;
	const compaction = state.backend === "cursor" || !state.compaction ? undefined : `compact ${state.compaction.state}${state.compaction.willRetry ? " · retry" : ""}`;
	const metadata = [state.backend, state.model, state.thinking ? `thinking ${state.thinking}` : undefined, usage, compaction, state.cwd].filter((value): value is string => !!value).join(" · ");
	if (metadata) fixed.push(line({ role: "muted", text: fit(metadata, width) }));
	const blocks = state.timeline.map((row) => ({ key: row.kind === "tool" ? `tool:${row.turn}:${row.id}` : `${row.kind}:${row.turn}:${row.seq}`, lines: timelineLines(row, width, state.startedAt ?? row.ts) }));
	return { sticky: fixed, blocks, footer };
}

/** Render semantic tokens only; callers apply their own theme/ANSI overlay. */
export function renderRunLedger(state: RunLedgerState, options: RenderRunLedgerOptions): RunLedgerFrame {
	const width = Math.max(1, Math.floor(options.width)); const height = Math.max(1, Math.floor(options.height));
	const { sticky: fixed, blocks, footer } = buildRunLedgerPresentation(state, { width, now: options.now });
	if (height === 1 && footer) return { lines: [footer], width, height };
	const reserveFooter = footer ? 1 : 0; const fixedVisible = fixed.slice(0, Math.max(0, height - reserveFooter));
	const remaining = Math.max(0, height - reserveFooter - fixedVisible.length);
	const selected: RunLedgerLine[][] = [];
	let used = 0;
	for (const block of [...blocks].reverse()) {
		if (block.lines.length <= remaining - used) { selected.unshift(block.lines); used += block.lines.length; }
		else if (used === 0 && remaining > 0) { selected.unshift(block.lines.slice(0, remaining)); used = remaining; }
		if (used >= remaining) break;
	}
	return { lines: [...fixedVisible, ...selected.flat(), ...(footer ? [footer] : [])], width, height };
}

export const renderLedger = renderRunLedger;
