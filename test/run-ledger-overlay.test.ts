import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { RunLedgerOverlay, type LedgerOverlaySource } from "../extensions/run-ledger-overlay.ts";
import { createRunLedgerState, normalizeRunLedgerEvent, reduceRunLedgerEvents, type RunLedgerState } from "../extensions/run-ledger.ts";
import type { AgentStateSnapshot } from "../extensions/unified-deps.ts";

function ledger(extra: Array<Record<string, unknown>> = []): RunLedgerState {
	const records = [
		{ kind: "run", runId: "agent", agentName: "/agent", backend: "pi", model: "test/model" },
		{ kind: "runtime", state: "running" },
		{ kind: "phase", name: "Thinking" },
		...extra,
	].map((record, index) => normalizeRunLedgerEvent({ v: 2, seq: index + 1, ts: 1_000 + index, turn: 1, ...record })!);
	return reduceRunLedgerEvents(records, createRunLedgerState({ startedAt: 1_000 }));
}
function agent(overrides: Partial<AgentStateSnapshot> = {}): AgentStateSnapshot {
	return { id: "agent", agentName: "/agent", backend: "pi", model: "test/model", thinking: "high", status: "running", createdAt: 1_000, updatedAt: 1_000, startedAt: 1_000, lastActivityAt: 1_000, activity: "Thinking", turnId: "turn", turnSequence: 1, turnOrdinal: 1, permissionPending: false, ledgerRevision: 1, ...overrides };
}
class FakeSource implements LedgerOverlaySource {
	readOnly = false; currentAgent: AgentStateSnapshot | undefined = agent(); currentLedger: RunLedgerState | undefined = ledger(); rawReads = 0; sends: string[] = []; interrupts = 0; failSend = false; listeners = new Set<() => void>();
	getAgent() { return this.currentAgent; }
	getLedger() { return this.currentLedger; }
	subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	async send(message: string) { this.sends.push(message); if (this.failSend) throw new Error("token=private send failure"); }
	async interrupt() { this.interrupts++; }
	readRawDiagnostics() { this.rawReads++; return ["raw token=private command output"]; }
	emit() { for (const listener of this.listeners) listener(); }
}
function harness(source = new FakeSource(), rows = 30) {
	let renders = 0; let result: unknown = "open"; const tui = { terminal: { rows, columns: 120 }, requestRender() { renders++; } } as any;
	const theme = { fg: (_role: string, value: string) => value, bold: (value: string) => value } as any;
	const overlay = new RunLedgerOverlay(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), source, (value) => { result = value; }, () => 2_000); overlay.focused = true;
	return { overlay, source, get renders() { return renders; }, get result() { return result; } };
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("native ledger is semantic by default and raw diagnostics require two confirmations", () => {
	const h = harness(); const semantic = h.overlay.render(100).join("\n"); assert.match(semantic, /Thinking/); assert.doesNotMatch(semantic, /raw token|private/); assert.equal(h.source.rawReads, 0);
	h.overlay.handleInput("r"); assert.equal(h.source.rawReads, 0); assert.match(h.overlay.render(100).join("\n"), /may expose prompts/); assert.match(h.overlay.render(100).join("\n"), /r again RAW/);
	h.overlay.handleInput("z"); assert.equal(h.source.rawReads, 0);
	h.overlay.handleInput("r"); h.overlay.handleInput("r"); assert.equal(h.source.rawReads, 1); const raw = h.overlay.render(100).join("\n"); assert.match(raw, /RAW DIAGNOSTICS/); assert.match(raw, /token=private/);
	h.overlay.handleInput("r"); assert.match(h.overlay.render(100).join("\n"), /Thinking/); h.overlay.dispose();
});

test("composer preserves a failed draft, clears on success, and forwards focus", async () => {
	const h = harness(); h.source.failSend = true; h.overlay.handleInput("\r"); assert.match(h.overlay.render(100).join("\n"), /Steer Pi — current turn/); h.overlay.handleInput("h"); h.overlay.handleInput("i"); h.overlay.handleInput("\r"); await flush();
	assert.deepEqual(h.source.sends, ["hi"]); assert.match(h.overlay.render(100).join("\n"), /hi/); assert.match(h.overlay.render(100).join("\n"), /Action failed/); assert.doesNotMatch(h.overlay.render(100).join("\n"), /private/);
	h.source.failSend = false; h.overlay.handleInput("\r"); await flush(); assert.deepEqual(h.source.sends, ["hi", "hi"]); assert.doesNotMatch(h.overlay.render(100).join("\n"), /Enter send/); h.overlay.dispose();
});

