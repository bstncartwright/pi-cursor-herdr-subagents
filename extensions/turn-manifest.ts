/**
 * Phase 2A canonical turn manifest. This module is deliberately standalone and
 * unused by unified.ts until Phase 2B; it must never become a second production
 * source of truth during that intermediate step.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const TURN_MANIFEST_VERSION = 1 as const;
export const TURN_MANIFEST_FILE = "queue.manifest.json";
export const TURN_MANIFEST_LOCK_FILE = ".lock";
export const TURN_MANIFEST_RECLAIM_FILE = ".lock.reclaim";
export const DEFAULT_ACTIVE_TURN_LIMIT = 4;
export const DEFAULT_LOCK_GRACE_MS = 30_000;
export const MAX_MANIFEST_BYTES = 1_048_576;
export const MAX_MANIFEST_AGENTS = 512;
export const MAX_MANIFEST_TURNS = 8_192;
export const MAX_ARRAY_LENGTH = 128;
export const MAX_CAPABILITY_KEYS = 1;
export const MAX_LOCK_BYTES = 4_096;

export type ManifestBackend = "pi" | "cursor";
export type PermissionMode = "agent" | "prompt" | "allow-once" | "deny";
export type TurnState = "queued" | "admitted" | "running" | "terminal";
export type TerminalStatus = "completed" | "failed" | "interrupted" | "paused";
export type TurnSource = "initial" | "follow-up" | "cursor-correction";
export type AgentProjectionStatus = "queued" | "starting" | "running" | TerminalStatus | "closed";

export interface ResolvedExecutionSnapshot {
	backend: ManifestBackend;
	cwd: string;
	model: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
	tools?: string;
	skills: string[];
	skillPaths: string[];
	extensions: string[];
	extensionPaths: string[];
	cursorModel?: string;
	permissionMode: PermissionMode;
	sessionFile?: string;
	/** Private manifest fields; never surface them in state subscriptions. */
	prompt: string;
	displayMessage: string;
}

export interface ResponseReference {
	turnId: string;
	path: string;
}

export interface ManifestTurn {
	id: string;
	agentId: string;
	sequence: number;
	ordinal: number;
	source: TurnSource;
	state: TurnState;
	ownerEpoch: string;
	execution: ResolvedExecutionSnapshot;
	createdAt: number;
	admittedAt?: number;
	startedAt?: number;
	completedAt?: number;
	lastActivityAt: number;
	terminalStatus?: TerminalStatus;
	terminalReason?: string;
	error?: string;
	response?: ResponseReference;
}

export interface ManifestAgent {
	id: string;
	taskName: string;
	canonicalName: string;
	backend: ManifestBackend;
	parentSessionId: string;
	parentSessionFile?: string;
	agentType?: string;
	cwd: string;
	model: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
	tools?: string;
	skills: string[];
	skillPaths: string[];
	extensions: string[];
	extensionPaths: string[];
	cursorModel?: string;
	permissionMode: PermissionMode;
	acpSessionId?: string;
	acpCapabilities?: { loadSession?: boolean };
	sessionFile?: string;
	infoFile: string;
	logFile: string;
	responseFile: string;
	viewerPaneId?: string;
	viewerTabId?: string;
	createdAt: number;
	updatedAt: number;
	currentTurnId?: string;
	nextOrdinal: number;
	closed: boolean;
	closedAt?: number;
	closeReason?: string;
}

export interface ParentManifestV1 {
	version: typeof TURN_MANIFEST_VERSION;
	parentSessionId: string;
	epoch: string;
	nextSequence: number;
	updatedAt: number;
	agents: Record<string, ManifestAgent>;
	turns: Record<string, ManifestTurn>;
}

export interface AgentInfoProjection {
	id: string;
	taskName: string;
	canonicalName: string;
	backend: ManifestBackend;
	parentSessionId: string;
	parentSessionFile?: string;
	agentType?: string;
	cwd: string;
	model: string;
	provider?: string;
	modelId?: string;
	thinking?: string;
	tools?: string;
	skills: string[];
	skillPaths: string[];
	extensions: string[];
	extensionPaths: string[];
	cursorModel?: string;
	permissionMode?: PermissionMode;
	acpSessionId?: string;
	acpCapabilities?: { loadSession?: boolean };
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
	status: AgentProjectionStatus;
	lastTaskMessage?: string;
	error?: string;
	currentTurnId?: string;
	terminalReason?: string;
	response?: ResponseReference;
	finalResponse?: string;
}

export interface AddAgentInput extends Omit<ManifestAgent, "nextOrdinal" | "currentTurnId" | "closed" | "closedAt" | "closeReason"> {
	closed?: boolean;
	closedAt?: number;
	closeReason?: string;
}

export interface EnqueueTurnInput {
	id: string;
	agentId: string;
	source: Exclude<TurnSource, "cursor-correction">;
	execution: ResolvedExecutionSnapshot;
	createdAt: number;
	ownerEpoch?: string;
}

export interface StoreDependencies {
	now?: () => number;
	uuid?: () => string;
	pid?: () => number;
	processAlive?: (pid: number) => boolean;
	lockGraceMs?: number;
}

export interface ManifestLock {
	nonce: string;
	epoch: string;
	pid: number;
	createdAt: number;
}

function fail(message: string): never { throw new Error(`Invalid turn manifest: ${message}`); }
function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key} is unsupported`);
}
function string(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${path} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
	if (value.length > 65_536) fail(`${path} exceeds maximum length`);
	return value;
}
function optionalString(value: unknown, path: string): string | undefined { return value === undefined ? undefined : string(value, path, true); }
function safeInt(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${path} must be a nonnegative safe integer`);
	return value as number;
}
function bool(value: unknown, path: string): boolean { if (typeof value !== "boolean") fail(`${path} must be boolean`); return value; }
function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) fail(`${path} must be one of ${values.join(", ")}`);
	return value as T;
}
function optionalEnum<T extends string>(value: unknown, values: readonly T[], path: string): T | undefined { return value === undefined ? undefined : enumValue(value, values, path); }
function strings(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) fail(`${path} must be a bounded array`);
	return value.map((entry, index) => string(entry, `${path}[${index}]`, true));
}
function opaqueId(value: unknown, path: string): string {
	const id = string(value, path);
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail(`${path} must be a safe opaque identifier`);
	return id;
}
function capabilities(value: unknown, path: string): { loadSession?: boolean } | undefined {
	if (value === undefined) return undefined;
	const record = object(value, path);
	exactKeys(record, ["loadSession"], path);
	if (Object.keys(record).length > MAX_CAPABILITY_KEYS) fail(`${path} has too many capability keys`);
	if (record.loadSession !== undefined && typeof record.loadSession !== "boolean") fail(`${path}.loadSession must be boolean`);
	return record.loadSession === undefined ? {} : { loadSession: record.loadSession };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }

export function createParentManifest(parentSessionId: string, epoch: string, now: number): ParentManifestV1 {
	string(parentSessionId, "parentSessionId"); string(epoch, "epoch"); safeInt(now, "updatedAt");
	return { version: TURN_MANIFEST_VERSION, parentSessionId, epoch, nextSequence: 1, updatedAt: now, agents: {}, turns: {} };
}

export interface ParseManifestOptions { scopeDir?: string; }

