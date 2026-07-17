import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { registerUnifiedSubagents } from "../extensions/unified.ts";
import type {
	HerdrAgent, HerdrOperations, PiRuntime, PiRuntimeAgent,
	UnifiedSubagentDependencies, UnifiedTestObserver,
} from "../extensions/unified-deps.ts";

type Tool = { name: string; execute: (...args: any[]) => Promise<any> };
type Listener = (...args: any[]) => unknown;

function fakeApi() {
	const tools = new Map<string, Tool>();
	const lifecycle = new Map<string, Listener[]>();
	return {
		tools,
		registerTool(tool: Tool) { tools.set(tool.name, tool); },
		registerCommand() {}, registerMessageRenderer() {},
		on(name: string, listener: Listener) { lifecycle.set(name, [...(lifecycle.get(name) ?? []), listener]); },
		async emit(name: string, ...args: unknown[]) { for (const listener of lifecycle.get(name) ?? []) await listener(...args); },
		getThinkingLevel() { return "low"; },
		getActiveTools() { return ["read"]; },
		getAllTools() { return [{ name: "read", sourceInfo: { source: "builtin" } }]; },
		sendMessage() {},
	} as any;
}

function context(sessionId: string, cwd: string, projectTrusted = false) {
	return {
		cwd, mode: "json", model: { provider: "test", id: "model" }, modelRegistry: { find: () => ({}) },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `${sessionId}.jsonl`) },
		ui: { setWidget() {}, notify() {} },
		isProjectTrusted: () => projectTrusted,
	};
}

class FakeRuntimes {
	readonly pi = new Map<string, { handlers: { onEvent(event: unknown, turnToken?: string): void; onExit(error?: Error): void }; message?: string; token?: string }>();
	private readonly closeResolvers = new Map<string, () => void>();
	private readonly blockedCloses = new Set<string>();
	readonly cursor = new Map<string, { handlers: any; message?: string; token?: string }>();
	private readonly heldStats = new Map<string, (value: any) => void>();
	private readonly holdStatsFor = new Set<string>();
	readonly statsCalls = new Map<string, number>();
	private readonly failStatsFor = new Set<string>();
	failStats(name: string) { this.failStatsFor.add(name); }
	holdStats(name: string) { this.holdStatsFor.add(name); }
	releaseStats(name: string, value = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, cost: 0 }) { this.holdStatsFor.delete(name); this.heldStats.get(name)?.(value); this.heldStats.delete(name); }
	createPi = (info: PiRuntimeAgent, handlers: { onEvent(event: unknown, turnToken?: string): void; onExit(error?: Error): void }): PiRuntime => {
		const runtimes = this;
		runtimes.pi.set(info.canonicalName, { handlers });
		return {
			async start() {},
			async getSessionStats() { runtimes.statsCalls.set(info.canonicalName, (runtimes.statsCalls.get(info.canonicalName) ?? 0) + 1); if (runtimes.failStatsFor.has(info.canonicalName)) throw new Error("stats failed"); if (!runtimes.holdStatsFor.has(info.canonicalName)) return { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, cost: 0 }; return await new Promise<any>((resolve) => runtimes.heldStats.set(info.canonicalName, resolve)); },
			async prompt(message, token) { const record = runtimes.pi.get(info.canonicalName)!; record.message = message; record.token = token; },
			async steer(message) { runtimes.pi.get(info.canonicalName)!.message = message; },
			async abort() {},
			async close() {
				if (!runtimes.blockedCloses.has(info.canonicalName)) return;
				await new Promise<void>((resolve) => runtimes.closeResolvers.set(info.canonicalName, resolve));
			},
		};
	};
	settlePi(name: string, output?: string) {
		const runtime = this.pi.get(name); assert.ok(runtime, `Pi runtime ${name}`);
		const result = output ?? `result:${runtime.message}`;
		runtime.handlers.onEvent({ type: "text", text: result }, runtime.token);
		runtime.handlers.onEvent({ type: "settled", output: result }, runtime.token);
	}
	emitPi(name: string, event: unknown) { const runtime = this.pi.get(name); assert.ok(runtime); runtime.handlers.onEvent(event, runtime.token); }
	blockClose(name: string) { this.blockedCloses.add(name); }
	releaseClose(name: string) { this.blockedCloses.delete(name); this.closeResolvers.get(name)?.(); this.closeResolvers.delete(name); }
}

