/**
 * Dependency-free terminal front end for the private Run Ledger. This module is
 * intentionally import-safe: the CLI starts only when this file is the entrypoint.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
	createRunLedgerState,
	parseRunLedgerJsonl,
	reduceRunLedgerEvents,
	renderRunLedger,
	renderRunLedgerText,
	sanitizeTerminalText,
	type RunLedgerFrame,
	type RunLedgerRole,
	type RunLedgerStateSeed,
} from "./run-ledger.ts";

export interface RunLedgerViewerPaths {
	infoPath: string;
	journalPath: string;
	rawLogPath: string;
}

export interface ViewerFrameOptions extends RunLedgerViewerPaths {
	width: number;
	height: number;
	now?: number;
}

export const JOURNAL_TAIL_BYTES = 256 * 1024;
export const JOURNAL_TAIL_LINES = 800;
export const RAW_TAIL_BYTES = 24 * 1024;
export const RAW_TAIL_LINES = 80;

export function readBoundedTail(path: string, maxBytes: number): string {
	try {
		const size = statSync(path).size;
		const length = Math.max(0, Math.min(size, maxBytes));
		if (!length) return "";
		const fd = openSync(path, "r");
		try {
			const data = Buffer.alloc(length);
			readSync(fd, data, 0, length, Math.max(0, size - length));
			const text = data.toString("utf8");
			// A bounded tail may begin in the middle of JSONL. Drop that first
			// physical line here so the parser never mistakes it for corruption.
			if (size > maxBytes) {
				const preceding = Buffer.alloc(1);
				readSync(fd, preceding, 0, 1, size - length - 1);
				// Preserve an exact record boundary; otherwise discard only the
				// partial first physical line.
				if (preceding[0] !== 0x0a) {
					const newline = text.indexOf("\n");
					return newline < 0 ? "" : text.slice(newline + 1);
				}
			}
			return text;
		} finally { closeSync(fd); }
	} catch { return ""; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function safeInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
/** The viewer accepts only the same numeric-only Pi metrics durable schema. */
function viewerMetrics(value: unknown): RunLedgerStateSeed["metrics"] {
	const raw = asRecord(value); if (!raw || Object.keys(raw).some((key) => !["sampledAt", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "contextUsage", "compactionCount"].includes(key))) return undefined;
	const sampledAt = safeInteger(raw.sampledAt), inputTokens = safeInteger(raw.inputTokens), outputTokens = safeInteger(raw.outputTokens), cacheReadTokens = safeInteger(raw.cacheReadTokens), cacheWriteTokens = safeInteger(raw.cacheWriteTokens), totalTokens = safeInteger(raw.totalTokens), compactionCount = safeInteger(raw.compactionCount), cost = number(raw.cost);
	if ([sampledAt, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, compactionCount].some((entry) => entry === undefined) || cost === undefined || cost < 0) return undefined;
	let contextUsage: NonNullable<RunLedgerStateSeed["metrics"]>["contextUsage"];
	if (raw.contextUsage !== undefined) { const context = asRecord(raw.contextUsage); if (!context || Object.keys(context).some((key) => !["tokens", "contextWindow", "percent"].includes(key)) || !Object.prototype.hasOwnProperty.call(context, "tokens") || !Object.prototype.hasOwnProperty.call(context, "contextWindow") || !Object.prototype.hasOwnProperty.call(context, "percent") || (context.tokens !== null && safeInteger(context.tokens) === undefined) || safeInteger(context.contextWindow) === undefined || (context.percent !== null && (number(context.percent) === undefined || (context.percent as number) < 0))) return undefined; contextUsage = { tokens: context.tokens as number | null, contextWindow: context.contextWindow as number, percent: context.percent as number | null }; }
	return { sampledAt: sampledAt!, inputTokens: inputTokens!, outputTokens: outputTokens!, cacheReadTokens: cacheReadTokens!, cacheWriteTokens: cacheWriteTokens!, totalTokens: totalTokens!, cost, ...(contextUsage ? { contextUsage } : {}), compactionCount: compactionCount! };
}