test("composer labels Cursor replacement and settled follow-up semantics exactly", () => {
	const cursor = new FakeSource(); cursor.currentAgent = agent({ backend: "cursor", model: "Auto" }); const c = harness(cursor); c.overlay.handleInput("\r"); assert.match(c.overlay.render(100).join("\n"), /Correct Cursor — replaces current turn/); c.overlay.dispose();
	const settled = new FakeSource(); settled.currentAgent = agent({ status: "completed", completedAt: 2_000 }); const s = harness(settled); s.overlay.handleInput("\r"); assert.match(s.overlay.render(100).join("\n"), /Follow up — queues a new turn/); s.overlay.dispose();
	const queued = new FakeSource(); queued.currentAgent = agent({ status: "queued", queuePosition: 1 }); const q = harness(queued); q.overlay.handleInput("\r"); assert.doesNotMatch(q.overlay.render(100).join("\n"), /Enter send|Steer Pi/); q.overlay.dispose();
});

test("a hanging send never traps the overlay", async () => {
	const source = new FakeSource(); source.send = async (message: string) => { source.sends.push(message); await new Promise(() => {}); };
	const h = harness(source); h.overlay.handleInput("\r"); h.overlay.handleInput("x"); h.overlay.handleInput("\r"); await flush(); assert.match(h.overlay.render(80).join("\n"), /Sending/);
	h.overlay.handleInput("\x1b"); assert.equal(h.result, undefined); assert.equal(source.listeners.size, 0);
});

test("stop requires two consecutive keys and read-only history denies actions", async () => {
	const h = harness(); h.overlay.handleInput("x"); h.overlay.handleInput("z"); h.overlay.handleInput("x"); h.overlay.handleInput("x"); await flush(); assert.equal(h.source.interrupts, 1); h.overlay.dispose();
	const readOnly = new FakeSource(); readOnly.readOnly = true; const r = harness(readOnly); r.overlay.handleInput("\r"); r.overlay.handleInput("x"); r.overlay.handleInput("x"); await flush(); assert.deepEqual(readOnly.sends, []); assert.equal(readOnly.interrupts, 0); r.overlay.dispose();
});

test("an in-flight interrupt excludes send without sticking the stop state", async () => {
	const source = new FakeSource(); let release!: () => void; source.interrupt = async () => { source.interrupts++; await new Promise<void>((resolve) => { release = resolve; }); };
	const h = harness(source); h.overlay.handleInput("x"); h.overlay.handleInput("x"); h.overlay.handleInput("\r"); assert.doesNotMatch(h.overlay.render(80).join("\n"), /Enter send/); release(); await flush();
	h.overlay.handleInput("\r"); assert.match(h.overlay.render(80).join("\n"), /Enter send/); h.overlay.handleInput("\x1b"); h.overlay.dispose();
});

test("safe permission state remains visible when its journal record is outside the tail", () => {
	const source = new FakeSource(); source.currentAgent = agent({ permissionPending: true }); const h = harness(source); assert.match(h.overlay.render(80).join("\n"), /Awaiting parent-agent approval/); assert.doesNotMatch(h.overlay.render(80).join("\n"), /approvalId/); h.overlay.dispose();
});

test("detached scrolling counts new semantic blocks, navigation disposes, and every line fits", () => {
	const h = harness(); h.overlay.handleInput("k"); h.source.currentLedger = ledger([{ kind: "phase", name: "New safe phase" }]); h.source.emit(); assert.match(h.overlay.render(80).join("\n"), /1 new/);
	for (const width of [1, 5, 6, 20, 40, 100]) for (const line of h.overlay.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	h.overlay.handleInput("\x1b[C"); assert.equal(h.result, "next"); assert.equal(h.source.listeners.size, 0);
	const tiny = harness(new FakeSource(), 3); assert.ok(tiny.overlay.render(20).length <= 2); tiny.overlay.dispose();
});
