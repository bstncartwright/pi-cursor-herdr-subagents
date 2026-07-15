import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	parseFrontmatter,
	truncateHead,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CursorAcpClient, PACKAGE_NAME, type CursorModel, type JsonRpcMessage } from "./acp.ts";
import {
	ALLOW_ONCE_IDS,
	cancelledPermissionResult,
	findPermissionOptionId,
	normalizePermissionMode,
	normalizePermissionOptions,
	redactPermissionPayload,
	rejectPermissionResult,
	resolveAgentPermissionDecision,
	resolveAutomaticPermission,
	restoreCursorConfigVerified,
	skippedAskQuestion,
	type PermissionMode,
} from "./helpers.ts";

const ROOT = join(getAgentDir(), PACKAGE_NAME);
const CONFIG_PATH = join(ROOT, "config.json");
const AGENTS_DIR = join(ROOT, "agents");
const DEFAULT_RUNS_DIR = join(ROOT, "runs");
const CURSOR_CONFIG_PATH = join(homedir(), ".cursor", "cli-config.json");
const MAX_AGENTS = 8;
const REQUEST_TIMEOUT_MS = 15_000;
const PERMISSION_TIMEOUT_MS = 120_000;
const PARENT_SOURCE = `${PACKAGE_NAME}:unified-parent`;
const FINAL = new Set<AgentStatus>(["completed", "failed", "interrupted", "closed"]);

export type AgentBackend = "pi" | "cursor";
export type AgentStatus = "starting" | "running" | "completed" | "failed" | "interrupted" | "closed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentTemplate {
	name: string;
	description?: string;
	hint?: string;
	backend?: AgentBackend;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string;
	skills?: string[];
	extensions?: string[];
	cursorModel?: CursorModel;
	permissionMode?: PermissionMode;
	prompt?: string;
}

export interface AgentInfo {
	id: string;
	taskName: string;
	canonicalName: string;
	backend: AgentBackend;
	parentSessionId: string;
	parentSessionFile?: string;
	agentType?: string;
	cwd: string;
	model: string;
	provider?: string;
	modelId?: string;
	thinking?: ThinkingLevel;
	tools?: string;
	skills?: string[];
	skillPaths?: string[];
	extensions?: string[];
	extensionPaths?: string[];
	cursorModel?: CursorModel;
	permissionMode?: PermissionMode;
	acpSessionId?: string;
	acpCapabilities?: Record<string, unknown>;
	sessionFile?: string;
	infoFile: string;
	logFile: string;
	responseFile: string;
	viewerPaneId?: string;
	viewerTabId?: string;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	closedAt?: number;
	lastActivity: number;
	turn: number;
	status: AgentStatus;
	lastTaskMessage?: string;
	finalResponse?: string;
	error?: string;
}

