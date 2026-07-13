import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CursorAcpClient,
	PACKAGE_NAME,
	type CursorModel,
	type JsonRpcMessage,
} from "./acp.ts";
import {
	answeredAskQuestion,
	askQuestionPromptability,
	normalizeAskQuestions,
	normalizePermissionMode,
	normalizePermissionOptions,
	permissionSelectLabels,
	redactPermissionPayload,
	rejectPermissionResult,
	resolveAutomaticPermission,
	resolvePromptPermissionSelection,
	restoreCursorConfigVerified,
	skippedAskQuestion,
	type CursorConfigFs,
	type PermissionMode,
} from "./helpers.ts";

const RUNTIME_KEY = Symbol.for(`${PACKAGE_NAME}/runtime`);
const WIDGET_KEY = PACKAGE_NAME;
const STATE_ROOT = join(getAgentDir(), PACKAGE_NAME);
const CURSOR_CONFIG_PATH = join(homedir(), ".cursor", "cli-config.json");
const MAX_SUBAGENTS = 8;
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
const UI_PROMPT_TIMEOUT_MS = 120_000;
export const SUBAGENT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

type ManagedStatus = "starting" | "working" | "ready" | "failed" | "stopped";

interface ManagedSubagent {
	id: string;
	name: string;
	model: CursorModel;
	permissionMode: PermissionMode;
	cwd: string;
	client: CursorAcpClient;
	sessionId?: string;
	viewerPaneId: string;
	viewerTabId: string;
	workspaceId: string;
	logPath: string;
	createdAt: number;
	turn: number;
	status: ManagedStatus;
	activity: string;
	pending: boolean;
	closing: boolean;
	currentPrompt: string;
	currentThought: string;
	currentOutput: string;
	lastOutput?: string;
	lastError?: string;
	todos: Array<{ id?: string; content?: string; status?: string }>;
	streamLabel?: "thought" | "assistant";
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface RuntimeState {
	agents: Map<string, ManagedSubagent>;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	widgetTimer?: ReturnType<typeof setInterval>;
	widgetDebounce?: ReturnType<typeof setTimeout>;
	prerequisitesChecked: boolean;
	configQueue: Promise<void>;
	uiQueue: Promise<void>;
}

const runtime: RuntimeState =
	(globalThis as any)[RUNTIME_KEY] ??
	((globalThis as any)[RUNTIME_KEY] = {
		agents: new Map<string, ManagedSubagent>(),
		prerequisitesChecked: false,
		configQueue: Promise.resolve(),
		uiQueue: Promise.resolve(),
	});

if (!runtime.uiQueue) runtime.uiQueue = Promise.resolve();

if (runtime.widgetTimer) {
	clearInterval(runtime.widgetTimer);
	runtime.widgetTimer = undefined;
}
if (runtime.widgetDebounce) {
	clearTimeout(runtime.widgetDebounce);
	runtime.widgetDebounce = undefined;
}

const ActionSchema = StringEnum(["spawn", "send", "list", "read", "stop"] as const, {
	description:
		"spawn starts a Cursor ACP session; send submits a follow-up; list shows sessions; read returns the structured event log; stop terminates the session and closes its Herdr viewer.",
});

const ModelSchema = StringEnum(["Auto", "Grok 4.5 High"] as const, {
	description: "Cursor model. Grok 4.5 High explicitly disables Fast mode.",
	default: "Auto",
});

const PermissionModeSchema = StringEnum(["prompt", "allow-once", "deny"] as const, {
	description:
		"How session/request_permission is handled. prompt (default) asks via Pi UI when available; allow-once auto-approves once; deny rejects. allow-always is never auto-selected.",
	default: "prompt",
});

const SubagentParams = Type.Object({
	action: ActionSchema,
	name: Type.Optional(Type.String({ description: "Display name for action=spawn" })),
	task: Type.Optional(Type.String({ description: "Initial task for action=spawn" })),
	model: Type.Optional(ModelSchema),
	permissionMode: Type.Optional(PermissionModeSchema),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for action=spawn. Defaults to the current Pi cwd." }),
	),
	target: Type.Optional(
		Type.String({ description: "Subagent id or exact display name for send, read, or stop" }),
	),
	message: Type.Optional(Type.String({ description: "Follow-up message for action=send" })),
	lines: Type.Optional(
		Type.Integer({ description: "Log lines for action=read. Defaults to 200.", minimum: 20, maximum: 1000 }),
	),
});

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function appendBounded(current: string, addition: string, maxChars = MAX_BUFFER_CHARS): string {
	const next = current + addition;
	return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

export function resolveCwd(requested: string | undefined, fallback: string): string {
	const cwd = requested ? (isAbsolute(requested) ? requested : resolve(fallback, requested)) : fallback;
	let valid = false;
	try {
		valid = statSync(cwd).isDirectory();
	} catch {
		valid = false;
	}
	if (!valid) throw new Error(`Cursor subagent cwd is not a directory: ${cwd}`);
	return cwd;
}

function resolveTarget(target: string | undefined): ManagedSubagent {
	const requested = target?.trim();
	if (!requested) throw new Error("Provide target as a subagent id or exact display name.");

	const byId = runtime.agents.get(requested);
	if (byId) return byId;
	const matches = Array.from(runtime.agents.values()).filter((agent) => agent.name === requested);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`No managed Cursor subagent matches ${JSON.stringify(requested)}.`);
	throw new Error(
		`Ambiguous Cursor subagent name ${JSON.stringify(requested)}. Use one of: ${matches
			.map((agent) => agent.id)
			.join(", ")}`,
	);
}

