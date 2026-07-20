import type { CursorModel, JsonRpcMessage, StartedAcpSession } from "./acp.ts";

/** Narrow internal seams. Production registration supplies the current process-backed defaults. */
export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type CommandRunner = (command: string, args: string[], cwd: string, timeoutMs?: number) => Promise<CommandResult>;

export interface UnifiedStoragePaths {
	root: string;
	configPath: string;
	agentsDir: string;
	runsDir: string;
	cursorConfigPath: string;
	viewerPath?: string;
}

/** Runtime inputs deliberately exclude task prompts, thought, and tool output. */
export interface PiRuntimeAgent {
	canonicalName: string;
	cwd: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
	tools?: string;
	skillPaths?: string[];
	extensionPaths?: string[];
	sessionFile?: string;
	logFile: string;
}

/** Herdr only needs viewer identity and location, never raw agent content. */
export interface HerdrAgent {
	id: string;
	canonicalName: string;
	backend: "pi" | "cursor";
	cwd: string;
	viewerPaneId?: string;
	viewerTabId?: string;
}

export interface PiRuntime {
	/** Strict, numeric-only Pi session totals; never exposes session identifiers. */
	getSessionStats?(): Promise<PiSessionStats>;
	start(): Promise<void>;
	prompt(message: string, turnToken?: string): Promise<void>;
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
	close(): Promise<void>;
}

export interface PiSessionStats {
	inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number; contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface CursorRuntime {
	start(model: CursorModel, options?: { sessionId?: string }): Promise<StartedAcpSession>;
	prompt(message: string, turnToken?: string): Promise<{ stopReason?: string }>;
	cancel(): void;
	close(): Promise<void>;
}

export interface HerdrOperations {
	ensure(backend: "pi" | "cursor", cwd: string): Promise<void>;
	createViewer(info: HerdrAgent): Promise<{ paneId: string; tabId: string }>;
	closeViewer(info: HerdrAgent): Promise<void>;
	reportParent?(working: boolean): Promise<void>;
}

export interface AgentMetricsSnapshot extends PiSessionStats { sampledAt: number; compactionCount: number; }
export interface AgentStateSnapshot {
	id: string; agentName: string; backend: "pi" | "cursor"; model: string; thinking?: string;
	status: "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "paused" | "closed";
	createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number; closedAt?: number; lastActivityAt: number;
	/** Sanitized runtime phase/tool metadata only. */ activity: string | null;
	turnId?: string; turnSequence?: number; turnOrdinal?: number; terminalReason?: string; toolCallCount?: number; queuePosition?: number; permissionPending: boolean;
	/** In-memory semantic journal revision; never canonical lifecycle state. */ ledgerRevision: number;
	/** Pi only; Cursor intentionally has no estimates. */ metrics?: AgentMetricsSnapshot;
}
export interface ManagerStateSnapshot {
	parentSessionId: string;
	agents: AgentStateSnapshot[];
}

export type ManagerStateListener = (snapshot: ManagerStateSnapshot) => void;

/** Internal test observer: no raw agent lookup/control escapes registration. */
export interface UnifiedTestObserver {
	snapshot(parentSessionId: string): ManagerStateSnapshot;
	subscribe(parentSessionId: string, listener: ManagerStateListener): () => void;
	shutdown(): Promise<void>;
}

export interface UnifiedSubagentDependencies {
	/** Internal-only test hooks; omitted by the package entrypoint. */
	clock?: () => number;
	uuid?: () => string;
	paths?: Partial<UnifiedStoragePaths>;
	commandRunner?: CommandRunner;
	herdr?: HerdrOperations;
	createPiRuntime?: (info: PiRuntimeAgent, handlers: { onEvent(event: unknown, turnToken?: string): void; onExit(error?: Error): void }) => PiRuntime;
	/** Test seam for the globally installed Codex conversion resolver. */
	resolveCodexExtension?: () => string | undefined;
	createCursorRuntime?: (cwd: string, handlers: {
		onNotification(message: JsonRpcMessage, turnToken?: string): void;
		onRequest(message: JsonRpcMessage, turnToken?: string): Promise<unknown>;
		onStderr(text: string): void;
		onExit(code: number | null, signal: NodeJS.Signals | null): void;
	}) => CursorRuntime;
	onReady?: (observer: UnifiedTestObserver) => void;
}