export function parseParentManifest(input: unknown, options: ParseManifestOptions = {}): ParentManifestV1 {
	const root = object(input, "manifest");
	exactKeys(root, ["version", "parentSessionId", "epoch", "nextSequence", "updatedAt", "agents", "turns"], "manifest");
	if (root.version !== TURN_MANIFEST_VERSION) fail(`version ${String(root.version)} is unsupported`);
	const manifest: ParentManifestV1 = {
		version: TURN_MANIFEST_VERSION,
		parentSessionId: string(root.parentSessionId, "manifest.parentSessionId"),
		epoch: string(root.epoch, "manifest.epoch"),
		nextSequence: safeInt(root.nextSequence, "manifest.nextSequence"),
		updatedAt: safeInt(root.updatedAt, "manifest.updatedAt"),
		agents: {}, turns: {},
	};
	assert(manifest.nextSequence >= 1, "manifest.nextSequence must start at 1");
	const agents = object(root.agents, "manifest.agents");
	if (Object.keys(agents).length > MAX_MANIFEST_AGENTS) fail("manifest.agents exceeds bound");
	for (const [id, raw] of Object.entries(agents)) manifest.agents[id] = parseAgent(raw, `manifest.agents.${id}`);
	const turns = object(root.turns, "manifest.turns");
	if (Object.keys(turns).length > MAX_MANIFEST_TURNS) fail("manifest.turns exceeds bound");
	for (const [id, raw] of Object.entries(turns)) manifest.turns[id] = parseTurn(raw, `manifest.turns.${id}`);
	validateManifest(manifest);
	if (options.scopeDir !== undefined) validateManifestPaths(manifest, options.scopeDir);
	return clone(manifest);
}

function parseExecution(raw: unknown, path: string): ResolvedExecutionSnapshot {
	const value = object(raw, path);
	exactKeys(value, ["backend", "cwd", "model", "provider", "modelId", "thinking", "tools", "skills", "skillPaths", "extensions", "extensionPaths", "cursorModel", "permissionMode", "sessionFile", "prompt", "displayMessage"], path);
	return {
		backend: enumValue(value.backend, ["pi", "cursor"] as const, `${path}.backend`), cwd: string(value.cwd, `${path}.cwd`), model: string(value.model, `${path}.model`),
		provider: optionalString(value.provider, `${path}.provider`), modelId: optionalString(value.modelId, `${path}.modelId`), thinking: optionalString(value.thinking, `${path}.thinking`), tools: optionalString(value.tools, `${path}.tools`),
		skills: strings(value.skills, `${path}.skills`), skillPaths: strings(value.skillPaths, `${path}.skillPaths`), extensions: strings(value.extensions, `${path}.extensions`), extensionPaths: strings(value.extensionPaths, `${path}.extensionPaths`),
		cursorModel: optionalString(value.cursorModel, `${path}.cursorModel`), permissionMode: enumValue(value.permissionMode, ["agent", "prompt", "allow-once", "deny"] as const, `${path}.permissionMode`), sessionFile: optionalString(value.sessionFile, `${path}.sessionFile`),
		prompt: string(value.prompt, `${path}.prompt`, true), displayMessage: string(value.displayMessage, `${path}.displayMessage`, true),
	};
}
function parseResponse(raw: unknown, path: string): ResponseReference | undefined {
	if (raw === undefined) return undefined;
	const value = object(raw, path); exactKeys(value, ["turnId", "path"], path);
	return { turnId: string(value.turnId, `${path}.turnId`), path: string(value.path, `${path}.path`) };
}
function parseTurn(raw: unknown, path: string): ManifestTurn {
	const value = object(raw, path);
	exactKeys(value, ["id", "agentId", "sequence", "ordinal", "source", "state", "ownerEpoch", "execution", "createdAt", "admittedAt", "startedAt", "completedAt", "lastActivityAt", "terminalStatus", "terminalReason", "error", "response"], path);
	const state = enumValue(value.state, ["queued", "admitted", "running", "terminal"] as const, `${path}.state`);
	const terminalStatus = optionalEnum(value.terminalStatus, ["completed", "failed", "interrupted", "paused"] as const, `${path}.terminalStatus`);
	if (state === "terminal" && !terminalStatus) fail(`${path}.terminalStatus is required for terminal state`);
	if (state !== "terminal" && terminalStatus !== undefined) fail(`${path}.terminalStatus is only valid for terminal state`);
	return {
		id: opaqueId(value.id, `${path}.id`), agentId: opaqueId(value.agentId, `${path}.agentId`), sequence: safeInt(value.sequence, `${path}.sequence`), ordinal: safeInt(value.ordinal, `${path}.ordinal`),
		source: enumValue(value.source, ["initial", "follow-up", "cursor-correction"] as const, `${path}.source`), state, ownerEpoch: string(value.ownerEpoch, `${path}.ownerEpoch`), execution: parseExecution(value.execution, `${path}.execution`),
		createdAt: safeInt(value.createdAt, `${path}.createdAt`), lastActivityAt: safeInt(value.lastActivityAt, `${path}.lastActivityAt`), admittedAt: value.admittedAt === undefined ? undefined : safeInt(value.admittedAt, `${path}.admittedAt`),
		startedAt: value.startedAt === undefined ? undefined : safeInt(value.startedAt, `${path}.startedAt`), completedAt: value.completedAt === undefined ? undefined : safeInt(value.completedAt, `${path}.completedAt`),
		terminalStatus, terminalReason: optionalString(value.terminalReason, `${path}.terminalReason`), error: optionalString(value.error, `${path}.error`), response: parseResponse(value.response, `${path}.response`),
	};
}
function parseAgent(raw: unknown, path: string): ManifestAgent {
	const value = object(raw, path);
	exactKeys(value, ["id", "taskName", "canonicalName", "backend", "parentSessionId", "parentSessionFile", "agentType", "cwd", "model", "provider", "modelId", "thinking", "tools", "skills", "skillPaths", "extensions", "extensionPaths", "cursorModel", "permissionMode", "acpSessionId", "acpCapabilities", "sessionFile", "infoFile", "logFile", "responseFile", "viewerPaneId", "viewerTabId", "createdAt", "updatedAt", "currentTurnId", "nextOrdinal", "closed", "closedAt", "closeReason"], path);
	return {
		id: opaqueId(value.id, `${path}.id`), taskName: string(value.taskName, `${path}.taskName`), canonicalName: string(value.canonicalName, `${path}.canonicalName`), backend: enumValue(value.backend, ["pi", "cursor"] as const, `${path}.backend`),
		parentSessionId: string(value.parentSessionId, `${path}.parentSessionId`), parentSessionFile: optionalString(value.parentSessionFile, `${path}.parentSessionFile`), agentType: optionalString(value.agentType, `${path}.agentType`), cwd: string(value.cwd, `${path}.cwd`), model: string(value.model, `${path}.model`),
		provider: optionalString(value.provider, `${path}.provider`), modelId: optionalString(value.modelId, `${path}.modelId`), thinking: optionalString(value.thinking, `${path}.thinking`), tools: optionalString(value.tools, `${path}.tools`), skills: strings(value.skills, `${path}.skills`), skillPaths: strings(value.skillPaths, `${path}.skillPaths`), extensions: strings(value.extensions, `${path}.extensions`), extensionPaths: strings(value.extensionPaths, `${path}.extensionPaths`),
		cursorModel: optionalString(value.cursorModel, `${path}.cursorModel`), permissionMode: enumValue(value.permissionMode, ["agent", "prompt", "allow-once", "deny"] as const, `${path}.permissionMode`), acpSessionId: optionalString(value.acpSessionId, `${path}.acpSessionId`), acpCapabilities: capabilities(value.acpCapabilities, `${path}.acpCapabilities`), sessionFile: optionalString(value.sessionFile, `${path}.sessionFile`),
		infoFile: string(value.infoFile, `${path}.infoFile`), logFile: string(value.logFile, `${path}.logFile`), responseFile: string(value.responseFile, `${path}.responseFile`), viewerPaneId: optionalString(value.viewerPaneId, `${path}.viewerPaneId`), viewerTabId: optionalString(value.viewerTabId, `${path}.viewerTabId`),
		createdAt: safeInt(value.createdAt, `${path}.createdAt`), updatedAt: safeInt(value.updatedAt, `${path}.updatedAt`), currentTurnId: optionalString(value.currentTurnId, `${path}.currentTurnId`), nextOrdinal: safeInt(value.nextOrdinal, `${path}.nextOrdinal`), closed: bool(value.closed, `${path}.closed`), closedAt: value.closedAt === undefined ? undefined : safeInt(value.closedAt, `${path}.closedAt`), closeReason: optionalString(value.closeReason, `${path}.closeReason`),
	};
}