/** Private info is only a seed; malformed/old info must never prevent rendering. */
export function seedFromViewerInfo(path: string): RunLedgerStateSeed {
	let raw: Record<string, unknown> | undefined;
	try { raw = asRecord(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
	if (!raw) return {};
	const backend = string(raw.backend);
	return {
		runId: string(raw.id),
		title: string(raw.canonicalName) ?? string(raw.taskName),
		agentName: string(raw.canonicalName) ?? string(raw.taskName),
		backend,
		model: string(raw.model),
		thinking: string(raw.thinking),
		cwd: string(raw.cwd),
		task: string(raw.lastTaskMessage),
		runtimeState: string(raw.status),
		turn: number(raw.turn),
		startedAt: number(raw.startedAt) ?? number(raw.createdAt),
		metrics: backend === "pi" ? viewerMetrics(raw.metrics) : undefined,
	};
}

function fit(value: string, width: number): string {
	const points = Array.from(value);
	return points.length <= width ? value : width <= 1 ? "…" : `${points.slice(0, width - 1).join("")}…`;
}

/** Sanitized, bounded compatibility view for old raw .events.log files. */
export function renderLegacyRunLog(rawLogPath: string, width: number, height: number, reason?: string): string {
	const raw = readBoundedTail(rawLogPath, RAW_TAIL_BYTES);
	const lines = raw.replace(/\r/g, "").split("\n")
		.map((line) => sanitizeTerminalText(line, Math.max(1, width)))
		.filter(Boolean)
		.slice(-Math.max(0, Math.min(RAW_TAIL_LINES, height - 1)));
	const heading = fit(reason ? `Legacy event log · ${reason}` : "Legacy event log", Math.max(1, width));
	return [heading, ...lines].slice(0, Math.max(1, height)).join("\n") || "Legacy event log";
}

interface ViewerPresentation { plain: string; frame?: RunLedgerFrame; }

function viewerPresentation(options: ViewerFrameOptions): ViewerPresentation {
	const width = Math.max(1, Math.floor(options.width) || 1);
	const height = Math.max(1, Math.floor(options.height) || 1);
	const journal = readBoundedTail(options.journalPath, JOURNAL_TAIL_BYTES);
	const parsed = parseRunLedgerJsonl(journal, { maxBytes: JOURNAL_TAIL_BYTES, maxLines: JOURNAL_TAIL_LINES });
	if (!parsed.events.length) {
		const reason = !existsSync(options.journalPath) ? "journal unavailable" : parsed.malformed || parsed.unsupported ? "journal unavailable" : "waiting for ledger";
		return { plain: renderLegacyRunLog(options.rawLogPath, width, height, reason) };
	}
	const state = reduceRunLedgerEvents(parsed.events, createRunLedgerState(seedFromViewerInfo(options.infoPath)));
	const frame = renderRunLedger(state, { width, height, now: options.now ?? state.lastTs });
	return { plain: renderRunLedgerText(frame), frame };
}

/** Read a bounded journal tail, seed from info, and return a deterministic plain frame. */
export function renderViewerFrame(options: ViewerFrameOptions): string { return viewerPresentation(options).plain; }

const ANSI: Partial<Record<RunLedgerRole, string>> = {
	identity: "\x1b[1;37m", state: "\x1b[36m", elapsed: "\x1b[2m", turn: "\x1b[2m", muted: "\x1b[2m", task: "\x1b[37m",
	timestamp: "\x1b[2m", thought: "\x1b[35m", response: "\x1b[37m", tool: "\x1b[34m", success: "\x1b[32m", warning: "\x1b[33m", error: "\x1b[31m", completion: "\x1b[32m",
};

/** Apply a deliberately restrained role palette. NO_COLOR callers receive plain text. */
export function colorViewerFrame(plain: string, enabled = !process.env.NO_COLOR): string {
	if (!enabled) return plain;
	// Re-rendering roles from text would be lossy. This palette is used for the stable, semantic headers below.
	return plain.split("\n").map((line) => {
		const role: RunLedgerRole = /^Error/.test(line) ? "error" : /^Permission/.test(line) ? "warning" : /^Completed/.test(line) ? "completion" : /^RUN /.test(line) ? "identity" : /^\+.*(?:Thought)/.test(line) ? "thought" : /^\+.*(?:Tool)/.test(line) ? "tool" : /^\+.*(?:Response)/.test(line) ? "response" : "muted";
		return `${ANSI[role] ?? ""}${line}\x1b[0m`;
	}).join("\n");
}

function colorLedgerFrame(frame: RunLedgerFrame, enabled = !process.env.NO_COLOR): string {
	if (!enabled) return renderRunLedgerText(frame);
	return frame.lines.map((line) => line.tokens.map((token) => `${ANSI[token.role] ?? ""}${token.text}\x1b[0m`).join("")).join("\n");
}

export interface ViewerCliOptions extends RunLedgerViewerPaths { snapshot: boolean; width: number; height: number; }
export function parseViewerArgs(argv: readonly string[]): ViewerCliOptions {
	const values: Partial<ViewerCliOptions> = { snapshot: false, width: 100, height: 28 };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--snapshot") { values.snapshot = true; continue; }
		if (arg === "--info") values.infoPath = argv[++index];
		else if (arg === "--journal") values.journalPath = argv[++index];
		else if (arg === "--raw" || arg === "--log" || arg === "--legacy") values.rawLogPath = argv[++index];
		else if (arg === "--width") values.width = Number(argv[++index]);
		else if (arg === "--height") values.height = Number(argv[++index]);
	}
	if (!values.infoPath || !values.journalPath || !values.rawLogPath) throw new Error("Usage: run-ledger-viewer.ts --info PATH --journal PATH --raw PATH [--snapshot]");
	return { infoPath: values.infoPath, journalPath: values.journalPath, rawLogPath: values.rawLogPath, snapshot: !!values.snapshot, width: Math.max(1, Math.floor(values.width || 1)), height: Math.max(1, Math.floor(values.height || 1)) };
}

function isMain(): boolean {
	if (!process.argv[1]) return false;
	try { return pathToFileURL(resolve(process.argv[1])).href === import.meta.url; } catch { return false; }
}

export async function runViewerCli(argv = process.argv.slice(2)): Promise<void> {
	const options = parseViewerArgs(argv);
	const tty = !!process.stdout.isTTY && !options.snapshot;
	if (!tty) {
		process.stdout.write(`${renderViewerFrame(options)}\n`);
		return;
	}
	let restored = false;
	let previous = "";
	const restore = () => {
		if (restored) return;
		restored = true;
		process.stdout.write("\x1b[?25h\x1b[?1049l");
	};
	const draw = () => {
		const presentation = viewerPresentation({ ...options, width: process.stdout.columns || options.width, height: process.stdout.rows || options.height, now: Date.now() });
		if (presentation.plain === previous) return;
		previous = presentation.plain;
		const painted = presentation.frame ? colorLedgerFrame(presentation.frame) : colorViewerFrame(presentation.plain);
		process.stdout.write(`\x1b[H\x1b[2J${painted}\x1b[J`);
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	const exit = (code = 0) => { if (timer) clearInterval(timer); restore(); process.exit(code); };
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	process.on("SIGWINCH", draw);
	process.once("SIGINT", () => exit(130));
	process.once("SIGTERM", () => exit(143));
	process.once("exit", () => { if (timer) clearInterval(timer); restore(); });
	draw();
	timer = setInterval(draw, 225);
}

if (isMain()) {
	runViewerCli().catch((error) => {
		process.stderr.write(`Run Ledger viewer: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