// Cursor's structural runtime is easier to keep deterministic without ACP subprocesses.
function cursorFactory(runtimes: FakeRuntimes): UnifiedSubagentDependencies["createCursorRuntime"] {
	return (cwd, handlers) => {
		runtimes.cursor.set(cwd, { handlers });
		return {
			async start() { return { sessionId: "cursor-session", model: "Auto", configOptions: [], agentCapabilities: { loadSession: true, mcpCapabilities: { tools: true } }, loaded: false }; },
			async prompt(message, token) { const runtime = runtimes.cursor.get(cwd)!; runtime.message = message; runtime.token = token; return new Promise(() => {}); },
			cancel() {}, async close() {},
		};
	};
}

class Gate {
	private resolveGate!: () => void;
	readonly wait = new Promise<void>((resolve) => { this.resolveGate = resolve; });
	release() { this.resolveGate(); }
}

interface ProjectionCapture { pi: Array<Record<string, unknown>>; herdr: Array<Record<string, unknown>>; }

function dependencies(root: string, events: string[], runtimes: FakeRuntimes, observer: (value: UnifiedTestObserver) => void, options: { failPiStart?: boolean; viewerCloseGate?: Gate; projections?: ProjectionCapture; mutateProjections?: boolean } = {}): UnifiedSubagentDependencies {
	let tick = 1_000;
	let id = 0;
	const herdr: HerdrOperations = {
		async ensure(kind) { events.push(`ensure:${kind}`); },
		async createViewer(info) {
			const safe = { ...info };
			options.projections?.herdr.push({ ...info });
			if (options.mutateProjections) Object.assign(info, { canonicalName: "/corrupted", parentSessionId: "leak" });
			events.push(`viewer:create:${safe.canonicalName}`);
			return { paneId: `pane-${safe.id}`, tabId: `tab-${safe.id}` };
		},
		async closeViewer(info: HerdrAgent) {
			const safe = { ...info };
			options.projections?.herdr.push({ ...info });
			if (options.mutateProjections) Object.assign(info, { canonicalName: "/corrupted-close", finalResponse: "leak" });
			events.push(`viewer:close:${safe.canonicalName}:${safe.viewerPaneId}/${safe.viewerTabId}`);
			await options.viewerCloseGate?.wait;
		},
	};
	return {
		clock: () => ++tick, uuid: () => `fake-${++id}`,
		paths: { root, configPath: join(root, "config.json"), agentsDir: join(root, "agents"), runsDir: join(root, "runs"), cursorConfigPath: join(root, "cursor.json") },
		herdr, onReady: observer,
		createPiRuntime: (info, handlers) => {
			const safe = { ...info, skillPaths: info.skillPaths ? [...info.skillPaths] : undefined, extensionPaths: info.extensionPaths ? [...info.extensionPaths] : undefined };
			options.projections?.pi.push({ ...info });
			const runtime = runtimes.createPi(safe, handlers);
			if (options.mutateProjections) Object.assign(info, { canonicalName: "/corrupted", parentSessionId: "leak", finalResponse: "leak" });
			if (options.failPiStart) return { ...runtime, async start() { throw new Error("start failure"); } };
			return runtime;
		},
		createCursorRuntime: cursorFactory(runtimes),
	};
}

async function execute(api: ReturnType<typeof fakeApi>, name: string, params: unknown, ctx: any) {
	const tool = api.tools.get(name); assert.ok(tool, `registered ${name}`);
	return tool.execute("call", params, undefined, undefined, ctx);
}