async function exec(command: string, args: string[], timeout = 5000) {
	const pi = runtime.pi;
	if (!pi) throw new Error("Cursor subagent runtime is not attached to an active Pi session.");
	return pi.exec(command, args, { timeout });
}

async function execHerdr(args: string[], timeout = 5000): Promise<string> {
	const result = await exec("herdr", args, timeout);
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || `herdr ${args.join(" ")} failed`).trim());
	}
	return result.stdout;
}

export function parseJson<T>(raw: string, context: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`Unexpected ${context} output: ${raw.trim() || "(empty)"}`);
	}
}

async function ensurePrerequisites(): Promise<void> {
	if (process.env.HERDR_ENV !== "1") {
		throw new Error("Cursor subagents require Pi to be running inside Herdr (HERDR_ENV=1).");
	}
	if (!process.env.HERDR_WORKSPACE_ID) {
		throw new Error("HERDR_WORKSPACE_ID is unavailable; cannot create a Cursor subagent viewer.");
	}
	if (runtime.prerequisitesChecked) return;

	const [herdr, cursor] = await Promise.all([
		exec("herdr", ["--version"], 5000),
		exec("agent", ["--version"], 5000),
	]);
	if (herdr.code !== 0) throw new Error((herdr.stderr || "herdr CLI is unavailable").trim());
	if (cursor.code !== 0) throw new Error((cursor.stderr || "Cursor agent CLI is unavailable").trim());
	runtime.prerequisitesChecked = true;
}

async function withQueue<T>(
	queueKey: "configQueue" | "uiQueue",
	operation: () => Promise<T>,
): Promise<T> {
	let release!: () => void;
	const gate = new Promise<void>((resolveGate) => {
		release = resolveGate;
	});
	const previous = runtime[queueKey];
	runtime[queueKey] = previous.then(() => gate);
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

const nodeCursorConfigFs: CursorConfigFs = {
	exists: (path) => existsSync(path),
	read: (path) => readFileSync(path, "utf8"),
	write: (path, content) => writeFileSync(path, content, "utf8"),
	unlink: (path) => unlinkSync(path),
};

async function withCursorConfigPreserved<T>(operation: () => Promise<T>): Promise<T> {
	return withQueue("configQueue", async () => {
		const existed = existsSync(CURSOR_CONFIG_PATH);
		const original = existed ? readFileSync(CURSOR_CONFIG_PATH, "utf8") : undefined;
		try {
			return await operation();
		} finally {
			// Cursor persists ACP config selections to the normal CLI config. The
			// session already holds its own selection, so restore + verify the
			// user's default (or remove a file we caused to be created).
			await restoreCursorConfigVerified({
				path: CURSOR_CONFIG_PATH,
				existedBefore: existed,
				originalContent: original,
				fs: nodeCursorConfigFs,
			});
		}
	});
}

async function withUiInteraction<T>(operation: () => Promise<T>): Promise<T> {
	return withQueue("uiQueue", operation);
}

function ensurePrivateStateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Best-effort on platforms that ignore POSIX modes.
	}
}

function writePrivateFile(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best-effort on platforms that ignore POSIX modes.
	}
}

