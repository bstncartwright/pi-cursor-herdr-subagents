import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
} from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_CURSOR_MODEL,
	CursorAcpClient,
	isCursorModel,
	PACKAGE_NAME,
	type CursorModel,
	type JsonRpcMessage,
} from "./acp.ts";
import { listSubagentModels, subagentModelToolResult } from "./model-catalog.ts";
import { Mailbox, resolveAndSettlePermission, type MailEvent as MailboxEvent } from "./mailbox.ts";
import {
	createRunLedgerState,
	parseRunLedgerJsonl,
	reduceRunLedgerEvents,
	normalizeRunLedgerEvent,
	generatedThoughtPreview,
	sanitizeTerminalText,
	type RunLedgerEvent,
	type RunLedgerState,
} from "./run-ledger.ts";
import { JOURNAL_TAIL_BYTES, JOURNAL_TAIL_LINES, RAW_TAIL_BYTES, RAW_TAIL_LINES, readBoundedTail } from "./run-ledger-viewer.ts";
import { RunLedgerOverlay, type LedgerOverlaySource } from "./run-ledger-overlay.ts";
import {
	ALLOW_ONCE_IDS,
	cancelledPermissionResult,
	findPermissionOptionId,
	normalizePermissionMode,
	normalizePermissionOptions,
	redactPermissionPayload,
	rejectPermissionResult,
	permissionSelectLabels,
	resolveAgentPermissionDecision,
	resolveAutomaticPermission,
	resolvePromptPermissionSelection,
	restoreCursorConfigVerified,
	type PermissionResult,
	skippedAskQuestion,
	type PermissionMode,
} from "./helpers.ts";
import type {
	CommandResult, CommandRunner, CursorRuntime, HerdrAgent, HerdrOperations, PiRuntime, PiSessionStats,
	ManagerStateListener, ManagerStateSnapshot, PiRuntimeAgent, UnifiedStoragePaths, UnifiedSubagentDependencies, UnifiedTestObserver,
} from "./unified-deps.ts";
import { PiRpcClient, JsonlDecoder, normalizePiCompactionEvent, normalizePiRpcToolEvent, type NormalizedBackendToolEvent } from "./pi-runtime.ts";
import { formatWaitProgressRows, makeWaitProgress, waitProgressResult, type WaitProgressAgent } from "./wait-progress.ts";
import {
	TurnManifestStore, addAgentAtScope, admitFifo, closeAgent as closeManifestAgent, createParentManifest,
	enqueueTurn, materializeAgentProjections, migrateLegacyInfo, reconcileManifest, replaceCursorTurn,
	transitionTurn, touchTurn, updateAgentRuntimeResources, updateAgentMetrics,
	type AgentMetrics, type ManifestAgent, type ManifestTurn, type ParentManifestV1, type ResolvedExecutionSnapshot,
} from "./turn-manifest.ts";
export { JsonlDecoder, normalizePiCompactionEvent, normalizePiRpcToolEvent };
export type { NormalizedBackendToolEvent };

const ROOT = join(getAgentDir(), PACKAGE_NAME);
const CONFIG_PATH = join(ROOT, "config.json");
const AGENTS_DIR = join(ROOT, "agents");
const DEFAULT_RUNS_DIR = join(ROOT, "runs");
const CURSOR_CONFIG_PATH = join(homedir(), ".cursor", "cli-config.json");

const PRODUCTION_PATHS: UnifiedStoragePaths = {
	root: ROOT,
	configPath: CONFIG_PATH,
	agentsDir: AGENTS_DIR,
	runsDir: DEFAULT_RUNS_DIR,
	cursorConfigPath: CURSOR_CONFIG_PATH,
};
const MAX_AGENTS = 8;
const DEFAULT_PI_TOOLS = "read,bash,grep,find,ls";
const PERMISSION_TIMEOUT_MS = 120_000;
const CURSOR_CANCEL_TIMEOUT_MS = 2_000;
export const SUBAGENT_IDLE_CLOSE_MS = 15 * 60 * 1000;
const PARENT_SOURCE = `${PACKAGE_NAME}:unified-parent`;
const FINAL = new Set<AgentStatus>(["completed", "failed", "interrupted", "paused", "closed"]);

export type AgentBackend = "pi" | "cursor";
export type AgentStatus = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "paused" | "closed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function requirePendingApproval<T>(pendingApprovals: ReadonlyMap<string, T>, approvalId: string, agentName: string): T {
	const pending = pendingApprovals.get(approvalId);
	if (!pending) throw new Error(`No pending approval ${JSON.stringify(approvalId)} for ${agentName}.`);
	return pending;
}

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
	/** Current canonical manifest turn identity and ordinal. */
	currentTurnId?: string;
	turnSequence?: number;
	terminalReason?: string;
	metrics?: AgentMetrics;
}

/** The private viewer journal is deterministically derived, never persisted in AgentInfo. */
export function runLedgerJournalPath(info: Pick<AgentInfo, "logFile">): string {
	return info.logFile.endsWith(".events.log") ? `${info.logFile.slice(0, -".events.log".length)}.viewer.jsonl` : `${info.logFile}.viewer.jsonl`;
}