async function turn() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("registered template catalog is trust-gated, prompt-safe, project-preferred, and hot-read by spawn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-templates-")); const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); let observer!: UnifiedTestObserver;
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; }));
	const globalDir = join(root, "agents"); const projectDir = join(root, ".pi", "pi-bstn-subagents", "agents"); await mkdir(globalDir, { recursive: true }); await mkdir(projectDir, { recursive: true });
	await writeFile(join(globalDir, "reviewer.md"), "---\nname: reviewer\nbackend: pi\ndescription: global\n---\nglobal private prompt\n");
	await writeFile(join(projectDir, "reviewer.md"), "---\nname: reviewer\nbackend: pi\ndescription: project one\n---\nproject private one\n");
	await writeFile(join(root, "config.json"), JSON.stringify({ trustedProjects: [root] }));
	const blocked = await execute(api, "list_agent_templates", {}, context("blocked", root, false)); assert.equal(blocked.details.templates[0].scope, "global"); assert.equal(blocked.details.project_status, "blocked-pi-trust");
	const trusted = context("trusted", root, true); const listed = await execute(api, "list_agent_templates", {}, trusted); assert.equal(listed.details.templates[0].scope, "project"); assert.equal(listed.details.templates[0].shadows_global, true); assert.doesNotMatch(listed.content[0].text, /private one|global private/);
	try {
		await execute(api, "spawn_agent", { task_name: "one", message: "task one", backend: "pi", agent_type: "reviewer" }, trusted); await turn(); assert.equal(runtimes.pi.get("/one")?.message, "project private one\n\ntask one");
		await writeFile(join(projectDir, "reviewer.md"), "---\nname: reviewer\nbackend: pi\ndescription: project two\n---\nproject private two\n");
		await execute(api, "spawn_agent", { task_name: "two", message: "task two", backend: "pi", agent_type: "reviewer" }, trusted); await turn(); assert.equal(runtimes.pi.get("/two")?.message, "project private two\n\ntask two");
		await mkdir(join(root, "nested")); await execute(api, "spawn_agent", { task_name: "nested", message: "task nested", backend: "pi", agent_type: "reviewer", cwd: "nested" }, trusted); await turn(); assert.equal(runtimes.pi.get("/nested")?.message, "project private two\n\ntask nested");
	} finally { await observer.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("project skills require both trust gates and global templates cannot bind same-named project resources", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-template-resources-")); const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); let observer!: UnifiedTestObserver; const projections: ProjectionCapture = { pi: [], herdr: [] };
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; }, { projections }));
	const projectTemplates = join(root, ".pi", "pi-bstn-subagents", "agents"); const projectSkill = join(root, ".pi", "skills", "local"); await mkdir(projectTemplates, { recursive: true }); await mkdir(projectSkill, { recursive: true }); await mkdir(join(root, "agents"), { recursive: true });
	await writeFile(join(projectSkill, "SKILL.md"), "# trusted local skill\n"); await writeFile(join(root, "config.json"), JSON.stringify({ trustedProjects: [root] }));
	await writeFile(join(root, "agents", "global-local.md"), "---\nname: global-local\nbackend: pi\nskills: local\n---\nglobal\n");
	await writeFile(join(projectTemplates, "project-local.md"), "---\nname: project-local\nbackend: pi\nskills: local\n---\nproject\n");
	const outsideSkill = join(resolve(root, ".."), `outside-skill-${Date.now()}`); await mkdir(outsideSkill); await writeFile(join(outsideSkill, "SKILL.md"), "# outside\n"); await symlink(outsideSkill, join(root, ".pi", "skills", "escape"));
	await writeFile(join(projectTemplates, "escape.md"), "---\nname: escape\nbackend: pi\nskills: escape\n---\nescape\n");
	await writeFile(join(projectTemplates, "traversal.md"), "---\nname: traversal\nbackend: pi\nskills: ../../outside\n---\ntraversal\n");
	try {
		await assert.rejects(() => execute(api, "spawn_agent", { task_name: "blocked", message: "x", backend: "pi", agent_type: "project-local" }, context("blocked-resource", root, false)), /not found/);
		await assert.rejects(() => execute(api, "spawn_agent", { task_name: "global", message: "x", backend: "pi", agent_type: "global-local" }, context("trusted-resource", root, true)), /Skill not found/);
		await assert.rejects(() => execute(api, "spawn_agent", { task_name: "escape", message: "x", backend: "pi", agent_type: "escape" }, context("trusted-resource", root, true)), /Skill not found/);
		await assert.rejects(() => execute(api, "spawn_agent", { task_name: "traversal", message: "x", backend: "pi", agent_type: "traversal" }, context("trusted-resource", root, true)), /Skill path not found/);
		await execute(api, "spawn_agent", { task_name: "project", message: "x", backend: "pi", agent_type: "project-local" }, context("trusted-resource", root, true)); await turn();
		assert.deepEqual(projections.pi.at(-1)?.skillPaths, [await realpath(projectSkill)]);
	} finally { await observer.shutdown(); await rm(root, { recursive: true, force: true }); await rm(outsideSkill, { recursive: true, force: true }); }
});