function timestamp(): string {
	return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function endLogStream(agent: ManagedSubagent): void {
	if (!agent.streamLabel) return;
	appendFileSync(agent.logPath, "\n", "utf8");
	agent.streamLabel = undefined;
}

function writeLog(agent: ManagedSubagent, label: string, value: string): void {
	endLogStream(agent);
	const lines = String(value || "").replace(/\r/g, "").split("\n");
	for (const line of lines) {
		appendFileSync(agent.logPath, `[${timestamp()}] ${label}: ${line}\n`, "utf8");
	}
}

function writeStream(agent: ManagedSubagent, label: "thought" | "assistant", chunk: string): void {
	if (!chunk) return;
	if (agent.streamLabel !== label) {
		endLogStream(agent);
		appendFileSync(agent.logPath, `[${timestamp()}] ${label}: `, "utf8");
		agent.streamLabel = label;
	}
	appendFileSync(agent.logPath, chunk.replace(/\n/g, "\n    "), "utf8");
}

export function summarize(value: unknown, max = 500): string {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	const text = serialized ?? String(value);
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function scheduleWidgetUpdate(): void {
	if (runtime.widgetDebounce) return;
	runtime.widgetDebounce = setTimeout(() => {
		runtime.widgetDebounce = undefined;
		updateWidget();
	}, 100);
	runtime.widgetDebounce.unref?.();
}

function updateWidget(): void {
	const ctx = runtime.ctx;
	if (!ctx || ctx.mode !== "tui") return;
	if (runtime.agents.size === 0) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number) {
				const agents = Array.from(runtime.agents.values());
				const working = agents.filter((agent) => agent.status === "working" || agent.status === "starting").length;
				const ready = agents.filter((agent) => agent.status === "ready").length;
				const header = theme.fg(
					"accent",
					theme.bold(`Cursor ACP subagents — ${working} working · ${ready} ready`),
				);
				const lines = [truncateToWidth(header, width)];
				for (const agent of agents) {
					const color = agent.status === "failed"
						? "error"
						: agent.status === "ready"
							? "success"
							: "warning";
					const line =
						`  ${theme.fg(color, "●")} ` +
						theme.fg("toolTitle", agent.name) +
						theme.fg(
							"dim",
							` [${agent.id}] · ${agent.model} · ${agent.activity} · ${formatElapsed(agent.createdAt)}`,
						);
					lines.push(truncateToWidth(line, width));
				}
				return lines;
			},
			invalidate() {},
		}),
		{ placement: "aboveEditor" },
	);
}

function startWidgetTimer(): void {
	if (runtime.widgetTimer) return;
	runtime.widgetTimer = setInterval(updateWidget, 1000);
	runtime.widgetTimer.unref?.();
}

function stopWidgetTimer(): void {
	if (!runtime.widgetTimer) return;
	clearInterval(runtime.widgetTimer);
	runtime.widgetTimer = undefined;
}

