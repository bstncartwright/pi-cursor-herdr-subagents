import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { PiRuntimeAgent, PiSessionStats } from "./unified-deps.ts";
import { childEnvironment } from "./acp.ts";

const REQUEST_TIMEOUT_MS = 15_000;
/** Never expose child extension diagnostics through a runtime error or persisted projection. */
export const PI_EXTENSION_STARTUP_FAILURE = "Child Pi extension failed during startup.";
function statsNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function statsInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
function statsCount(value: unknown): boolean { return statsInteger(value) !== undefined; }
/** Strictly validate Pi's documented full stats response while retaining only numeric usage. */
export function parsePiSessionStats(value: unknown): PiSessionStats | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const allowed = ["sessionFile", "sessionId", "userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "tokens", "cost", "contextUsage"];
	if (Object.keys(raw).some((key) => !allowed.includes(key)) || typeof raw.sessionId !== "string" || !raw.sessionId || (raw.sessionFile !== undefined && typeof raw.sessionFile !== "string") || ![raw.userMessages, raw.assistantMessages, raw.toolCalls, raw.toolResults, raw.totalMessages].every(statsCount)) return undefined;
	if (!raw.tokens || typeof raw.tokens !== "object" || Array.isArray(raw.tokens)) return undefined;
	const tokens = raw.tokens as Record<string, unknown>;
	if (Object.keys(tokens).some((key) => !["input", "output", "cacheRead", "cacheWrite", "total"].includes(key))) return undefined;
	const inputTokens = statsInteger(tokens.input), outputTokens = statsInteger(tokens.output), cacheReadTokens = statsInteger(tokens.cacheRead), cacheWriteTokens = statsInteger(tokens.cacheWrite), totalTokens = statsInteger(tokens.total), cost = statsNumber(raw.cost);
	if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost].some((entry) => entry === undefined)) return undefined;
	let contextUsage: PiSessionStats["contextUsage"];
	if (raw.contextUsage !== undefined) {
		if (!raw.contextUsage || typeof raw.contextUsage !== "object" || Array.isArray(raw.contextUsage)) return undefined;
		const context = raw.contextUsage as Record<string, unknown>;
		if (Object.keys(context).some((key) => !["tokens", "contextWindow", "percent"].includes(key)) || !Object.prototype.hasOwnProperty.call(context, "tokens") || !Object.prototype.hasOwnProperty.call(context, "contextWindow") || !Object.prototype.hasOwnProperty.call(context, "percent")) return undefined;
		if ((context.tokens !== null && statsInteger(context.tokens) === undefined) || statsInteger(context.contextWindow) === undefined || (context.percent !== null && statsNumber(context.percent) === undefined)) return undefined;
		contextUsage = { tokens: context.tokens as number | null, contextWindow: context.contextWindow as number, percent: context.percent as number | null };
	}
	return { inputTokens: inputTokens!, outputTokens: outputTokens!, cacheReadTokens: cacheReadTokens!, cacheWriteTokens: cacheWriteTokens!, totalTokens: totalTokens!, cost: cost!, ...(contextUsage ? { contextUsage } : {}) };
}


export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		for (;;) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) break;
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		return lines;
	}
	end(): string[] {
		this.buffer += this.decoder.end();
		if (!this.buffer) return [];
		const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
		this.buffer = "";
		return [line];
	}
}


export type NormalizedBackendToolEvent =
	| { type: "tool_start"; id: string; name: string; input?: unknown }
	| { type: "tool_update"; id: string; status?: string; partialResult?: unknown }
	| { type: "tool_end"; id: string; status?: string; result?: unknown; isError?: boolean }
	| { type: "tool_observed"; phase: string };

function stableString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
function own(object: Record<string, unknown> | undefined, key: string): unknown {
	return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}
function compactionReason(value: unknown): "manual" | "threshold" | "overflow" | undefined { return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined; }
export type PiCompactionHint = { type: "compaction"; state: "started" | "completed" | "aborted" | "failed"; reason?: "manual" | "threshold" | "overflow"; tokensBefore?: number; estimatedTokensAfter?: number; willRetry?: boolean };
/** Extract the only safe compaction lifecycle fields from Pi RPC notifications. */
export function normalizePiCompactionEvent(value: unknown): PiCompactionHint | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>; const reason = compactionReason(event.reason);
	if (event.type === "auto_compaction_start" || event.type === "compaction_start") return { type: "compaction", state: "started", ...(reason ? { reason } : {}) };
	if (event.type !== "auto_compaction_end" && event.type !== "compaction_end") return undefined;
	const result = event.result && typeof event.result === "object" && !Array.isArray(event.result) ? event.result as Record<string, unknown> : undefined;
	const tokensBefore = statsInteger(result?.tokensBefore), estimatedTokensAfter = statsInteger(result?.estimatedTokensAfter);
	const validResult = !!result && tokensBefore !== undefined && estimatedTokensAfter !== undefined;
	const state = event.aborted === true || result?.aborted === true ? "aborted" : typeof event.errorMessage === "string" || typeof result?.errorMessage === "string" || !validResult ? "failed" : "completed";
	return { type: "compaction", state, ...(reason ? { reason } : {}), ...(tokensBefore === undefined ? {} : { tokensBefore }), ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }), ...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}) };
}