test("registered tools remain detached, isolated, serialized, and observable through the narrow test observer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-foundation-"));
	const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); const viewerCloseGate = new Gate();
	const projections: ProjectionCapture = { pi: [], herdr: [] };
	let observer!: UnifiedTestObserver;
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; }, { viewerCloseGate, projections, mutateProjections: true }));
	const parentA = context("parent-a", root); const parentB = context("parent-b", root);
	const snapshots: unknown[] = [];
	const record = (state: unknown) => snapshots.push(state);
	const unsubscribe = observer.subscribe("parent-a", record);
	const duplicateUnsubscribe = observer.subscribe("parent-a", record);
	assert.equal(snapshots.length, 1, "a repeated listener subscription has one initial snapshot");
	try {
		const spawned = await execute(api, "spawn_agent", { task_name: "alpha", message: "secret initial task", backend: "pi" }, parentA);
		assert.equal(spawned.details.status, "queued");
		await turn();
		assert.deepEqual(spawned.content, [{ type: "text", text: "Spawned /alpha with backend=pi. Use wait_agent or wait_all_agents for completion." }]);
		assert.deepEqual(Object.keys(projections.pi[0]!).sort(), ["canonicalName", "cwd", "extensionPaths", "logFile", "modelId", "provider", "sessionFile", "skillPaths", "thinking", "tools"].sort());
		assert.deepEqual(Object.keys(projections.herdr[0]!).sort(), ["id", "canonicalName", "backend", "cwd", "viewerPaneId", "viewerTabId"].sort());
		assert.doesNotMatch(JSON.stringify(projections), /secret initial task|parentSessionId|finalResponse/);
		const projectedList = await execute(api, "list_agents", {}, parentA);
		assert.equal(projectedList.details.agents[0].agent_name, "/alpha", "projection mutation cannot alter persisted agent metadata");
		const waiting = execute(api, "wait_agent", { targets: ["alpha"] }, parentA);
		let pending = true; void waiting.finally(() => { pending = false; }); await turn(); assert.equal(pending, true);
		const revisionBefore = (snapshots.at(-1) as any).agents.find((agent: any) => agent.agentName === "/alpha").ledgerRevision;
		runtimes.emitPi("/alpha", { type: "phase", phase: "Reading plan" });
		assert.match(JSON.stringify(snapshots), /Reading plan/);
		assert.ok((snapshots.at(-1) as any).agents.find((agent: any) => agent.agentName === "/alpha").ledgerRevision > revisionBefore);
		runtimes.settlePi("/alpha");
		const waited = await waiting;
		const waitedPayload = JSON.parse(waited.content[0].text);
		assert.equal(waitedPayload.agent_name, "/alpha"); assert.equal(waitedPayload.status, "completed");
		assert.equal(waitedPayload.finalResponse, "result:secret initial task"); assert.ok(waitedPayload.turn_id);
		const read = await execute(api, "read_agent_response", { target: "alpha" }, parentA);
		assert.equal(read.content[0].text, JSON.stringify({ agent_name: "/alpha", status: "completed", finalResponse: "result:secret initial task" }, null, 2));
		const sent = await execute(api, "send_message", { target: "alpha", message: "follow up" }, parentA);
		assert.equal(sent.content[0].text, "Message queued as a new agent turn.");
		await turn();
		runtimes.settlePi("/alpha");
		await execute(api, "wait_agent", { targets: ["alpha"] }, parentA);
		const isolated = await execute(api, "list_agents", {}, parentB); assert.deepEqual(isolated.details.agents, []);
		await execute(api, "spawn_agent", { task_name: "pi-interrupt", message: "hold", backend: "pi" }, parentA);
		const piInterrupted = await execute(api, "interrupt_agent", { target: "pi-interrupt" }, parentA);
		assert.equal(piInterrupted.details.previous_status, "running");
		runtimes.emitPi("/pi-interrupt", { type: "text", text: "late Pi text" });
		runtimes.emitPi("/pi-interrupt", { type: "tool_start", id: "late-tool", name: "late tool" });
		const piInterruptedWait = await execute(api, "wait_agent", { targets: ["pi-interrupt"] }, parentA);
		assert.equal(piInterruptedWait.details.status, "interrupted");
		const piInterruptedRead = await execute(api, "read_agent_response", { target: "pi-interrupt" }, parentA);
		assert.equal(piInterruptedRead.details.status, "interrupted");
		assert.doesNotMatch(piInterruptedRead.content[0].text, /late Pi text/);
		await execute(api, "spawn_agent", { task_name: "race", message: "hold", backend: "pi" }, parentA);
		runtimes.blockClose("/race");
		const closing = execute(api, "close_agent", { target: "race" }, parentA);
		await turn();
		const queuedSend = execute(api, "send_message", { target: "race", message: "must not win" }, parentA);
		runtimes.settlePi("/race", "late result");
		runtimes.releaseClose("/race");
		await turn();
		const thirdControl = execute(api, "interrupt_agent", { target: "race" }, parentA);
		viewerCloseGate.release();
		assert.equal((await closing).details.previous_status, "running");
		await assert.rejects(() => queuedSend, /Agent is closed/);
		assert.equal((await thirdControl).details.previous_status, "closed");
		const race = await execute(api, "read_agent_response", { target: "race" }, parentA);
		assert.equal(race.details.status, "closed");
		const closed = await execute(api, "close_agent", { target: "alpha" }, parentA); assert.equal(closed.content[0].text, "Agent closed.");
		assert.equal(events.filter((event) => event.startsWith("viewer:close:/alpha")).length, 1);
		assert.doesNotMatch(JSON.stringify(snapshots), /secret initial task|result:secret|follow up/);
		unsubscribe(); const count = snapshots.length;
		await execute(api, "spawn_agent", { task_name: "beta", message: "after unsubscribe", backend: "pi" }, parentA);
		assert.equal(snapshots.length, count);
	} finally { duplicateUnsubscribe(); unsubscribe(); await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});