function sendAsyncMessage(
	customType: "cursor_subagent_result" | "cursor_subagent_status",
	content: string,
	details: Record<string, unknown>,
): void {
	const pi = runtime.pi;
	if (!pi) return;
	pi.sendMessage(
		{ customType, content, display: true, details },
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function boundedOutput(output: string): { text: string; truncated: boolean } {
	const result = truncateTail(output || "(Cursor produced no final text.)", {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!result.truncated) return { text: result.content, truncated: false };
	return {
		text:
			`[Earlier output omitted: showing the final ${result.outputLines} of ${result.totalLines} lines.]\n\n` +
			result.content,
		truncated: true,
	};
}

function setActivity(agent: ManagedSubagent, status: ManagedStatus, activity: string): void {
	agent.status = status;
	agent.activity = activity;
	scheduleWidgetUpdate();
}

export function contentText(content: unknown): string {
	if (!content || typeof content !== "object") return "";
	const value = content as { type?: unknown; text?: unknown };
	return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

export function toolLabel(update: any): string {
	return (
		update?.title ??
		update?.toolCall?.title ??
		update?.toolCall?.name ??
		update?.kind ??
		update?.name ??
		"tool"
	);
}

function handleSessionUpdate(agent: ManagedSubagent, update: any): void {
	const kind = update?.sessionUpdate;
	switch (kind) {
		case "agent_thought_chunk": {
			const text = contentText(update.content);
			agent.currentThought = appendBounded(agent.currentThought, text);
			writeStream(agent, "thought", text);
			setActivity(agent, "working", "thinking");
			break;
		}
		case "agent_message_chunk": {
			const text = contentText(update.content);
			agent.currentOutput = appendBounded(agent.currentOutput, text);
			writeStream(agent, "assistant", text);
			setActivity(agent, "working", "responding");
			break;
		}
		case "tool_call": {
			const label = toolLabel(update);
			writeLog(agent, "tool", label);
			setActivity(agent, "working", label);
			break;
		}
		case "tool_call_update": {
			const label = toolLabel(update);
			const status = update?.status ?? update?.toolCall?.status;
			writeLog(agent, "tool", `${label}${status ? ` — ${status}` : ""}`);
			setActivity(agent, "working", label);
			break;
		}
		case "plan":
			writeLog(agent, "plan", summarize(update.entries ?? update, 2000));
			setActivity(agent, "working", "planning");
			break;
		case "session_info_update":
			if (update.title) writeLog(agent, "title", update.title);
			break;
		case "usage_update":
			writeLog(agent, "usage", summarize(update));
			break;
		case "available_commands_update":
			break;
		default:
			if (kind) writeLog(agent, kind, summarize(update));
	}
}

function handleNotification(agent: ManagedSubagent, message: JsonRpcMessage): void {
	if (message.method === "session/update") {
		if (message.params?.sessionId && agent.sessionId && message.params.sessionId !== agent.sessionId) return;
		handleSessionUpdate(agent, message.params?.update);
		return;
	}

	if (message.method === "cursor/update_todos") {
		agent.todos = Array.isArray(message.params?.todos) ? message.params.todos : [];
		const summary = agent.todos.map((todo) => `${todo.status ?? "pending"}: ${todo.content ?? todo.id}`).join(" | ");
		writeLog(agent, "todos", summary || "updated");
		setActivity(agent, "working", "todos");
		return;
	}

	if (message.method === "cursor/task") {
		writeLog(agent, "cursor task", summarize(message.params, 2000));
		setActivity(agent, "working", message.params?.description ?? "subtask");
		return;
	}

	if (message.method === "cursor/generate_image") {
		writeLog(agent, "image", summarize(message.params, 2000));
		setActivity(agent, "working", "generating image");
		return;
	}

	writeLog(agent, message.method ?? "notification", summarize(message.params));
}

async function handlePermissionRequest(agent: ManagedSubagent, params: unknown): Promise<unknown> {
	const options = normalizePermissionOptions(params);
	writeLog(agent, "permission", redactPermissionPayload(params));

	if (agent.permissionMode !== "prompt") {
		const result = resolveAutomaticPermission(agent.permissionMode, options);
		const selected =
			result.outcome.outcome === "selected" ? result.outcome.optionId : "cancelled";
		writeLog(agent, "permission", `${agent.permissionMode} → ${selected}`);
		setActivity(
			agent,
			"working",
			agent.permissionMode === "allow-once" ? "permission allowed once" : "permission denied",
		);
		return result;
	}

	const ctx = runtime.ctx;
	if (!ctx?.hasUI) {
		const result = rejectPermissionResult(options);
		writeLog(agent, "permission", "rejected (no UI)");
		setActivity(agent, "working", "permission denied");
		return result;
	}

	return withUiInteraction(async () => {
		setActivity(agent, "working", "awaiting permission");
		const labels = permissionSelectLabels(options);
		const choice =
			labels.length > 0
				? await ctx.ui.select(`Cursor subagent "${agent.name}" — permission`, labels, {
						timeout: UI_PROMPT_TIMEOUT_MS,
					})
				: undefined;
		const result = resolvePromptPermissionSelection(options, choice);
		const selected =
			result.outcome.outcome === "selected" ? result.outcome.optionId : "cancelled";
		writeLog(
			agent,
			"permission",
			choice ? `user selected ${selected}` : "rejected (cancelled or timed out)",
		);
		setActivity(
			agent,
			"working",
			result.outcome.outcome === "selected" && !selected.includes("reject")
				? "permission granted"
				: "permission denied",
		);
		return result;
	});
}

async function handleAskQuestion(agent: ManagedSubagent, params: unknown): Promise<unknown> {
	const questions = normalizeAskQuestions(params);
	const title =
		params && typeof params === "object" && typeof (params as { title?: unknown }).title === "string"
			? (params as { title: string }).title
			: undefined;
	writeLog(agent, "question", title ? `title=${title} (${questions.length})` : `${questions.length} question(s)`);

	const promptable = askQuestionPromptability(questions);
	if (!promptable.ok) {
		writeLog(agent, "question", `skipped — ${promptable.reason}`);
		return skippedAskQuestion(promptable.reason);
	}

	const ctx = runtime.ctx;
	if (!ctx?.hasUI) {
		const reason = "No dialog-capable Pi UI is available; skipped without fabricating answers.";
		writeLog(agent, "question", `skipped — ${reason}`);
		return skippedAskQuestion(reason);
	}

	return withUiInteraction(async () => {
		setActivity(agent, "working", "awaiting question");
		const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
		for (const question of questions) {
			const baseLabels = question.options.map((option) => option.label);
			const labels = question.options.map((option, index) => {
				const base = baseLabels[index]!;
				return baseLabels.filter((label) => label === base).length > 1
					? `${base} (${option.id})`
					: base;
			});
			const header = title
				? `Cursor subagent "${agent.name}" — ${title}`
				: `Cursor subagent "${agent.name}" — question`;
			const choice = await ctx.ui.select(`${header}\n${question.prompt}`, labels, {
				timeout: UI_PROMPT_TIMEOUT_MS,
			});
			if (!choice) {
				const reason = "User cancelled or the question prompt timed out; skipped without fabricating answers.";
				writeLog(agent, "question", `skipped — ${reason}`);
				return skippedAskQuestion(reason);
			}
			const selectedIndex = labels.indexOf(choice);
			const selected = selectedIndex >= 0 ? question.options[selectedIndex] : undefined;
			if (!selected) {
				const reason = "Could not map the selected label to an option id; skipped without fabricating answers.";
				writeLog(agent, "question", `skipped — ${reason}`);
				return skippedAskQuestion(reason);
			}
			answers.push({ questionId: question.id, selectedOptionIds: [selected.id] });
		}
		writeLog(agent, "question", `answered ${answers.length} question(s)`);
		setActivity(agent, "working", "question answered");
		return answeredAskQuestion(answers);
	});
}

async function handleRequest(agent: ManagedSubagent, message: JsonRpcMessage): Promise<unknown> {
	if (message.method === "session/request_permission") {
		return handlePermissionRequest(agent, message.params);
	}

	if (message.method === "cursor/create_plan") {
		writeLog(agent, "plan accepted", summarize(message.params, 4000));
		return { outcome: { outcome: "accepted" } };
	}

	if (message.method === "cursor/ask_question") {
		return handleAskQuestion(agent, message.params);
	}

	throw new Error(`Unsupported Cursor ACP request: ${message.method}`);
}

function deliverResult(agent: ManagedSubagent, stopReason?: string): void {
	const output = boundedOutput(agent.currentOutput);
	agent.lastOutput = output.text;
	sendAsyncMessage(
		"cursor_subagent_result",
		[
			`Cursor subagent "${agent.name}" completed turn ${agent.turn}${stopReason ? ` (${stopReason})` : ""}.`,
			`It remains open for follow-ups for 15 minutes. Use subagent action=send with target ${JSON.stringify(agent.id)}, or subagent action=stop when no more follow-up is needed.`,
			"",
			output.text,
		].join("\n"),
		{
			id: agent.id,
			name: agent.name,
			turn: agent.turn,
			model: agent.model,
			sessionId: agent.sessionId,
			viewerPaneId: agent.viewerPaneId,
			viewerTabId: agent.viewerTabId,
			logPath: agent.logPath,
			stopReason,
			truncated: output.truncated,
			output: output.text,
		},
	);
}

function clearIdleTimer(agent: ManagedSubagent): void {
	if (!agent.idleTimer) return;
	clearTimeout(agent.idleTimer);
	agent.idleTimer = undefined;
}

function scheduleIdleClose(agent: ManagedSubagent): void {
	clearIdleTimer(agent);
	agent.idleTimer = setTimeout(() => {
		agent.idleTimer = undefined;
		if (runtime.agents.get(agent.id) !== agent || agent.pending || agent.closing) return;
		void stopSubagent(agent, "closed automatically after 15 minutes without a follow-up");
	}, SUBAGENT_IDLE_TIMEOUT_MS);
	agent.idleTimer.unref?.();
}

function deliverFailure(agent: ManagedSubagent, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	agent.lastError = message;
	sendAsyncMessage(
		"cursor_subagent_status",
		`Cursor subagent "${agent.name}" failed: ${message}\n\nEvent log: ${agent.logPath}`,
		{
			id: agent.id,
			name: agent.name,
			status: "failed",
			error: message,
			logPath: agent.logPath,
		},
	);
}

function beginTurn(agent: ManagedSubagent, prompt: string): void {
	if (agent.pending) throw new Error(`Cursor subagent ${JSON.stringify(agent.name)} is already working.`);
	if (!agent.client.isAlive) throw new Error(`Cursor subagent ${JSON.stringify(agent.name)} is not running.`);
	clearIdleTimer(agent);

	agent.turn += 1;
	agent.pending = true;
	agent.currentPrompt = prompt;
	agent.currentThought = "";
	agent.currentOutput = "";
	writeLog(agent, "user", prompt);
	setActivity(agent, "working", "starting turn");

	agent.client
		.prompt(prompt)
		.then((result) => {
			if (runtime.agents.get(agent.id) !== agent || agent.closing) return;
			endLogStream(agent);
			agent.pending = false;
			writeLog(agent, "turn", `completed${result.stopReason ? ` — ${result.stopReason}` : ""}`);
			setActivity(agent, "ready", "ready for follow-up");
			deliverResult(agent, result.stopReason);
			scheduleIdleClose(agent);
		})
		.catch((error) => {
			if (runtime.agents.get(agent.id) !== agent || agent.closing) return;
			endLogStream(agent);
			agent.pending = false;
			writeLog(agent, "error", error?.message ?? String(error));
			setActivity(agent, "failed", "failed");
			deliverFailure(agent, error);
		});
}

async function createViewer(name: string, cwd: string, logPath: string): Promise<{
	paneId: string;
	tabId: string;
	workspaceId: string;
}> {
	const workspaceId = process.env.HERDR_WORKSPACE_ID!;
	const created = parseJson<{
		result?: {
			root_pane?: { pane_id?: string; tab_id?: string; workspace_id?: string };
			tab?: { tab_id?: string; workspace_id?: string };
		};
	}>(
		await execHerdr([
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			cwd,
			"--label",
			name,
			"--no-focus",
		]),
		"herdr tab create",
	);
	const paneId = created.result?.root_pane?.pane_id;
	const tabId = created.result?.tab?.tab_id ?? created.result?.root_pane?.tab_id;
	if (!paneId || !tabId) throw new Error("Herdr did not return a pane and tab for the Cursor viewer.");

	await execHerdr(["pane", "run", paneId, `tail -n 200 -F ${shellQuote(logPath)}`]);
	return { paneId, tabId, workspaceId };
}

async function closeViewer(agent: ManagedSubagent): Promise<void> {
	const tab = await exec("herdr", ["tab", "close", agent.viewerTabId], 5000);
	if (tab.code === 0) return;
	await exec("herdr", ["pane", "close", agent.viewerPaneId], 5000).catch(() => undefined);
}

async function spawnSubagent(
	params: {
		name?: string;
		task?: string;
		model?: CursorModel;
		cwd?: string;
		permissionMode?: PermissionMode;
	},
	ctx: ExtensionContext,
): Promise<ManagedSubagent> {
	await ensurePrerequisites();
	if (runtime.agents.size >= MAX_SUBAGENTS) {
		throw new Error(`At most ${MAX_SUBAGENTS} Cursor subagents can be managed at once.`);
	}

	const name = params.name?.trim();
	const task = params.task?.trim();
	if (!name) throw new Error("action=spawn requires name.");
	if (!task) throw new Error("action=spawn requires task.");
	if (Array.from(runtime.agents.values()).some((agent) => agent.name === name)) {
		throw new Error(`A managed Cursor subagent named ${JSON.stringify(name)} already exists.`);
	}

	const id = randomUUID().slice(0, 8);
	const model = params.model ?? "Auto";
	const permissionMode = normalizePermissionMode(params.permissionMode);
	const cwd = resolveCwd(params.cwd, ctx.cwd);
	ensurePrivateStateDir(STATE_ROOT);
	const stateDir = join(STATE_ROOT, id);
	ensurePrivateStateDir(stateDir);
	const logPath = join(stateDir, "events.log");
	writePrivateFile(
		logPath,
		[
			`Cursor ACP subagent: ${name} [${id}]`,
			`Model: ${model}${model === "Grok 4.5 High" ? " (effort=high, fast=false)" : ""}`,
			`Permission mode: ${permissionMode}`,
			`Working directory: ${cwd}`,
			"",
		].join("\n"),
	);

	const viewer = await createViewer(name, cwd, logPath);
	let agent!: ManagedSubagent;
	const client = new CursorAcpClient(cwd, {
		onNotification: (message) => handleNotification(agent, message),
		onRequest: (message) => handleRequest(agent, message),
		onStderr: (text) => {
			if (agent) writeLog(agent, "cursor stderr", text.trimEnd());
		},
		onExit: (code, signal) => {
			if (!agent || agent.closing || runtime.agents.get(agent.id) !== agent) return;
			agent.pending = false;
			writeLog(agent, "process", `exited (${code ?? signal ?? "unknown"})`);
			setActivity(agent, "failed", "ACP process exited");
			deliverFailure(agent, new Error(`Cursor ACP process exited (${code ?? signal ?? "unknown"}).`));
		},
	});

	agent = {
		id,
		name,
		model,
		permissionMode,
		cwd,
		client,
		viewerPaneId: viewer.paneId,
		viewerTabId: viewer.tabId,
		workspaceId: viewer.workspaceId,
		logPath,
		createdAt: Date.now(),
		turn: 0,
		status: "starting",
		activity: "starting ACP",
		pending: false,
		closing: false,
		currentPrompt: "",
		currentThought: "",
		currentOutput: "",
		todos: [],
	};
	runtime.agents.set(id, agent);
	startWidgetTimer();
	updateWidget();

	try {
		const started = await withCursorConfigPreserved(() => client.start(model));
		agent.sessionId = started.sessionId;
		writeLog(agent, "session", `${started.sessionId} — ${model}`);
		setActivity(agent, "ready", "ready");
		beginTurn(agent, task);
		return agent;
	} catch (error) {
		agent.closing = true;
		runtime.agents.delete(id);
		writeLog(agent, "startup error", error instanceof Error ? error.message : String(error));
		await client.close().catch(() => undefined);
		await closeViewer(agent).catch(() => undefined);
		updateWidget();
		throw error;
	}
}

async function stopSubagent(agent: ManagedSubagent, reason = "stopped by parent"): Promise<void> {
	clearIdleTimer(agent);
	agent.closing = true;
	agent.status = "stopped";
	agent.activity = "stopped";
	runtime.agents.delete(agent.id);
	endLogStream(agent);
	writeLog(agent, "session", reason);
	await Promise.allSettled([agent.client.close(), closeViewer(agent)]);
	updateWidget();
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	const first = result.content?.[0];
	return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

export default function cursorHerdrSubagents(pi: ExtensionAPI) {
	runtime.pi = pi;

	pi.on("session_start", (_event, ctx) => {
		runtime.pi = pi;
		runtime.ctx = ctx;
		if (runtime.agents.size > 0) startWidgetTimer();
		updateWidget();
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopWidgetTimer();
		if (runtime.widgetDebounce) {
			clearTimeout(runtime.widgetDebounce);
			runtime.widgetDebounce = undefined;
		}
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
		runtime.ctx = undefined;
		if (event.reason === "reload") return;

		const agents = Array.from(runtime.agents.values());
		runtime.agents.clear();
		await Promise.allSettled(agents.map((agent) => stopSubagent(agent)));
	});

	pi.registerTool({
		name: "subagent",
		label: "Cursor Subagent",
		description:
			"Manage interactive Cursor agents through ACP, with each agent visualized in a dedicated background Herdr event-viewer tab. " +
			"Actions: spawn, send, list, read, stop. spawn and send return after submission; structured ACP thoughts, tool calls, todos, and streamed messages appear in the Herdr viewer. " +
			"When a turn ends, the result is automatically steered back into Pi. The ACP session remains open for follow-ups for 15 minutes, then closes automatically. " +
			"permissionMode defaults to prompt (Pi UI when available; otherwise reject). allow-once and deny are also supported; allow-always is never auto-selected. " +
			"Models: Auto, or Grok 4.5 High with effort=high and Fast explicitly disabled. Returned output is capped at 2000 lines or 50KB.",
		promptSnippet:
			"Spawn and converse with Cursor ACP agents in Herdr. Completed turns are delivered automatically; stop sessions when finished, or they auto-close after 15 idle minutes.",
		promptGuidelines: [
			"Use subagent action=spawn to delegate independent work to Cursor ACP; choose only Auto or Grok 4.5 High.",
			"Grok 4.5 High in subagent explicitly uses effort=high and fast=false; never substitute a Fast variant.",
			"Default permissionMode is prompt so the user can approve or deny tool permissions in Pi; use allow-once or deny only when the user asks for that policy.",
			"After subagent action=spawn or action=send, do not poll or sleep. The subagent tool automatically steers the completed turn back into Pi.",
			"Use subagent action=send with the returned id for follow-ups; the same Cursor ACP session remains open.",
			"After receiving a completed result, use subagent action=stop when no more follow-up is needed. Ready sessions also close automatically after 15 minutes without a follow-up.",
			"Use subagent action=read only when the user asks to inspect the structured event log or when diagnosing a failed run.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "spawn": {
					const agent = await spawnSubagent(params, ctx);
					return {
						content: [
							{
								type: "text",
								text:
									`Cursor ACP subagent "${agent.name}" [${agent.id}] launched with ${agent.model}. ` +
									"Do not invent or assume its result. The completed turn will be delivered automatically. " +
									`Use subagent action=send with target ${JSON.stringify(agent.id)} for follow-ups.`,
							},
						],
						details: {
							action: "spawn",
							status: "started",
							id: agent.id,
							name: agent.name,
							model: agent.model,
							permissionMode: agent.permissionMode,
							sessionId: agent.sessionId,
							viewerPaneId: agent.viewerPaneId,
							viewerTabId: agent.viewerTabId,
							logPath: agent.logPath,
						},
					};
				}

				case "send": {
					const agent = resolveTarget(params.target);
					const message = params.message?.trim();
					if (!message) throw new Error("action=send requires message.");
					beginTurn(agent, message);
					return {
						content: [
							{
								type: "text",
								text: `Follow-up sent to Cursor ACP subagent "${agent.name}" [${agent.id}]. Its completed turn will be delivered automatically.`,
							},
						],
						details: {
							action: "send",
							status: "sent",
							id: agent.id,
							name: agent.name,
							turn: agent.turn,
						},
					};
				}

				case "list": {
					const agents = Array.from(runtime.agents.values());
					const text = agents.length === 0
						? "No managed Cursor ACP subagents."
						: agents
							.map(
								(agent) =>
									`- ${agent.name} [${agent.id}] — ${agent.model}, permissions=${agent.permissionMode}, ${agent.status}, ${agent.activity}, turn ${agent.turn}, ${formatElapsed(agent.createdAt)}`,
							)
							.join("\n");
					return {
						content: [{ type: "text", text }],
						details: {
							action: "list",
							agents: agents.map((agent) => ({
								id: agent.id,
								name: agent.name,
								model: agent.model,
								permissionMode: agent.permissionMode,
								status: agent.status,
								activity: agent.activity,
								turn: agent.turn,
								sessionId: agent.sessionId,
								viewerPaneId: agent.viewerPaneId,
								viewerTabId: agent.viewerTabId,
								logPath: agent.logPath,
							})),
						},
					};
				}

				case "read": {
					const agent = resolveTarget(params.target);
					endLogStream(agent);
					const raw = readFileSync(agent.logPath, "utf8");
					const result = truncateTail(raw, {
						maxLines: params.lines ?? 200,
						maxBytes: DEFAULT_MAX_BYTES,
					});
					return {
						content: [{ type: "text", text: result.content || "(empty Cursor ACP event log)" }],
						details: {
							action: "read",
							id: agent.id,
							name: agent.name,
							status: agent.status,
							logPath: agent.logPath,
							truncated: result.truncated,
						},
					};
				}

				case "stop": {
					const agent = resolveTarget(params.target);
					await stopSubagent(agent);
					return {
						content: [{ type: "text", text: `Stopped Cursor ACP subagent "${agent.name}" [${agent.id}].` }],
						details: { action: "stop", status: "stopped", id: agent.id, name: agent.name },
					};
				}
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "...";
			let text = theme.fg("toolTitle", theme.bold(`subagent ${action}`));
			if (action === "spawn") {
				text += theme.fg("accent", ` ${args.name ?? "(unnamed)"}`);
				text += theme.fg("dim", ` · ${args.model ?? "Auto"}`);
			} else if (args.target) {
				text += theme.fg("accent", ` ${args.target}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			const status = typeof details?.status === "string" ? details.status : undefined;
			const name = typeof details?.name === "string" ? details.name : undefined;
			if (status && name) {
				return new Text(
					theme.fg("accent", status === "stopped" ? "■" : "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", ` — ${status}`),
					0,
					0,
				);
			}
			return new Text(theme.fg("dim", resultText(result)), 0, 0);
		},
	});

	pi.registerMessageRenderer("cursor_subagent_result", (message, options, theme) => {
		const details = message.details as Record<string, unknown> | undefined;
		const name = typeof details?.name === "string" ? details.name : "Cursor subagent";
		const turn = typeof details?.turn === "number" ? details.turn : "?";
		const output = typeof details?.output === "string" ? details.output : String(message.content ?? "");
		const lines = output.split("\n");
		const visible = options.expanded ? lines : lines.slice(0, 10);
		const content = [
			theme.fg("success", "✓") +
				" " +
				theme.fg("toolTitle", theme.bold(name)) +
				theme.fg("dim", ` — turn ${turn} completed`),
			...visible.map((line) => theme.fg("customMessageText", line)),
		];
		if (!options.expanded && lines.length > visible.length) {
			content.push(theme.fg("muted", `… ${lines.length - visible.length} more lines`));
		}
		const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
		box.addChild(new Text(content.join("\n"), 0, 0));
		return box;
	});

	pi.registerMessageRenderer("cursor_subagent_status", (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("warning", content), 0, 0));
		return box;
	});
}