interface Config {
	storageDir?: string;
	defaults?: {
		skills?: string[];
		extensions?: string[];
	};
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
	id: string;
	summary: string;
	options: ReturnType<typeof normalizePermissionOptions>;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface RuntimeHandle {
	info: AgentInfo;
	kind: AgentBackend;
	pi?: PiRpcClient;
	cursor?: CursorAcpClient;
	pending: boolean;
	closing: boolean;
	generation: number;
	currentOutput: string;
	candidateError?: string;
	queuedCursorMessage?: string;
	pendingApprovals: Map<string, PendingApproval>;
}

interface MailEvent {
	id: string;
	parentSessionId: string;
	agentName: string;
	kind: "completion" | "permission";
	status: AgentStatus;
	finalResponse?: string;
	error?: string;
	approvalId?: string;
	summary?: string;
	allowOnceOffered?: boolean;
	createdAt: number;
}

interface Waiter {
	parentSessionId: string;
	targets?: Set<string>;
	resolve: (event: MailEvent) => void;
}

interface SpawnParams {
	task_name: string;
	message: string;
	backend: AgentBackend;
	agent_type?: string;
	skills?: string[];
	cwd?: string;
	cursor_model?: CursorModel;
	permission_mode?: PermissionMode;
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	try { chmodSync(path, 0o700); } catch {}
}

function writePrivate(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	try { chmodSync(path, 0o600); } catch {}
}

function atomicJson(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writePrivate(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
	try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function expandHome(value: string): string {
	return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function resolveSkillPath(value: string, cwd: string): string {
	const expanded = expandHome(value);
	if (isAbsolute(expanded) || expanded.startsWith(".")) {
		const candidate = resolve(cwd, expanded);
		if (existsSync(candidate)) return candidate;
		throw new Error(`Skill path not found: ${value}`);
	}
	const roots = [join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills")];
	let current = cwd;
	for (;;) {
		roots.push(join(current, CONFIG_DIR_NAME, "skills"), join(current, ".agents", "skills"));
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}
	for (const root of roots) {
		const directory = join(root, value);
		if (existsSync(join(directory, "SKILL.md"))) return directory;
		const markdown = join(root, `${value}.md`);
		if (existsSync(markdown)) return markdown;
	}
	throw new Error(`Skill not found: ${value}`);
}

function resolveExtensionPath(value: string, cwd: string): string {
	const expanded = expandHome(value);
	if (isAbsolute(expanded) || expanded.startsWith(".")) {
		const candidate = resolve(cwd, expanded);
		if (existsSync(candidate)) return candidate;
		throw new Error(`Extension path not found: ${value}`);
	}
	const candidates = [
		join(cwd, CONFIG_DIR_NAME, "npm", "node_modules", value),
		join(getAgentDir(), "npm", "node_modules", value),
	];
	const candidate = candidates.find(existsSync);
	if (!candidate) throw new Error(`Installed extension package not found: ${value}. Install it with pi install first.`);
	return candidate;
}

function runsDir(): string {
	const config = readJson<Config>(CONFIG_PATH);
	if (!config?.storageDir?.trim()) return DEFAULT_RUNS_DIR;
	const expanded = expandHome(config.storageDir.trim());
	return isAbsolute(expanded) ? expanded : resolve(ROOT, expanded);
}

export function parentScopeKey(parentSessionId: string): string {
	return createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24);
}

export function taskStorageKey(taskName: string): string {
	return createHash("sha256").update(taskName).digest("hex").slice(0, 24);
}

function scopeDir(parentSessionId: string): string {
	return join(runsDir(), parentScopeKey(parentSessionId));
}

export function normalizeTaskName(value: string): string {
	const name = value.trim().replace(/^\/+|\/+$/g, "");
	if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(name)) {
		throw new Error("task_name must use letters, digits, underscores, dashes, and optional slash separators.");
	}
	return name;
}

function stringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const result = raw.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
	return result.length ? [...new Set(result)] : undefined;
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
		? value as ThinkingLevel
		: undefined;
}

export function parseAgentTemplateText(text: string, fallbackName: string): AgentTemplate {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const backend = frontmatter.backend === "pi" || frontmatter.backend === "cursor" ? frontmatter.backend : undefined;
	const cursorModel = frontmatter.cursor_model === "Auto" || frontmatter.cursor_model === "Grok 4.5 High"
		? frontmatter.cursor_model
		: undefined;
	const permissionMode = ["agent", "prompt", "allow-once", "deny"].includes(String(frontmatter.permission_mode))
		? normalizePermissionMode(frontmatter.permission_mode)
		: undefined;
	return {
		name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		hint: typeof frontmatter.hint === "string" ? frontmatter.hint : undefined,
		backend,
		provider: typeof frontmatter.provider === "string" ? frontmatter.provider : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: thinkingLevel(frontmatter.thinking),
		tools: typeof frontmatter.tools === "string" ? frontmatter.tools : undefined,
		skills: stringList(frontmatter.skills),
		extensions: stringList(frontmatter.extensions),
		cursorModel,
		permissionMode,
		prompt: body.trim() || undefined,
	};
}

export function listAgentTemplates(): AgentTemplate[] {
	ensureDir(AGENTS_DIR);
	return readdirSync(AGENTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.flatMap((name) => {
			try { return [parseAgentTemplateText(readFileSync(join(AGENTS_DIR, name), "utf8"), name.slice(0, -3))]; }
			catch { return []; }
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function templatesDescription(): string {
	const templates = listAgentTemplates();
	if (!templates.length) return `No templates found. Add Markdown templates to ${AGENTS_DIR}.`;
	return templates.map((template) => {
		let line = `- \`${template.name}\`${template.backend ? ` [${template.backend}]` : ""}${template.description ? ` — ${template.description}` : ""}`;
		if (template.hint) line += `\n  Caller hint: ${template.hint}`;
		return line;
	}).join("\n");
}

function saveInfo(info: AgentInfo): void {
	info.updatedAt = Date.now();
	ensureDir(resolve(info.infoFile, ".."));
	atomicJson(info.infoFile, info);
}

function readScope(parentSessionId: string): AgentInfo[] {
	const dir = scopeDir(parentSessionId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".info.json"))
		.flatMap((name) => {
			const info = readJson<AgentInfo>(join(dir, name));
			return info ? [info] : [];
		})
		.sort((a, b) => b.lastActivity - a.lastActivity);
}

function readAll(): AgentInfo[] {
	const root = runsDir();
	if (!existsSync(root)) return [];
	const result: AgentInfo[] = [];
	for (const scope of readdirSync(root, { withFileTypes: true })) {
		if (!scope.isDirectory() || scope.name === "_outputs") continue;
		for (const name of readdirSync(join(root, scope.name))) {
			if (!name.endsWith(".info.json")) continue;
			const info = readJson<AgentInfo>(join(root, scope.name, name));
			if (info) result.push(info);
		}
	}
	return result.sort((a, b) => b.lastActivity - a.lastActivity);
}

function log(info: AgentInfo, category: string, message: string): void {
	ensureDir(resolve(info.logFile, ".."));
	for (const line of String(message).replace(/\r/g, "").split("\n")) {
		appendFileSync(info.logFile, `[${new Date().toISOString()}] ${category}: ${line}\n`, "utf8");
	}
}

function boundedResult(text: string, info: AgentInfo): { text: string; truncated: boolean; fullOutputPath?: string } {
	const result = truncateHead(text || "(no final response)", { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!result.truncated) return { text: result.content, truncated: false };
	writePrivate(info.responseFile, text);
	return {
		text: `${result.content}\n\n[Output truncated: ${result.outputLines}/${result.totalLines} lines, ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Full response: ${info.responseFile}]`,
		truncated: true,
		fullOutputPath: info.responseFile,
	};
}

function contentText(content: unknown): string {
	if (!content || typeof content !== "object") return "";
	const value = content as { type?: unknown; text?: unknown };
	return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function messageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n\n");
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

function piInvocation(): { command: string; prefix: string[] } {
	if (process.env.PI_SUBAGENT_PI_BIN) return { command: process.env.PI_SUBAGENT_PI_BIN, prefix: [] };
	const entry = process.argv[1];
	if (entry && existsSync(entry)) return { command: process.execPath, prefix: [entry] };
	return { command: "pi", prefix: [] };
}

class PiRpcClient {
	private readonly info: AgentInfo;
	private readonly onEvent: (event: any) => void;
	private readonly onExit: (error?: Error) => void;
	private proc?: ChildProcessWithoutNullStreams;
	private requests = new Map<string, PendingRequest>();
	private requestId = 0;
	private closed = false;
	private candidateResponse = "";
	private candidateError?: string;

	constructor(info: AgentInfo, onEvent: (event: any) => void, onExit: (error?: Error) => void) {
		this.info = info;
		this.onEvent = onEvent;
		this.onExit = onExit;
	}

	async start(): Promise<void> {
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
		log(this.info, "spawn", `${launch.command} ${args.join(" ")}`);
		this.proc = spawn(launch.command, args, { cwd: this.info.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		const decoder = new JsonlDecoder();
		this.proc.stdout.on("data", (chunk) => { for (const line of decoder.push(chunk)) this.handleLine(line); });
		this.proc.stdout.on("end", () => { for (const line of decoder.end()) this.handleLine(line); });
		this.proc.stderr.on("data", (chunk) => log(this.info, "pi stderr", chunk.toString().trimEnd()));
		this.proc.on("error", (error) => this.finish(error));
		this.proc.on("exit", (code, signal) => this.finish(this.closed ? undefined : new Error(`Child Pi exited (${code ?? signal ?? "unknown"}).`)));
		await this.command({ type: "get_state" });
	}

	async prompt(message: string): Promise<void> {
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

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: any;
		try { event = JSON.parse(line); } catch { log(this.info, "pi rpc", `invalid JSON: ${line.slice(0, 500)}`); return; }
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
			if (delta?.type === "text_delta") this.onEvent({ type: "text", text: delta.delta ?? "" });
			if (delta?.type === "thinking_delta") this.onEvent({ type: "thought", text: delta.delta ?? "" });
		}
		if (event.type === "tool_execution_start") this.onEvent({ type: "tool", name: event.toolName ?? "tool" });
		if (event.type === "message_end" && event.message?.role === "assistant") {
			this.candidateResponse = messageText(event.message).trim();
			this.candidateError = ["error", "aborted"].includes(event.message.stopReason)
				? event.message.errorMessage || `Pi subagent ended with ${event.message.stopReason}.`
				: undefined;
		}
		if (event.type === "agent_end") {
			const assistant = [...(event.messages ?? [])].reverse().find((message: any) => message?.role === "assistant");
			if (assistant) {
				this.candidateResponse = messageText(assistant).trim();
				this.candidateError = ["error", "aborted"].includes(assistant.stopReason)
					? assistant.errorMessage || `Pi subagent ended with ${assistant.stopReason}.`
					: undefined;
			}
		}
		if (event.type === "auto_retry_end" && event.success === false) this.candidateError = event.finalError || "Pi retry failed.";
		if (event.type === "agent_settled") this.onEvent({ type: "settled", output: this.candidateResponse, error: this.candidateError });
	}

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

class UnifiedManager {
	private readonly pi: ExtensionAPI;
	private readonly live = new Map<string, RuntimeHandle>();
	private readonly mailbox: MailEvent[] = [];
	private waiters: Waiter[] = [];
	private readonly defaultWaitTargets = new Map<string, Set<string>>();
	private ctx?: ExtensionContext;
	private parentSeq = Date.now() * 1000;
	private parentWorking = false;
	private parentQueue = Promise.resolve();
	private cursorConfigQueue = Promise.resolve();
	private widgetTimer?: ReturnType<typeof setInterval>;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		ensureDir(ROOT);
		ensureDir(AGENTS_DIR);
		ensureDir(runsDir());
	}

	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.updateWidget();
		if (!this.widgetTimer) {
			this.widgetTimer = setInterval(() => this.updateWidget(), 1000);
			this.widgetTimer.unref?.();
		}
	}

	parentSessionId(ctx: ExtensionContext | ExtensionCommandContext): string {
		const id = ctx.sessionManager.getSessionId?.();
		if (!id) throw new Error("The parent Pi session has no persistent session id.");
		return String(id);
	}

	list(parentSessionId: string, includeAll = false, pathPrefix?: string): AgentInfo[] {
		const prefix = pathPrefix?.trim().replace(/^\/+/, "");
		return (includeAll ? readAll() : readScope(parentSessionId)).filter((info) => !prefix || info.taskName.startsWith(prefix));
	}

	get(target: string, parentSessionId: string): AgentInfo {
		const name = normalizeTaskName(target);
		const info = readScope(parentSessionId).find((entry) => entry.taskName === name);
		if (!info) throw new Error(`Agent not found in this parent session: /${name}`);
		return this.live.get(info.id)?.info ?? info;
	}

	async spawn(params: SpawnParams, ctx: ExtensionContext): Promise<AgentInfo> {
		await this.ensurePrerequisites(params.backend);
		const parentSessionId = this.parentSessionId(ctx);
		if (readScope(parentSessionId).filter((info) => info.status !== "closed").length >= MAX_AGENTS) {
			throw new Error(`At most ${MAX_AGENTS} open agents are allowed per parent session.`);
		}
		const taskName = normalizeTaskName(params.task_name);
		const template = params.agent_type ? listAgentTemplates().find((entry) => entry.name === params.agent_type) : undefined;
		if (params.agent_type && !template) throw new Error(`Agent template not found: ${params.agent_type}`);
		if (template?.backend && template.backend !== params.backend) {
			throw new Error(`Template ${template.name} requires backend=${template.backend}, but spawn_agent received backend=${params.backend}.`);
		}
		const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
		if (!statSync(cwd).isDirectory()) throw new Error(`Agent cwd is not a directory: ${cwd}`);
		const dir = scopeDir(parentSessionId);
		ensureDir(dir);
		const lockPath = join(dir, `.task-${taskStorageKey(taskName)}.lock`);
		let lock: number | undefined;
		try {
			try { lock = openSync(lockPath, "wx", 0o600); }
			catch (error: any) {
				if (error?.code === "EEXIST") throw new Error(`Agent /${taskName} is already being created.`);
				throw error;
			}
			if (readScope(parentSessionId).some((info) => info.taskName === taskName)) {
				throw new Error(`Agent /${taskName} already exists in this parent session. Use another task_name.`);
			}
			const id = randomUUID();
			const prefix = join(dir, id);
			const now = Date.now();
			const currentModel = ctx.model;
			if (params.backend === "pi" && (!currentModel?.provider || !currentModel?.id)) {
				throw new Error("Pi backend requires an active parent provider/model.");
			}
			const provider = template?.provider && template.model ? template.provider : currentModel?.provider;
			const modelId = template?.provider && template.model ? template.model : currentModel?.id;
			const cursorModel = params.cursor_model ?? template?.cursorModel ?? "Auto";
			const config = readJson<Config>(CONFIG_PATH) ?? {};
			const configuredSkills = params.backend === "pi" ? template?.skills ?? stringList(config.defaults?.skills) : undefined;
			const configuredExtensions = params.backend === "pi" ? template?.extensions ?? stringList(config.defaults?.extensions) : undefined;
			const selectedSkills = params.backend === "pi" ? [...new Set([...(configuredSkills ?? []), ...(params.skills ?? [])])] : [];
			const info: AgentInfo = {
				id,
				taskName,
				canonicalName: `/${taskName}`,
				backend: params.backend,
				parentSessionId,
				parentSessionFile: ctx.sessionManager.getSessionFile?.(),
				agentType: params.agent_type,
				cwd,
				model: params.backend === "pi" ? `${provider}:${modelId}` : cursorModel,
				provider,
				modelId,
				thinking: template?.thinking ?? (this.pi.getThinkingLevel() as ThinkingLevel),
				tools: template?.tools ?? (params.backend === "pi" ? this.pi.getActiveTools().join(",") : undefined),
				skills: selectedSkills,
				skillPaths: selectedSkills.map((skill) => resolveSkillPath(skill, cwd)),
				extensions: configuredExtensions,
				extensionPaths: configuredExtensions?.map((extension) => resolveExtensionPath(extension, cwd)),
				cursorModel,
				permissionMode: normalizePermissionMode(params.permission_mode ?? template?.permissionMode),
				sessionFile: params.backend === "pi" ? `${prefix}.session.jsonl` : undefined,
				infoFile: `${prefix}.info.json`,
				logFile: `${prefix}.events.log`,
				responseFile: `${prefix}.response.txt`,
				createdAt: now,
				updatedAt: now,
				startedAt: now,
				lastActivity: now,
				turn: 0,
				status: "starting",
				lastTaskMessage: params.message,
			};
			writePrivate(info.logFile, `${params.backend.toUpperCase()} subagent ${info.canonicalName}\nCwd: ${cwd}\nModel: ${info.model}\n\n`);
			saveInfo(info);
			try {
				const viewer = await this.createViewer(info);
				info.viewerPaneId = viewer.paneId;
				info.viewerTabId = viewer.tabId;
				saveInfo(info);
				await this.startRuntime(info);
				const prompt = [template?.prompt, params.message].filter(Boolean).join("\n\n");
				await this.beginPrompt(info, prompt, params.message);
				const targets = this.defaultWaitTargets.get(parentSessionId) ?? new Set<string>();
				targets.add(info.canonicalName);
				this.defaultWaitTargets.set(parentSessionId, targets);
				return info;
			} catch (error) {
				info.status = "failed";
				info.error = error instanceof Error ? error.message : String(error);
				info.completedAt = Date.now();
				info.lastActivity = Date.now();
				saveInfo(info);
				await this.closeLive(info.id, false).catch(() => undefined);
				await this.closeViewer(info).catch(() => undefined);
				throw error;
			}
		} finally {
			if (lock !== undefined) closeSync(lock);
			try { unlinkSync(lockPath); } catch {}
		}
	}

	async send(parentSessionId: string, target: string, message: string): Promise<{ delivery: "steer" | "cancel-and-prompt" | "prompt" }> {
		const info = this.get(target, parentSessionId);
		if (info.status === "closed") throw new Error(`Agent is closed: ${info.canonicalName}`);
		let live = this.live.get(info.id);
		const wasLive = Boolean(live);
		if (!live) {
			if (info.status === "starting" || info.status === "running") {
				info.status = "interrupted";
				info.completedAt = Date.now();
				saveInfo(info);
			}
			live = await this.startRuntime(info);
		}
		if (wasLive && live.pending) {
			info.lastTaskMessage = message;
			info.lastActivity = Date.now();
			saveInfo(info);
			if (info.backend === "pi") {
				await live.pi!.steer(message);
				log(info, "steer", message);
				return { delivery: "steer" };
			}
			if (live.queuedCursorMessage) throw new Error(`Cursor agent ${info.canonicalName} already has a corrective message queued.`);
			live.queuedCursorMessage = message;
			this.rejectApprovals(live, true, "active Cursor turn interrupted");
			live.cursor!.cancel();
			log(info, "steer", `cancel-and-prompt: ${message}`);
			return { delivery: "cancel-and-prompt" };
		}
		await this.beginPrompt(info, message, message);
		const targets = this.defaultWaitTargets.get(parentSessionId) ?? new Set<string>();
		targets.add(info.canonicalName);
		this.defaultWaitTargets.set(parentSessionId, targets);
		return { delivery: "prompt" };
	}

	async interrupt(parentSessionId: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parentSessionId);
		const previous = info.status;
		if (previous !== "starting" && previous !== "running") return previous;
		const live = this.live.get(info.id);
		if (live) {
			live.generation++;
			live.pending = false;
			this.rejectApprovals(live, true, "agent interrupted");
			if (live.kind === "pi") await live.pi!.abort();
			else live.cursor!.cancel();
		}
		info.status = "interrupted";
		info.completedAt = Date.now();
		info.lastActivity = Date.now();
		saveInfo(info);
		this.pushMail(this.completionEvent(info));
		this.refresh();
		return previous;
	}

	async close(parentSessionId: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parentSessionId);
		const previous = info.status;
		if (previous === "closed") return previous;
		info.status = "closed";
		info.closedAt = Date.now();
		info.lastActivity = Date.now();
		saveInfo(info);
		await this.closeLive(info.id, true);
		await this.closeViewer(info).catch(() => undefined);
		this.pushMail(this.completionEvent(info));
		this.refresh();
		return previous;
	}

	respondPermission(parentSessionId: string, target: string, approvalId: string, decision: "approve" | "reject"): void {
		const info = this.get(target, parentSessionId);
		const live = this.live.get(info.id);
		const pending = live?.pendingApprovals.get(approvalId);
		if (!live || !pending) throw new Error(`No pending approval ${JSON.stringify(approvalId)} for ${info.canonicalName}.`);
		const result = resolveAgentPermissionDecision(decision, pending.options);
		clearTimeout(pending.timer);
		live.pendingApprovals.delete(approvalId);
		pending.resolve(result);
		log(info, "permission", `${approvalId} ${decision === "approve" ? "approved once" : "rejected"}`);
	}

	readResponse(parentSessionId: string, target: string): { info: AgentInfo; response: string } {
		const info = this.get(target, parentSessionId);
		const stored = FINAL.has(info.status) && existsSync(info.responseFile) ? readFileSync(info.responseFile, "utf8") : "";
		return { info, response: info.finalResponse ?? stored };
	}

	async waitAgent(parentSessionId: string, targets: string[] | undefined, signal?: AbortSignal): Promise<MailEvent> {
		const normalized = targets?.length ? new Set(targets.map((target) => `/${normalizeTaskName(target)}`)) : undefined;
		const existingIndex = this.mailbox.findIndex((event) => event.parentSessionId === parentSessionId && (!normalized || normalized.has(event.agentName)));
		if (existingIndex >= 0) return this.mailbox.splice(existingIndex, 1)[0]!;
		if (normalized) {
			const infos = readScope(parentSessionId).filter((info) => normalized.has(info.canonicalName));
			if (!infos.length) throw new Error(`No matching agents in this parent session: ${[...normalized].join(", ")}`);
			const final = infos.find((info) => FINAL.has(info.status));
			if (final) return this.completionEvent(final);
		}
		if (signal?.aborted) throw signal.reason;
		return new Promise((resolveWait, rejectWait) => {
			let waiter!: Waiter;
			const onAbort = () => {
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				rejectWait(signal?.reason instanceof Error ? signal.reason : new Error("Wait cancelled."));
			};
			waiter = { parentSessionId, targets: normalized, resolve: (event) => {
				signal?.removeEventListener("abort", onAbort);
				resolveWait(event);
			} };
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async waitAll(parentSessionId: string, targets: string[] | undefined, signal?: AbortSignal): Promise<{ infos?: AgentInfo[]; event?: MailEvent }> {
		const names = targets?.length
			? new Set(targets.map((target) => `/${normalizeTaskName(target)}`))
			: new Set(this.defaultWaitTargets.get(parentSessionId) ?? []);
		if (targets?.length) {
			const known = readScope(parentSessionId);
			const missing = [...names].filter((name) => !known.some((info) => info.canonicalName === name));
			if (missing.length) throw new Error(`Agent not found in this parent session: ${missing.join(", ")}`);
		}
		for (;;) {
			if (signal?.aborted) throw signal.reason;
			const permissionIndex = this.mailbox.findIndex((event) => event.kind === "permission" && event.parentSessionId === parentSessionId && names.has(event.agentName));
			if (permissionIndex >= 0) return { event: this.mailbox.splice(permissionIndex, 1)[0]! };
			const infos = readScope(parentSessionId).filter((info) => names.has(info.canonicalName));
			if (infos.every((info) => FINAL.has(info.status))) {
				for (const info of infos) this.defaultWaitTargets.get(parentSessionId)?.delete(info.canonicalName);
				for (let index = this.mailbox.length - 1; index >= 0; index--) {
					const event = this.mailbox[index]!;
					if (event.parentSessionId === parentSessionId && names.has(event.agentName) && event.kind === "completion") this.mailbox.splice(index, 1);
				}
				return { infos };
			}
			await delay(250, undefined, signal ? { signal } : undefined);
		}
	}

	async shutdown(): Promise<void> {
		if (this.widgetTimer) clearInterval(this.widgetTimer);
		this.widgetTimer = undefined;
		this.ctx?.ui.setWidget(`${PACKAGE_NAME}:agents`, undefined);
		const lives = [...this.live.values()];
		for (const live of lives) {
			if (live.info.status === "starting" || live.info.status === "running") {
				live.info.status = "interrupted";
				live.info.completedAt = Date.now();
				live.info.lastActivity = Date.now();
				saveInfo(live.info);
			}
		}
		await Promise.allSettled(lives.map((live) => this.closeLive(live.info.id, true)));
		await Promise.allSettled(lives.map((live) => this.closeViewer(live.info)));
		this.waiters = [];
		this.ctx = undefined;
		this.parentWorking = true;
		this.reportParent(false, true);
	}

	reassertParent(): void {
		if (![...this.live.values()].some((live) => live.pending)) return;
		const timer = setTimeout(() => this.reportParent(true, true), 500);
		timer.unref?.();
	}

	private async ensurePrerequisites(backend: AgentBackend): Promise<void> {
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
			throw new Error("Subagents require Pi to run inside a Herdr workspace.");
		}
		const commands: Array<[string, string[]]> = [["herdr", ["--version"]]];
		if (backend === "cursor") commands.push(["agent", ["--version"]]);
		else commands.push([piInvocation().command, ["--version"]]);
		for (const [command, args] of commands) {
			const result = await this.pi.exec(command, args, { timeout: 5000 });
			if (result.code !== 0) throw new Error((result.stderr || `${command} is unavailable`).trim());
		}
	}

	private async createViewer(info: AgentInfo): Promise<{ paneId: string; tabId: string }> {
		const result = await this.pi.exec("herdr", [
			"tab", "create",
			"--workspace", process.env.HERDR_WORKSPACE_ID!,
			"--cwd", info.cwd,
			"--label", `${info.taskName} [${info.backend}]`,
			"--no-focus",
		], { timeout: 5000 });
		if (result.code !== 0) throw new Error((result.stderr || result.stdout || "herdr tab create failed").trim());
		let parsed: any;
		try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`Unexpected Herdr output: ${result.stdout.trim()}`); }
		const paneId = parsed.result?.root_pane?.pane_id;
		const tabId = parsed.result?.tab?.tab_id ?? parsed.result?.root_pane?.tab_id;
		if (!paneId || !tabId) throw new Error("Herdr did not return viewer pane/tab ids.");
		const tail = await this.pi.exec("herdr", ["pane", "run", paneId, `tail -n 200 -F '${info.logFile.replace(/'/g, `'\\''`)}'`], { timeout: 5000 });
		if (tail.code !== 0) throw new Error((tail.stderr || "Could not start Herdr viewer").trim());
		return { paneId, tabId };
	}

	private async closeViewer(info: AgentInfo): Promise<void> {
		const tabId = info.viewerTabId;
		const paneId = info.viewerPaneId;
		delete info.viewerTabId;
		delete info.viewerPaneId;
		saveInfo(info);
		if (tabId) {
			const result = await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 5000 });
			if (result.code === 0) return;
		}
		if (paneId) await this.pi.exec("herdr", ["pane", "close", paneId], { timeout: 5000 });
	}

	private async startRuntime(info: AgentInfo): Promise<RuntimeHandle> {
		const existing = this.live.get(info.id);
		if (existing) return existing;
		if (info.backend === "cursor" && info.acpSessionId && info.acpCapabilities?.loadSession !== true) {
			throw new Error(`Cursor ACP session ${info.acpSessionId} cannot reconnect because loadSession was not advertised.`);
		}
		if (!info.viewerPaneId || !info.viewerTabId) {
			const viewer = await this.createViewer(info);
			info.viewerPaneId = viewer.paneId;
			info.viewerTabId = viewer.tabId;
			saveInfo(info);
		}
		const live: RuntimeHandle = {
			info,
			kind: info.backend,
			pending: false,
			closing: false,
			generation: 0,
			currentOutput: "",
			pendingApprovals: new Map(),
		};
		this.live.set(info.id, live);
		try {
			if (info.backend === "pi") {
				live.pi = new PiRpcClient(
					info,
					(event) => this.handlePiEvent(live, event),
					(error) => this.handleRuntimeExit(live, error),
				);
				await live.pi.start();
			} else {
				live.cursor = new CursorAcpClient(info.cwd, {
					onNotification: (message) => this.handleCursorNotification(live, message),
					onRequest: (message) => this.handleCursorRequest(live, message),
					onStderr: (text) => log(info, "cursor stderr", text.trimEnd()),
					onExit: (code, signal) => this.handleRuntimeExit(live, new Error(`Cursor ACP exited (${code ?? signal ?? "unknown"}).`)),
				});
				const started = await this.withCursorConfig(() => live.cursor!.start(info.cursorModel ?? "Auto", { sessionId: info.acpSessionId }));
				info.acpSessionId = started.sessionId;
				info.acpCapabilities = started.agentCapabilities;
				log(info, "ACP", `${started.loaded ? "loaded" : "created"} ${started.sessionId}`);
				saveInfo(info);
			}
			this.refresh();
			return live;
		} catch (error) {
			this.live.delete(info.id);
			await live.pi?.close().catch(() => undefined);
			await live.cursor?.close().catch(() => undefined);
			await this.closeViewer(info).catch(() => undefined);
			throw error;
		}
	}

	private async withCursorConfig<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.cursorConfigQueue;
		let release!: () => void;
		this.cursorConfigQueue = new Promise<void>((done) => { release = done; });
		await previous;
		const existed = existsSync(CURSOR_CONFIG_PATH);
		const original = existed ? readFileSync(CURSOR_CONFIG_PATH, "utf8") : undefined;
		try { return await operation(); }
		finally {
			await restoreCursorConfigVerified({
				path: CURSOR_CONFIG_PATH,
				existedBefore: existed,
				originalContent: original,
				fs: {
					exists: existsSync,
					read: (path) => readFileSync(path, "utf8"),
					write: (path, content) => writeFileSync(path, content, "utf8"),
					unlink: unlinkSync,
				},
			}).finally(release);
		}
	}

	private async beginPrompt(info: AgentInfo, prompt: string, displayMessage: string): Promise<void> {
		const live = this.live.get(info.id) ?? await this.startRuntime(info);
		if (live.pending) throw new Error(`Agent ${info.canonicalName} is already running.`);
		live.pending = true;
		live.generation++;
		live.currentOutput = "";
		live.candidateError = undefined;
		const generation = live.generation;
		info.status = "running";
		info.turn++;
		info.lastTaskMessage = displayMessage;
		info.lastActivity = Date.now();
		delete info.finalResponse;
		delete info.error;
		delete info.completedAt;
		try { unlinkSync(info.responseFile); } catch {}
		saveInfo(info);
		log(info, "user", displayMessage);
		this.refresh();
		if (info.backend === "pi") {
			try { await live.pi!.prompt(prompt); }
			catch (error) { if (live.generation === generation) this.finalize(live, "failed", "", error instanceof Error ? error.message : String(error)); throw error; }
			return;
		}
		void live.cursor!.prompt(prompt).then((result) => {
			if (live.closing || live.generation !== generation) return;
			if (live.queuedCursorMessage) {
				const next = live.queuedCursorMessage;
				live.queuedCursorMessage = undefined;
				live.pending = false;
				void this.beginPrompt(info, next, next).catch((error) => this.finalize(live, "failed", "", error instanceof Error ? error.message : String(error)));
				return;
			}
			this.finalize(live, live.candidateError ? "failed" : "completed", live.currentOutput, live.candidateError ?? (result.stopReason === "error" ? "Cursor prompt failed." : undefined));
		}).catch((error) => {
			if (live.closing || live.generation !== generation) return;
			if (live.queuedCursorMessage) {
				const next = live.queuedCursorMessage;
				live.queuedCursorMessage = undefined;
				live.pending = false;
				void this.beginPrompt(info, next, next).catch((nextError) => this.finalize(live, "failed", "", nextError instanceof Error ? nextError.message : String(nextError)));
				return;
			}
			this.finalize(live, "failed", live.currentOutput, error instanceof Error ? error.message : String(error));
		});
	}

	private handlePiEvent(live: RuntimeHandle, event: any): void {
		if (live.closing) return;
		if (event.type === "text") {
			live.currentOutput += event.text;
			log(live.info, "assistant", event.text);
		} else if (event.type === "thought") {
			log(live.info, "thought", event.text);
		} else if (event.type === "tool") {
			log(live.info, "tool", event.name);
		} else if (event.type === "settled" && live.pending) {
			this.finalize(live, event.error ? "failed" : "completed", event.output ?? live.currentOutput, event.error);
		}
		live.info.lastActivity = Date.now();
		saveInfo(live.info);
	}

	private handleCursorNotification(live: RuntimeHandle, message: JsonRpcMessage): void {
		if (message.method === "session/update") {
			const update = message.params?.update;
			const kind = update?.sessionUpdate;
			if (kind === "agent_message_chunk") {
				const text = contentText(update.content);
				live.currentOutput += text;
				log(live.info, "assistant", text);
			} else if (kind === "agent_thought_chunk") {
				log(live.info, "thought", contentText(update.content));
			} else if (kind === "tool_call" || kind === "tool_call_update") {
				log(live.info, "tool", update.title ?? update.toolCall?.title ?? update.toolCall?.name ?? "tool");
			} else if (kind) log(live.info, kind, JSON.stringify(update).slice(0, 2000));
		} else if (message.method === "cursor/update_todos") {
			log(live.info, "todos", JSON.stringify(message.params?.todos ?? []).slice(0, 2000));
		} else log(live.info, message.method ?? "notification", JSON.stringify(message.params ?? {}).slice(0, 2000));
		live.info.lastActivity = Date.now();
		saveInfo(live.info);
	}

	private async handleCursorRequest(live: RuntimeHandle, message: JsonRpcMessage): Promise<unknown> {
		if (message.method === "session/request_permission") return this.handlePermission(live, message.params);
		if (message.method === "cursor/create_plan") return { outcome: { outcome: "accepted" } };
		if (message.method === "cursor/ask_question") {
			return skippedAskQuestion("Unified ACP agents do not fabricate interactive answers.");
		}
		throw new Error(`Unsupported Cursor ACP request: ${message.method}`);
	}

	private async handlePermission(live: RuntimeHandle, params: unknown): Promise<unknown> {
		const options = normalizePermissionOptions(params);
		const summary = redactPermissionPayload(params);
		const mode = live.info.permissionMode ?? "agent";
		log(live.info, "permission", summary);
		if (mode === "allow-once" || mode === "deny") return resolveAutomaticPermission(mode, options);
		if (mode === "prompt") {
			const ctx = this.ctx;
			if (!ctx?.hasUI) return rejectPermissionResult(options);
			const labels = options.map((option) => option.name ?? option.optionId);
			const selected = await ctx.ui.select(`Cursor ${live.info.canonicalName} — ${summary}`, labels, { timeout: PERMISSION_TIMEOUT_MS });
			const option = options[labels.indexOf(selected ?? "")];
			return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : rejectPermissionResult(options);
		}
		const approvalId = randomUUID().slice(0, 8);
		const allowOnceOffered = !!findPermissionOptionId(options, ALLOW_ONCE_IDS);
		return new Promise((resolvePermission) => {
			const timer = setTimeout(() => {
				live.pendingApprovals.delete(approvalId);
				resolvePermission(rejectPermissionResult(options));
				log(live.info, "permission", `${approvalId} timed out and was rejected`);
			}, PERMISSION_TIMEOUT_MS);
			timer.unref?.();
			live.pendingApprovals.set(approvalId, { id: approvalId, summary, options, resolve: resolvePermission, timer });
			this.pushMail({
				id: randomUUID(),
				parentSessionId: live.info.parentSessionId,
				agentName: live.info.canonicalName,
				kind: "permission",
				status: "running",
				approvalId,
				summary,
				allowOnceOffered,
				createdAt: Date.now(),
			});
		});
	}

	private finalize(live: RuntimeHandle, status: "completed" | "failed", output: string, error?: string): void {
		if (live.closing || !live.pending) return;
		live.pending = false;
		live.info.status = status;
		live.info.finalResponse = output.trim();
		live.info.error = error;
		live.info.completedAt = Date.now();
		live.info.lastActivity = Date.now();
		if (live.info.finalResponse) writePrivate(live.info.responseFile, live.info.finalResponse);
		log(live.info, "turn", error ? `failed: ${error}` : "completed");
		saveInfo(live.info);
		this.pushMail(this.completionEvent(live.info));
		this.refresh();
	}

	private completionEvent(info: AgentInfo): MailEvent {
		return {
			id: randomUUID(),
			parentSessionId: info.parentSessionId,
			agentName: info.canonicalName,
			kind: "completion",
			status: info.status,
			finalResponse: info.finalResponse,
			error: info.error,
			createdAt: Date.now(),
		};
	}

	private pushMail(event: MailEvent): void {
		if (event.kind === "completion") {
			for (let index = this.mailbox.length - 1; index >= 0; index--) {
				const old = this.mailbox[index]!;
				if (old.kind === "completion" && old.parentSessionId === event.parentSessionId && old.agentName === event.agentName) this.mailbox.splice(index, 1);
			}
		}
		const index = this.waiters.findIndex((waiter) => waiter.parentSessionId === event.parentSessionId && (!waiter.targets || waiter.targets.has(event.agentName)));
		if (index >= 0) {
			const [waiter] = this.waiters.splice(index, 1);
			waiter!.resolve(event);
		} else this.mailbox.push(event);
	}

	private rejectApprovals(live: RuntimeHandle, cancelled: boolean, reason: string): void {
		for (const approval of live.pendingApprovals.values()) {
			clearTimeout(approval.timer);
			approval.resolve(cancelled ? cancelledPermissionResult() : rejectPermissionResult(approval.options));
			log(live.info, "permission", `${approval.id} ${cancelled ? "cancelled" : "rejected"}: ${reason}`);
		}
		live.pendingApprovals.clear();
	}

	private handleRuntimeExit(live: RuntimeHandle, error?: Error): void {
		if (live.closing) return;
		this.live.delete(live.info.id);
		if (live.pending && !FINAL.has(live.info.status)) {
			live.pending = false;
			this.rejectApprovals(live, false, "runtime exited");
			live.info.status = "failed";
			live.info.error = error?.message ?? "Subagent runtime exited unexpectedly.";
			live.info.completedAt = Date.now();
			live.info.lastActivity = Date.now();
			saveInfo(live.info);
			this.pushMail(this.completionEvent(live.info));
		}
		this.refresh();
	}

	private async closeLive(id: string, remove: boolean): Promise<void> {
		const live = this.live.get(id);
		if (!live) return;
		live.closing = true;
		live.pending = false;
		this.rejectApprovals(live, false, "agent closed");
		await Promise.allSettled([live.pi?.close(), live.cursor?.close()].filter(Boolean) as Promise<void>[]);
		if (remove) this.live.delete(id);
	}

	private refresh(): void {
		this.updateWidget();
		this.reportParent([...this.live.values()].some((live) => live.pending));
	}

	private updateWidget(): void {
		const ctx = this.ctx;
		if (!ctx || ctx.mode !== "tui") return;
		let parent: string;
		try { parent = this.parentSessionId(ctx); } catch { return; }
		const infos = readScope(parent).filter((info) => info.status !== "closed");
		if (!infos.length) {
			ctx.ui.setWidget(`${PACKAGE_NAME}:agents`, undefined);
			return;
		}
		ctx.ui.setWidget(`${PACKAGE_NAME}:agents`, (_tui, theme) => ({
			render(width: number) {
				const running = infos.filter((info) => info.status === "starting" || info.status === "running").length;
				const lines = [theme.fg("accent", theme.bold(`Subagents — ${running} running · ${infos.length - running} settled`))];
				for (const info of infos) {
					const color = info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning";
					lines.push(`${theme.fg(color, "●")} ${theme.fg("toolTitle", info.canonicalName)} ${theme.fg("dim", `[${info.backend}] ${info.model} · ${info.status}`)}`);
				}
				return lines.map((line) => truncateToWidth(line, width));
			},
			invalidate() {},
		}));
	}

	private reportParent(working: boolean, force = false): void {
		const paneId = process.env.HERDR_PANE_ID;
		if (!paneId || process.env.HERDR_ENV !== "1") return;
		if (!force && working === this.parentWorking) return;
		this.parentWorking = working;
		const seq = ++this.parentSeq;
		const args = working
			? ["pane", "report-agent", paneId, "--source", PARENT_SOURCE, "--agent", "pi", "--state", "working", "--message", "Subagent working", "--seq", String(seq)]
			: ["pane", "release-agent", paneId, "--source", PARENT_SOURCE, "--agent", "pi", "--seq", String(seq)];
		this.parentQueue = this.parentQueue.then(async () => {
			await this.pi.exec("herdr", args, { timeout: 5000 });
		}).catch(() => undefined);
	}
}

class AgentLogOverlay {
	private readonly tui: TUI;
	private readonly manager: UnifiedManager;
	private readonly theme: Theme;
	private readonly parentSessionId: string;
	private readonly target: string;
	private readonly done: (navigation?: "previous" | "next") => void;
	private timer?: ReturnType<typeof setInterval>;
	private scroll = Number.MAX_SAFE_INTEGER;
	private cache: string[] = [];
	constructor(tui: TUI, theme: Theme, manager: UnifiedManager, parentSessionId: string, target: string, done: (navigation?: "previous" | "next") => void) {
		this.tui = tui;
		this.theme = theme;
		this.manager = manager;
		this.parentSessionId = parentSessionId;
		this.target = target;
		this.done = done;
		this.reload();
		this.timer = setInterval(() => { this.reload(); this.tui.requestRender(); }, 250);
	}
	private reload(): void {
		try {
			const info = this.manager.get(this.target, this.parentSessionId);
			const raw = existsSync(info.logFile) ? readFileSync(info.logFile, "utf8") : "";
			this.cache = raw.replace(/\r/g, "").split("\n");
		} catch { this.cache = ["Agent unavailable."]; }
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.dispose(); this.done(); }
		else if (matchesKey(data, "left")) { this.dispose(); this.done("previous"); }
		else if (matchesKey(data, "right")) { this.dispose(); this.done("next"); }
		else if (matchesKey(data, "up") || data === "k") { this.scroll = Math.max(0, Math.min(this.cache.length, this.scroll) - 1); }
		else if (matchesKey(data, "down") || data === "j") { this.scroll = Math.min(this.cache.length, Math.min(this.cache.length, this.scroll) + 1); }
		else if (data === "g") this.scroll = 0;
		else if (data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		this.tui.requestRender();
	}
	render(width: number): string[] {
		let info: AgentInfo;
		try { info = this.manager.get(this.target, this.parentSessionId); }
		catch { return [truncateToWidth("Agent unavailable", width)]; }
		const inner = Math.max(20, width - 2);
		const height = Math.max(6, Math.min(50, this.tui.terminal.rows - 8));
		const maxScroll = Math.max(0, this.cache.length - height);
		if (this.scroll === Number.MAX_SAFE_INTEGER) this.scroll = maxScroll;
		this.scroll = Math.min(maxScroll, this.scroll);
		const statusColor = info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning";
		const top = `╭ ${info.canonicalName} [${info.backend}] ${info.model} · ${info.status} `;
		const lines = [truncateToWidth(this.theme.fg(statusColor, top.padEnd(inner + 1, "─") + "╮"), width)];
		for (const line of this.cache.slice(this.scroll, this.scroll + height)) lines.push(`│${truncateToWidth(line, inner).padEnd(inner)}│`);
		while (lines.length < height + 1) lines.push(`│${" ".repeat(inner)}│`);
		const footer = "←/→ agent · j/k scroll · g/G top/end · q close";
		lines.push(`╰${truncateToWidth(footer, inner).padEnd(inner, "─")}╯`);
		return lines.map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
	dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

function textResult(text: string, details?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function targets(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.map(String).filter((entry) => entry.trim()) : undefined;
}

function eventText(event: MailEvent, manager: UnifiedManager, parentSessionId: string): { text: string; details: Record<string, unknown> } {
	if (event.kind === "permission") {
		return {
			text: `Permission required by ${event.agentName}: ${event.summary}\nApproval id: ${event.approvalId}\n${event.allowOnceOffered ? "Call respond_agent_permission with decision=approve or reject, then wait again." : "Allow-once is unavailable; reject this request with respond_agent_permission, then wait again."}`,
			details: { ...event },
		};
	}
	const info = manager.get(event.agentName, parentSessionId);
	const output = boundedResult(event.finalResponse ?? event.error ?? "", info);
	return {
		text: JSON.stringify({ agent_name: event.agentName, status: event.status, finalResponse: output.text, error: event.error }, null, 2),
		details: { ...event, truncated: output.truncated, fullOutputPath: output.fullOutputPath },
	};
}

export function registerUnifiedSubagents(pi: ExtensionAPI): void {
	const manager = new UnifiedManager(pi);
	const Backend = StringEnum(["pi", "cursor"] as const, { description: "Required runtime backend. Choose explicitly." });
	const CursorModelSchema = StringEnum(["Auto", "Grok 4.5 High"] as const);
	const PermissionSchema = StringEnum(["agent", "prompt", "allow-once", "deny"] as const);
	const SpawnSchema = Type.Object({
		task_name: Type.String({ description: "Session-scoped task name; slash-separated names are allowed." }),
		message: Type.String({ description: "Initial concrete task." }),
		backend: Backend,
		agent_type: Type.Optional(Type.String({ description: `Optional template from ${AGENTS_DIR}.` })),
		skills: Type.Optional(Type.Array(Type.String(), { description: "Additional explicit Pi skills. Ignored by Cursor." })),
		cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to parent cwd." })),
		cursor_model: Type.Optional(CursorModelSchema),
		permission_mode: Type.Optional(PermissionSchema),
	});
	const TargetSchema = Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) });

	const spawnTool = {
		name: "spawn_agent",
		label: "Spawn Agent",
		get description() {
			return `Spawn a fresh-context Pi or Cursor ACP subagent. backend is required explicitly. Returns after startup; use wait_agent or wait_all_agents for results. Templates can configure backend-specific model, tools, skills, extensions, and prompts.\n\nAvailable templates:\n${templatesDescription()}`;
		},
		promptSnippet: "Spawn a session-scoped Pi or Cursor ACP agent; backend must be explicit.",
		promptGuidelines: [
			"Always pass backend=pi or backend=cursor explicitly to spawn_agent; never infer a hidden default.",
			"After spawn_agent, use wait_agent or wait_all_agents when the delegated result is needed.",
			"Cursor ACP permission requests are returned by wait_agent; answer them with respond_agent_permission and wait again.",
		],
		parameters: SpawnSchema,
		async execute(_id: string, params: SpawnParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			const info = await manager.spawn(params, ctx);
			return textResult(`Spawned ${info.canonicalName} with backend=${info.backend}. Use wait_agent or wait_all_agents for completion.`, {
				agent_name: info.canonicalName,
				backend: info.backend,
				status: info.status,
				model: info.model,
				viewerPaneId: info.viewerPaneId,
				viewerTabId: info.viewerTabId,
				logFile: info.logFile,
			});
		},
		renderCall(args: SpawnParams, theme: any) { return new Text(`${theme.fg("toolTitle", theme.bold("spawn_agent "))}${theme.fg("accent", args.task_name ?? "?")}${theme.fg("dim", ` [${args.backend ?? "?"}]`)}`, 0, 0); },
		renderResult(result: any, _options: any, theme: any) { return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ spawn failed" : `✓ ${result.details?.agent_name ?? "spawned"}`), 0, 0); },
	};
	pi.registerTool(spawnTool);

	pi.registerTool({
		name: "wait_agent",
		label: "Wait Agent",
		description: "Wait without a timeout for one session-owned agent completion or Cursor permission request. Omit targets to receive the next event.",
		promptSnippet: "Wait for one selected subagent completion or permission request.",
		parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal, _update, ctx) {
			const parent = manager.parentSessionId(ctx);
			const event = await manager.waitAgent(parent, targets(params.targets), signal);
			const rendered = eventText(event, manager, parent);
			return textResult(rendered.text, rendered.details);
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("wait_agent ")) + theme.fg("accent", args.targets?.join(",") || "any"), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ wait failed" : result.details?.kind === "permission" ? "⚿ permission required" : `✓ ${result.details?.agentName ?? "done"}`), 0, 0); },
	});

	pi.registerTool({
		name: "wait_all_agents",
		label: "Wait All Agents",
		description: "Wait without a timeout until all selected session-owned agents reach final status. Omit targets for agents spawned or messaged since the last wait-all.",
		promptSnippet: "Wait for all selected subagents and return their final responses.",
		parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal, _update, ctx) {
			const parent = manager.parentSessionId(ctx);
			const waited = await manager.waitAll(parent, targets(params.targets), signal);
			if (waited.event) {
				const rendered = eventText(waited.event, manager, parent);
				return textResult(rendered.text, rendered.details);
			}
			const responses = (waited.infos ?? []).map((info) => {
				const output = boundedResult(info.finalResponse ?? info.error ?? "", info);
				return { agent_name: info.canonicalName, backend: info.backend, status: info.status, finalResponse: output.text, error: info.error };
			});
			return textResult(JSON.stringify({ responses }, null, 2), { responses });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("wait_all_agents ")) + theme.fg("accent", args.targets?.join(",") || "all"), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ wait failed" : `✓ ${result.details?.responses?.length ?? 0} agents`), 0, 0); },
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List current-parent-session agents. include_all enables an explicit read-only historical view across sessions.",
		promptSnippet: "List session-scoped subagents and their backend/status.",
		parameters: Type.Object({
			path_prefix: Type.Optional(Type.String()),
			include_all: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const parent = manager.parentSessionId(ctx);
			const infos = manager.list(parent, params.include_all === true, params.path_prefix);
			const agents = infos.map((info) => ({
				agent_name: info.canonicalName,
				backend: info.backend,
				agent_status: info.status,
				model: info.model,
				last_task_message: info.lastTaskMessage ?? null,
				...(params.include_all ? { parent_session_id: info.parentSessionId } : {}),
			}));
			return textResult(JSON.stringify({ agents }, null, 2), { agents });
		},
		renderCall(_args, theme) { return new Text(theme.fg("toolTitle", theme.bold("list_agents")), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg("success", `✓ ${result.details?.agents?.length ?? 0} agents`), 0, 0); },
	});

	pi.registerTool({
		name: "read_agent_response",
		label: "Read Agent Response",
		description: "Read one current-session agent's latest final raw text response.",
		parameters: TargetSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const result = manager.readResponse(manager.parentSessionId(ctx), params.target);
			const bounded = boundedResult(result.response, result.info);
			return textResult(JSON.stringify({ agent_name: result.info.canonicalName, status: result.info.status, finalResponse: bounded.text }, null, 2), { agent_name: result.info.canonicalName, status: result.info.status, truncated: bounded.truncated, fullOutputPath: bounded.fullOutputPath });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("read_agent_response ")) + theme.fg("accent", args.target), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ read failed" : `✓ ${result.details?.agent_name}`), 0, 0); },
	});

	pi.registerTool({
		name: "send_message",
		label: "Send Message",
		description: "Send a message to a session-owned agent. Pi receives true steering while active; Cursor ACP cancels and restarts with the correction. Settled agents start another turn.",
		parameters: Type.Object({ target: Type.String(), message: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await manager.send(manager.parentSessionId(ctx), params.target, params.message);
			return textResult(result.delivery === "steer" ? "Message steered into running Pi agent." : result.delivery === "cancel-and-prompt" ? "Running Cursor turn cancelled; corrective prompt queued on the same ACP session." : "Message started a new agent turn.", { target: params.target, ...result });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("send_message ")) + theme.fg("accent", args.target), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ send failed" : `✓ ${result.details?.delivery}`), 0, 0); },
	});

	pi.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description: "Abort an active turn without permanently closing the session.",
		parameters: TargetSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const previous = await manager.interrupt(manager.parentSessionId(ctx), params.target);
			return textResult("Interrupt handled.", { target: params.target, previous_status: previous });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("interrupt_agent ")) + theme.fg("accent", args.target), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg("warning", `↯ previous: ${result.details?.previous_status}`), 0, 0); },
	});

	pi.registerTool({
		name: "close_agent",
		label: "Close Agent",
		description: "Permanently close a session-owned agent process and its Herdr viewer. History remains readable.",
		parameters: TargetSchema,
		async execute(_id, params, _signal, _update, ctx) {
			const previous = await manager.close(manager.parentSessionId(ctx), params.target);
			return textResult("Agent closed.", { target: params.target, previous_status: previous });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("close_agent ")) + theme.fg("accent", args.target), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg("success", `✓ previous: ${result.details?.previous_status}`), 0, 0); },
	});

	pi.registerTool({
		name: "respond_agent_permission",
		label: "Respond Agent Permission",
		description: "Approve exactly once or reject a pending Cursor ACP permission request returned by wait_agent.",
		promptSnippet: "Answer a pending Cursor ACP permission request.",
		parameters: Type.Object({
			target: Type.String(),
			approval_id: Type.String(),
			decision: StringEnum(["approve", "reject"] as const),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			manager.respondPermission(manager.parentSessionId(ctx), params.target, params.approval_id, params.decision);
			return textResult(params.decision === "approve" ? "Permission approved once." : "Permission rejected.", { target: params.target, approval_id: params.approval_id, decision: params.decision });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("respond_agent_permission ")) + theme.fg("accent", `${args.target} ${args.decision}`), 0, 0); },
		renderResult(result: any, _options, theme) { return new Text(theme.fg(result.details?.decision === "approve" ? "success" : "warning", `✓ ${result.details?.decision}`), 0, 0); },
	});

	async function openOverlay(ctx: ExtensionCommandContext, initialTarget: string, scopeParent = manager.parentSessionId(ctx), includeAll = false): Promise<void> {
		if (ctx.mode !== "tui") { ctx.ui.notify("Agent overlays require TUI mode.", "warning"); return; }
		let target = `/${normalizeTaskName(initialTarget)}`;
		for (;;) {
			const navigation = await ctx.ui.custom<"previous" | "next" | undefined>((tui, theme, _keys, done) => new AgentLogOverlay(tui, theme, manager, scopeParent, target, done), {
				overlay: true,
				overlayOptions: { anchor: "right-center", width: "50%", minWidth: 60, maxHeight: 60, margin: { right: 2, top: 2, bottom: 2 } },
			});
			if (!navigation) return;
			const infos = manager.list(manager.parentSessionId(ctx), includeAll);
			if (infos.length < 2) return;
			const index = infos.findIndex((info) => info.canonicalName === target && info.parentSessionId === scopeParent);
			if (index < 0) return;
			const offset = navigation === "next" ? 1 : -1;
			const next = infos[(index + offset + infos.length) % infos.length]!;
			target = next.canonicalName;
			scopeParent = next.parentSessionId;
		}
	}

	async function pickAgent(ctx: ExtensionCommandContext): Promise<{ target: string; parent: string; includeAll: boolean } | undefined> {
		const currentParent = manager.parentSessionId(ctx);
		return ctx.ui.custom((tui, theme, _keys, done) => {
			let selected = 0;
			let includeAll = false;
			return {
				render(width: number) {
					const infos = manager.list(currentParent, includeAll);
					selected = Math.max(0, Math.min(selected, infos.length - 1));
					const lines = [theme.fg("accent", theme.bold(`Subagents (${includeAll ? "all sessions" : "this session"})`)), ""];
					if (!infos.length) lines.push(theme.fg("dim", "No agents. Press Tab for historical agents."));
					for (const [index, info] of infos.slice(0, 12).entries()) {
						const pointer = index === selected ? theme.fg("accent", "› ") : "  ";
						const statusColor = info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning";
						lines.push(pointer + theme.fg(index === selected ? "accent" : "text", info.canonicalName.padEnd(28)) + theme.fg(statusColor, info.status.padEnd(12)) + theme.fg("dim", `${info.backend} · ${info.model}`));
					}
					lines.push("", theme.fg("dim", "enter open · tab this/all · j/k navigate · q close"));
					return lines.map((line) => truncateToWidth(line, width));
				},
				handleInput(data: string) {
					const infos = manager.list(currentParent, includeAll);
					if (matchesKey(data, "escape") || data === "q") done(undefined);
					else if (matchesKey(data, "tab")) { includeAll = !includeAll; selected = 0; }
					else if (matchesKey(data, "down") || data === "j") selected = Math.min(infos.length - 1, selected + 1);
					else if (matchesKey(data, "up") || data === "k") selected = Math.max(0, selected - 1);
					else if (matchesKey(data, "return") && infos[selected]) done({ target: infos[selected]!.canonicalName, parent: infos[selected]!.parentSessionId, includeAll });
					tui.requestRender();
				},
				invalidate() {},
			};
		});
	}

	pi.registerCommand("agents", {
		description: "Browse Pi and Cursor ACP subagents.",
		handler: async (_args, ctx) => {
			const selection = await pickAgent(ctx);
			if (selection) await openOverlay(ctx, selection.target, selection.parent, selection.includeAll);
		},
	});
	pi.registerCommand("subagent", {
		description: "Open one current-session agent. Usage: /subagent <task-name>",
		handler: async (args, ctx) => {
			if (args.trim()) await openOverlay(ctx, args.trim());
			else {
				const selection = await pickAgent(ctx);
				if (selection) await openOverlay(ctx, selection.target, selection.parent, selection.includeAll);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => manager.attach(ctx));
	pi.on("agent_end", () => manager.reassertParent());
	pi.on("session_shutdown", async () => manager.shutdown());
}