test("listener failures, permission/activity transitions, Cursor path, and failed viewer cleanup are contained", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-foundation-"));
	const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); let observer!: UnifiedTestObserver;
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; }));
	const ctx = context("parent-cursor", root); const states: unknown[] = [];
	observer.subscribe("parent-cursor", () => { throw new Error("listener failure"); });
	observer.subscribe("parent-cursor", (state) => states.push(state));
	try {
		const spawned = await execute(api, "spawn_agent", { task_name: "cursor", message: "check", backend: "cursor", cursor_model: "Auto", permission_mode: "agent" }, ctx);
		assert.equal(spawned.details.status, "queued");
		await new Promise((resolve) => setTimeout(resolve, 350));
		const runtime = runtimes.cursor.get(root)!;
		const approval = runtime.handlers.onRequest({ method: "session/request_permission", params: { title: "read", options: [{ optionId: "allow-once" }, { optionId: "reject-once" }] } }, runtime.token);
		await turn(); assert.match(JSON.stringify(states), /Awaiting approval/);
		const permission = await execute(api, "wait_agent", { targets: ["cursor"] }, ctx);
		await execute(api, "respond_agent_permission", { target: "cursor", approval_id: permission.details.approvalId, decision: "approve" }, ctx);
		await approval;
		assert.doesNotMatch(JSON.stringify(states.at(-1)), /Awaiting approval/);
		const interrupted = await execute(api, "interrupt_agent", { target: "cursor" }, ctx);
		assert.equal(interrupted.details.previous_status, "running");
		const lateAfterInterrupt = await runtime.handlers.onRequest({ method: "session/request_permission", params: { title: "late", options: [{ optionId: "reject-once" }] } });
		assert.deepEqual(lateAfterInterrupt, { outcome: { outcome: "selected", optionId: "reject-once" } });
		await assert.rejects(
			() => runtime.handlers.onRequest({ method: "cursor/create_plan", params: {} }),
			/inactive subagent turn/,
		);
		runtime.handlers.onNotification({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late interrupt output" } } } });
		const interruptedWait = await execute(api, "wait_agent", { targets: ["cursor"] }, ctx);
		assert.equal(interruptedWait.details.status, "interrupted");
		await execute(api, "close_agent", { target: "cursor" }, ctx);
		const lateAfterClose = await runtime.handlers.onRequest({ method: "session/request_permission", params: { title: "late", options: [{ optionId: "reject-once" }] } });
		assert.deepEqual(lateAfterClose, { outcome: { outcome: "selected", optionId: "reject-once" } });
		runtime.handlers.onNotification({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late close output" } } } });
		const terminalWait = await execute(api, "wait_agent", { targets: ["cursor"] }, ctx);
		assert.equal(terminalWait.details.kind, "completion");
		assert.equal(terminalWait.details.status, "closed");
		const terminalRead = await execute(api, "read_agent_response", { target: "cursor" }, ctx);
		assert.equal(terminalRead.details.status, "closed");
		assert.doesNotMatch(terminalRead.content[0].text, /late (interrupt|close) output/);

		const failEvents: string[] = []; const failApi = fakeApi();
		registerUnifiedSubagents(failApi, dependencies(join(root, "failed"), failEvents, new FakeRuntimes(), () => {}, { failPiStart: true }));
		const failedSpawn = await execute(failApi, "spawn_agent", { task_name: "fails", message: "x", backend: "pi" }, context("parent-fail", root));
		assert.equal(failedSpawn.details.status, "queued");
		await turn();
		await failApi.emit("session_shutdown");
		assert.equal(failEvents.filter((event) => event.startsWith("viewer:close:/fails")).length, 1);
	} finally { await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});


test("a stale Pi metrics refresh cannot mutate an interrupted lifecycle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-metrics-")); const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); let observer!: UnifiedTestObserver;
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; })); const ctx = context("parent-metrics", root);
	try {
		runtimes.holdStats("/metrics");
		await execute(api, "spawn_agent", { task_name: "metrics", message: "hold", backend: "pi" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await execute(api, "interrupt_agent", { target: "metrics" }, ctx);
		runtimes.releaseStats("/metrics"); await new Promise((resolve) => setTimeout(resolve, 10));
		const state = observer.snapshot("parent-metrics").agents.find((agent) => agent.agentName === "/metrics");
		assert.equal(state?.status, "interrupted"); assert.equal(state?.metrics, undefined);
	} finally { await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});


test("a dirty Pi stats hint during an in-flight refresh is rate-limited to the next second", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-rate-")); const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi();
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, () => {})); const ctx = context("parent-rate", root);
	try {
		runtimes.holdStats("/rate"); await execute(api, "spawn_agent", { task_name: "rate", message: "hold", backend: "pi" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(runtimes.statsCalls.get("/rate"), 1);
		runtimes.emitPi("/rate", { type: "metrics_hint" }); runtimes.releaseStats("/rate");
		await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(runtimes.statsCalls.get("/rate"), 1, "second request must not start inside the first run");
		await new Promise((resolve) => setTimeout(resolve, 1_050)); assert.equal(runtimes.statsCalls.get("/rate"), 2);
	} finally { await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});


test("completed compaction durably increments an existing sample when its refresh fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-unified-compaction-")); const events: string[] = []; const runtimes = new FakeRuntimes(); const api = fakeApi(); let observer!: UnifiedTestObserver;
	registerUnifiedSubagents(api, dependencies(root, events, runtimes, (value) => { observer = value; })); const ctx = context("parent-compaction", root);
	try {
		await execute(api, "spawn_agent", { task_name: "compact", message: "hold", backend: "pi" }, ctx); await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(observer.snapshot("parent-compaction").agents.find((agent) => agent.agentName === "/compact")?.metrics?.compactionCount, 0);
		runtimes.failStats("/compact"); runtimes.emitPi("/compact", { type: "compaction", state: "completed", tokensBefore: 10, estimatedTokensAfter: 2, willRetry: true });
		assert.equal(observer.snapshot("parent-compaction").agents.find((agent) => agent.agentName === "/compact")?.metrics?.compactionCount, 1);
		await new Promise((resolve) => setTimeout(resolve, 1_050));
		const metrics = observer.snapshot("parent-compaction").agents.find((agent) => agent.agentName === "/compact")?.metrics;
		assert.equal(metrics?.compactionCount, 1); assert.equal(metrics?.totalTokens, 2);
	} finally { await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});