/** Preserve Pi RPC lifecycle fields verbatim until the journal boundary summarizes them. */
export function normalizePiRpcToolEvent(event: unknown): NormalizedBackendToolEvent | undefined {
	const raw = event && typeof event === "object" ? event as Record<string, unknown> : undefined;
	if (!raw) return undefined;
	const type = raw.type;
	if (type !== "tool_execution_start" && type !== "tool_execution_update" && type !== "tool_execution_end") return undefined;
	const id = stableString(raw.toolCallId);
	if (!id) return { type: "tool_observed", phase: "Observed Pi tool without stable id" };
	const name = stableString(raw.toolName) ?? "tool";
	if (type === "tool_execution_start") return { type: "tool_start", id, name, input: own(raw, "args") ?? own(raw, "arguments") ?? own(raw, "input") };
	if (type === "tool_execution_update") return { type: "tool_update", id, status: stableString(raw.status), partialResult: own(raw, "partialResult") };
	return { type: "tool_end", id, status: stableString(raw.status), result: own(raw, "result"), isError: raw.isError === true };
}


function resolveExecutable(name: string, override?: string): string {
	if (override?.trim()) return override.trim();
	const candidates = [
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
		join(homedir(), ".local", "bin", name),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

function piInvocation(): { command: string; prefix: string[] } {
	if (process.env.PI_SUBAGENT_PI_BIN) return { command: resolveExecutable("pi", process.env.PI_SUBAGENT_PI_BIN), prefix: [] };
	const entry = process.argv[1];
	if (entry && existsSync(entry)) return { command: process.execPath, prefix: [entry] };
	return { command: "pi", prefix: [] };
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n");
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class PiRpcClient {
	private readonly info: PiRuntimeAgent;
	private readonly onEvent: (event: any, turnToken?: string) => void;
	private activeTurnToken?: string;
	private readonly onExit: (error?: Error) => void;
	private readonly log: (category: string, message: string) => void;
	private proc?: ChildProcessWithoutNullStreams;
	private requests = new Map<string, PendingRequest>();
	private requestId = 0;
	private closed = false;
	private candidateResponse = "";
	private candidateError?: string;
	private startupInProgress = false;
	private startupFailure?: Error;
	private startupClose?: Promise<void>;

	constructor(info: PiRuntimeAgent, onEvent: (event: any, turnToken?: string) => void, onExit: (error?: Error) => void, log: (category: string, message: string) => void) {
		this.info = info;
		this.onEvent = onEvent;
		this.onExit = onExit;
		this.log = log;
	}

	async start(): Promise<void> {
		this.startupInProgress = true;
		const launch = piInvocation();
		const args = [
			...launch.prefix,
			"--mode", "rpc",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--provider", this.info.provider!,
			"--model", this.info.modelId!,
			"--session", this.info.sessionFile!,
		];
		if (this.info.thinking) args.push("--thinking", this.info.thinking);
		if (this.info.tools !== undefined) {
			if (this.info.tools.trim()) args.push("--tools", this.info.tools);
			else args.push("--no-builtin-tools");
		}
		for (const skill of this.info.skillPaths ?? []) args.push("--skill", skill);
		for (const extension of this.info.extensionPaths ?? []) args.push("--extension", extension);
		this.log("spawn", `${launch.command} ${args.join(" ")}`);
		this.proc = spawn(launch.command, args, { cwd: this.info.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: childEnvironment() });
		const decoder = new JsonlDecoder();
		this.proc.stdout.on("data", (chunk) => { for (const line of decoder.push(chunk)) this.handleLine(line); });
		this.proc.stdout.on("end", () => { for (const line of decoder.end()) this.handleLine(line); });
		this.proc.stderr.on("data", (chunk) => this.log("pi stderr", chunk.toString().trimEnd()));
		this.proc.on("error", (error) => this.finish(error));
		this.proc.on("exit", (code, signal) => this.finish(this.closed ? undefined : new Error(`Child Pi exited (${code ?? signal ?? "unknown"}).`)));
		try { await this.command({ type: "get_state" }); }
		catch (error) { if (this.startupFailure) await this.startupClose?.catch(() => undefined); throw error; }
		finally { this.startupInProgress = false; }
		if (this.startupFailure) throw this.startupFailure;
	}

	async getSessionStats(): Promise<PiSessionStats> {
		const parsed = parsePiSessionStats(await this.command({ type: "get_session_stats" }));
		if (!parsed) throw new Error("Child Pi returned malformed session stats.");
		return parsed;
	}

	async prompt(message: string, turnToken?: string): Promise<void> {
		this.activeTurnToken = turnToken;
		this.candidateResponse = "";
		this.candidateError = undefined;
		await this.command({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.command({ type: "steer", message });
	}

	async abort(): Promise<void> {
		if (!this.proc || this.closed) return;
		await this.command({ type: "abort" }, 2000).catch(() => undefined);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.abort();
		this.closed = true;
		const proc = this.proc;
		try { proc?.stdin.end(); } catch {}
		if (!proc || proc.exitCode != null) return;
		const exited = new Promise<void>((done) => proc.once("exit", () => done()));
		await Promise.race([exited, delay(500)]);
		if (proc.exitCode == null) this.signal("SIGTERM");
		await Promise.race([exited, delay(1000)]);
		if (proc.exitCode == null) this.signal("SIGKILL");
	}

	private signal(signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && this.proc?.pid) process.kill(-this.proc.pid, signal);
			else this.proc?.kill(signal);
		} catch { try { this.proc?.kill(signal); } catch {} }
	}

	private command(command: Record<string, unknown>, timeout = REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (!this.proc || this.closed) return Promise.reject(new Error("Child Pi process is unavailable."));
		const id = `req-${++this.requestId}`;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.requests.delete(id);
				rejectRequest(new Error(`Timed out waiting for child Pi ${String(command.type)}.`));
			}, timeout);
			this.requests.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
			this.proc!.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	}

	private extensionDiagnostic(event: Record<string, unknown>): string {
		return typeof event.error === "string" ? event.error : typeof event.message === "string" ? event.message : "extension error";
	}
	private failStartup(error: Error): void {
		if (this.startupFailure) return;
		this.startupFailure = error;
		this.startupInProgress = false;
		for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.requests.clear();
		this.startupClose = this.close().catch(() => undefined);
	}
	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try { event = JSON.parse(line); } catch { this.log("pi rpc", `invalid JSON: ${line.slice(0, 500)}`); return; }
		if (event.type === "extension_error") {
			// Raw child diagnostics belong only in the explicitly raw diagnostics log. They must
			// never become an Error message that reaches manifests, projections, or tool output.
			this.log("pi extension", this.extensionDiagnostic(event));
			if (this.startupInProgress) this.failStartup(new Error(PI_EXTENSION_STARTUP_FAILURE));
			return;
		}
		if (event.type === "response" && event.id) {
			const pending = this.requests.get(event.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.requests.delete(event.id);
			if (event.success) pending.resolve(event.data);
			else pending.reject(new Error(event.error || "Child Pi command failed."));
			return;
		}
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta") this.emit({ type: "text", text: delta.delta ?? "" });
			if (delta?.type === "thinking_delta") this.emit({ type: "thought", text: delta.delta ?? "" });
		}
		const toolEvent = normalizePiRpcToolEvent(event);
		if (toolEvent) this.emit(toolEvent);
		if (event.type === "auto_retry_start") this.emit({ type: "phase", phase: "Retrying" });
		const compaction = normalizePiCompactionEvent(event);
		if (compaction?.state === "started") this.emit({ type: "phase", phase: "Compacting" });
		if (compaction) this.emit(compaction);
		if (event.type === "message_end" && event.message?.role === "assistant") {
			this.emit({ type: "metrics_hint" });
			this.candidateResponse = messageText(event.message);
			this.candidateError = ["error", "aborted"].includes(event.message.stopReason)
				? event.message.errorMessage || `Pi subagent ended with ${event.message.stopReason}.`
				: undefined;
		}
		if (event.type === "agent_end") {
			const assistant = [...(event.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
			if (assistant) {
				this.candidateResponse = messageText(assistant);
				this.candidateError = ["error", "aborted"].includes(assistant.stopReason)
					? assistant.errorMessage || `Pi subagent ended with ${assistant.stopReason}.`
					: undefined;
			}
		}
		if (event.type === "auto_retry_end" && event.success === false) this.candidateError = event.finalError || "Pi retry failed.";
		if (event.type === "agent_settled") { this.emit({ type: "metrics_hint" }); this.emit({ type: "settled", output: this.candidateResponse, error: this.candidateError }); this.activeTurnToken = undefined; }
	}

	private emit(event: any): void { this.onEvent(event, this.activeTurnToken); }

	private finish(error?: Error): void {
		if (this.closed && !error) return;
		this.closed = true;
		for (const pending of this.requests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error ?? new Error("Child Pi process exited."));
		}
		this.requests.clear();
		this.onExit(error);
	}
}