export function canonicalAgentPaths(scopeDir: string, agentId: string): Pick<ManifestAgent, "infoFile" | "logFile" | "responseFile"> & { sessionFile: string } {
	const id = opaqueId(agentId, "agentId");
	const scope = resolve(scopeDir);
	return { infoFile: join(scope, `${id}.info.json`), logFile: join(scope, `${id}.events.log`), responseFile: join(scope, `${id}.response.txt`), sessionFile: join(scope, `${id}.session.jsonl`) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function sameOptional(left: string | undefined, right: string | undefined): boolean { return left === right; }
function assertBackendConfig(agent: ManifestAgent): void {
	if (agent.backend === "pi") { assert(!!agent.provider && !!agent.modelId, `Pi agent ${agent.id} requires provider and modelId`); return; }
	assert(!!agent.cursorModel, `Cursor agent ${agent.id} requires cursorModel`);
	assert(agent.provider === undefined && agent.modelId === undefined && agent.thinking === undefined && agent.tools === undefined && agent.sessionFile === undefined, `Cursor agent ${agent.id} has Pi-only config`);
	assert(agent.skills.length === 0 && agent.skillPaths.length === 0 && agent.extensions.length === 0 && agent.extensionPaths.length === 0, `Cursor agent ${agent.id} must not have skills or extensions`);
}
function assertExecutionMatchesAgent(turn: ManifestTurn, agent: ManifestAgent): void {
	const execution = turn.execution;
	assert(execution.backend === agent.backend, `turn ${turn.id} execution backend does not match agent`);
	assert(execution.cwd === agent.cwd && execution.model === agent.model, `turn ${turn.id} execution cwd/model does not match agent`);
	assert(sameOptional(execution.provider, agent.provider) && sameOptional(execution.modelId, agent.modelId) && sameOptional(execution.thinking, agent.thinking) && sameOptional(execution.tools, agent.tools), `turn ${turn.id} execution Pi config does not match agent`);
	assert(sameStrings(execution.skills, agent.skills) && sameStrings(execution.skillPaths, agent.skillPaths) && sameStrings(execution.extensions, agent.extensions) && sameStrings(execution.extensionPaths, agent.extensionPaths), `turn ${turn.id} execution arrays do not match agent`);
	assert(sameOptional(execution.cursorModel, agent.cursorModel) && sameOptional(execution.permissionMode, agent.permissionMode) && sameOptional(execution.sessionFile, agent.sessionFile), `turn ${turn.id} execution Cursor/session config does not match agent`);
}

export function validateManifestPaths(manifest: ParentManifestV1, scopeDir: string): void {
	const scope = resolve(scopeDir);
	for (const agent of Object.values(manifest.agents)) {
		const expected = canonicalAgentPaths(scope, agent.id);
		assert(resolve(agent.infoFile) === expected.infoFile && resolve(agent.logFile) === expected.logFile && resolve(agent.responseFile) === expected.responseFile, `agent ${agent.id} has escaped or noncanonical resource paths`);
		assert(agent.backend === "pi" ? resolve(agent.sessionFile ?? "") === expected.sessionFile : agent.sessionFile === undefined, `agent ${agent.id} has invalid backend session path`);
	}
	for (const turn of Object.values(manifest.turns)) {
		if (turn.response) assert(resolve(turn.response.path) === resolve(manifest.agents[turn.agentId]!.responseFile), `turn ${turn.id} response path must equal owning agent responseFile`);
	}
}

export function validateManifest(manifest: ParentManifestV1): void {
	if (manifest.version !== TURN_MANIFEST_VERSION) fail("version is unsupported");
	assert(Object.keys(manifest.agents).length <= MAX_MANIFEST_AGENTS, "manifest.agents exceeds bound");
	assert(Object.keys(manifest.turns).length <= MAX_MANIFEST_TURNS, "manifest.turns exceeds bound");
	const ids = new Set<string>(); const sequences = new Set<number>(); const activeTurns: ManifestTurn[] = []; const perAgent = new Map<string, ManifestTurn[]>();
	for (const [key, agent] of Object.entries(manifest.agents)) {
		assert(key === agent.id, `agent key ${key} does not match id`); opaqueId(agent.id, `agent ${agent.id}.id`); assert(!ids.has(agent.id), `duplicate agent ${agent.id}`); ids.add(agent.id);
		assert(agent.parentSessionId === manifest.parentSessionId, `agent ${agent.id} has another parent session`);
		assert(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(agent.taskName), `agent ${agent.id} taskName must use normalized public task syntax`);
		assert(agent.canonicalName === `/${agent.taskName}`, `agent ${agent.id} canonicalName must equal /taskName`);
		const pathBase = `${resolve(agent.infoFile).slice(0, -".info.json".length)}`;
		assert(resolve(agent.infoFile) === agent.infoFile && agent.infoFile === `${pathBase}.info.json` && agent.logFile === `${pathBase}.events.log` && agent.responseFile === `${pathBase}.response.txt` && pathBase.endsWith(`/${agent.id}`), `agent ${agent.id} resource paths must be direct canonical agent paths`);
		assert(agent.backend === "pi" ? resolve(agent.sessionFile ?? "") === `${pathBase}.session.jsonl` : agent.sessionFile === undefined, `agent ${agent.id} has invalid backend session path`);
		assertBackendConfig(agent);
		assert(agent.nextOrdinal >= 1, `agent ${agent.id} nextOrdinal must start at 1`);
		assert(agent.updatedAt >= agent.createdAt, `agent ${agent.id} updatedAt precedes createdAt`);
		if (agent.closed) assert(agent.closedAt !== undefined && !!agent.closeReason && agent.closedAt >= agent.createdAt, `closed agent ${agent.id} requires ordered closedAt and closeReason`);
		if (!agent.closed) assert(agent.closedAt === undefined && agent.closeReason === undefined, `open agent ${agent.id} has closed metadata`);
		if (agent.acpCapabilities) assert(Object.keys(agent.acpCapabilities).every((key) => key === "loadSession") && Object.keys(agent.acpCapabilities).length <= MAX_CAPABILITY_KEYS, `agent ${agent.id} has unsupported capabilities`);
		if (agent.backend !== "cursor") assert(agent.acpSessionId === undefined && agent.acpCapabilities === undefined, `agent ${agent.id} ACP resources are only valid for Cursor`);
	}
	for (const [key, turn] of Object.entries(manifest.turns)) {
		assert(key === turn.id, `turn key ${key} does not match id`); opaqueId(turn.id, `turn ${turn.id}.id`); assert(manifest.agents[turn.agentId], `turn ${turn.id} references missing agent ${turn.agentId}`);
		const agent = manifest.agents[turn.agentId]!; assertExecutionMatchesAgent(turn, agent);
		if (turn.source === "cursor-correction") assert(agent.backend === "cursor" && turn.execution.backend === "cursor" && turn.state !== "queued" && (turn.state !== "terminal" || turn.admittedAt !== undefined), `cursor correction turn ${turn.id} must have admitted Cursor history`);
		assert(turn.sequence >= 1 && turn.sequence < manifest.nextSequence, `turn ${turn.id} sequence is out of range`);
		assert(!sequences.has(turn.sequence), `duplicate sequence ${turn.sequence}`); sequences.add(turn.sequence);
		assert(turn.ordinal >= 1 && turn.ordinal < agent.nextOrdinal, `turn ${turn.id} ordinal is out of range`);
		assert(turn.lastActivityAt >= turn.createdAt, `turn ${turn.id} lastActivityAt precedes createdAt`);
		assert(manifest.updatedAt >= turn.lastActivityAt, `manifest.updatedAt precedes turn ${turn.id}`);
		const list = perAgent.get(agent.id) ?? []; list.push(turn); perAgent.set(agent.id, list);
		if (turn.state !== "terminal") { assert(turn.ownerEpoch === manifest.epoch, `active turn ${turn.id} has stale owner epoch`); assert(!agent.closed, `closed agent ${agent.id} has active turn`); }
		if (turn.state === "admitted" || turn.state === "running") activeTurns.push(turn);
		if (turn.state === "queued") {
			assert(turn.admittedAt === undefined && turn.startedAt === undefined && turn.completedAt === undefined && turn.terminalStatus === undefined && turn.terminalReason === undefined && turn.error === undefined && turn.response === undefined, `queued turn ${turn.id} has later-state fields`);
		} else if (turn.state === "admitted") {
			assert(turn.admittedAt !== undefined && turn.admittedAt >= turn.createdAt && turn.lastActivityAt >= turn.admittedAt, `admitted turn ${turn.id} has invalid timestamps`);
			assert(turn.startedAt === undefined && turn.completedAt === undefined && turn.terminalStatus === undefined && turn.terminalReason === undefined && turn.error === undefined && turn.response === undefined, `admitted turn ${turn.id} has invalid state fields`);
		} else if (turn.state === "running") {
			assert(turn.admittedAt !== undefined && turn.startedAt !== undefined && turn.admittedAt >= turn.createdAt && turn.startedAt >= turn.admittedAt && turn.lastActivityAt >= turn.startedAt, `running turn ${turn.id} has invalid timestamps`);
			assert(turn.completedAt === undefined && turn.terminalStatus === undefined && turn.terminalReason === undefined && turn.error === undefined && turn.response === undefined, `running turn ${turn.id} has terminal fields`);
		} else {
			assert(turn.completedAt !== undefined && turn.terminalStatus !== undefined && turn.completedAt >= turn.createdAt && turn.lastActivityAt >= turn.completedAt, `terminal turn ${turn.id} has invalid timestamps`);
			if (turn.admittedAt !== undefined) assert(turn.admittedAt >= turn.createdAt && turn.completedAt >= turn.admittedAt, `terminal turn ${turn.id} admission ordering is invalid`);
			if (turn.startedAt !== undefined) { assert(turn.admittedAt !== undefined && turn.startedAt >= turn.admittedAt && turn.completedAt >= turn.startedAt, `terminal turn ${turn.id} start ordering is invalid`); }
		}
		if (turn.response) assert(turn.response.turnId === turn.id && resolve(turn.response.path) === resolve(agent.responseFile), `response reference for ${turn.id} must use owning responseFile`);
	}
	const maxSequence = Math.max(0, ...sequences);
	assert(manifest.nextSequence === maxSequence + 1, "manifest.nextSequence must exactly follow the maximum sequence");
	assert(activeTurns.length <= DEFAULT_ACTIVE_TURN_LIMIT, `manifest exceeds ${DEFAULT_ACTIVE_TURN_LIMIT} active turns`);
	for (const agent of Object.values(manifest.agents)) {
		assert(manifest.updatedAt >= agent.updatedAt, `manifest.updatedAt precedes agent ${agent.id}`);
		const turns = perAgent.get(agent.id) ?? [];
		if (turns.length === 0) { assert(agent.currentTurnId === undefined, `agent ${agent.id} has pointer without history`); continue; }
		const ordinals = new Set<number>(); for (const turn of turns) { assert(!ordinals.has(turn.ordinal), `agent ${agent.id} has duplicate ordinal ${turn.ordinal}`); ordinals.add(turn.ordinal); }
		const latestOrdinal = [...turns].sort((left, right) => right.ordinal - left.ordinal)[0]!;
		const latestSequence = [...turns].sort((left, right) => right.sequence - left.sequence)[0]!;
		assert(latestOrdinal.id === latestSequence.id && agent.currentTurnId === latestOrdinal.id, `agent ${agent.id} currentTurnId must point to latest ordinal/sequence turn`);
		assert(agent.nextOrdinal === latestOrdinal.ordinal + 1, `agent ${agent.id} nextOrdinal must follow latest turn`);
		assert(turns.filter((turn) => turn.state !== "terminal").length <= 1, `agent ${agent.id} has multiple ordinary nonterminal turns`);
	}
}

function assertMutationTime(manifest: ParentManifestV1, now: number, turn?: ManifestTurn): void {
	safeInt(now, "mutation time");
	assert(now >= manifest.updatedAt, "mutation time precedes manifest.updatedAt");
	if (turn) assert(now >= turn.lastActivityAt, `mutation time precedes turn ${turn.id} lastActivityAt`);
}

export function addAgent(manifest: ParentManifestV1, input: AddAgentInput, now: number): ParentManifestV1 {
	assertMutationTime(manifest, now); assert(input.createdAt <= now && input.updatedAt <= now, `agent ${input.id} timestamps exceed mutation time`);
	const next = clone(manifest); if (next.agents[input.id]) fail(`agent ${input.id} already exists`);
	assert(input.parentSessionId === next.parentSessionId, `agent ${input.id} has another parent session`);
	next.agents[input.id] = { ...clone(input), skills: [...input.skills], skillPaths: [...input.skillPaths], extensions: [...input.extensions], extensionPaths: [...input.extensionPaths], nextOrdinal: 1, currentTurnId: undefined, closed: input.closed ?? false };
	next.updatedAt = now; validateManifest(next); return next;
}

/** Pure constructor that derives all agent resource paths from the canonical scope and opaque ID. */
export function addAgentAtScope(manifest: ParentManifestV1, scopeDir: string, input: AddAgentInput, now: number): ParentManifestV1 {
	const paths = canonicalAgentPaths(scopeDir, input.id);
	return addAgent(manifest, { ...input, infoFile: paths.infoFile, logFile: paths.logFile, responseFile: paths.responseFile, sessionFile: input.backend === "pi" ? paths.sessionFile : undefined }, now);
}

export function enqueueTurn(manifest: ParentManifestV1, input: EnqueueTurnInput): ParentManifestV1 {
	assertMutationTime(manifest, input.createdAt);
	const next = clone(manifest); const agent = next.agents[input.agentId];
	if (input.source !== "initial" && input.source !== "follow-up") fail(`turn ${input.id} has invalid queued source`);
	if (!agent) fail(`turn ${input.id} references missing agent ${input.agentId}`);
	if (next.turns[input.id]) fail(`turn ${input.id} already exists`);
	if (agent.closed) fail(`agent ${agent.id} is closed`);
	if (agent.currentTurnId && next.turns[agent.currentTurnId]?.state !== "terminal") fail(`agent ${agent.id} already has a nonterminal turn`);
	const turn: ManifestTurn = { id: input.id, agentId: input.agentId, sequence: next.nextSequence++, ordinal: agent.nextOrdinal++, source: input.source, state: "queued", ownerEpoch: input.ownerEpoch ?? next.epoch, execution: clone(input.execution), createdAt: input.createdAt, lastActivityAt: input.createdAt };
	next.turns[turn.id] = turn; agent.currentTurnId = turn.id; agent.updatedAt = input.createdAt; next.updatedAt = input.createdAt; validateManifest(next); return next;
}

export function transitionTurn(manifest: ParentManifestV1, turnId: string, state: TurnState, now: number, terminal?: { status: TerminalStatus; reason?: string; error?: string; response?: ResponseReference }): ParentManifestV1 {
	const original = manifest.turns[turnId]; if (!original) fail(`turn ${turnId} does not exist`); assertMutationTime(manifest, now, original);
	const next = clone(manifest); const turn = next.turns[turnId]; if (!turn) fail(`turn ${turnId} does not exist`);
	const legal: Record<TurnState, TurnState[]> = { queued: ["admitted", "terminal"], admitted: ["running", "terminal"], running: ["terminal"], terminal: [] };
	if (!legal[turn.state].includes(state)) fail(`illegal transition ${turn.state} -> ${state} for ${turnId}`);
	if (state === "terminal") {
		if (!terminal) fail(`terminal transition for ${turnId} requires terminal details`);
		turn.state = "terminal"; turn.terminalStatus = terminal.status; turn.terminalReason = terminal.reason; turn.error = terminal.error; turn.response = terminal.response ? clone(terminal.response) : undefined; turn.completedAt = now; turn.lastActivityAt = now;
	} else if (state === "admitted") { turn.state = state; turn.admittedAt = now; turn.lastActivityAt = now; }
	else { turn.state = state; turn.startedAt = now; turn.lastActivityAt = now; }
	next.agents[turn.agentId]!.updatedAt = now; next.updatedAt = now; validateManifest(next); return next;
}

/** Records activity from the current live turn without permitting terminal or stale callbacks. */
export function touchTurn(manifest: ParentManifestV1, turnId: string, now: number): ParentManifestV1 {
	const original = manifest.turns[turnId]; if (!original) fail(`turn ${turnId} does not exist`);
	assert(original.state !== "terminal", `cannot touch terminal turn ${turnId}`); assert(manifest.agents[original.agentId]?.currentTurnId === turnId, `turn ${turnId} is not the agent current turn`);
	assertMutationTime(manifest, now, original);
	const next = clone(manifest); const turn = next.turns[turnId]!; turn.lastActivityAt = now;
	next.agents[turn.agentId]!.updatedAt = now; next.updatedAt = now; validateManifest(next); return next;
}

export interface AgentRuntimeResourceUpdate {
	/** Viewer resources are a pair; pass both null to explicitly clear persisted IDs. */
	viewerPaneId?: string | null;
	viewerTabId?: string | null;
	/** ACP state is Cursor-only; null explicitly clears the persisted value. */
	acpSessionId?: string | null;
	acpCapabilities?: { loadSession?: boolean } | null;
}

/** Applies the narrowly allowed runtime-owned resource fields without changing execution config. */
export function updateAgentRuntimeResources(manifest: ParentManifestV1, agentId: string, update: AgentRuntimeResourceUpdate, now: number): ParentManifestV1 {
	const original = manifest.agents[agentId]; if (!original) fail(`agent ${agentId} does not exist`);
	assertMutationTime(manifest, now); assert(now >= original.updatedAt, `mutation time precedes agent ${agentId} updatedAt`);
	const checked = object(update, "agent runtime resources"); exactKeys(checked, ["viewerPaneId", "viewerTabId", "acpSessionId", "acpCapabilities"], "agent runtime resources");
	const has = (key: string) => Object.prototype.hasOwnProperty.call(checked, key);
	const hasPane = has("viewerPaneId"); const hasTab = has("viewerTabId"); const hasAcpSession = has("acpSessionId"); const hasAcpCapabilities = has("acpCapabilities");
	assert(hasPane || hasTab || hasAcpSession || hasAcpCapabilities, "agent runtime resources must update at least one field");
	assert(hasPane === hasTab, "viewerPaneId and viewerTabId must be updated as a pair");
	if (hasPane) {
		assert((update.viewerPaneId === null && update.viewerTabId === null) || (typeof update.viewerPaneId === "string" && typeof update.viewerTabId === "string"), "viewerPaneId and viewerTabId must both be strings or both null");
		if (update.viewerPaneId !== null) { optionalString(update.viewerPaneId, "agent runtime resources.viewerPaneId"); optionalString(update.viewerTabId, "agent runtime resources.viewerTabId"); }
	}
	if (hasAcpSession || hasAcpCapabilities) assert(original.backend === "cursor", `agent ${agentId} ACP resources are only valid for Cursor`);
	if (hasAcpSession && update.acpSessionId !== null) optionalString(update.acpSessionId, "agent runtime resources.acpSessionId");
	if (hasAcpCapabilities && update.acpCapabilities !== null) capabilities(update.acpCapabilities, "agent runtime resources.acpCapabilities");
	const next = clone(manifest); const agent = next.agents[agentId]!;
	if (hasPane) { if (update.viewerPaneId === null) { delete agent.viewerPaneId; delete agent.viewerTabId; } else { agent.viewerPaneId = update.viewerPaneId; agent.viewerTabId = update.viewerTabId!; } }
	if (hasAcpSession) { if (update.acpSessionId === null) delete agent.acpSessionId; else agent.acpSessionId = update.acpSessionId; }
	if (hasAcpCapabilities) { if (update.acpCapabilities === null) delete agent.acpCapabilities; else agent.acpCapabilities = clone(update.acpCapabilities); }
	agent.updatedAt = now; next.updatedAt = now; validateManifest(next); return next;
}

/** Closes an agent and atomically interrupts its current queued/admitted/running turn, if any. */
export function closeAgent(manifest: ParentManifestV1, agentId: string, reason: string, now: number): ParentManifestV1 {
	const original = manifest.agents[agentId]; if (!original) fail(`agent ${agentId} does not exist`); string(reason, "close reason");
	const current = original.currentTurnId ? manifest.turns[original.currentTurnId] : undefined;
	assertMutationTime(manifest, now, current); assert(now >= original.updatedAt, `mutation time precedes agent ${agentId} updatedAt`);
	if (original.closed) fail(`agent ${agentId} is already closed`);
	const next = clone(manifest); const agent = next.agents[agentId]!; const turn = agent.currentTurnId ? next.turns[agent.currentTurnId] : undefined;
	if (turn && turn.state !== "terminal") { turn.state = "terminal"; turn.terminalStatus = "interrupted"; turn.terminalReason = reason; turn.completedAt = now; turn.lastActivityAt = now; }
	agent.closed = true; agent.closedAt = now; agent.closeReason = reason; agent.updatedAt = now; next.updatedAt = now;
	validateManifest(next); return next;
}

/** Atomically replaces an active Cursor turn without releasing its active slot. */
export function replaceCursorTurn(manifest: ParentManifestV1, oldTurnId: string, successorId: string, execution: ResolvedExecutionSnapshot, now: number): ParentManifestV1 {
	const original = manifest.turns[oldTurnId]; if (!original) fail(`turn ${oldTurnId} does not exist`); assertMutationTime(manifest, now, original);
	const next = clone(manifest); const old = next.turns[oldTurnId]; if (!old) fail(`turn ${oldTurnId} does not exist`);
	if (old.state !== "running" || old.execution.backend !== "cursor") fail(`turn ${oldTurnId} is not a running Cursor turn`);
	if (next.turns[successorId]) fail(`turn ${successorId} already exists`);
	const agent = next.agents[old.agentId]!;
	old.state = "terminal"; old.terminalStatus = "interrupted"; old.terminalReason = "parent-corrected"; old.completedAt = now; old.lastActivityAt = now;
	const successor: ManifestTurn = { id: successorId, agentId: agent.id, sequence: next.nextSequence++, ordinal: agent.nextOrdinal++, source: "cursor-correction", state: "admitted", ownerEpoch: next.epoch, execution: clone(execution), createdAt: now, admittedAt: now, lastActivityAt: now };
	next.turns[successorId] = successor; agent.currentTurnId = successorId; agent.updatedAt = now; next.updatedAt = now; validateManifest(next); return next;
}

export function admitFifo(manifest: ParentManifestV1, now: number, limit = DEFAULT_ACTIVE_TURN_LIMIT): { manifest: ParentManifestV1; admitted: string[] } {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_ACTIVE_TURN_LIMIT) fail(`admission limit must be a positive safe integer no greater than ${DEFAULT_ACTIVE_TURN_LIMIT}`);
	assertMutationTime(manifest, now);
	let next = clone(manifest); const active = Object.values(next.turns).filter((turn) => turn.state === "admitted" || turn.state === "running").length;
	const slots = Math.max(0, limit - active); const queued = Object.values(next.turns).filter((turn) => turn.state === "queued").sort((a, b) => a.sequence - b.sequence).slice(0, slots);
	for (const turn of queued) next = transitionTurn(next, turn.id, "admitted", now);
	return { manifest: next, admitted: queued.map((turn) => turn.id) };
}

export function reconcileManifest(manifest: ParentManifestV1, newEpoch: string, now: number): ParentManifestV1 {
	assertMutationTime(manifest, now);
	for (const turn of Object.values(manifest.turns)) assert(now >= turn.lastActivityAt, `reconciliation time precedes turn ${turn.id} lastActivityAt`);
	const next = clone(manifest); string(newEpoch, "newEpoch");
	assert(newEpoch !== manifest.epoch, "reconciliation requires a genuinely new epoch");
	for (const turn of Object.values(next.turns)) {
		if (turn.ownerEpoch === newEpoch || turn.state === "terminal") continue;
		if (turn.state === "queued") { turn.state = "terminal"; turn.terminalStatus = "paused"; turn.terminalReason = "shutdown-paused"; turn.completedAt = now; turn.lastActivityAt = now; }
		else { turn.state = "terminal"; turn.terminalStatus = "interrupted"; turn.terminalReason = "restart-interrupted"; turn.completedAt = now; turn.lastActivityAt = now; }
		next.agents[turn.agentId]!.updatedAt = now;
	}
	next.epoch = newEpoch; next.updatedAt = now; validateManifest(next); return next;
}

export interface ProjectionOptions {
	/** Phase 2B may inject a private response-file reader; manifest never stores response text. */
	readResponse?: (reference: ResponseReference) => string | undefined;
}

/** Phase 2A intentionally preserves queued/paused projection values; unified compatibility mapping belongs to Phase 2B. */
export function projectAgent(agent: ManifestAgent, turn: ManifestTurn | undefined, options: ProjectionOptions = {}): AgentInfoProjection {
	const status: AgentProjectionStatus = agent.closed ? "closed" : !turn ? "interrupted" : turn.state === "queued" ? "queued" : turn.state === "admitted" ? "starting" : turn.state === "running" ? "running" : turn.terminalStatus!;
	return {
		id: agent.id, taskName: agent.taskName, canonicalName: agent.canonicalName, backend: agent.backend, parentSessionId: agent.parentSessionId, parentSessionFile: agent.parentSessionFile, agentType: agent.agentType, cwd: agent.cwd, model: agent.model, provider: agent.provider, modelId: agent.modelId, thinking: agent.thinking, tools: agent.tools,
		skills: [...agent.skills], skillPaths: [...agent.skillPaths], extensions: [...agent.extensions], extensionPaths: [...agent.extensionPaths], cursorModel: agent.cursorModel, permissionMode: agent.permissionMode, acpSessionId: agent.acpSessionId, acpCapabilities: agent.acpCapabilities ? { ...agent.acpCapabilities } : undefined, sessionFile: agent.sessionFile,
		infoFile: agent.infoFile, logFile: agent.logFile, responseFile: agent.responseFile, viewerPaneId: agent.viewerPaneId, viewerTabId: agent.viewerTabId, createdAt: agent.createdAt, updatedAt: agent.updatedAt, startedAt: turn?.startedAt ?? turn?.admittedAt, completedAt: turn?.completedAt, closedAt: agent.closedAt, lastActivity: turn?.lastActivityAt ?? agent.updatedAt, turn: turn?.ordinal ?? Math.max(0, agent.nextOrdinal - 1), status, lastTaskMessage: turn?.execution.displayMessage, error: turn?.error, currentTurnId: agent.currentTurnId, terminalReason: turn?.terminalReason,
		response: turn?.response ? { ...turn.response } : undefined, finalResponse: turn?.response ? options.readResponse?.(turn.response) : undefined,
	};
}
export function materializeAgentProjections(manifest: ParentManifestV1, options: ProjectionOptions = {}): AgentInfoProjection[] {
	validateManifest(manifest);
	return Object.values(manifest.agents).map((agent) => projectAgent(agent, agent.currentTurnId ? manifest.turns[agent.currentTurnId] : undefined, options));
}

export interface LegacyInfoLike {
	id: string; taskName: string; canonicalName: string; backend: ManifestBackend; parentSessionId: string; cwd: string; model: string; infoFile: string; logFile: string; responseFile: string; createdAt: number; updatedAt: number; lastActivity: number; turn: number; status: string;
	parentSessionFile?: string; agentType?: string; provider?: string; modelId?: string; thinking?: string; tools?: string; skills?: string[]; skillPaths?: string[]; extensions?: string[]; extensionPaths?: string[]; cursorModel?: string; permissionMode?: string; acpSessionId?: string; acpCapabilities?: Record<string, unknown>; sessionFile?: string; viewerPaneId?: string; viewerTabId?: string; startedAt?: number; completedAt?: number; closedAt?: number; lastTaskMessage?: string; error?: string; finalResponse?: string;
}

function legacyCapabilities(value: Record<string, unknown> | undefined): { loadSession?: boolean } | undefined {
	return value && typeof value.loadSession === "boolean" ? { loadSession: value.loadSession } : undefined;
}
function legacyPermissionMode(value: string | undefined): PermissionMode {
	return value === "agent" || value === "prompt" || value === "allow-once" || value === "deny" ? value : "agent";
}

export function migrateLegacyInfo(parentSessionId: string, epoch: string, infos: LegacyInfoLike[], now: number): ParentManifestV1 {
	let manifest = createParentManifest(parentSessionId, epoch, now);
	for (const info of infos) {
		if (info.parentSessionId !== parentSessionId) fail(`legacy agent ${info.id} belongs to another parent`);
		const legacyClosed = info.status === "closed";
		manifest = addAgent(manifest, {
			id: info.id, taskName: info.taskName, canonicalName: info.canonicalName, backend: info.backend, parentSessionId, parentSessionFile: info.parentSessionFile, agentType: info.agentType, cwd: info.cwd, model: info.model, provider: info.provider, modelId: info.modelId, thinking: info.thinking, tools: info.tools, skills: info.skills ?? [], skillPaths: info.skillPaths ?? [], extensions: info.extensions ?? [], extensionPaths: info.extensionPaths ?? [], cursorModel: info.cursorModel, permissionMode: legacyPermissionMode(info.permissionMode), acpSessionId: info.backend === "cursor" ? info.acpSessionId : undefined, acpCapabilities: info.backend === "cursor" ? legacyCapabilities(info.acpCapabilities) : undefined, sessionFile: info.sessionFile, infoFile: info.infoFile, logFile: info.logFile, responseFile: info.responseFile, viewerPaneId: info.viewerPaneId, viewerTabId: info.viewerTabId, createdAt: info.createdAt, updatedAt: info.updatedAt,
		}, now);
		const terminal: TerminalStatus = info.status === "completed" ? "completed" : info.status === "failed" ? "failed" : info.status === "paused" ? "paused" : "interrupted";
		const execution: ResolvedExecutionSnapshot = { backend: info.backend, cwd: info.cwd, model: info.model, provider: info.provider, modelId: info.modelId, thinking: info.thinking, tools: info.tools, skills: info.skills ?? [], skillPaths: info.skillPaths ?? [], extensions: info.extensions ?? [], extensionPaths: info.extensionPaths ?? [], cursorModel: info.cursorModel, permissionMode: legacyPermissionMode(info.permissionMode), sessionFile: info.sessionFile, prompt: "", displayMessage: info.lastTaskMessage ?? "" };
		const turnId = `legacy-${info.id}`;
		manifest = enqueueTurn(manifest, { id: turnId, agentId: info.id, source: "initial", execution, createdAt: now, ownerEpoch: epoch });
		const completion = info.completedAt ?? info.updatedAt ?? now;
		manifest = transitionTurn(manifest, turnId, "terminal", now, { status: terminal, reason: info.status === "starting" || info.status === "running" ? "legacy-active-interrupted" : legacyClosed ? "legacy-closed" : info.status === "paused" ? "legacy-paused" : "legacy-preserved", error: info.error, response: info.finalResponse ? { turnId, path: info.responseFile } : undefined });
		const turn = manifest.turns[turnId]!;
		turn.createdAt = info.createdAt; turn.admittedAt = info.startedAt; turn.startedAt = info.startedAt; turn.completedAt = completion; turn.lastActivityAt = Math.max(info.lastActivity, completion, info.startedAt ?? 0); turn.ordinal = Math.max(1, info.turn || 1);
		const agent = manifest.agents[info.id]!; agent.nextOrdinal = turn.ordinal + 1; agent.updatedAt = Math.max(info.updatedAt, turn.lastActivityAt);
		if (legacyClosed) { agent.closed = true; agent.closedAt = info.closedAt ?? completion; agent.closeReason = "legacy-closed"; }
		validateManifest(manifest);
	}
	return manifest;
}

export class TurnManifestStore {
	readonly scopeDir: string;
	readonly manifestPath: string;
	readonly lockPath: string;
	readonly reclaimPath: string;
	private readonly now: () => number;
	private readonly uuid: () => string;
	private readonly pid: () => number;
	private readonly processAlive: (pid: number) => boolean;
	private readonly lockGraceMs: number;
	constructor(scopeDir: string, dependencies: StoreDependencies = {}) {
		this.scopeDir = resolve(scopeDir);
		this.manifestPath = join(this.scopeDir, TURN_MANIFEST_FILE); this.lockPath = join(this.scopeDir, TURN_MANIFEST_LOCK_FILE); this.reclaimPath = join(this.scopeDir, TURN_MANIFEST_RECLAIM_FILE);
		this.now = dependencies.now ?? Date.now; this.uuid = dependencies.uuid ?? (() => crypto.randomUUID()); this.pid = dependencies.pid ?? (() => process.pid);
		this.processAlive = dependencies.processAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === "ESRCH" ? false : true; } });
		this.lockGraceMs = dependencies.lockGraceMs ?? DEFAULT_LOCK_GRACE_MS;
	}
	read(): ParentManifestV1 {
		this.ensureScope(); this.ensureRegularIfPresent(this.manifestPath, 0o600, "manifest");
		if (!existsSync(this.manifestPath)) throw new Error(`Turn manifest is missing: ${this.manifestPath}`);
		let text: string; try { text = this.readBounded(this.manifestPath, MAX_MANIFEST_BYTES, "manifest"); } catch (error) { throw new Error(`Turn manifest is unreadable at ${this.manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
		let raw: unknown; try { raw = JSON.parse(text); } catch (error) { throw new Error(`Turn manifest is corrupt at ${this.manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
		try { const canonical = parseParentManifest(raw, { scopeDir: this.scopeDir }); return canonical; }
		catch (error) { throw new Error(`Turn manifest is corrupt at ${this.manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	writeAtomic(manifest: ParentManifestV1): ParentManifestV1 {
		this.ensureScope(); this.ensureRegularIfPresent(this.manifestPath, 0o600, "manifest");
		const canonical = parseParentManifest(manifest, { scopeDir: this.scopeDir });
		const content = `${JSON.stringify(canonical, null, 2)}\n`;
		if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) throw new Error(`Turn manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`);
		const temporary = `${this.manifestPath}.${this.pid()}.${this.uuid()}.tmp`;
		let fd: number | undefined;
		try {
			fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
			this.ensureRegularIfPresent(this.manifestPath, 0o600, "manifest"); renameSync(temporary, this.manifestPath); this.ensureRegularIfPresent(this.manifestPath, 0o600, "manifest"); this.fsyncDirectory();
			return canonical;
		} finally { if (fd !== undefined) try { closeSync(fd); } catch {}; try { if (existsSync(temporary)) unlinkSync(temporary); } catch {} }
	}
	acquire(expectedEpoch: string, options: { allowMissing?: boolean } = {}): ManifestLock {
		string(expectedEpoch, "expectedEpoch"); this.ensureScope();
		for (let attempt = 0; attempt < 3; attempt++) {
			this.assertNoReclaimGuard();
			const lock: ManifestLock = { epoch: expectedEpoch, nonce: this.uuid(), pid: this.pid(), createdAt: this.now() };
			const lockContent = `${JSON.stringify(lock)}\n`;
			if (Buffer.byteLength(lockContent) > MAX_LOCK_BYTES) throw new Error(`Turn manifest lock exceeds ${MAX_LOCK_BYTES} bytes.`);
			let created = false;
			try {
				this.ensureRegularIfPresent(this.lockPath, 0o600, "lock");
				const fd = openSync(this.lockPath, "wx", 0o600); created = true;
				try { writeFileSync(fd, lockContent, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
				this.ensureRegularIfPresent(this.lockPath, 0o600, "lock");
				try { this.assertNoReclaimGuard(); } catch (error) {
					this.release(lock); created = false;
					throw error;
				}
				try {
					if (!existsSync(this.manifestPath)) {
						if (options.allowMissing) return lock;
						throw new Error(`Turn manifest is missing: ${this.manifestPath}`);
					}
					const current = this.read();
					if (!options.allowMissing && current.epoch !== expectedEpoch) throw new Error(`Turn manifest epoch changed while acquiring lock (expected ${expectedEpoch}).`);
				} catch (error) {
					this.release(lock); created = false; throw error;
				}
				return lock;
			} catch (error: any) {
				if (created) { try { this.release(lock); } catch {} }
				if (error?.code !== "EEXIST") throw error;
				if (attempt < 2 && this.reclaimStaleLock()) continue;
				throw new Error(`Turn manifest lock is held at ${this.lockPath}; retry after its owner exits.`);
			}
		}
		throw new Error(`Turn manifest lock is held at ${this.lockPath}; retry after its owner exits.`);
	}
	/** Creates a missing manifest while holding the main lock; existing manifests are read, never overwritten. */
	initialize(manifest: ParentManifestV1): ParentManifestV1 {
		this.ensureScope(); const canonical = parseParentManifest(manifest, { scopeDir: this.scopeDir });
		if (existsSync(this.manifestPath)) {
			const existing = this.read();
			if (existing.parentSessionId !== canonical.parentSessionId) throw new Error(`Turn manifest parent session differs at ${this.manifestPath}; refusing initialization.`);
			return existing;
		}
		const lock = this.acquire(canonical.epoch, { allowMissing: true });
		try {
			if (!existsSync(this.manifestPath)) return this.writeAtomic(canonical);
			const existing = this.read();
			if (existing.parentSessionId !== canonical.parentSessionId) throw new Error(`Turn manifest parent session differs at ${this.manifestPath}; refusing initialization.`);
			return existing;
		} finally { this.release(lock); }
	}
	release(lock: ManifestLock): void {
		this.ensureScope();
		if (!existsSync(this.lockPath)) return;
		this.ensureRegularIfPresent(this.lockPath, 0o600, "lock");
		let current: ManifestLock; try { current = this.parseLock(this.readBounded(this.lockPath, MAX_LOCK_BYTES, "lock"), "lock"); } catch { throw new Error(`Turn manifest lock is corrupt at ${this.lockPath}; refusing release.`); }
		if (current.nonce !== lock.nonce) throw new Error(`Turn manifest lock nonce changed at ${this.lockPath}; refusing release.`);
		try { unlinkSync(this.lockPath); } catch (error) { throw new Error(`Turn manifest lock changed while releasing: ${error instanceof Error ? error.message : String(error)}`); }
		this.fsyncDirectory();
	}
	/** Mutation callback is synchronous by contract: no process/Herdr/RPC await while locked. */
	mutate(expectedEpoch: string, mutate: (manifest: ParentManifestV1) => ParentManifestV1): ParentManifestV1 {
		const lock = this.acquire(expectedEpoch);
		try { const current = this.read(); if (current.epoch !== expectedEpoch) throw new Error(`Turn manifest epoch changed under lock (expected ${expectedEpoch}).`); const next = mutate(current); if (next && typeof (next as any).then === "function") throw new Error("Turn manifest mutation must not return a Promise while locked."); return this.writeAtomic(next); }
		finally { this.release(lock); }
	}
	private assertNoReclaimGuard(): void {
		this.ensureRegularIfPresent(this.reclaimPath, 0o600, "reclaim guard");
		if (!existsSync(this.reclaimPath)) return;
		try { this.parseLock(this.readBounded(this.reclaimPath, MAX_LOCK_BYTES, "reclaim guard"), "reclaim guard"); }
		catch (error) { throw new Error(`Turn manifest reclaim guard at ${this.reclaimPath} is corrupt; manual recovery is required: ${error instanceof Error ? error.message : String(error)}`); }
		throw new Error(`Turn manifest reclaim guard is held at ${this.reclaimPath}; retry later or perform manual recovery if abandoned.`);
	}
	private acquireReclaimGuard(expectedEpoch: string): ManifestLock | undefined {
		const guard: ManifestLock = { epoch: expectedEpoch, nonce: this.uuid(), pid: this.pid(), createdAt: this.now() };
		const content = `${JSON.stringify(guard)}\n`;
		if (Buffer.byteLength(content) > MAX_LOCK_BYTES) throw new Error(`Turn manifest reclaim guard exceeds ${MAX_LOCK_BYTES} bytes.`);
		try {
			const fd = openSync(this.reclaimPath, "wx", 0o600);
			try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
			this.ensureRegularIfPresent(this.reclaimPath, 0o600, "reclaim guard"); return guard;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			this.assertNoReclaimGuard(); return undefined;
		}
	}
	private releaseReclaimGuard(guard: ManifestLock): void {
		this.ensureRegularIfPresent(this.reclaimPath, 0o600, "reclaim guard");
		let current: ManifestLock; try { current = this.parseLock(this.readBounded(this.reclaimPath, MAX_LOCK_BYTES, "reclaim guard"), "reclaim guard"); }
		catch (error) { throw new Error(`Turn manifest reclaim guard at ${this.reclaimPath} is corrupt; manual recovery is required: ${error instanceof Error ? error.message : String(error)}`); }
		if (current.nonce !== guard.nonce) throw new Error(`Turn manifest reclaim guard nonce changed at ${this.reclaimPath}; refusing release.`);
		try { unlinkSync(this.reclaimPath); } catch (error) { throw new Error(`Turn manifest reclaim guard changed while releasing: ${error instanceof Error ? error.message : String(error)}`); }
		this.fsyncDirectory();
	}
	private reclaimStaleLock(): boolean {
		const guard = this.acquireReclaimGuard("reclaim"); if (!guard) return false;
		try {
			this.ensureRegularIfPresent(this.lockPath, 0o600, "lock");
			if (!existsSync(this.lockPath)) return true;
			let lock: ManifestLock; try { lock = this.parseLock(this.readBounded(this.lockPath, MAX_LOCK_BYTES, "lock"), "lock"); }
			catch (error) { throw new Error(`Turn manifest lock is corrupt at ${this.lockPath}; refusing reclaim: ${error instanceof Error ? error.message : String(error)}`); }
			if (this.now() - lock.createdAt < this.lockGraceMs || this.processAlive(lock.pid)) return false;
			let verified: ManifestLock; try { verified = this.parseLock(this.readBounded(this.lockPath, MAX_LOCK_BYTES, "lock"), "lock"); }
			catch (error) { throw new Error(`Turn manifest lock changed while reclaiming at ${this.lockPath}; retry safely: ${error instanceof Error ? error.message : String(error)}`); }
			if (verified.nonce !== lock.nonce) throw new Error(`Turn manifest lock changed while reclaiming at ${this.lockPath}; retry safely.`);
			try { unlinkSync(this.lockPath); } catch (error: any) { if (error?.code === "ENOENT") return true; throw new Error(`Turn manifest stale lock reclaim failed at ${this.lockPath}: ${error?.message ?? String(error)}`); }
			this.fsyncDirectory(); return true;
		} finally { this.releaseReclaimGuard(guard); }
	}
	private parseLock(text: string, label: string): ManifestLock {
		const raw: unknown = JSON.parse(text);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Turn manifest ${label} has invalid contents.`);
		const lock = raw as Record<string, unknown>;
		if (Object.keys(lock).some((key) => key !== "nonce" && key !== "epoch" && key !== "pid" && key !== "createdAt") || !Number.isSafeInteger(lock.pid) || !Number.isSafeInteger(lock.createdAt) || typeof lock.nonce !== "string" || !lock.nonce || typeof lock.epoch !== "string" || !lock.epoch) throw new Error(`Turn manifest ${label} has invalid contents.`);
		return lock as unknown as ManifestLock;
	}

	private readBounded(path: string, maxBytes: number, label: string): string {
		const entry = statSync(path);
		if (entry.size > maxBytes) throw new Error(`Turn manifest ${label} exceeds ${maxBytes} bytes before read: ${path}`);
		return readFileSync(path, "utf8");
	}
	private ensureScope(): void {
		mkdirSync(this.scopeDir, { recursive: true, mode: 0o700 });
		const entry = lstatSync(this.scopeDir); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Turn manifest scope is not a safe directory: ${this.scopeDir}`);
		try { chmodSync(this.scopeDir, 0o700); } catch (error) { throw new Error(`Cannot establish private manifest scope mode: ${error instanceof Error ? error.message : String(error)}`); }
		this.assertModeAndOwner(this.scopeDir, 0o700, "scope", true);
	}
	private ensureRegularIfPresent(path: string, mode: number, label: string): void {
		let entry: ReturnType<typeof lstatSync>;
		try { entry = lstatSync(path); } catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
		if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Turn manifest ${label} is not a safe regular file: ${path}`);
		try { chmodSync(path, mode); } catch (error) { throw new Error(`Cannot establish private ${label} mode: ${error instanceof Error ? error.message : String(error)}`); }
		this.assertModeAndOwner(path, mode, label, false);
		const realScope = realpathSync(this.scopeDir); const realPath = realpathSync(path);
		if (!realPath.startsWith(`${realScope}/`)) throw new Error(`Turn manifest ${label} escapes scope: ${path}`);
	}
	private assertModeAndOwner(path: string, mode: number, label: string, directory: boolean): void {
		const entry = statSync(path); if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error(`Turn manifest ${label} changed type: ${path}`);
		if ((entry.mode & 0o777) !== mode) throw new Error(`Turn manifest ${label} mode is not ${mode.toString(8)}: ${path}`);
		const uid = process.getuid?.(); if (typeof uid === "number" && entry.uid !== uid) throw new Error(`Turn manifest ${label} is not owned by this user: ${path}`);
	}
	private fsyncDirectory(): void { try { const fd = openSync(this.scopeDir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort on filesystems without directory fsync */ } }
}
