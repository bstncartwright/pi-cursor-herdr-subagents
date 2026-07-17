import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function context(sessionId: string, cwd: string) {
	return {
		cwd, mode: "json", model: { provider: "test", id: "model" }, modelRegistry: { find: () => ({}) },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(cwd, `${sessionId}.jsonl`) },
		ui: { setWidget() {}, notify() {} },
	};
}

class FakeRuntimes {
	readonly pi = new Map<string, { handlers: { onEvent(event: unknown): void; onExit(error?: Error): void }; message?: string }>();
	private readonly closeResolvers = new Map<string, () => void>();
	private readonly blockedCloses = new Set<string>();
	readonly cursor = new Map<string, { handlers: any; message?: string }>();
	createPi = (info: PiRuntimeAgent, handlers: { onEvent(event: unknown): void; onExit(error?: Error): void }): PiRuntime => {
		const runtimes = this;
		runtimes.pi.set(info.canonicalName, { handlers });
		return {
			async start() {},
			async prompt(message) { runtimes.pi.get(info.canonicalName)!.message = message; },
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
		runtime.handlers.onEvent({ type: "text", text: result });
		runtime.handlers.onEvent({ type: "settled", output: result });
	}
	emitPi(name: string, event: unknown) { const runtime = this.pi.get(name); assert.ok(runtime); runtime.handlers.onEvent(event); }
	blockClose(name: string) { this.blockedCloses.add(name); }
	releaseClose(name: string) { this.blockedCloses.delete(name); this.closeResolvers.get(name)?.(); this.closeResolvers.delete(name); }
}

// Cursor's structural runtime is easier to keep deterministic without ACP subprocesses.
function cursorFactory(runtimes: FakeRuntimes): UnifiedSubagentDependencies["createCursorRuntime"] {
	return (cwd, handlers) => {
		runtimes.cursor.set(cwd, { handlers });
		return {
			async start() { return { sessionId: "cursor-session", model: "Auto", configOptions: [], agentCapabilities: {}, loaded: false }; },
			async prompt(message) { const runtime = runtimes.cursor.get(cwd)!; runtime.message = message; return new Promise(() => {}); },
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
		assert.equal(spawned.details.status, "running");
		assert.deepEqual(spawned.content, [{ type: "text", text: "Spawned /alpha with backend=pi. Use wait_agent or wait_all_agents for completion." }]);
		assert.deepEqual(Object.keys(projections.pi[0]!).sort(), ["canonicalName", "cwd", "extensionPaths", "logFile", "modelId", "provider", "sessionFile", "skillPaths", "thinking", "tools"].sort());
		assert.deepEqual(Object.keys(projections.herdr[0]!).sort(), ["id", "canonicalName", "backend", "cwd", "viewerPaneId", "viewerTabId"].sort());
		assert.doesNotMatch(JSON.stringify(projections), /secret initial task|parentSessionId|finalResponse/);
		const projectedList = await execute(api, "list_agents", {}, parentA);
		assert.equal(projectedList.details.agents[0].agent_name, "/alpha", "projection mutation cannot alter persisted agent metadata");
		const waiting = execute(api, "wait_agent", { targets: ["alpha"] }, parentA);
		let pending = true; void waiting.finally(() => { pending = false; }); await turn(); assert.equal(pending, true);
		runtimes.emitPi("/alpha", { type: "phase", phase: "Reading plan" });
		assert.match(JSON.stringify(snapshots), /Reading plan/);
		runtimes.settlePi("/alpha");
		const waited = await waiting;
		assert.equal(waited.content[0].text, JSON.stringify({ agent_name: "/alpha", status: "completed", finalResponse: "result:secret initial task", error: undefined }, null, 2));
		const read = await execute(api, "read_agent_response", { target: "alpha" }, parentA);
		assert.equal(read.content[0].text, JSON.stringify({ agent_name: "/alpha", status: "completed", finalResponse: "result:secret initial task" }, null, 2));
		const sent = await execute(api, "send_message", { target: "alpha", message: "follow up" }, parentA);
		assert.equal(sent.content[0].text, "Message started a new agent turn.");
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
		await turn(); // closeLive finished; viewer cleanup intentionally still blocks the first control tail.
		const thirdControl = execute(api, "interrupt_agent", { target: "race" }, parentA);
		let thirdPending = true; void thirdControl.finally(() => { thirdPending = false; });
		await turn();
		assert.equal(thirdPending, true, "a third same-agent control remains behind the queued second control");
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
		assert.equal(spawned.details.status, "running");
		const runtime = runtimes.cursor.get(root)!;
		const approval = runtime.handlers.onRequest({ method: "session/request_permission", params: { title: "read", options: [{ optionId: "allow-once" }, { optionId: "reject-once" }] } });
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
		await assert.rejects(() => execute(failApi, "spawn_agent", { task_name: "fails", message: "x", backend: "pi" }, context("parent-fail", root)), /start failure/);
		await failApi.emit("session_shutdown");
		assert.equal(failEvents.filter((event) => event.startsWith("viewer:close:/fails")).length, 1);
	} finally { await api.emit("session_shutdown"); await rm(root, { recursive: true, force: true }); }
});
