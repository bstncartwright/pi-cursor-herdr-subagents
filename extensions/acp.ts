import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;

export type CursorModel = "Auto" | "Grok 4.5 High";

export interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: any;
	result?: any;
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
}

export interface AcpHandlers {
	onNotification?: (message: JsonRpcMessage) => void;
	onRequest?: (message: JsonRpcMessage) => Promise<unknown> | unknown;
	onStderr?: (text: string) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface CursorAcpClientOptions extends AcpHandlers {
	/** Override the Cursor ACP executable. Defaults to `agent`. */
	agentCommand?: string;
	/** Override ACP argv after the command. Defaults to `["acp"]`. */
	agentArgs?: readonly string[];
	/** Base environment for the child process. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Per-request timeout in ms. Use `0` to disable. Defaults to 30000. */
	requestTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface StartedAcpSession {
	sessionId: string;
	model: CursorModel;
	configOptions: any[];
	agentCapabilities: Record<string, unknown>;
	loaded: boolean;
}

export interface StartAcpSessionOptions {
	sessionId?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const HERDR_ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_SOCKET_PATH",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
] as const;

/** Strip Herdr pane identity so Cursor's Herdr hook does not report against Pi's pane. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const key of HERDR_ENV_KEYS) {
		delete env[key];
	}
	return env;
}

export function findConfig(options: any[], id: string): any | undefined {
	return options.find((option) => option?.id === id);
}

export class CursorAcpClient {
	private readonly cwd: string;
	private readonly handlers: AcpHandlers;
	private readonly agentCommand: string;
	private readonly agentArgs: string[];
	private readonly env: NodeJS.ProcessEnv;
	private readonly requestTimeoutMs: number;
	private child?: ChildProcessWithoutNullStreams;
	private reader?: readline.Interface;
	private nextId = 1;
	private pending = new Map<number | string, PendingRequest>();
	private closed = false;
	private sessionId?: string;

	constructor(cwd: string, options: CursorAcpClientOptions = {}) {
		this.cwd = cwd;
		this.handlers = options;
		this.agentCommand = options.agentCommand ?? "agent";
		this.agentArgs = options.agentArgs ? [...options.agentArgs] : ["acp"];
		this.env = options.env ?? process.env;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get activeSessionId(): string | undefined {
		return this.sessionId;
	}

	get isAlive(): boolean {
		return !!this.child && this.child.exitCode == null && !this.closed;
	}

	async start(model: CursorModel, options: StartAcpSessionOptions = {}): Promise<StartedAcpSession> {
		if (this.child) throw new Error("Cursor ACP client is already started.");

		this.child = spawn(this.agentCommand, this.agentArgs, {
			cwd: this.cwd,
			env: childEnvironment(this.env),
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.reader = readline.createInterface({ input: this.child.stdout });
		this.reader.on("line", (line) => this.handleLine(line));
		this.child.stderr.on("data", (chunk) => this.handlers.onStderr?.(chunk.toString()));
		this.child.on("error", (error) => this.rejectAll(error));
		this.child.on("exit", (code, signal) => {
			this.closed = true;
			this.rejectAll(new Error(`Cursor ACP exited (${code ?? signal ?? "unknown"}).`));
			this.handlers.onExit?.(code, signal);
		});

		const initialized = await this.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				// Cursor extension capability. Without it, ACP advertises only a
				// single default variant per model, which forces Grok Fast.
				_meta: { parameterizedModelPicker: true },
			},
			clientInfo: {
				name: PACKAGE_NAME,
				title: "Pi BSTN Subagents",
				version: PACKAGE_VERSION,
			},
		});

		await this.request("authenticate", { methodId: "cursor_login" });
		const loaded = typeof options.sessionId === "string" && options.sessionId.length > 0;
		const created = loaded
			? await this.request("session/load", {
				cwd: this.cwd,
				mcpServers: [],
				sessionId: options.sessionId,
			})
			: await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
		const sessionId = loaded ? options.sessionId : created?.sessionId;
		if (typeof sessionId !== "string" || !sessionId) {
			throw new Error("Cursor ACP did not return a session id.");
		}
		this.sessionId = sessionId;

		let configOptions = created?.configOptions ?? [];
		if (model === "Auto") {
			configOptions = await this.setConfig("model", "default");
		} else {
			configOptions = await this.setConfig("model", "grok-4.5");
			configOptions = await this.setConfig("effort", "high");
			configOptions = await this.setConfig("fast", "false");

			const selectedModel = findConfig(configOptions, "model")?.currentValue;
			const selectedEffort = findConfig(configOptions, "effort")?.currentValue;
			const selectedFast = findConfig(configOptions, "fast")?.currentValue;
			if (selectedModel !== "grok-4.5" || selectedEffort !== "high" || selectedFast !== "false") {
				throw new Error(
					`Cursor ACP did not apply non-fast Grok High (model=${selectedModel}, effort=${selectedEffort}, fast=${selectedFast}).`,
				);
			}
		}

		return {
			sessionId,
			model,
			configOptions,
			agentCapabilities: initialized?.agentCapabilities ?? {},
			loaded,
		};
	}

	async prompt(text: string): Promise<{ stopReason?: string }> {
		if (!this.sessionId) throw new Error("Cursor ACP session is not initialized.");
		return this.request(
			"session/prompt",
			{
				sessionId: this.sessionId,
				prompt: [{ type: "text", text }],
			},
			0,
		);
	}

	cancel(): void {
		if (!this.sessionId || !this.isAlive) return;
		this.notify("session/cancel", { sessionId: this.sessionId });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.cancel();
		this.closed = true;
		this.reader?.close();
		this.child?.stdin.end();

		const child = this.child;
		if (!child || child.exitCode != null) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (child.exitCode == null) child.kill("SIGKILL");
				resolve();
			}, 1500);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private async setConfig(configId: string, value: string): Promise<any[]> {
		if (!this.sessionId) throw new Error("Cursor ACP session is not initialized.");
		const result = await this.request("session/set_config_option", {
			sessionId: this.sessionId,
			configId,
			value,
		});
		const configOptions = result?.configOptions ?? [];
		const current = findConfig(configOptions, configId)?.currentValue;
		if (current !== value) {
			throw new Error(`Cursor ACP rejected ${configId}=${value}; current value is ${String(current)}.`);
		}
		return configOptions;
	}

	private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<any> {
		if (!this.child || this.closed) return Promise.reject(new Error("Cursor ACP process is not running."));
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const pending: PendingRequest = { resolve, reject };
			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Timed out waiting for Cursor ACP ${method}.`));
				}, timeoutMs);
				pending.timer.unref?.();
			}
			this.pending.set(id, pending);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private respond(id: number | string, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	private respondError(id: number | string, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private write(message: JsonRpcMessage): void {
		if (!this.child || this.closed || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private handleLine(line: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			this.handlers.onStderr?.(`Invalid Cursor ACP JSON: ${line}\n`);
			return;
		}

		if (message.id !== undefined && !message.method) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (pending.timer) clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(
					new Error(
						`${message.error.message ?? "Cursor ACP error"}${message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""}`,
					),
				);
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (message.method && message.id !== undefined) {
			Promise.resolve(this.handlers.onRequest?.(message))
				.then((result) => this.respond(message.id!, result ?? {}))
				.catch((error) => this.respondError(message.id!, -32603, error?.message ?? String(error)));
			return;
		}

		if (message.method) this.handlers.onNotification?.(message);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