/** POSIX single-quote escaping for Herdr's shell command string. */
export function quotePosixShell(value: string): string {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export const shellQuote = quotePosixShell;

export interface RunLedgerViewerCommandOptions {
	nodeExecutable?: string;
	viewerPath: string;
	infoPath: string;
	journalPath: string;
	rawLogPath: string;
}

/** Build the only shell string handed to Herdr; every executable and path is quoted. */
export function buildRunLedgerViewerCommand(options: RunLedgerViewerCommandOptions): string {
	const node = options.nodeExecutable ?? process.execPath;
	return [
		quotePosixShell(node), "--experimental-strip-types", "--no-warnings", quotePosixShell(options.viewerPath),
		"--info", quotePosixShell(options.infoPath), "--journal", quotePosixShell(options.journalPath), "--raw", quotePosixShell(options.rawLogPath),
	].join(" ");
}

export const buildViewerCommand = buildRunLedgerViewerCommand;

const RUN_LEDGER_VIEWER_PATH = fileURLToPath(new URL("./run-ledger-viewer.ts", import.meta.url));

export function formatElapsed(startedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatPersistentWidgetMetadata(
	info: Pick<AgentInfo, "backend" | "model" | "thinking" | "status" | "createdAt">,
	now = Date.now(),
): string {
	const parts = [`[${info.backend}] ${info.model}`];
	if (info.backend === "pi") parts.push(`thinking ${info.thinking ?? "unknown"}`);
	parts.push(info.status, formatElapsed(info.createdAt, now));
	return parts.join(" · ");
}

export function compactActivityText(value: string | undefined, maxCodePoints = 120): string {
	if (!value) return "";
	const clean = value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const points = Array.from(clean);
	return points.length > maxCodePoints ? `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…` : clean;
}

export function agentActivitySummary(
	info: Pick<AgentInfo, "status" | "lastTaskMessage" | "finalResponse">,
	currentActivity?: string,
): string {
	const current = compactActivityText(currentActivity);
	if ((info.status === "starting" || info.status === "running") && current) return current;
	const result = compactActivityText(info.finalResponse);
	if (result) return `Result · ${result}`;
	const task = compactActivityText(info.lastTaskMessage);
	return task ? `Task · ${task}` : info.status === "starting" || info.status === "running" ? "Working" : "No result summary";
}

interface Config {
	storageDir?: string;
	defaults?: {
		skills?: string[];
		extensions?: string[];
	};
}

type MailEvent = MailboxEvent<AgentStatus>;


interface PendingApproval {
	id: string;
	summary: string;
	options: ReturnType<typeof normalizePermissionOptions>;
	resolve: (value: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface RuntimeHandle {
	info: AgentInfo;
	/** Callback ownership is checked against this immutable manifest identity. */
	turnId: string;
	epoch: string;
	kind: AgentBackend;
	pi?: PiRuntime;
	cursor?: CursorRuntime;
	pending: boolean;
	closing: boolean;
	generation: number;
	currentOutput: string;
	candidateError?: string;
	queuedCursorMessage?: string;
	phase: string;
	activeTools: Map<string, string>;
	/** Raw thought chunks exist only in this short-lived memory buffer. */
	thoughtChunks: number;
	thoughtCharacters: number;
	thoughtPreview?: string;
	thoughtPreviewKind?: "heading" | "generic";
	thoughtTimer?: ReturnType<typeof setTimeout>;
	promptPermissionPending: boolean;
	pendingApprovals: Map<string, PendingApproval>;
	/** Current Cursor prompt settles after ACP acknowledges completion/cancellation. */
	turnPromise?: Promise<{ stopReason?: string }>;
	metricsRefresh?: Promise<void>;
	metricsRefreshQueued?: boolean;
	metricsTimer?: ReturnType<typeof setTimeout>;
	metricsLastStartedAt?: number;
	compactionCount: number;
}


interface Waiter {
	parentSessionId: string;
	targets?: Set<string>;
	resolve: (event: MailEvent) => void;
}

interface WaitAllScope {
	parentSessionId: string;
	targets: Set<string>;
}

interface SpawnParams {
	task_name: string;
	message: string;
	backend: AgentBackend;
	agent_type?: string;
	skills?: string[];
	cwd?: string;
	pi_model?: string;
	pi_thinking?: ThinkingLevel;
	cursor_model?: string;
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

function runsDir(paths: UnifiedStoragePaths = PRODUCTION_PATHS): string {
	const config = readJson<Config>(paths.configPath);
	if (!config?.storageDir?.trim()) return paths.runsDir;
	const expanded = expandHome(config.storageDir.trim());
	return isAbsolute(expanded) ? expanded : resolve(paths.root, expanded);
}

export function parentScopeKey(parentSessionId: string): string {
	return createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24);
}

export function taskStorageKey(taskName: string): string {
	return createHash("sha256").update(taskName).digest("hex").slice(0, 24);
}

function scopeDir(parentSessionId: string, paths: UnifiedStoragePaths = PRODUCTION_PATHS): string {
	return join(runsDir(paths), parentScopeKey(parentSessionId));
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

export function selectInheritedPiTools(
	activeNames: string[],
	allTools: Array<{ name: string; sourceInfo?: { source?: string } }>,
): string {
	const active = new Set(activeNames);
	const builtins = allTools
		.filter((tool) => tool.sourceInfo?.source === "builtin" && active.has(tool.name))
		.map((tool) => tool.name);
	return builtins.length ? builtins.join(",") : DEFAULT_PI_TOOLS;
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
		? value as ThinkingLevel
		: undefined;
}

export type PiModelSelectionSource = "explicit" | "template" | "parent";
export type PiThinkingSelectionSource = "explicit" | "template" | "parent";

export interface PiSpawnSelection {
	provider: string;
	modelId: string;
	modelSource: PiModelSelectionSource;
	thinking?: ThinkingLevel;
	thinkingSource: PiThinkingSelectionSource;
}

export interface PiSpawnSelectionInput {
	piModel?: string;
	piThinking?: ThinkingLevel;
	template?: Pick<AgentTemplate, "name" | "provider" | "model" | "thinking">;
	parentModel?: { provider?: string; id?: string };
	parentThinking?: ThinkingLevel;
}

export function parsePiModel(value: string): { provider: string; modelId: string } {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	const provider = slash < 0 ? "" : trimmed.slice(0, slash).trim();
	const modelId = slash < 0 ? "" : trimmed.slice(slash + 1).trim();
	if (!provider || !modelId) {
		throw new Error("pi_model must use exact provider/model-id format with nonempty provider and model id.");
	}
	return { provider, modelId };
}

export function resolvePiSpawnSelection(input: PiSpawnSelectionInput): PiSpawnSelection {
	let provider: string;
	let modelId: string;
	let modelSource: PiModelSelectionSource;

	if (input.piModel !== undefined) {
		({ provider, modelId } = parsePiModel(input.piModel));
		modelSource = "explicit";
	} else {
		const hasTemplateProvider = input.template?.provider !== undefined;
		const hasTemplateModel = input.template?.model !== undefined;
		if (hasTemplateProvider || hasTemplateModel) {
			provider = input.template?.provider?.trim() ?? "";
			modelId = input.template?.model?.trim() ?? "";
			if (!provider || !modelId) {
				const label = input.template?.name ? ` ${input.template.name}` : "";
				throw new Error(`Pi template${label} must define both nonempty provider and model values.`);
			}
			modelSource = "template";
		} else {
			if (!input.parentModel?.provider || !input.parentModel.id) {
				throw new Error("Pi backend requires an active parent provider/model when no explicit or template model is selected.");
			}
			provider = input.parentModel.provider;
			modelId = input.parentModel.id;
			modelSource = "parent";
		}
	}

	const thinking = input.piThinking ?? input.template?.thinking ?? input.parentThinking;
	const thinkingSource: PiThinkingSelectionSource = input.piThinking !== undefined
		? "explicit"
		: input.template?.thinking !== undefined
			? "template"
			: "parent";
	return { provider, modelId, modelSource, thinking, thinkingSource };
}

export function validatePiModelSelection(
	selection: Pick<PiSpawnSelection, "provider" | "modelId" | "modelSource">,
	findModel: (provider: string, modelId: string) => unknown,
): void {
	if (selection.modelSource === "parent") return;
	if (!findModel(selection.provider, selection.modelId)) {
		throw new Error(`Pi model not found: ${selection.provider}/${selection.modelId}`);
	}
}

export function validateSpawnPiOptions(
	backend: AgentBackend,
	options: { pi_model?: string; pi_thinking?: ThinkingLevel },
): void {
	if (backend === "cursor" && (options.pi_model !== undefined || options.pi_thinking !== undefined)) {
		throw new Error("pi_model and pi_thinking are only valid when backend=pi.");
	}
}

/** Validate an exact Cursor preset discovered through list_subagent_models. */
export function requireCursorModel(value: unknown): CursorModel {
	if (!isCursorModel(value)) {
		throw new Error("Invalid cursor_model. Use list_subagent_models for an exact supported value.");
	}
	return value;
}

/** Cursor uses explicit spawn > parsed template > default; Pi intentionally ignores this field. */
export function resolveCursorSpawnModel(
	backend: AgentBackend,
	cursorModel: unknown,
	template?: Pick<AgentTemplate, "cursorModel">,
): CursorModel | undefined {
	if (backend === "pi") return undefined;
	return requireCursorModel(cursorModel === undefined ? template?.cursorModel ?? DEFAULT_CURSOR_MODEL : cursorModel);
}

export function parseAgentTemplateText(text: string, fallbackName: string): AgentTemplate {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const backend = frontmatter.backend === "pi" || frontmatter.backend === "cursor" ? frontmatter.backend : undefined;
	const cursorModel = isCursorModel(frontmatter.cursor_model) ? frontmatter.cursor_model : undefined;
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

export function listAgentTemplates(paths: UnifiedStoragePaths = PRODUCTION_PATHS): AgentTemplate[] {
	ensureDir(paths.agentsDir);
	return readdirSync(paths.agentsDir)
		.filter((name) => name.endsWith(".md"))
		.flatMap((name) => {
			try { return [parseAgentTemplateText(readFileSync(join(paths.agentsDir, name), "utf8"), name.slice(0, -3))]; }
			catch { return []; }
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function templatesDescription(paths: UnifiedStoragePaths = PRODUCTION_PATHS): string {
	const templates = listAgentTemplates(paths);
	if (!templates.length) return `No templates found. Add Markdown templates to ${paths.agentsDir}.`;
	return templates.map((template) => {
		let line = `- \`${template.name}\`${template.backend ? ` [${template.backend}]` : ""}${template.description ? ` — ${template.description}` : ""}`;
		if (template.hint) line += `\n  Caller hint: ${template.hint}`;
		return line;
	}).join("\n");
}

function log(info: Pick<AgentInfo, "logFile">, category: string, message: string): void {
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


function resolveExecutable(name: string, override?: string): string {
	if (override?.trim()) return override.trim();
	const candidates = [
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
		join(homedir(), ".local", "bin", name),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? name;
}


function runCommand(command: string, args: string[], cwd: string, timeoutMs = 5000): Promise<CommandResult> {
	return new Promise((done) => {
		const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done({ stdout, stderr, code, killed });
		};
		child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => { stderr += error.message; finish(1); });
		child.on("exit", (code) => finish(code ?? 0));
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGTERM");
			finish(1);
		}, timeoutMs);
		timer.unref?.();
	});
}

function stableString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
function own(object: Record<string, unknown> | undefined, key: string): unknown {
	return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

/** Keep only the ACP capability bit used for reconnect decisions. */
export function sanitizeAcpCapabilities(value: unknown): { loadSession?: boolean } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const loadSession = own(value as Record<string, unknown>, "loadSession");
	return typeof loadSession === "boolean" ? { loadSession } : undefined;
}

/** Cursor ACP fields are only accepted from explicit ID/input/output members, never titles. */
export function normalizeCursorToolUpdate(updateValue: unknown): NormalizedBackendToolEvent | undefined {
	const update = updateValue && typeof updateValue === "object" ? updateValue as Record<string, unknown> : undefined;
	if (!update) return undefined;
	const call = update.toolCall && typeof update.toolCall === "object" ? update.toolCall as Record<string, unknown> : undefined;
	const id = stableString(own(update, "toolCallId")) ?? stableString(own(call, "toolCallId")) ?? stableString(own(call, "id"));
	const title = stableString(own(update, "title")) ?? stableString(own(call, "title")) ?? stableString(own(call, "name")) ?? "tool";
	const status = stableString(own(update, "status")) ?? stableString(own(call, "status"));
	const terminal = !!status && /^(completed|failed|cancelled|canceled|error)$/i.test(status);
	if (!id) return { type: "tool_observed", phase: `Observed Cursor tool${title === "tool" ? "" : ` · ${title}`}` };
	const sessionUpdate = own(update, "sessionUpdate");
	if (sessionUpdate === "tool_call") return { type: "tool_start", id, name: title, input: own(update, "input") ?? own(update, "arguments") ?? own(call, "input") ?? own(call, "arguments") };
	if (terminal) return { type: "tool_end", id, status, result: own(update, "result") ?? own(update, "output") ?? own(call, "result") ?? own(call, "output"), isError: own(update, "isError") === true || own(call, "isError") === true };
	return { type: "tool_update", id, status, partialResult: own(update, "partialResult") ?? own(call, "partialResult") };
}

export interface TerminalToolEnd { id: string; status: string; }
/** Never invent a successful tool terminal state when the backend never sent one. */
export function finalizeActiveToolStatus(runStatus: "completed" | "failed"): string {
	return runStatus === "failed" ? "failed" : "settled-without-terminal-update";
}
/** Produce exact terminal events before an active-tool map is cleared. */
export function terminalizeActiveToolEvents(activeTools: ReadonlyMap<string, string>, status: string): TerminalToolEnd[] {
	return [...activeTools.keys()].map((id) => ({ id, status }));
}

export function opaqueToolValueCount(value: unknown): number | undefined {
	if (typeof value === "string") return Math.min(value.length, 100_000);
	if (Array.isArray(value)) return Math.min(value.length, 100_000);
	if (value == null) return 0;
	return undefined;
}

/** Journal permission state follows the actual ACP response, not the requested mode or log wording. */
export function permissionJournalStatus(result: PermissionResult, reason?: "expired" | "cancelled"): string {
	if (result.outcome.outcome === "cancelled") return reason ?? "cancelled";
	const id = result.outcome.optionId.toLowerCase();
	if (id === "reject-once" || id === "reject_once" || id.startsWith("reject") || id.startsWith("deny")) return "rejected";
	return "resolved";
}

function piInvocation(): { command: string; prefix: string[] } {
	if (process.env.PI_SUBAGENT_PI_BIN) return { command: resolveExecutable("pi", process.env.PI_SUBAGENT_PI_BIN), prefix: [] };
	const entry = process.argv[1];
	if (entry && existsSync(entry)) return { command: process.execPath, prefix: [entry] };
	return { command: "pi", prefix: [] };
}


class UnifiedManager {
	private readonly pi: ExtensionAPI;
	private readonly paths: UnifiedStoragePaths;
	private readonly now: () => number;
	private readonly uuid: () => string;
	private readonly epoch: string;
	private readonly commandRunner: CommandRunner;
	private readonly herdr?: HerdrOperations;
	private readonly createPiRuntime: NonNullable<UnifiedSubagentDependencies["createPiRuntime"]>;
	private readonly createCursorRuntime: NonNullable<UnifiedSubagentDependencies["createCursorRuntime"]>;
	private readonly stateListeners = new Map<string, Set<ManagerStateListener>>();
	private readonly lastSnapshots = new Map<string, string>();
	private readonly stores = new Map<string, TurnManifestStore>();
	private readonly readyParents = new Set<string>();
	private readonly live = new Map<string, RuntimeHandle>();
	private readonly controlQueues = new Map<string, Promise<void>>();
	private readonly mailbox = new Mailbox<AgentStatus>();
	private waiters: Waiter[] = [];
	private readonly waitAllScopes = new Set<WaitAllScope>();
	private readonly idleCloseTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; completedAt: number }>();
	private readonly defaultWaitTargets = new Map<string, Set<string>>();
	private readonly draining = new Set<string>();
	private readonly drainRequested = new Set<string>();
	private readonly lastActivityCommit = new Map<string, number>();
	private readonly ledgerRevisions = new Map<string, number>();
	private ctx?: ExtensionContext;
	private parentSeq = 0;
	private ledgerSeq = 0;
	private parentWorking = false;
	private parentQueue = Promise.resolve();
	private cursorConfigQueue = Promise.resolve();
	private widgetTimer?: ReturnType<typeof setInterval>;

	constructor(pi: ExtensionAPI, dependencies: UnifiedSubagentDependencies = {}) {
		this.pi = pi; this.now = dependencies.clock ?? Date.now; this.uuid = dependencies.uuid ?? randomUUID;
		this.epoch = this.uuid(); this.paths = { ...PRODUCTION_PATHS, viewerPath: RUN_LEDGER_VIEWER_PATH, ...dependencies.paths };
		this.commandRunner = dependencies.commandRunner ?? runCommand; this.herdr = dependencies.herdr;
		this.createPiRuntime = dependencies.createPiRuntime ?? ((info, handlers) => new PiRpcClient(info, handlers.onEvent, handlers.onExit, (category, message) => log(info, category, message)));
		this.createCursorRuntime = dependencies.createCursorRuntime ?? ((cwd, handlers) => new CursorAcpClient(cwd, handlers));
		this.parentSeq = this.now() * 1000; this.ledgerSeq = this.now() * 1000;
		ensureDir(this.paths.root); ensureDir(this.paths.agentsDir); ensureDir(runsDir(this.paths));
	}

	private store(parent: string): TurnManifestStore {
		let store = this.stores.get(parent);
		if (!store) { store = new TurnManifestStore(scopeDir(parent, this.paths), { now: this.now, uuid: this.uuid }); this.stores.set(parent, store); }
		return store;
	}
	/** The manifest is the only authority. Info files are write-only compatibility projections. */
	private ensureParentReady(parent: string): ParentManifestV1 {
		const store = this.store(parent); const dir = store.scopeDir;
		let manifest: ParentManifestV1;
		try {
			// A missing manifest is the one compatibility exception: import legacy projections once
			// while the store initialization lock establishes canonical ownership.
			if (!existsSync(store.manifestPath)) {
				const legacy = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".info.json")).map((name) => {
					const value = readJson<AgentInfo>(join(dir, name));
					if (!value) throw new Error(`Legacy agent projection is unreadable: ${join(dir, name)}`);
					return value;
				}) : [];
				// Legacy finalResponse was formerly projection-owned. Preserve it in the private
				// response file before the manifest records a reference to that file.
				for (const info of legacy) if (info.finalResponse !== undefined) writePrivate(info.responseFile, info.finalResponse);
				manifest = store.initialize(legacy.length ? migrateLegacyInfo(parent, this.epoch, legacy as any, this.now()) : createParentManifest(parent, this.epoch, this.now()));
			} else manifest = store.initialize(createParentManifest(parent, this.epoch, this.now()));
		} catch (error) { throw error; } // Corruption deliberately fails closed.
		if (manifest.parentSessionId !== parent) throw new Error(`Turn manifest parent session differs for ${parent}.`);
		let reconciled = false;
		if (manifest.epoch !== this.epoch) {
			// Ownership is claimed once. A stale manager must never reconcile a newer
			// manager back to its own epoch merely because an old callback fired.
			if (this.readyParents.has(parent)) throw new Error(`Turn manifest epoch ownership was lost for ${parent}.`);
			manifest = store.mutate(manifest.epoch, (current) => reconcileManifest(current, this.epoch, this.now()));
			reconciled = true;
		}
		this.readyParents.add(parent); this.writeProjections(manifest, dir);
		if (reconciled) this.scheduleReconciledViewerCleanup(parent, this.project(manifest));
		return manifest;
	}
	private scheduleReconciledViewerCleanup(parent: string, infos: AgentInfo[]): void {
		const stale = infos.filter((info) => (info.terminalReason === "restart-interrupted" || info.terminalReason === "shutdown-paused") && (info.viewerPaneId || info.viewerTabId));
		if (!stale.length) return;
		queueMicrotask(() => void (async () => {
			for (const info of stale) {
				await this.closeViewer(info).catch(() => undefined);
				try { this.mutate(parent, (current) => current.agents[info.id]?.currentTurnId === info.currentTurnId && !current.agents[info.id]?.closed ? updateAgentRuntimeResources(current, info.id, { viewerPaneId: null, viewerTabId: null }, this.now()) : current); } catch {}
			}
		})());
	}
	private response(reference: { path: string }): string | undefined {
		try { return readFileSync(reference.path, "utf8"); } catch { return undefined; }
	}
	private project(manifest: ParentManifestV1): AgentInfo[] {
		return materializeAgentProjections(manifest, { readResponse: (reference) => this.response(reference) }).map((value) => {
			const turn = value.currentTurnId ? manifest.turns[value.currentTurnId] : undefined;
			return { ...value, skills: value.skills, skillPaths: value.skillPaths, extensions: value.extensions, extensionPaths: value.extensionPaths,
				status: value.status as AgentStatus, thinking: value.thinking as ThinkingLevel | undefined, cursorModel: value.cursorModel as CursorModel | undefined,
				turnSequence: turn?.sequence, terminalReason: turn?.terminalReason, metrics: value.metrics ? { ...value.metrics, ...(value.metrics.contextUsage ? { contextUsage: { ...value.metrics.contextUsage } } : {}) } : undefined } as AgentInfo;
		});
	}
	private writeProjections(manifest: ParentManifestV1, dir = this.store(manifest.parentSessionId).scopeDir): void {
		ensureDir(dir);
		for (const info of this.project(manifest)) atomicJson(info.infoFile, info);
	}
	/** Synchronous manifest transaction, followed only by derived projections and observers. */
	private mutate(parent: string, change: (manifest: ParentManifestV1) => ParentManifestV1): ParentManifestV1 {
		this.ensureParentReady(parent); const manifest = this.store(parent).mutate(this.epoch, change);
		this.writeProjections(manifest); this.publishState(parent); this.refresh(); return manifest;
	}
	private manifest(parent: string): ParentManifestV1 { return this.ensureParentReady(parent); }
	private readScope(parent: string): AgentInfo[] { return this.project(this.manifest(parent)).sort((a, b) => b.lastActivity - a.lastActivity); }
	private readAll(): AgentInfo[] {
		const root = runsDir(this.paths); if (!existsSync(root)) return []; const infos: AgentInfo[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === "_outputs") continue;
			const store = new TurnManifestStore(join(root, entry.name), { now: this.now, uuid: this.uuid });
			const manifest = store.read(); // A corrupt historical manifest is not silently hidden.
			this.writeProjections(manifest, store.scopeDir); infos.push(...this.project(manifest));
		}
		return infos.sort((a, b) => b.lastActivity - a.lastActivity);
	}
	private current(parent: string, id: string): { manifest: ParentManifestV1; agent: ManifestAgent; turn?: ManifestTurn; info: AgentInfo } {
		const manifest = this.manifest(parent); const agent = manifest.agents[id]; if (!agent) throw new Error(`Agent not found in this parent session.`);
		const info = this.project(manifest).find((entry) => entry.id === id)!; return { manifest, agent, turn: agent.currentTurnId ? manifest.turns[agent.currentTurnId] : undefined, info };
	}

	snapshot(parentSessionId: string): ManagerStateSnapshot {
		const infos = this.readScope(parentSessionId); const queued = infos.filter((info) => info.status === "queued").sort((a, b) => (a.turnSequence ?? 0) - (b.turnSequence ?? 0));
		return { parentSessionId, agents: infos.map((info) => { const live = this.live.get(info.id); return { id: info.id, agentName: info.canonicalName, backend: info.backend, model: info.model, thinking: info.backend === "pi" ? info.thinking : undefined, status: info.status, createdAt: info.createdAt, updatedAt: info.updatedAt, startedAt: info.startedAt, completedAt: info.completedAt, closedAt: info.closedAt, lastActivityAt: info.lastActivity, activity: this.currentActivity(info) ? compactActivityText(this.currentActivity(info), 120) : null, turnId: info.currentTurnId, turnSequence: info.turnSequence, turnOrdinal: info.turn, terminalReason: info.terminalReason, queuePosition: info.status === "queued" ? queued.findIndex((entry) => entry.id === info.id) + 1 : undefined, permissionPending: !!live && (live.promptPermissionPending || live.pendingApprovals.size > 0), ledgerRevision: this.ledgerRevisions.get(info.id) ?? 0, metrics: info.backend === "pi" && info.metrics ? { ...info.metrics, ...(info.metrics.contextUsage ? { contextUsage: { ...info.metrics.contextUsage } } : {}) } : undefined }; }) };
	}
	subscribe(parent: string, listener: ManagerStateListener): () => void {
		const listeners = this.stateListeners.get(parent) ?? new Set<ManagerStateListener>();
		if (!listeners.has(listener)) { listeners.add(listener); this.stateListeners.set(parent, listeners); const snapshot = this.snapshot(parent); this.lastSnapshots.set(parent, JSON.stringify(snapshot)); try { listener(snapshot); } catch {} }
		let active = true; return () => { if (!active) return; active = false; listeners.delete(listener); if (!listeners.size) { this.stateListeners.delete(parent); this.lastSnapshots.delete(parent); } };
	}
	private publishState(parent: string): void {
		const listeners = this.stateListeners.get(parent); if (!listeners?.size) return;
		const snapshot = this.snapshot(parent); const serialized = JSON.stringify(snapshot); if (this.lastSnapshots.get(parent) === serialized) return;
		this.lastSnapshots.set(parent, serialized); for (const listener of listeners) try { listener(snapshot); } catch {}
	}
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx; try { this.ensureParentReady(this.parentSessionId(ctx)); } catch { /* tool calls expose durable corruption */ }
		this.refresh(); this.updateWidget(); if (!this.widgetTimer) { this.widgetTimer = setInterval(() => this.updateWidget(), 1000); this.widgetTimer.unref?.(); }
	}
	parentSessionId(ctx: ExtensionContext | ExtensionCommandContext): string { const id = ctx.sessionManager.getSessionId?.(); if (!id) throw new Error("The parent Pi session has no persistent session id."); return String(id); }
	templateDescription(): string { return templatesDescription(this.paths); }
	templateDirectory(): string { return this.paths.agentsDir; }
	list(parent: string, includeAll = false, pathPrefix?: string): AgentInfo[] { const prefix = pathPrefix?.trim().replace(/^\/+/, ""); return (includeAll ? this.readAll() : this.readScope(parent)).filter((info) => !prefix || info.taskName.startsWith(prefix)); }
	get(target: string, parent: string): AgentInfo { const name = normalizeTaskName(target); const info = this.readScope(parent).find((entry) => entry.taskName === name); if (!info) throw new Error(`Agent not found in this parent session: /${name}`); return info; }
	overlayInfo(target: string, parent: string, readOnly: boolean): AgentInfo {
		const name = normalizeTaskName(target); const infos = readOnly ? this.readAll() : this.readScope(parent);
		const info = infos.find((entry) => entry.parentSessionId === parent && entry.taskName === name); if (!info) throw new Error(`Agent not found: /${name}`); return info;
	}
	overlaySource(info: AgentInfo, readOnly: boolean): LedgerOverlaySource {
		const staticSnapshot = (): ManagerStateSnapshot["agents"][number] => ({
			id: info.id, agentName: info.canonicalName, backend: info.backend, model: info.model, thinking: info.backend === "pi" ? info.thinking : undefined,
			status: info.status, createdAt: info.createdAt, updatedAt: info.updatedAt, startedAt: info.startedAt, completedAt: info.completedAt, closedAt: info.closedAt,
			lastActivityAt: info.lastActivity, activity: null, turnId: info.currentTurnId, turnSequence: info.turnSequence, turnOrdinal: info.turn,
			terminalReason: info.terminalReason, permissionPending: false, ledgerRevision: 0,
			metrics: info.backend === "pi" && info.metrics ? { ...info.metrics, ...(info.metrics.contextUsage ? { contextUsage: { ...info.metrics.contextUsage } } : {}) } : undefined,
		});
		const getAgent = () => readOnly ? staticSnapshot() : this.snapshot(info.parentSessionId).agents.find((agent) => agent.id === info.id);
		const getLedger = (): RunLedgerState | undefined => {
			const agent = getAgent(); if (!agent) return undefined;
			const parsed = parseRunLedgerJsonl(readBoundedTail(runLedgerJournalPath(info), JOURNAL_TAIL_BYTES), { maxBytes: JOURNAL_TAIL_BYTES, maxLines: JOURNAL_TAIL_LINES });
			if (!parsed.events.length) return undefined;
			return reduceRunLedgerEvents(parsed.events, createRunLedgerState({ runId: agent.id, title: agent.agentName, agentName: agent.agentName, backend: agent.backend, model: agent.model, thinking: agent.thinking, runtimeState: agent.status, turn: agent.turnOrdinal, startedAt: agent.startedAt ?? agent.createdAt, metrics: agent.backend === "pi" ? agent.metrics : undefined }));
		};
		return {
			readOnly, getAgent, getLedger,
			subscribe: (listener) => readOnly ? () => {} : this.subscribe(info.parentSessionId, (snapshot) => { if (snapshot.agents.some((agent) => agent.id === info.id)) listener(); }),
			send: async (message) => { if (readOnly) throw new Error("Historical agents are read-only."); return this.send(info.parentSessionId, info.canonicalName, message); },
			interrupt: async () => { if (readOnly) throw new Error("Historical agents are read-only."); return this.interrupt(info.parentSessionId, info.canonicalName); },
			readRawDiagnostics: () => readBoundedTail(info.logFile, RAW_TAIL_BYTES).replace(/\r/g, "").split("\n").map((line) => sanitizeTerminalText(line, 500)).filter(Boolean).slice(-RAW_TAIL_LINES),
		};
	}

	private execution(agent: ManifestAgent, prompt: string, displayMessage: string): ResolvedExecutionSnapshot {
		return { backend: agent.backend, cwd: agent.cwd, model: agent.model, provider: agent.provider, modelId: agent.modelId, thinking: agent.thinking, tools: agent.tools, skills: [...agent.skills], skillPaths: [...agent.skillPaths], extensions: [...agent.extensions], extensionPaths: [...agent.extensionPaths], cursorModel: agent.cursorModel, permissionMode: agent.permissionMode, sessionFile: agent.sessionFile, prompt, displayMessage };
	}
	private initializeLedger(info: AgentInfo): void {
		const path = runLedgerJournalPath(info); ensureDir(resolve(path, "..")); const created = !existsSync(path); if (created) writePrivate(path, ""); else try { chmodSync(path, 0o600); } catch {}
		if (created) { this.appendLedger(info, { kind: "run", runId: info.id, createdAt: info.createdAt, title: info.canonicalName, agentName: info.canonicalName, backend: info.backend, model: info.model, thinking: info.thinking, cwd: info.cwd }); this.appendLedger(info, { kind: "runtime", state: info.status, detail: "journal initialized" }); }
	}
	private appendLedger(info: AgentInfo, fields: { kind: RunLedgerEvent["kind"]; turn?: number } & Record<string, unknown>): void { const now = this.now(); const seq = this.ledgerSeq = Math.max(this.ledgerSeq + 1, now * 1000); const event = normalizeRunLedgerEvent({ v: 2, seq, ts: now, turn: info.turn, ...fields }); if (event) try { appendFileSync(runLedgerJournalPath(info), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 }); this.ledgerRevisions.set(info.id, (this.ledgerRevisions.get(info.id) ?? 0) + 1); this.publishState(info.parentSessionId); } catch {} }
	private async ensurePrerequisites(backend: AgentBackend, cwd: string): Promise<void> { if (this.herdr) return this.herdr.ensure(backend, cwd); if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new Error("Subagents require Pi to run inside a Herdr workspace."); const commands: Array<[string, string[]]> = [[resolveExecutable("herdr", process.env.HERDR_BIN), ["--version"]], backend === "cursor" ? [resolveExecutable("agent", process.env.CURSOR_AGENT_BIN), ["--version"]] : [piInvocation().command, ["--version"]]]; for (const [command, args] of commands) { const result = await this.commandRunner(command, args, cwd, 5000); if (result.code !== 0) throw new Error((result.stderr || `${command} is unavailable`).trim()); } }
	private piRuntimeAgent(agent: ManifestAgent): PiRuntimeAgent { return { canonicalName: agent.canonicalName, cwd: agent.cwd, provider: agent.provider, modelId: agent.modelId, thinking: agent.thinking, tools: agent.tools, skillPaths: [...agent.skillPaths], extensionPaths: [...agent.extensionPaths], sessionFile: agent.sessionFile, logFile: agent.logFile }; }
	private herdrAgent(info: AgentInfo): HerdrAgent { return { id: info.id, canonicalName: info.canonicalName, backend: info.backend, cwd: info.cwd, viewerPaneId: info.viewerPaneId, viewerTabId: info.viewerTabId }; }
	private async createViewer(info: AgentInfo): Promise<{ paneId: string; tabId: string }> {
		if (this.herdr) return this.herdr.createViewer(this.herdrAgent(info));
		this.initializeLedger(info); let paneId: string | undefined; let tabId: string | undefined;
		try {
			const result = await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--cwd", info.cwd, "--label", `${info.taskName} [${info.backend}]`, "--no-focus"], info.cwd, 5000);
			if (result.code !== 0) throw new Error((result.stderr || result.stdout || "herdr tab create failed").trim());
			let parsed: any; try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`Unexpected Herdr output: ${result.stdout.trim()}`); }
			paneId = parsed.result?.root_pane?.pane_id; tabId = parsed.result?.tab?.tab_id ?? parsed.result?.root_pane?.tab_id;
			if (!paneId || !tabId) throw new Error("Herdr did not return viewer pane/tab ids.");
			const viewerCommand = buildRunLedgerViewerCommand({ nodeExecutable: process.execPath, viewerPath: this.paths.viewerPath ?? RUN_LEDGER_VIEWER_PATH, infoPath: info.infoFile, journalPath: runLedgerJournalPath(info), rawLogPath: info.logFile });
			const viewer = await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["pane", "run", paneId, viewerCommand], info.cwd, 5000);
			if (viewer.code !== 0) throw new Error((viewer.stderr || viewer.stdout || "Could not start Run Ledger viewer").trim());
			return { paneId, tabId };
		} catch (error) {
			// pane-run and parse failures occur after tab creation; do not leave an orphan viewer.
			try { if (tabId) await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["tab", "close", tabId], info.cwd, 5000); else if (paneId) await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["pane", "close", paneId], info.cwd, 5000); } catch {}
			throw error;
		}
	}
	private async closeViewer(info: AgentInfo): Promise<void> {
		if (!info.viewerPaneId && !info.viewerTabId) return;
		const viewer = this.herdrAgent(info);
		if (this.herdr) return this.herdr.closeViewer(viewer);
		if (viewer.viewerTabId) { const result = await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["tab", "close", viewer.viewerTabId], viewer.cwd, 5000); if (result.code === 0) return; }
		if (viewer.viewerPaneId) await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), ["pane", "close", viewer.viewerPaneId], viewer.cwd, 5000);
	}


	private enqueueControl<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.controlQueues.get(id) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(operation);
		const tail = run.then(() => undefined, () => undefined);
		this.controlQueues.set(id, tail);
		void tail.finally(() => { if (this.controlQueues.get(id) === tail) this.controlQueues.delete(id); });
		return run;
	}
	async spawn(params: SpawnParams, ctx: ExtensionContext): Promise<AgentInfo> {
		validateSpawnPiOptions(params.backend, params); const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd; if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Agent cwd is not a directory: ${cwd}`);
		const taskName = normalizeTaskName(params.task_name); const template = params.agent_type ? listAgentTemplates(this.paths).find((entry) => entry.name === params.agent_type) : undefined; if (params.agent_type && !template) throw new Error(`Agent template not found: ${params.agent_type}`); if (template?.backend && template.backend !== params.backend) throw new Error(`Template ${template.name} requires backend=${template.backend}, but spawn_agent received backend=${params.backend}.`);
		const piSelection = params.backend === "pi" ? resolvePiSpawnSelection({ piModel: params.pi_model, piThinking: params.pi_thinking, template, parentModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, parentThinking: this.pi.getThinkingLevel() as ThinkingLevel }) : undefined; if (piSelection) validatePiModelSelection(piSelection, (provider, modelId) => ctx.modelRegistry.find(provider, modelId)); const cursorModel = resolveCursorSpawnModel(params.backend, params.cursor_model, template);
		await this.ensurePrerequisites(params.backend, cwd); const parent = this.parentSessionId(ctx); const manifest = this.manifest(parent); if (Object.values(manifest.agents).filter((agent) => !agent.closed).length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} open agents are allowed per parent session.`); if (Object.values(manifest.agents).some((agent) => agent.taskName === taskName)) throw new Error(`Agent /${taskName} already exists in this parent session. Use another task_name.`);
		const id = this.uuid(); const now = this.now(); const config = readJson<Config>(this.paths.configPath) ?? {}; const configuredSkills = params.backend === "pi" ? template?.skills ?? stringList(config.defaults?.skills) : undefined; const configuredExtensions = params.backend === "pi" ? template?.extensions ?? stringList(config.defaults?.extensions) : undefined; const selectedSkills = params.backend === "pi" ? [...new Set([...(configuredSkills ?? []), ...(params.skills ?? [])])] : []; const selectedTools = params.backend === "pi" ? template?.tools ?? (configuredExtensions?.length ? undefined : selectInheritedPiTools(this.pi.getActiveTools(), this.pi.getAllTools())) : undefined;
		const proto: Omit<ManifestAgent, "nextOrdinal" | "currentTurnId" | "closed"> = { id, taskName, canonicalName: `/${taskName}`, backend: params.backend, parentSessionId: parent, parentSessionFile: ctx.sessionManager.getSessionFile?.(), agentType: params.agent_type, cwd, model: piSelection ? `${piSelection.provider}:${piSelection.modelId}` : cursorModel ?? DEFAULT_CURSOR_MODEL, provider: piSelection?.provider, modelId: piSelection?.modelId, thinking: piSelection?.thinking, tools: selectedTools, skills: selectedSkills, skillPaths: selectedSkills.map((skill) => resolveSkillPath(skill, cwd)), extensions: configuredExtensions ?? [], extensionPaths: (configuredExtensions ?? []).map((extension) => resolveExtensionPath(extension, cwd)), cursorModel, permissionMode: normalizePermissionMode(params.permission_mode ?? template?.permissionMode), sessionFile: undefined, infoFile: "", logFile: "", responseFile: "", createdAt: now, updatedAt: now };
		const prompt = [template?.prompt, params.message].filter(Boolean).join("\n\n"); const turnId = this.uuid();
		const queued = this.mutate(parent, (current) => {
			if (Object.values(current.agents).filter((agent) => !agent.closed).length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} open agents are allowed per parent session.`);
			if (Object.values(current.agents).some((agent) => agent.taskName === taskName || agent.canonicalName === `/${taskName}`)) throw new Error(`Agent /${taskName} already exists in this parent session. Use another task_name.`);
			let next = addAgentAtScope(current, this.store(parent).scopeDir, proto as any, now);
			const agent = next.agents[id]!;
			return enqueueTurn(next, { id: turnId, agentId: id, source: "initial", execution: this.execution(agent, prompt, params.message), createdAt: now, ownerEpoch: this.epoch });
		});
		let info = this.project(queued).find((entry) => entry.id === id)!;
		try {
			writePrivate(info.logFile, `${params.backend.toUpperCase()} subagent ${info.canonicalName}\nCwd: ${cwd}\nModel: ${info.model}\n\n`);
			this.initializeLedger(info); this.appendLedger(info, { kind: "runtime", state: "queued", detail: "turn queued" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.mutate(parent, (current) => transitionTurn(current, turnId, "terminal", this.now(), { status: "failed", reason: "spawn-preparation-failed", error: message }));
			throw error;
		}
		let createdViewer: { paneId: string; tabId: string } | undefined;
		try {
			createdViewer = await this.createViewer(info);
			const updated = this.mutate(parent, (current) => updateAgentRuntimeResources(current, id, { viewerPaneId: createdViewer!.paneId, viewerTabId: createdViewer!.tabId }, this.now()));
			info = this.project(updated).find((entry) => entry.id === id)!;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (createdViewer) await this.closeViewer({ ...info, viewerPaneId: createdViewer.paneId, viewerTabId: createdViewer.tabId }).catch(() => undefined);
			try {
				const failed = this.mutate(parent, (current) => transitionTurn(current, turnId, "terminal", this.now(), { status: "failed", reason: "viewer-create-failed", error: message }));
				const failedInfo = this.project(failed).find((entry) => entry.id === id)!;
				this.appendLedger(failedInfo, { kind: "error", message }); this.appendLedger(failedInfo, { kind: "completion", status: "failed", summary: message });
			} catch { /* ownership may have changed; local viewer cleanup above is still required */ }
			throw error;
		}
		const targets = this.defaultWaitTargets.get(parent) ?? new Set<string>(); targets.add(info.canonicalName); this.defaultWaitTargets.set(parent, targets); queueMicrotask(() => this.requestDrain(parent)); return info;
	}

	private requestDrain(parent: string): void { this.drainRequested.add(parent); if (this.draining.has(parent)) return; queueMicrotask(() => void this.drain(parent)); }
	private async drain(parent: string): Promise<void> {
		if (this.draining.has(parent)) return; this.draining.add(parent);
		try {
			while (this.drainRequested.delete(parent)) {
				let admittedIds: string[] = [];
				this.mutate(parent, (current) => {
					const admission = admitFifo(current, this.now(), undefined, (turn) => !!current.agents[turn.agentId]?.viewerPaneId && !!current.agents[turn.agentId]?.viewerTabId);
					admittedIds = admission.admitted;
					return admission.manifest;
				});
				if (!admittedIds.length) break;
				await Promise.all(admittedIds.map((turnId) => this.launchAdmitted(parent, turnId)));
			}
		}
		finally { this.draining.delete(parent); if (this.drainRequested.has(parent)) void this.drain(parent); }
	}
	private matching(live: RuntimeHandle, requireRunning = true, turnToken?: string): boolean {
		if (turnToken !== undefined && turnToken !== live.turnId) return false;
		if (live.epoch !== this.epoch || this.live.get(live.info.id) !== live || live.closing) return false;
		try {
			const value = this.current(live.info.parentSessionId, live.info.id);
			if (value.agent.currentTurnId !== live.turnId || value.turn?.ownerEpoch !== live.epoch) return false;
			return requireRunning ? value.turn?.state === "running" : value.turn?.state === "admitted" || value.turn?.state === "running";
		} catch { return false; }
	}
	private async withCursorConfig<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.cursorConfigQueue;
		let release!: () => void;
		this.cursorConfigQueue = new Promise<void>((done) => { release = done; });
		await previous;
		const existed = existsSync(this.paths.cursorConfigPath);
		const original = existed ? readFileSync(this.paths.cursorConfigPath, "utf8") : undefined;
		try { return await operation(); }
		finally {
			await restoreCursorConfigVerified({ path: this.paths.cursorConfigPath, existedBefore: existed, originalContent: original,
				fs: { exists: existsSync, read: (path) => readFileSync(path, "utf8"), write: (path, content) => writeFileSync(path, content, "utf8"), unlink: unlinkSync },
			}).finally(release);
		}
	}
	private async launchAdmitted(parent: string, turnId: string): Promise<void> {
		let item: ReturnType<UnifiedManager["current"]>;
		try {
			const manifest = this.manifest(parent);
			const turn = manifest.turns[turnId];
			if (!turn || turn.state !== "admitted" || turn.ownerEpoch !== this.epoch || manifest.agents[turn.agentId]?.currentTurnId !== turnId) return;
			item = this.current(parent, turn.agentId);
		} catch { return; }
		const { agent, turn, info } = item;
		if (!turn) return;

		// A settled process is deliberately retained for follow-up turns. Its callbacks close
		// over this same handle, whose turn identity is replaced before dispatch.
		const retained = this.live.get(agent.id);
		// Idle processes are retained only until a distinct turn is actually dispatched. Retire
		// them here so every turn owns an immutable handle and late callbacks cannot cross turns.
		if (retained && !retained.pending) await this.discardFreshRuntime(retained);
		const live: RuntimeHandle = {
			info, kind: agent.backend, turnId, epoch: this.epoch, pi: undefined, cursor: undefined,
			pending: true, closing: false, generation: 1, currentOutput: "", phase: "Starting",
			activeTools: new Map(), thoughtChunks: 0, thoughtCharacters: 0, promptPermissionPending: false, pendingApprovals: new Map(), compactionCount: info.metrics?.compactionCount ?? 0,
		};
		this.live.set(agent.id, live);

		try {
			if (agent.backend === "pi") {
				live.pi = this.createPiRuntime(this.piRuntimeAgent(agent), {
					onEvent: (event, token) => this.handlePiEvent(live, event, token),
					onExit: (error) => this.handleRuntimeExit(live, error),
				});
				await live.pi.start();
			} else if (!live.cursor) {
				live.cursor = this.createCursorRuntime(agent.cwd, {
					onNotification: (message, token) => this.handleCursorNotification(live, message, token),
					onRequest: (message, token) => this.handleCursorRequest(live, message, token),
					onStderr: (text) => log(info, "cursor stderr", text.trimEnd()),
					onExit: (code, signal) => this.handleRuntimeExit(live, new Error(`Cursor ACP exited (${code ?? signal ?? "unknown"}).`)),
				});
				const started = await this.withCursorConfig(() => live.cursor!.start(agent.cursorModel as CursorModel ?? DEFAULT_CURSOR_MODEL, { sessionId: agent.acpSessionId }));
				if (!this.matching(live, false)) { await this.discardFreshRuntime(live); return; }
				this.mutate(parent, (current) => updateAgentRuntimeResources(current, agent.id, { acpSessionId: started.sessionId, acpCapabilities: sanitizeAcpCapabilities(started.agentCapabilities) ?? null }, this.now()));
			}
			if (!this.matching(live, false)) { await this.discardFreshRuntime(live); return; }
			this.mutate(parent, (current) => {
				const currentTurn = current.turns[turnId];
				if (!currentTurn || current.agents[agent.id]?.currentTurnId !== turnId || currentTurn.state !== "admitted" || currentTurn.ownerEpoch !== this.epoch) return current;
				return transitionTurn(current, turnId, "running", this.now());
			});
			if (!this.matching(live)) { await this.discardFreshRuntime(live); return; }
			live.info = this.current(parent, agent.id).info;
			this.appendLedger(live.info, { kind: "runtime", state: "running", detail: "turn admitted" });
			this.appendLedger(live.info, { kind: "task", synopsis: turn.execution.displayMessage });
			log(live.info, "user", turn.execution.displayMessage);
			this.refresh();
			if (agent.backend === "pi") { this.requestMetricsRefresh(live); await live.pi!.prompt(turn.execution.prompt, turnId); }
			else {
				const generation = live.generation;
				const promise = live.cursor!.prompt(turn.execution.prompt, turnId);
				live.turnPromise = promise;
				void promise.then((result) => this.finishCursor(live, result.stopReason === "error" ? "Cursor prompt failed." : undefined, generation))
					.catch((error) => this.finishCursor(live, error instanceof Error ? error.message : String(error), generation));
			}
		} catch (error) {
			if (this.matching(live, false)) this.terminal(live, "failed", "", error instanceof Error ? error.message : String(error));
			await Promise.allSettled([live.pi?.close(), live.cursor?.close()].filter(Boolean) as Promise<void>[]); if (this.live.get(agent.id) === live) this.live.delete(agent.id);
		}
	}
	private async discardFreshRuntime(live: RuntimeHandle): Promise<void> {
		if (this.live.get(live.info.id) === live) this.live.delete(live.info.id);
		live.closing = true; live.pending = false; this.clearMetrics(live);
		await Promise.allSettled([live.pi?.close(), live.cursor?.close()].filter(Boolean) as Promise<void>[]);
	}
	private finishCursor(live: RuntimeHandle, error?: string, generation = live.generation): void { if (generation !== live.generation || !this.matching(live)) return; this.terminal(live, error ? "failed" : "completed", live.currentOutput, error); }

	async send(parent: string, target: string, message: string): Promise<{ delivery: "steer" | "cancel-and-prompt" | "prompt"; turnId: string }> {
		const info = this.get(target, parent); return this.enqueueControl(info.id, () => this.sendNow(parent, target, message));
	}
	async interrupt(parent: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parent); return this.enqueueControl(info.id, () => this.interruptNow(parent, target));
	}
	async close(parent: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parent); return this.enqueueControl(info.id, () => this.closeNow(parent, target));
	}
	private async sendNow(parent: string, target: string, message: string): Promise<{ delivery: "steer" | "cancel-and-prompt" | "prompt"; turnId: string }> {
		const info = this.get(target, parent); const item = this.current(parent, info.id); const turn = item.turn; if (item.agent.closed) throw new Error(`Agent is closed: ${info.canonicalName}`); if (!turn) throw new Error(`Agent has no current turn: ${info.canonicalName}`); if (turn.state === "queued" || turn.state === "admitted") throw new Error(`Agent ${info.canonicalName} has a queued or admitted turn and cannot receive another message.`);
		if (turn.state === "running") {
			const live = this.live.get(info.id); if (!live || !this.matching(live)) throw new Error(`Agent ${info.canonicalName} runtime is unavailable.`);
			if (item.agent.backend === "pi") { await live.pi!.steer(message); this.setPhase(live, "Applying parent correction"); this.touch(live); log(live.info, "steer", message); return { delivery: "steer", turnId: turn.id }; }
			const successor = this.uuid();
			const next = this.mutate(parent, (current) => replaceCursorTurn(current, turn.id, successor, this.execution(current.agents[info.id]!, message, message), this.now()));
			this.clearCompletionMail(parent, info.canonicalName);
			this.rejectApprovals(live, true, "active Cursor turn interrupted");
			const oldPrompt = live.turnPromise;
			live.closing = true; live.pending = false; this.clearMetrics(live); this.live.delete(info.id);
			this.appendLedger(this.project(next).find((entry) => entry.id === info.id)!, { kind: "runtime", state: "interrupted", detail: "parent corrected" });
			live.cursor!.cancel();
			// ACP cancellation can leave its prompt request unresolved. Bound the acknowledgement
			// wait, then force-close this process and reconnect the successor via session/load.
			if (oldPrompt) await Promise.race([oldPrompt.catch(() => undefined), delay(CURSOR_CANCEL_TIMEOUT_MS)]);
			await this.discardFreshRuntime(live);
			await this.launchAdmitted(parent, successor);
			return { delivery: "cancel-and-prompt", turnId: successor };
		}
		const id = this.uuid();
		let next = this.mutate(parent, (current) => enqueueTurn(current, { id, agentId: info.id, source: "follow-up", execution: this.execution(current.agents[info.id]!, message, message), createdAt: this.now(), ownerEpoch: this.epoch }));
		let updated = this.project(next).find((entry) => entry.id === info.id)!;
		// Reconciled work never resumes through its old tab. Explicit new work receives a fresh
		// queued viewer only after the stale resource is closed and its IDs are durably cleared.
		const staleViewer = info.status === "paused" || info.terminalReason === "restart-interrupted";
		if (staleViewer && (info.viewerPaneId || info.viewerTabId)) {
			await this.closeViewer(info).catch(() => undefined);
			next = this.mutate(parent, (current) => updateAgentRuntimeResources(current, info.id, { viewerPaneId: null, viewerTabId: null }, this.now()));
			updated = this.project(next).find((entry) => entry.id === info.id)!;
		}
		if (!updated.viewerPaneId || !updated.viewerTabId) {
			let createdViewer: { paneId: string; tabId: string } | undefined;
			try {
				createdViewer = await this.createViewer(updated);
				next = this.mutate(parent, (current) => updateAgentRuntimeResources(current, info.id, { viewerPaneId: createdViewer!.paneId, viewerTabId: createdViewer!.tabId }, this.now()));
				updated = this.project(next).find((entry) => entry.id === info.id)!;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (createdViewer) await this.closeViewer({ ...updated, viewerPaneId: createdViewer.paneId, viewerTabId: createdViewer.tabId }).catch(() => undefined);
				try {
					const failed = this.mutate(parent, (current) => transitionTurn(current, id, "terminal", this.now(), { status: "failed", reason: "viewer-create-failed", error: message }));
					const failedInfo = this.project(failed).find((entry) => entry.id === info.id)!;
					this.appendLedger(failedInfo, { kind: "error", message }); this.appendLedger(failedInfo, { kind: "runtime", state: "failed" }); this.appendLedger(failedInfo, { kind: "completion", status: "failed", summary: message });
				} catch {}
				this.requestDrain(parent); throw error;
			}
		}
		this.clearIdleClose(info.id); this.clearCompletionMail(parent, updated.canonicalName);
		this.appendLedger(updated, { kind: "runtime", state: "queued", detail: "follow-up queued" });
		const targets = this.defaultWaitTargets.get(parent) ?? new Set<string>(); targets.add(updated.canonicalName); this.defaultWaitTargets.set(parent, targets);
		this.requestDrain(parent); return { delivery: "prompt", turnId: id };
	}
	private async interruptNow(parent: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parent); const { turn } = this.current(parent, info.id); const previous = info.status;
		if (!turn || turn.state === "terminal") return previous;
		const next = this.mutate(parent, (current) => transitionTurn(current, turn.id, "terminal", this.now(), { status: "interrupted", reason: "agent-interrupted" }));
		const live = this.live.get(info.id);
		if (live) {
			live.pending = false; live.closing = true; this.clearMetrics(live);
			this.flushThought(live); this.terminalizeActiveTools(live, "interrupted");
			this.rejectApprovals(live, true, "agent interrupted");
			try { if (live.kind === "pi") await live.pi!.abort(); else live.cursor!.cancel(); } catch {}
			await this.discardFreshRuntime(live);
		}
		const updated = this.project(next).find((entry) => entry.id === info.id)!;
		this.appendLedger(updated, { kind: "runtime", state: "interrupted" });
		this.appendLedger(updated, { kind: "completion", status: "interrupted", summary: "agent interrupted" });
		this.pushMail(this.completionEvent(updated)); this.scheduleIdleClose(updated); this.requestDrain(parent); return previous;
	}
	private async closeNow(parent: string, target: string): Promise<AgentStatus> {
		const info = this.get(target, parent); const previous = info.status; if (previous === "closed") return previous;
		const next = this.mutate(parent, (current) => closeManifestAgent(current, info.id, "agent-closed", this.now()));
		const updated = this.project(next).find((entry) => entry.id === info.id)!; const live = this.live.get(info.id);
		if (live) {
			live.closing = true; live.pending = false; this.clearMetrics(live); this.flushThought(live); this.terminalizeActiveTools(live, "closed"); this.rejectApprovals(live, true, "agent closed");
			try { if (live.kind === "pi") await live.pi!.abort(); else live.cursor!.cancel(); } catch {}
			await Promise.allSettled([live.pi?.close(), live.cursor?.close()].filter(Boolean) as Promise<void>[]);
			this.live.delete(info.id);
		}
		this.appendLedger(updated, { kind: "runtime", state: "closed" }); this.appendLedger(updated, { kind: "completion", status: "closed", summary: "agent closed" });
		await this.closeViewer(updated).catch(() => undefined);
		this.mutate(parent, (current) => updateAgentRuntimeResources(current, info.id, { viewerPaneId: null, viewerTabId: null }, this.now()));
		this.pushMail(this.completionEvent(updated), false); this.requestDrain(parent); return previous;
	}

	private touch(live: RuntimeHandle, force = false): void {
		if (!this.matching(live)) return;
		const now = this.now();
		const key = `${live.epoch}:${live.turnId}`;
		if (!force && now - (this.lastActivityCommit.get(key) ?? 0) < 250) { this.publishState(live.info.parentSessionId); return; }
		try {
			this.mutate(live.info.parentSessionId, (current) => touchTurn(current, live.turnId, now));
			this.lastActivityCommit.set(key, now); live.info = this.current(live.info.parentSessionId, live.info.id).info;
		} catch {}
	}
	private terminal(live: RuntimeHandle, requestedStatus: "completed" | "failed", output: string, requestedError?: string, refreshMetrics = true): void {
		if (!this.matching(live, false)) return;
		let status = requestedStatus; let error = requestedError; let response: { turnId: string; path: string } | undefined;
		if (output) {
			try { writePrivate(live.info.responseFile, output); response = { turnId: live.turnId, path: live.info.responseFile }; }
			catch (writeError) { status = "failed"; error = `response-write-failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`; output = ""; }
		}
		if (refreshMetrics) this.requestMetricsRefresh(live);
		this.touch(live, true); live.pending = false; this.flushThought(live);
		this.terminalizeActiveTools(live, finalizeActiveToolStatus(status)); this.rejectApprovals(live, false, "agent completed");
		let next: ParentManifestV1;
		try {
			next = this.mutate(live.info.parentSessionId, (current) => {
				const turn = current.turns[live.turnId];
				if (!turn || current.agents[live.info.id]?.currentTurnId !== live.turnId || (turn.state !== "running" && turn.state !== "admitted") || turn.ownerEpoch !== live.epoch) return current;
				return transitionTurn(current, live.turnId, "terminal", this.now(), { status, reason: error?.startsWith("response-write-failed:") ? "response-write-failed" : undefined, error, response });
			});
		} catch { return; }
		const info = this.project(next).find((entry) => entry.id === live.info.id)!; live.info = info;
		if (error) this.appendLedger(info, { kind: "error", message: error });
		if (output) this.appendLedger(info, { kind: "response", text: output });
		this.appendLedger(info, { kind: "runtime", state: status }); this.appendLedger(info, { kind: "completion", status, summary: error ?? output });
		this.pushMail(this.completionEvent(info)); this.scheduleIdleClose(info); this.requestDrain(info.parentSessionId);
	}

	/** Coalesced best-effort Pi stats refresh. Failed/malformed replies deliberately preserve the last durable sample. */
	private requestMetricsRefresh(live: RuntimeHandle): void {
		if (live.kind !== "pi" || !live.pi || live.closing || this.live.get(live.info.id) !== live) return;
		live.metricsRefreshQueued = true;
		if (live.metricsRefresh || live.metricsTimer) return;
		const run = async () => {
			// One scheduled run owns exactly one RPC. New hints remain dirty for finally to rate-limit.
			live.metricsRefreshQueued = false;
			let stats: PiSessionStats;
			try { stats = await live.pi!.getSessionStats?.()!; } catch { return; }
			if (!stats || this.live.get(live.info.id) !== live || live.epoch !== this.epoch || live.closing) return;
			try {
				const now = this.now(); const current = this.current(live.info.parentSessionId, live.info.id);
				if (current.agent.currentTurnId !== live.turnId || current.turn?.ownerEpoch !== live.epoch) return;
				const metrics: AgentMetrics = { sampledAt: now, ...stats, compactionCount: live.compactionCount };
				const next = this.mutate(live.info.parentSessionId, (manifest) => manifest.agents[live.info.id]?.currentTurnId === live.turnId && manifest.turns[live.turnId]?.ownerEpoch === live.epoch ? updateAgentMetrics(manifest, live.info.id, metrics, now) : manifest);
				live.info = this.project(next).find((info) => info.id === live.info.id) ?? live.info;
				this.appendLedger(live.info, { kind: "metrics", ...metrics });
			} catch { /* metrics cannot affect lifecycle */ }
		};
		const start = () => { live.metricsTimer = undefined; live.metricsLastStartedAt = this.now(); live.metricsRefresh = run().finally(() => { live.metricsRefresh = undefined; if (live.metricsRefreshQueued) this.requestMetricsRefresh(live); }); };
		// Coalesce dirty lifecycle bursts and never start more than one stats RPC per handle-second.
		const wait = Math.max(0, 1_000 - (this.now() - (live.metricsLastStartedAt ?? Number.NEGATIVE_INFINITY)));
		live.metricsTimer = setTimeout(start, wait); live.metricsTimer.unref?.();
	}
	/** Persist only an already-valid sample's absolute count; never invent token fields. */
	private persistCompactionCount(live: RuntimeHandle): void {
		try {
			const current = this.current(live.info.parentSessionId, live.info.id); const prior = current.info.metrics;
			if (!prior || current.agent.currentTurnId !== live.turnId || current.turn?.ownerEpoch !== live.epoch) return;
			const metrics: AgentMetrics = { ...prior, ...(prior.contextUsage ? { contextUsage: { ...prior.contextUsage } } : {}), compactionCount: live.compactionCount };
			const now = this.now(); const next = this.mutate(live.info.parentSessionId, (manifest) => manifest.agents[live.info.id]?.currentTurnId === live.turnId && manifest.turns[live.turnId]?.ownerEpoch === live.epoch ? updateAgentMetrics(manifest, live.info.id, metrics, now) : manifest);
			live.info = this.project(next).find((info) => info.id === live.info.id) ?? live.info;
			this.appendLedger(live.info, { kind: "metrics", ...metrics });
		} catch { /* compaction lifecycle never depends on durable metrics */ }
	}
	private noteCompaction(live: RuntimeHandle, event: { state: "started" | "completed" | "aborted" | "failed"; reason?: "manual" | "threshold" | "overflow"; tokensBefore?: unknown; estimatedTokensAfter?: unknown; willRetry?: boolean }): void {
		if (event.state === "completed") { live.compactionCount++; this.persistCompactionCount(live); }
		const safeInt = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
		this.appendLedger(live.info, { kind: "compaction", state: event.state, reason: event.reason, tokensBefore: safeInt(event.tokensBefore), estimatedTokensAfter: safeInt(event.estimatedTokensAfter), willRetry: event.willRetry, compactionCount: live.compactionCount });
		if (event.state === "completed") this.requestMetricsRefresh(live);
	}
	private clearMetrics(live: RuntimeHandle): void { if (live.metricsTimer) clearTimeout(live.metricsTimer); live.metricsTimer = undefined; live.metricsRefreshQueued = false; live.metricsLastStartedAt = undefined; }
	private handleRuntimeExit(live: RuntimeHandle, error?: Error): void {
		if (this.live.get(live.info.id) !== live) return;
		this.clearMetrics(live);
		if (this.matching(live)) this.terminal(live, "failed", live.currentOutput, error?.message ?? "Subagent runtime exited unexpectedly.", false);
		// An idle process can exit between turns; never retain a dead handle.
		this.live.delete(live.info.id);
	}
	private handlePiEvent(live: RuntimeHandle, event: any, turnToken?: string): void { if (!turnToken || !this.matching(live, true, turnToken)) return; if (event.type === "text") { this.flushThought(live); live.currentOutput += event.text; this.setPhase(live, "Writing response"); log(live.info, "assistant", event.text); } else if (event.type === "thought") { this.setPhase(live, "Thinking"); this.bufferThought(live, event.text); log(live.info, "thought", event.text); } else if (event.type === "tool_start") { this.flushThought(live); live.activeTools.set(event.id, compactActivityText(event.name, 80) || "tool"); this.appendLedger(live.info, { kind: "tool-start", id: event.id, name: event.name, input: event.input }); } else if (event.type === "tool_update") { if (live.activeTools.has(event.id)) this.appendLedger(live.info, { kind: "tool-update", id: event.id, status: event.status, count: opaqueToolValueCount(event.partialResult) }); } else if (event.type === "tool_end") { live.activeTools.delete(event.id); this.appendLedger(live.info, { kind: "tool-end", id: event.id, status: event.status, result: event.result, isError: event.isError }); } else if (event.type === "tool_observed") { this.appendLedger(live.info, { kind: "phase", name: event.phase }); } else if (event.type === "phase") this.setPhase(live, event.phase); else if (event.type === "metrics_hint") this.requestMetricsRefresh(live); else if (event.type === "compaction") this.noteCompaction(live, event); else if (event.type === "settled") this.terminal(live, event.error ? "failed" : "completed", event.output ?? live.currentOutput, event.error); this.touch(live); }
	private handleCursorNotification(live: RuntimeHandle, message: JsonRpcMessage, turnToken?: string): void {
		if (!turnToken || !this.matching(live, true, turnToken)) return;
		if (message.method === "session/update") {
			const update = message.params?.update; const kind = update?.sessionUpdate;
			if (kind === "agent_message_chunk") { const text = contentText(update.content); live.currentOutput += text; this.setPhase(live, "Writing response"); log(live.info, "assistant", text); }
			else if (kind === "agent_thought_chunk") { const text = contentText(update.content); this.setPhase(live, "Thinking"); this.bufferThought(live, text); }
			else if (kind === "tool_call" || kind === "tool_call_update") {
				const tool = normalizeCursorToolUpdate(update);
				if (tool?.type === "tool_start") { live.activeTools.set(tool.id, compactActivityText(tool.name, 80) || "tool"); this.appendLedger(live.info, { kind: "tool-start", id: tool.id, name: tool.name, input: tool.input }); }
				else if (tool?.type === "tool_update") { if (live.activeTools.has(tool.id)) this.appendLedger(live.info, { kind: "tool-update", id: tool.id, status: tool.status, count: opaqueToolValueCount(tool.partialResult) }); else this.appendLedger(live.info, { kind: "phase", name: "Observed Cursor tool update", detail: tool.id }); }
				else if (tool?.type === "tool_end") { live.activeTools.delete(tool.id); this.appendLedger(live.info, { kind: "tool-end", id: tool.id, status: tool.status, result: tool.result, isError: tool.isError }); }
				else if (tool?.type === "tool_observed") this.appendLedger(live.info, { kind: "phase", name: tool.phase });
			}
		}
		this.touch(live);
	}
	private async handleCursorRequest(live: RuntimeHandle, message: JsonRpcMessage, turnToken?: string): Promise<unknown> { if (!turnToken || !this.matching(live, true, turnToken)) { if (message.method === "session/request_permission") return rejectPermissionResult(normalizePermissionOptions(message.params)); throw new Error(`Cursor request received for an inactive subagent turn: ${message.method}`); } if (message.method === "session/request_permission") return this.handlePermission(live, message.params); if (message.method === "cursor/create_plan") return { outcome: { outcome: "accepted" } }; if (message.method === "cursor/ask_question") return skippedAskQuestion("Unified ACP agents do not fabricate interactive answers."); throw new Error(`Unsupported Cursor ACP request: ${message.method}`); }
	private async handlePermission(live: RuntimeHandle, params: unknown): Promise<unknown> {
		const options = normalizePermissionOptions(params);
		if (!this.matching(live)) return rejectPermissionResult(options);
		const summary = redactPermissionPayload(params); const mode = live.info.permissionMode ?? "agent";
		this.flushThought(live); this.appendLedger(live.info, { kind: "permission", status: "pending", summary });
		if (mode === "allow-once" || mode === "deny") {
			const result = resolveAutomaticPermission(mode, options);
			this.appendLedger(live.info, { kind: "permission", status: permissionJournalStatus(result), summary }); return result;
		}
		if (mode === "prompt") {
			const ctx = this.ctx;
			if (!ctx?.hasUI) { const result = rejectPermissionResult(options); this.appendLedger(live.info, { kind: "permission", status: permissionJournalStatus(result), summary }); return result; }
			live.promptPermissionPending = true; this.publishState(live.info.parentSessionId); this.updateWidget();
			try { const result = resolvePromptPermissionSelection(options, await ctx.ui.select(`Cursor ${live.info.canonicalName} — ${summary}`, permissionSelectLabels(options), { timeout: PERMISSION_TIMEOUT_MS })); this.appendLedger(live.info, { kind: "permission", status: permissionJournalStatus(result), summary }); return result; }
			finally { live.promptPermissionPending = false; this.publishState(live.info.parentSessionId); this.updateWidget(); }
		}
		const approvalId = this.uuid().slice(0, 8);
		return new Promise((resolvePermission) => {
			const timer = setTimeout(() => { const pending = live.pendingApprovals.get(approvalId); if (pending) this.settleApproval(live, pending, () => rejectPermissionResult(options), `${approvalId} timed out`, "expired"); }, PERMISSION_TIMEOUT_MS);
			timer.unref?.(); live.pendingApprovals.set(approvalId, { id: approvalId, summary, options, resolve: resolvePermission, timer });
			this.publishState(live.info.parentSessionId); this.updateWidget();
			this.pushMail({ id: this.uuid(), parentSessionId: live.info.parentSessionId, agentName: live.info.canonicalName, kind: "permission", status: "running", approvalId, summary, allowOnceOffered: !!findPermissionOptionId(options, ALLOW_ONCE_IDS), createdAt: this.now(), turnId: live.turnId });
		});
	}
	respondPermission(parent: string, target: string, approvalId: string, decision: "approve" | "reject"): void { const info = this.get(target, parent); const live = this.live.get(info.id); if (!live || !this.matching(live)) throw new Error(`No pending approval ${JSON.stringify(approvalId)} for ${info.canonicalName}.`); const pending = requirePendingApproval(live.pendingApprovals, approvalId, info.canonicalName); this.settleApproval(live, pending, () => resolveAgentPermissionDecision(decision, pending.options), `${approvalId} ${decision}`); }
	private settleApproval<T>(live: RuntimeHandle, approval: PendingApproval, resolveDecision: () => T, note: string, reason?: "expired" | "cancelled"): T { const decision = resolveAndSettlePermission(this.mailbox, { parentSessionId: live.info.parentSessionId, agentName: live.info.canonicalName, approvalId: approval.id }, resolveDecision, (value) => { clearTimeout(approval.timer); live.pendingApprovals.delete(approval.id); approval.resolve(value); }); this.appendLedger(live.info, { kind: "permission", status: permissionJournalStatus(decision as PermissionResult, reason), summary: approval.summary }); log(live.info, "permission", note); this.publishState(live.info.parentSessionId); this.updateWidget(); return decision; }
	private rejectApprovals(live: RuntimeHandle, cancelled: boolean, reason: string): void { for (const approval of [...live.pendingApprovals.values()]) this.settleApproval(live, approval, () => cancelled ? cancelledPermissionResult() : rejectPermissionResult(approval.options), reason, cancelled ? "cancelled" : undefined); live.promptPermissionPending = false; }
	private isPermissionPending(event: MailEvent): boolean { return event.kind === "permission" && !!event.approvalId && [...this.live.values()].some((live) => live.turnId === event.turnId && live.info.parentSessionId === event.parentSessionId && live.pendingApprovals.has(event.approvalId!)); }
	private completionEvent(info: AgentInfo): MailEvent { return { id: this.uuid(), parentSessionId: info.parentSessionId, agentName: info.canonicalName, kind: "completion", status: info.status === "paused" ? "interrupted" : info.status, terminalReason: info.terminalReason, turnId: info.currentTurnId, finalResponse: info.finalResponse, error: info.error, createdAt: this.now() }; }
	private pushMail(event: MailEvent, notifyParent = true): void { if (event.kind === "permission" && !this.isPermissionPending(event)) return; if (event.kind === "completion") this.mailbox.remove((old) => old.kind === "completion" && old.parentSessionId === event.parentSessionId && old.agentName === event.agentName); const index = this.waiters.findIndex((waiter) => waiter.parentSessionId === event.parentSessionId && (!waiter.targets || waiter.targets.has(event.agentName))); if (index >= 0) { this.waiters.splice(index, 1)[0]!.resolve(event); return; } this.mailbox.push(event); if (notifyParent && ![...this.waitAllScopes].some((scope) => scope.parentSessionId === event.parentSessionId && scope.targets.has(event.agentName))) this.notifyParent(event); }
	private clearCompletionMail(parent: string, name: string): void { this.mailbox.remove((event) => event.kind === "completion" && event.parentSessionId === parent && event.agentName === name); }
	private notifyParent(event: MailEvent): void { if (event.kind === "permission") { this.pi.sendMessage({ customType: "bstn_subagent_permission", content: `Cursor ACP subagent ${event.agentName} requires permission: ${event.summary}.`, display: true, details: { ...event } }, { triggerTurn: true, deliverAs: "followUp" }); return; } const info = this.get(event.agentName, event.parentSessionId); const output = boundedResult(event.finalResponse ?? event.error ?? "", info); this.pi.sendMessage({ customType: "bstn_subagent_completion", content: `Subagent ${event.agentName} [${info.backend}] reached ${event.status}.\n\n${output.text}`, display: true, details: { ...event, backend: info.backend, output: output.text, truncated: output.truncated, fullOutputPath: output.fullOutputPath } }, { triggerTurn: true, deliverAs: "followUp" }); }
	readResponse(parent: string, target: string): { info: AgentInfo; response: string } {
		const info = this.get(target, parent); const current = this.current(parent, info.id).turn;
		return { info, response: FINAL.has(info.status) && current?.response ? this.response(current.response) ?? "" : "" };
	}
	private beginWaitProgress(parent: string, mode: "one" | "all", names: Set<string>, onUpdate?: (result: unknown) => void): () => void {
		if (!onUpdate) return () => {};
		const startedAt = this.now(); let timer: ReturnType<typeof setTimeout> | undefined; let tick: ReturnType<typeof setInterval> | undefined; let closed = false; let previous = ""; let firstSnapshot = true;
		const emit = () => { if (closed) return; const snapshot = this.snapshot(parent); const agents: WaitProgressAgent[] = snapshot.agents.map((agent) => ({ ...agent, metrics: agent.metrics ? { ...agent.metrics, ...(agent.metrics.contextUsage ? { contextUsage: { ...agent.metrics.contextUsage } } : {}) } : undefined })); onUpdate(waitProgressResult(makeWaitProgress(mode, [...names], agents, startedAt, this.now()))); };
		const schedule = (immediate = false) => { if (closed) return; if (immediate) { if (timer) clearTimeout(timer); timer = undefined; emit(); return; } if (!timer) timer = setTimeout(() => { timer = undefined; emit(); }, 250); };
		const unsubscribe = this.subscribe(parent, (snapshot) => { const relevant = snapshot.agents.filter((agent) => names.has(agent.agentName)); const next = JSON.stringify(relevant.map((agent) => ({ agentName: agent.agentName, backend: agent.backend, status: agent.status, queuePosition: agent.queuePosition, permissionPending: agent.permissionPending, activity: agent.activity, metrics: agent.metrics }))); if (firstSnapshot) { firstSnapshot = false; previous = next; return; } const urgent = relevant.some((agent) => agent.permissionPending || FINAL.has(agent.status)) && next !== previous; previous = next; schedule(urgent); });
		emit(); tick = setInterval(emit, 1000); tick.unref?.();
		return () => { if (closed) return; closed = true; unsubscribe(); if (timer) clearTimeout(timer); if (tick) clearInterval(tick); };
	}
	async waitAgent(parent: string, targets: string[] | undefined, signal?: AbortSignal, onUpdate?: (result: unknown) => void): Promise<MailEvent> {
		const names = targets?.length ? new Set(targets.map((target) => `/${normalizeTaskName(target)}`)) : undefined;
		if (names) { const known = this.readScope(parent); const missing = [...names].filter((name) => !known.some((info) => info.canonicalName === name)); if (missing.length) throw new Error(`Agent not found in this parent session: ${missing.join(", ")}`); }
		const cleanup = this.beginWaitProgress(parent, "one", names ?? new Set(this.readScope(parent).map((info) => info.canonicalName)), onUpdate);
		try {
			const currentEvent = (event: MailEvent) => { const info = this.readScope(parent).find((value) => value.canonicalName === event.agentName); return !!info && (event.turnId === undefined || event.turnId === info.currentTurnId) && (!names || names.has(event.agentName)); };
			const existing = this.mailbox.claim((event) => event.parentSessionId === parent && currentEvent(event), (event) => this.isPermissionPending(event)); if (existing) return existing;
			if (names) { const final = this.readScope(parent).filter((info) => names.has(info.canonicalName)).find((info) => FINAL.has(info.status)); if (final) return this.completionEvent(final); }
			if (signal?.aborted) throw signal.reason;
			return await new Promise<MailEvent>((resolveWait, rejectWait) => { let waiter!: Waiter; const abort = () => { this.waiters = this.waiters.filter((entry) => entry !== waiter); rejectWait(signal?.reason instanceof Error ? signal.reason : new Error("Wait cancelled.")); }; waiter = { parentSessionId: parent, targets: names, resolve: (event) => { signal?.removeEventListener("abort", abort); resolveWait(event); } }; this.waiters.push(waiter); signal?.addEventListener("abort", abort, { once: true }); });
		} finally { cleanup(); }
	}
	async waitAll(parent: string, targets: string[] | undefined, signal?: AbortSignal, onUpdate?: (result: unknown) => void): Promise<{ infos?: AgentInfo[]; event?: MailEvent }> {
		const names = targets?.length ? new Set(targets.map((target) => `/${normalizeTaskName(target)}`)) : new Set(this.defaultWaitTargets.get(parent) ?? []);
		const known = this.readScope(parent); const missing = [...names].filter((name) => !known.some((info) => info.canonicalName === name)); if (missing.length) throw new Error(`Agent not found in this parent session: ${missing.join(", ")}`);
		const scope: WaitAllScope = { parentSessionId: parent, targets: names }; this.waitAllScopes.add(scope); const cleanup = this.beginWaitProgress(parent, "all", names, onUpdate);
		try { for (;;) {
			if (signal?.aborted) throw signal.reason;
			const observed = JSON.stringify(this.snapshot(parent));
			const permission = this.mailbox.claim((event) => event.kind === "permission" && event.parentSessionId === parent && names.has(event.agentName), (event) => this.isPermissionPending(event)); if (permission) return { event: permission };
			const infos = this.readScope(parent).filter((info) => names.has(info.canonicalName));
			if (infos.length === names.size && infos.every((info) => FINAL.has(info.status))) { for (const info of infos) this.defaultWaitTargets.get(parent)?.delete(info.canonicalName); this.mailbox.remove((event) => event.kind === "completion" && event.parentSessionId === parent && names.has(event.agentName)); return { infos }; }
			await new Promise<void>((resolveWait, rejectWait) => { let done = false; let armed = false; let changedDuringSubscribe = false; let unsubscribe: () => void = () => {}; const abort = () => { if (done) return; done = true; unsubscribe(); rejectWait(signal?.reason instanceof Error ? signal.reason : new Error("Wait cancelled.")); }; const finish = () => { if (done) return; if (!armed) { changedDuringSubscribe = true; return; } done = true; unsubscribe(); signal?.removeEventListener("abort", abort); resolveWait(); }; unsubscribe = this.subscribe(parent, (snapshot) => { if (!armed) { changedDuringSubscribe ||= JSON.stringify(snapshot) !== observed; return; } finish(); }); armed = true; if (signal?.aborted) abort(); else if (changedDuringSubscribe) finish(); else signal?.addEventListener("abort", abort, { once: true }); });
		} } finally { cleanup(); this.waitAllScopes.delete(scope); }
	}
	private clearIdleClose(id: string): void { const record = this.idleCloseTimers.get(id); if (record) clearTimeout(record.timer); this.idleCloseTimers.delete(id); }
	private scheduleIdleClose(info: AgentInfo): void {
		if (!info.completedAt || info.status === "closed") return;
		this.clearIdleClose(info.id); const completedAt = info.completedAt;
		const timer = setTimeout(() => void this.autoCloseIdle(info.parentSessionId, info.id, completedAt), SUBAGENT_IDLE_CLOSE_MS);
		timer.unref?.(); this.idleCloseTimers.set(info.id, { timer, completedAt });
	}
	private async autoCloseIdle(parent: string, id: string, completedAt: number): Promise<void> {
		const record = this.idleCloseTimers.get(id); if (!record || record.completedAt !== completedAt) return;
		this.idleCloseTimers.delete(id);
		try { const info = this.current(parent, id).info; if (info.completedAt !== completedAt || !FINAL.has(info.status) || info.status === "closed") return; await this.close(parent, info.canonicalName); } catch {}
	}
	async shutdown(): Promise<void> {
		if (this.widgetTimer) clearInterval(this.widgetTimer); this.widgetTimer = undefined;
		this.ctx?.ui.setWidget(`${PACKAGE_NAME}:agents`, undefined);
		for (const timer of this.idleCloseTimers.values()) clearTimeout(timer.timer); this.idleCloseTimers.clear();
		const terminalByParent = new Map<string, AgentInfo[]>();
		for (const parent of this.readyParents) {
			try {
				const next = this.mutate(parent, (current) => {
					let updated = current;
					for (const turn of Object.values(current.turns)) {
						if (turn.state === "queued") updated = transitionTurn(updated, turn.id, "terminal", this.now(), { status: "paused", reason: "shutdown-paused" });
						else if (turn.state === "admitted" || turn.state === "running") updated = transitionTurn(updated, turn.id, "terminal", this.now(), { status: "interrupted", reason: "shutdown-interrupted" });
					}
					return updated;
				});
				terminalByParent.set(parent, this.project(next));
			} catch {}
		}
		const lives = [...this.live.values()]; this.live.clear();
		await Promise.allSettled(lives.map(async (live) => {
			const wasPending = live.pending;
			live.closing = true; live.pending = false; this.clearMetrics(live);
			if (wasPending) {
				this.flushThought(live); this.terminalizeActiveTools(live, "interrupted"); this.rejectApprovals(live, true, "shutdown");
				this.appendLedger(live.info, { kind: "runtime", state: "interrupted", detail: "shutdown" }); this.appendLedger(live.info, { kind: "completion", status: "interrupted", summary: "shutdown" });
			} else { live.activeTools.clear(); this.rejectApprovals(live, true, "shutdown"); }
			try { await Promise.all([live.pi?.close(), live.cursor?.close()].filter(Boolean) as Promise<void>[]); } catch {}
		}));
		for (const [parent, infos] of terminalByParent) {
			await Promise.allSettled(infos.map((info) => this.closeViewer(info)));
			try { this.mutate(parent, (current) => { let updated = current; for (const info of infos) if (current.agents[info.id]?.viewerPaneId || current.agents[info.id]?.viewerTabId) updated = updateAgentRuntimeResources(updated, info.id, { viewerPaneId: null, viewerTabId: null }, this.now()); return updated; }); } catch {}
		}
		// Wait cancellation only stops observation. Shutdown is a lifecycle event, so every
		// local observer receives its current target's effective interrupted completion.
		for (const waiter of this.waiters.splice(0)) {
			const infos = terminalByParent.get(waiter.parentSessionId) ?? [];
			const info = infos.find((entry) => !waiter.targets || waiter.targets.has(entry.canonicalName));
			if (info) waiter.resolve(this.completionEvent(info));
		}
		this.mailbox.remove(() => true); this.defaultWaitTargets.clear(); this.stateListeners.clear(); this.lastSnapshots.clear(); this.ctx = undefined;
		this.reportParent(false, true);
	}

	currentActivity(info: AgentInfo): string | undefined { const live = this.live.get(info.id); if (!live?.pending || !this.matching(live)) return undefined; if (live.promptPermissionPending || live.pendingApprovals.size) return "Awaiting approval"; const tool = [...live.activeTools.values()].at(-1); return tool ? `Tool · ${tool}` : live.phase || "Working"; }
	activitySummary(info: AgentInfo): string { return agentActivitySummary(info, this.currentActivity(info)); }
	private flushThought(live: RuntimeHandle): void { if (live.thoughtTimer) clearTimeout(live.thoughtTimer); live.thoughtTimer = undefined; if (!live.thoughtChunks) return; this.appendLedger(live.info, { kind: "thought", previewKind: live.thoughtPreviewKind ?? "generic", preview: live.thoughtPreview ?? "Working through details", chunks: live.thoughtChunks, characters: live.thoughtCharacters }); live.thoughtChunks = 0; live.thoughtCharacters = 0; live.thoughtPreview = undefined; live.thoughtPreviewKind = undefined; }
	private bufferThought(live: RuntimeHandle, raw: unknown): void { const text = typeof raw === "string" ? raw : ""; if (!text.trim()) return; live.thoughtChunks++; live.thoughtCharacters += Array.from(text).length; const value = generatedThoughtPreview(text); if (value) { live.thoughtPreview = value.preview; live.thoughtPreviewKind = value.previewKind; } }
	private terminalizeActiveTools(live: RuntimeHandle, status: string): void { for (const event of terminalizeActiveToolEvents(live.activeTools, status)) this.appendLedger(live.info, { kind: "tool-end", id: event.id, status: event.status }); live.activeTools.clear(); }
	private setPhase(live: RuntimeHandle, phase: string): void { if (live.phase === phase) return; live.phase = phase; this.appendLedger(live.info, { kind: "phase", name: phase }); this.publishState(live.info.parentSessionId); this.updateWidget(); }
	private refresh(): void { this.updateWidget(); const ctx = this.ctx; if (!ctx) return; try { const parent = this.parentSessionId(ctx); const working = Object.values(this.manifest(parent).turns).some((turn) => turn.state === "queued" || turn.state === "admitted" || turn.state === "running"); this.reportParent(working); } catch {} }
	reassertParent(): void { this.refresh(); }
	private updateWidget(): void { const ctx = this.ctx; if (!ctx || ctx.mode !== "tui") return; let infos: AgentInfo[]; try { infos = this.readScope(this.parentSessionId(ctx)).filter((info) => info.status !== "closed"); } catch { return; } if (!infos.length) { ctx.ui.setWidget(`${PACKAGE_NAME}:agents`, undefined); return; } const activities = new Map(infos.map((info) => [info.id, this.activitySummary(info)])); ctx.ui.setWidget(`${PACKAGE_NAME}:agents`, (_tui, theme) => ({ render: (width: number) => { const running = infos.filter((info) => ["queued", "starting", "running"].includes(info.status)).length; const lines = [theme.fg("accent", theme.bold(`Subagents — ${running} active · ${infos.length - running} settled`))]; for (const info of infos) { const color = info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning"; lines.push(`${theme.fg(color, "●")} ${theme.fg("toolTitle", info.canonicalName)} ${theme.fg("dim", formatPersistentWidgetMetadata(info))}`); lines.push(theme.fg("dim", `  ↳ ${activities.get(info.id) ?? "No task summary"}`)); } return lines.map((line) => truncateToWidth(line, width)); }, invalidate() {} })); }
	private reportParent(working: boolean, force = false): void { if (this.herdr?.reportParent) { if (!force && working === this.parentWorking) return; this.parentWorking = working; this.parentQueue = this.parentQueue.then(() => this.herdr!.reportParent!(working)).catch(() => undefined); return; } const paneId = process.env.HERDR_PANE_ID; if (!paneId || process.env.HERDR_ENV !== "1" || (!force && working === this.parentWorking)) return; this.parentWorking = working; const seq = ++this.parentSeq; const args = working ? ["pane", "report-agent", paneId, "--source", PARENT_SOURCE, "--agent", "pi", "--state", "working", "--message", "Subagent working", "--seq", String(seq)] : ["pane", "release-agent", paneId, "--source", PARENT_SOURCE, "--agent", "pi", "--seq", String(seq)]; this.parentQueue = this.parentQueue.then(async () => { await this.commandRunner(resolveExecutable("herdr", process.env.HERDR_BIN), args, this.ctx?.cwd ?? process.cwd(), 5000); }).catch(() => undefined); }
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
		text: JSON.stringify({ agent_name: event.agentName, status: event.status, terminal_reason: event.terminalReason, turn_id: event.turnId, finalResponse: output.text, error: event.error }, null, 2),
		details: { ...event, turn_id: event.turnId, terminal_reason: event.terminalReason, truncated: output.truncated, fullOutputPath: output.fullOutputPath },
	};
}

export function registerUnifiedSubagents(pi: ExtensionAPI, dependencies: UnifiedSubagentDependencies = {}): void {
	const manager = new UnifiedManager(pi, dependencies);
	const Backend = StringEnum(["pi", "cursor"] as const, { description: "Required runtime backend. Choose explicitly." });
	const PiThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Explicit Pi thinking level. Invalid for Cursor." });
	const PermissionSchema = StringEnum(["agent", "prompt", "allow-once", "deny"] as const);
	const SpawnSchema = Type.Object({
		task_name: Type.String({ description: "Session-scoped task name; slash-separated names are allowed." }),
		message: Type.String({ description: "Initial concrete task." }),
		backend: Backend,
		agent_type: Type.Optional(Type.String({ description: `Optional template from ${manager.templateDirectory()}.` })),
		skills: Type.Optional(Type.Array(Type.String(), { description: "Additional explicit Pi skills. Ignored by Cursor." })),
		cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to parent cwd." })),
		pi_model: Type.Optional(Type.String({ description: "Pi model in exact provider/model-id format. Split at the first slash; later slashes and colons remain part of the model id. Invalid for Cursor." })),
		pi_thinking: Type.Optional(PiThinkingSchema),
		cursor_model: Type.Optional(Type.String({ description: "Cursor model string. Use list_subagent_models for exact supported values." })),
		permission_mode: Type.Optional(PermissionSchema),
	});
	const TargetSchema = Type.Object({ target: Type.String({ description: "Session-owned agent task name." }) });

	const spawnTool = {
		name: "spawn_agent",
		label: "Spawn Agent",
		get description() {
			return `Spawn a fresh-context Pi or Cursor ACP subagent. backend is required explicitly. Durably queues work and returns before runtime startup; use wait_agent or wait_all_agents for results. Queued work remains visible in Herdr; reload-paused work requires an explicit new message. For Pi, pi_model must be provider/model-id and pi_thinking selects reasoning effort; each independently uses explicit spawn > template > parent precedence. Pi-only fields are rejected for Cursor. Templates can configure backend-specific model, tools, skills, extensions, and prompts.\n\nAvailable templates:\n${templatesDescription()}`;
		},
		promptSnippet: "Queue a session-scoped Pi or Cursor ACP agent; backend must be explicit.",
		promptGuidelines: [
			"Always pass backend=pi or backend=cursor explicitly to spawn_agent; never infer a hidden default.",
			"Before spawn_agent selects a non-inherited model, use list_subagent_models to discover exact backend-specific spawn values and thinking controls.",
			"For spawn_agent backend=pi, use pi_model in exact provider/model-id format and pi_thinking only when overriding template or parent defaults. Model and thinking each resolve as explicit spawn > template > parent.",
			"Never pass pi_model or pi_thinking to spawn_agent backend=cursor; use cursor_model instead.",
			"After spawn_agent, use wait_agent or wait_all_agents when the delegated result must block the current workflow; never sleep or poll.",
			"When no active wait consumes a subagent completion, it is delivered automatically as a follow-up message. Use the included result directly and do not wait for that completed turn again.",
			"Cursor ACP permission requests are returned by an active wait or delivered as follow-up messages; answer them with respond_agent_permission and wait again when needed.",
			"Settled subagents auto-close after 15 idle minutes. Use send_message before then for follow-up work, or close_agent immediately when reuse is unnecessary.",
		],
		parameters: SpawnSchema,
		async execute(_id: string, params: SpawnParams, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			const info = await manager.spawn(params, ctx);
			return textResult(`Spawned ${info.canonicalName} with backend=${info.backend}. Use wait_agent or wait_all_agents for completion.`, {
				agent_name: info.canonicalName,
				backend: info.backend,
				status: info.status,
				turn_id: info.currentTurnId,
				turn_sequence: info.turnSequence,
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
		name: "list_subagent_models",
		label: "List Subagent Models",
		description: "List exact model choices for subagent backends. Pi rows are live models with configured auth; Cursor rows are static presets and do not probe ACP installation or login. Supports substring filtering and bounded pagination.",
		promptSnippet: "List exact backend-specific subagent model and thinking parameters.",
		promptGuidelines: [
			"Use list_subagent_models before spawn_agent whenever selecting a non-inherited model; use the returned spawn_parameter as the field name and model as its exact value.",
		],
		parameters: Type.Object({
			backend: Type.Optional(Type.String({ description: "Exact backend adapter ID, such as pi or cursor." })),
			search: Type.Optional(Type.String({ description: "Case-insensitive substring over backend, model, and display_name." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based result offset. Defaults to 0." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Page size from 1 through 100. Defaults to 50." })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const catalog = await listSubagentModels(ctx, params);
			return subagentModelToolResult(catalog);
		},
		renderCall(args, theme) {
			const scope = [args.backend, args.search].filter(Boolean).join(" · ") || "all";
			return new Text(theme.fg("toolTitle", theme.bold("list_subagent_models ")) + theme.fg("accent", scope), 0, 0);
		},
		renderResult(result: any, _options, theme) {
			return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ model listing failed" : `✓ ${result.details?.models?.length ?? 0}/${result.details?.total ?? 0} models`), 0, 0);
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait Agent",
		description: "Wait without a timeout for one session-owned agent completion or Cursor permission request. Queued work stays pending; reload-paused work resolves as interrupted with terminal_reason. Omit targets to receive the next event.",
		promptSnippet: "Wait for one selected subagent completion or permission request.",
		parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal, onUpdate, ctx) {
			const parent = manager.parentSessionId(ctx);
			const event = await manager.waitAgent(parent, targets(params.targets), signal, onUpdate as any);
			const rendered = eventText(event, manager, parent);
			return textResult(rendered.text, rendered.details);
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("wait_agent ")) + theme.fg("accent", args.targets?.join(",") || "any"), 0, 0); },
		renderResult(result: any, options: any, theme) { const progress = result.details?.wait_progress; return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ wait failed" : options?.isPartial && progress ? formatWaitProgressRows(progress) : result.details?.kind === "permission" ? "⚿ permission required" : `✓ ${result.details?.agentName ?? "done"}`), 0, 0); },
	});

	pi.registerTool({
		name: "wait_all_agents",
		label: "Wait All Agents",
		description: "Wait without a timeout until all selected session-owned agents reach final status. Omit targets for agents spawned or messaged since the last wait-all.",
		promptSnippet: "Wait for all selected subagents and return their final responses.",
		parameters: Type.Object({ targets: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, signal, onUpdate, ctx) {
			const parent = manager.parentSessionId(ctx);
			const waited = await manager.waitAll(parent, targets(params.targets), signal, onUpdate as any);
			if (waited.event) {
				const rendered = eventText(waited.event, manager, parent);
				return textResult(rendered.text, rendered.details);
			}
			const responses = (waited.infos ?? []).map((info) => {
				const output = boundedResult(info.finalResponse ?? info.error ?? "", info);
				return { agent_name: info.canonicalName, backend: info.backend, status: info.status === "paused" ? "interrupted" : info.status, terminal_reason: info.terminalReason, finalResponse: output.text, error: info.error };
			});
			return textResult(JSON.stringify({ responses }, null, 2), { responses });
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("wait_all_agents ")) + theme.fg("accent", args.targets?.join(",") || "all"), 0, 0); },
		renderResult(result: any, options: any, theme) { const progress = result.details?.wait_progress; return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ wait failed" : options?.isPartial && progress ? formatWaitProgressRows(progress) : `✓ ${result.details?.responses?.length ?? 0} agents`), 0, 0); },
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
				current_activity: manager.currentActivity(info) ?? null,
				activity_summary: manager.activitySummary(info),
				elapsed: formatElapsed(info.createdAt),
				last_task_message: info.lastTaskMessage ?? null,
				turn_id: info.currentTurnId ?? null,
				terminal_reason: info.terminalReason ?? null,
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
		description: "Send a message to a session-owned agent. Pi receives true steering while active; Cursor ACP replaces an active turn with a directly admitted correction. Settled or reload-paused agents queue a new turn; queued/admitted turns reject sends.",
		parameters: Type.Object({ target: Type.String(), message: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await manager.send(manager.parentSessionId(ctx), params.target, params.message);
			return textResult(result.delivery === "steer" ? "Message steered into running Pi agent." : result.delivery === "cancel-and-prompt" ? "Running Cursor turn cancelled; corrective turn admitted on the same ACP session." : "Message queued as a new agent turn.", { target: params.target, ...result, turn_id: result.turnId });
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
			const parent = manager.parentSessionId(ctx); const previous = await manager.interrupt(parent, params.target);
			const info = manager.get(params.target, parent);
			return textResult("Interrupt handled.", { target: params.target, previous_status: previous, status: info.status, turn_id: info.currentTurnId });
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
			const parent = manager.parentSessionId(ctx); const previous = await manager.close(parent, params.target);
			const info = manager.get(params.target, parent);
			return textResult("Agent closed.", { target: params.target, previous_status: previous, status: info.status, turn_id: info.currentTurnId });
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
			let info: AgentInfo; try { info = manager.overlayInfo(target, scopeParent, includeAll); } catch { ctx.ui.notify(`Agent unavailable: ${target}`, "warning"); return; }
			const source = manager.overlaySource(info, includeAll);
			const navigation = await ctx.ui.custom<"previous" | "next" | undefined>((tui, theme, keys, done) => new RunLedgerOverlay(tui, theme, keys, source, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 },
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
			let selectedId: string | undefined;
			let includeAll = false;
			let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => { if (!includeAll) tui.requestRender(); }, 500);
			timer.unref?.();
			const finish = (value: { target: string; parent: string; includeAll: boolean } | undefined) => {
				if (timer) clearInterval(timer);
				timer = undefined;
				done(value);
			};
			const selection = (infos: AgentInfo[]) => {
				let index = selectedId ? infos.findIndex((info) => info.id === selectedId) : -1;
				if (index < 0 && infos.length) {
					index = 0;
					selectedId = infos[0]!.id;
				}
				return index;
			};
			return {
				render(width: number) {
					const infos = manager.list(currentParent, includeAll);
					const selected = selection(infos);
					const maxVisible = Math.max(1, Math.min(8, Math.floor((tui.terminal.rows - 7) / 2)));
					const start = Math.max(0, Math.min(selected - maxVisible + 1, infos.length - maxVisible));
					const visible = infos.slice(start, start + maxVisible);
					const lines = [theme.fg("accent", theme.bold(`Subagents (${includeAll ? "all sessions" : "this session"})`)), ""];
					if (!infos.length) lines.push(theme.fg("dim", "No agents. Press Tab for historical agents."));
					for (const [offset, info] of visible.entries()) {
						const index = start + offset;
						const pointer = index === selected ? theme.fg("accent", "› ") : "  ";
						const statusColor = info.status === "failed" ? "error" : info.status === "completed" ? "success" : "warning";
						lines.push(pointer + theme.fg(index === selected ? "accent" : "text", info.canonicalName.padEnd(28)) + theme.fg(statusColor, info.status.padEnd(12)) + theme.fg("dim", `${info.backend} · ${info.model} · ${formatElapsed(info.createdAt)}`));
						lines.push(theme.fg("dim", `    ↳ ${manager.activitySummary(info)}`));
					}
					const range = infos.length > maxVisible ? ` · ${start + 1}–${Math.min(infos.length, start + maxVisible)} of ${infos.length}` : "";
					lines.push("", theme.fg("dim", `enter open · tab this/all · j/k navigate · q close${range}`));
					return lines.map((line) => truncateToWidth(line, width));
				},
				handleInput(data: string) {
					const infos = manager.list(currentParent, includeAll);
					let selected = selection(infos);
					if (matchesKey(data, "escape") || data === "q") finish(undefined);
					else if (matchesKey(data, "tab")) { includeAll = !includeAll; selectedId = undefined; }
					else if ((matchesKey(data, "down") || data === "j") && infos.length) { selected = Math.min(infos.length - 1, selected + 1); selectedId = infos[selected]!.id; }
					else if ((matchesKey(data, "up") || data === "k") && infos.length) { selected = Math.max(0, selected - 1); selectedId = infos[selected]!.id; }
					else if (matchesKey(data, "return") && selected >= 0 && infos[selected]) finish({ target: infos[selected]!.canonicalName, parent: infos[selected]!.parentSessionId, includeAll });
					tui.requestRender();
				},
				invalidate() {},
				dispose() { if (timer) clearInterval(timer); timer = undefined; },
			};
		});
	}

	pi.registerMessageRenderer("bstn_subagent_completion", (message, options, theme) => {
		const details = message.details as { agentName?: string; backend?: string; status?: string; output?: string } | undefined;
		const output = details?.output ?? String(message.content ?? "");
		const lines = output.split("\n");
		const visible = options.expanded ? lines : lines.slice(0, 10);
		let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(details?.agentName ?? "Subagent"))} ${theme.fg("dim", `[${details?.backend ?? "?"}] ${details?.status ?? "completed"}`)}`;
		if (visible.length) text += `\n${visible.map((line) => theme.fg("customMessageText", line)).join("\n")}`;
		if (!options.expanded && lines.length > visible.length) text += `\n${theme.fg("muted", `… ${lines.length - visible.length} more lines`)}`;
		return new Text(text, 0, 0);
	});
	pi.registerMessageRenderer("bstn_subagent_permission", (message, _options, theme) =>
		new Text(theme.fg("warning", String(message.content ?? "Cursor permission required")), 0, 0)
	);

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
	const observer: UnifiedTestObserver = {
		snapshot: (parentSessionId) => manager.snapshot(parentSessionId),
		subscribe: (parentSessionId, listener) => manager.subscribe(parentSessionId, listener),
		shutdown: () => manager.shutdown(),
	};
	try { dependencies.onReady?.(observer); } catch { /* test observer setup cannot break registration */ }
}
