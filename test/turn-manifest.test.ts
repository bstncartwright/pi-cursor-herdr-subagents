import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_ACTIVE_TURN_LIMIT, MAX_LOCK_BYTES, MAX_MANIFEST_BYTES, TURN_MANIFEST_FILE, TURN_MANIFEST_LOCK_FILE, TURN_MANIFEST_RECLAIM_FILE, TurnManifestStore,
	addAgent, addAgentAtScope, admitFifo, canonicalAgentPaths, closeAgent, createParentManifest, enqueueTurn, materializeAgentProjections,
	migrateLegacyInfo, parseParentManifest, reconcileManifest, replaceCursorTurn, touchTurn, transitionTurn, updateAgentRuntimeResources, updateAgentWorktree,
	type AddAgentInput, type ResolvedExecutionSnapshot,
} from "../extensions/turn-manifest.ts";

const parent = "parent-test";
let serial = 0;
const now = 1_000;
function execution(backend: "pi" | "cursor" = "pi", message = "task"): ResolvedExecutionSnapshot {
	return { backend, cwd: "/work", model: backend === "pi" ? "provider:model" : "Auto", provider: backend === "pi" ? "provider" : undefined, modelId: backend === "pi" ? "model" : undefined, thinking: backend === "pi" ? "low" : undefined, tools: backend === "pi" ? "read" : undefined, skills: [], skillPaths: [], extensions: [], extensionPaths: [], cursorModel: backend === "cursor" ? "Auto" : undefined, permissionMode: "agent", sessionFile: backend === "pi" ? undefined : undefined, prompt: `private:${message}`, displayMessage: message };
}
function agent(id = `agent-${++serial}`, backend: "pi" | "cursor" = "pi"): AddAgentInput {
	return { id, taskName: id, canonicalName: `/${id}`, backend, parentSessionId: parent, cwd: "/work", model: backend === "pi" ? "provider:model" : "Auto", provider: backend === "pi" ? "provider" : undefined, modelId: backend === "pi" ? "model" : undefined, thinking: backend === "pi" ? "low" : undefined, tools: backend === "pi" ? "read" : undefined, skills: [], skillPaths: [], extensions: [], extensionPaths: [], cursorModel: backend === "cursor" ? "Auto" : undefined, permissionMode: "agent", sessionFile: backend === "pi" ? `/run/${id}.session.jsonl` : undefined, infoFile: `/run/${id}.info.json`, logFile: `/run/${id}.events.log`, responseFile: `/run/${id}.response.txt`, createdAt: now, updatedAt: now };
}
function seeded(count = 1, backend: "pi" | "cursor" = "pi") {
	let manifest = createParentManifest(parent, "epoch-a", now);
	const ids: string[] = [];
	for (let index = 0; index < count; index++) { const input = agent(`agent-${index}`, backend); ids.push(input.id); manifest = addAgent(manifest, input, now); }
	return { manifest, ids };
}
function queue(manifest: ReturnType<typeof createParentManifest>, agentId: string, id: string, backend: "pi" | "cursor" = "pi", createdAt = now) { return enqueueTurn(manifest, { id, agentId, source: "initial", execution: { ...execution(backend, id), cwd: manifest.agents[agentId]!.cwd, sessionFile: manifest.agents[agentId]!.sessionFile }, createdAt, ownerEpoch: manifest.epoch }); }

function mutateJson(manifest: unknown, change: (value: any) => void) { const value = JSON.parse(JSON.stringify(manifest)); change(value); return value; }

test("manifest parsing is strict, versioned, corrupt-fail-closed, and contains no final output field", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	assert.deepEqual(parseParentManifest(manifest), manifest);
	for (const corrupt of [
		mutateJson(manifest, (value) => { value.version = 4; }),
		mutateJson(manifest, (value) => { value.extra = true; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].sequence = 0.1; }),
		mutateJson(manifest, (value) => { value.agents[ids[0]].currentTurnId = "missing"; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].execution.backend = "cursor"; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].execution.sessionFile = "/wrong"; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].admittedAt = now + 1; }),
		mutateJson(manifest, (value) => { delete value.agents[ids[0]].permissionMode; }),
		mutateJson(manifest, (value) => { value.agents[ids[0]].permissionMode = "unsafe"; }),
		mutateJson(manifest, (value) => { delete value.turns["turn-a"].execution.permissionMode; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].execution.permissionMode = "unsafe"; }),
		mutateJson(manifest, (value) => { value.agents[ids[0]].currentTurnId = "turn-a"; value.turns["turn-a"].ordinal = 1; value.agents[ids[0]].nextOrdinal = 3; value.turns.extra = { ...value.turns["turn-a"], id: "extra", ordinal: 1, sequence: 2 }; value.agents[ids[0]].currentTurnId = "extra"; }),
		mutateJson(manifest, (value) => { value.turns["turn-a"].finalResponse = "leak"; }),
	]) assert.throws(() => parseParentManifest(corrupt), /Invalid turn manifest/);
	assert.doesNotMatch(JSON.stringify(manifest), /finalResponse/);
});

test("parser rejects five active turns, stale current pointers, invalid timestamp/state fields, and scope path mismatch", () => {
	let { manifest, ids } = seeded(5);
	for (const [index, id] of ids.entries()) manifest = queue(manifest, id, `active-${index}`);
	const fiveActive = mutateJson(manifest, (value) => {
		value.updatedAt = now + 1;
		for (const turn of Object.values<any>(value.turns)) { turn.state = "admitted"; turn.admittedAt = now + 1; turn.lastActivityAt = now + 1; }
	});
	assert.throws(() => parseParentManifest(fiveActive), /exceeds 4 active/);
	const stale = mutateJson(manifest, (value) => { value.agents[ids[0]].currentTurnId = `active-1`; });
	assert.throws(() => parseParentManifest(stale), /latest ordinal\/sequence turn/);
	const invalidRunning = mutateJson(manifest, (value) => { value.updatedAt = now + 2; const turn = value.turns["active-0"]; turn.state = "running"; turn.admittedAt = now + 2; turn.lastActivityAt = now + 2; });
	assert.throws(() => parseParentManifest(invalidRunning), /running turn/);
	// Build an actual scoped agent first, then prove response/path escape fails under scope-aware parsing.
	const paths = canonicalAgentPaths("/safe-scope", ids[0]!);
	let scopedManifest = createParentManifest(parent, "epoch-a", now);
	const scopedAgent = { ...agent(ids[0]!), ...paths };
	scopedManifest = addAgentAtScope(scopedManifest, "/safe-scope", scopedAgent, now);
	assert.deepEqual(canonicalAgentPaths("/safe-scope", ids[0]!), { infoFile: scopedManifest.agents[ids[0]!]!.infoFile, logFile: scopedManifest.agents[ids[0]!]!.logFile, responseFile: scopedManifest.agents[ids[0]!]!.responseFile, sessionFile: scopedManifest.agents[ids[0]!]!.sessionFile });
	scopedManifest = queue(scopedManifest, ids[0]!, "turn-a");
	const escaped = mutateJson(scopedManifest, (value) => { value.agents[ids[0]].logFile = "/escape.events.log"; });
	assert.throws(() => parseParentManifest(escaped, { scopeDir: "/safe-scope" }), /resource paths/);
	const scopedCursor = addAgentAtScope(createParentManifest(parent, "epoch-a", now), "/safe-scope", agent("scoped-cursor", "cursor"), now);
	assert.equal(scopedCursor.agents["scoped-cursor"]!.sessionFile, undefined);
	assert.doesNotThrow(() => parseParentManifest(scopedCursor, { scopeDir: "/safe-scope" }));
});

test("backend snapshots reject cross-backend configuration and queued Cursor corrections", () => {
	let pi = seeded(); pi.manifest = queue(pi.manifest, pi.ids[0]!, "pi-turn");
	assert.throws(() => parseParentManifest(mutateJson(pi.manifest, (value) => { value.agents[pi.ids[0]].provider = undefined; value.turns["pi-turn"].execution.provider = undefined; })), /requires provider and modelId/);
	let cursor = seeded(1, "cursor"); cursor.manifest = queue(cursor.manifest, cursor.ids[0]!, "cursor-turn", "cursor");
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { value.agents[cursor.ids[0]].cursorModel = undefined; value.turns["cursor-turn"].execution.cursorModel = undefined; })), /requires cursorModel/);
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { value.agents[cursor.ids[0]].provider = "forbidden"; value.turns["cursor-turn"].execution.provider = "forbidden"; })), /Pi-only config/);
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { value.agents[cursor.ids[0]].skills = ["forbidden"]; value.turns["cursor-turn"].execution.skills = ["forbidden"]; })), /must not have skills or extensions/);
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { value.turns["cursor-turn"].source = "cursor-correction"; })), /cursor correction.*admitted Cursor history/);
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { const turn = value.turns["cursor-turn"]; turn.source = "cursor-correction"; turn.state = "terminal"; turn.terminalStatus = "interrupted"; turn.completedAt = now; })), /cursor correction.*admitted Cursor history/);
});

test("turn transition matrix and one-active invariant are enforced", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	assert.throws(() => transitionTurn(manifest, "turn-a", "running", now), /illegal transition/);
	manifest = transitionTurn(manifest, "turn-a", "admitted", now + 1);
	assert.throws(() => transitionTurn(manifest, "turn-a", "queued", now + 2), /illegal transition/);
	manifest = transitionTurn(manifest, "turn-a", "running", now + 2);
	manifest = transitionTurn(manifest, "turn-a", "terminal", now + 3, { status: "completed", response: { turnId: "turn-a", path: manifest.agents[ids[0]!]!.responseFile } });
	assert.equal(manifest.turns["turn-a"]!.terminalStatus, "completed");
	manifest = queue(manifest, ids[0]!, "turn-b", "pi", now + 3);
	assert.throws(() => queue(manifest, ids[0]!, "turn-c", "pi", now + 3), /already has a nonterminal turn/);
});

test("FIFO admission reserves at most four parent-global active turns", () => {
	let { manifest, ids } = seeded(6);
	for (const [index, id] of ids.entries()) manifest = queue(manifest, id, `turn-${index}`);
	const admitted = admitFifo(manifest, now + 1);
	assert.deepEqual(admitted.admitted, ["turn-0", "turn-1", "turn-2", "turn-3"]);
	assert.equal(Object.values(admitted.manifest.turns).filter((turn) => turn.state === "admitted").length, DEFAULT_ACTIVE_TURN_LIMIT);
	const again = admitFifo(admitted.manifest, now + 2);
	assert.deepEqual(again.admitted, []);
});

test("Cursor correction atomically terminals old work and directly admits successor", () => {
	let { manifest, ids } = seeded(1, "cursor"); manifest = queue(manifest, ids[0]!, "cursor-old", "cursor");
	manifest = transitionTurn(manifest, "cursor-old", "admitted", now + 1); manifest = transitionTurn(manifest, "cursor-old", "running", now + 2);
	const next = replaceCursorTurn(manifest, "cursor-old", "cursor-new", execution("cursor", "correction"), now + 3);
	assert.equal(next.turns["cursor-old"]!.terminalStatus, "interrupted");
	assert.equal(next.turns["cursor-old"]!.terminalReason, "parent-corrected");
	assert.equal(next.turns["cursor-new"]!.state, "admitted");
	assert.equal(next.agents[ids[0]!]!.currentTurnId, "cursor-new");
	assert.equal(Object.values(next.turns).filter((turn) => turn.state !== "terminal").length, 1);
	const settled = transitionTurn(next, "cursor-new", "terminal", now + 4, { status: "interrupted", reason: "test" });
	assert.equal(settled.turns["cursor-new"]!.admittedAt, now + 3);
});

test("projection dynamically represents queued/admitted/running/terminal and closed override", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	assert.equal(materializeAgentProjections(manifest)[0]!.status, "queued");
	manifest = transitionTurn(manifest, "turn-a", "admitted", now + 1); assert.equal(materializeAgentProjections(manifest)[0]!.status, "starting");
	manifest = transitionTurn(manifest, "turn-a", "running", now + 2); assert.equal(materializeAgentProjections(manifest)[0]!.status, "running");
	manifest = transitionTurn(manifest, "turn-a", "terminal", now + 3, { status: "paused", reason: "shutdown-paused", response: { turnId: "turn-a", path: manifest.agents[ids[0]!]!.responseFile } });
	assert.equal(materializeAgentProjections(manifest)[0]!.status, "paused");
	assert.equal(materializeAgentProjections(manifest)[0]!.finalResponse, undefined);
	assert.equal(materializeAgentProjections(manifest, { readResponse: (reference) => reference.path === manifest.agents[ids[0]!]!.responseFile ? "read privately" : undefined })[0]!.finalResponse, "read privately");
	manifest.agents[ids[0]!]!.closed = true; manifest.agents[ids[0]!]!.closedAt = now + 4; manifest.agents[ids[0]!]!.closeReason = "explicit-close";
	assert.equal(materializeAgentProjections(manifest)[0]!.status, "closed");
});

test("reconciliation terminalizes prior epoch work without auto-resume", () => {
	let { manifest, ids } = seeded(2); manifest = queue(manifest, ids[0]!, "queued"); manifest = queue(manifest, ids[1]!, "running");
	manifest = transitionTurn(manifest, "running", "admitted", now + 1); manifest = transitionTurn(manifest, "running", "running", now + 2);
	const reconciled = reconcileManifest(manifest, "epoch-b", now + 3);
	assert.equal(reconciled.epoch, "epoch-b");
	assert.equal(reconciled.turns.queued!.terminalStatus, "paused"); assert.equal(reconciled.turns.queued!.terminalReason, "shutdown-paused");
	assert.equal(reconciled.turns.running!.terminalStatus, "interrupted"); assert.equal(reconciled.turns.running!.terminalReason, "restart-interrupted");
	assert.deepEqual(admitFifo(reconciled, now + 4).admitted, []);
});

test("legacy info-only migration preserves settled records and interrupts old active records", () => {
	const manifest = migrateLegacyInfo(parent, "epoch-b", [
		{ ...agent("legacy-running"), permissionMode: undefined, status: "running", turn: 1, lastActivity: now, startedAt: now, error: undefined },
		{ ...agent("legacy-complete"), status: "completed", turn: 2, lastActivity: now, completedAt: now, finalResponse: "do not persist this" },
		{
			...agent("legacy-paused", "cursor"), status: "paused", turn: 3, lastActivity: now,
			// Old Cursor projections inherited these parent-Pi fields before the backend split.
			provider: "stale-provider", modelId: "stale-model", thinking: "high", tools: "bash",
			skills: ["stale-skill"], skillPaths: ["/stale/skill"], extensions: ["stale-extension"], extensionPaths: ["/stale/extension"],
			acpCapabilities: { loadSession: true, unsafe: "discard" },
		},
		{ ...agent("legacy-closed"), status: "closed", turn: 4, lastActivity: now, closedAt: now },
	], now + 1);
	assert.equal(manifest.turns["legacy-legacy-running"]!.terminalStatus, "interrupted");
	assert.equal(manifest.turns["legacy-legacy-running"]!.terminalReason, "legacy-active-interrupted");
	assert.equal(manifest.agents["legacy-running"]!.permissionMode, "agent");
	assert.equal(manifest.turns["legacy-legacy-complete"]!.terminalStatus, "completed");
	assert.equal(manifest.turns["legacy-legacy-paused"]!.terminalStatus, "paused");
	assert.deepEqual(manifest.agents["legacy-paused"]!.acpCapabilities, { loadSession: true });
	assert.equal(manifest.agents["legacy-paused"]!.provider, undefined);
	assert.equal(manifest.agents["legacy-paused"]!.thinking, undefined);
	assert.deepEqual(manifest.agents["legacy-paused"]!.skills, []);
	assert.equal(manifest.agents["legacy-closed"]!.closed, true);
	assert.equal(manifest.turns["legacy-legacy-closed"]!.terminalStatus, "interrupted");
	assert.equal(manifest.turns["legacy-legacy-complete"]!.ordinal, 2);
	assert.doesNotMatch(JSON.stringify(manifest), /do not persist this|unsafe/);
	const nested = migrateLegacyInfo(parent, "epoch-c", [{ ...agent("legacy-nested"), taskName: "Feature_2/Nested-Task", canonicalName: "/Feature_2/Nested-Task", status: "completed", turn: 1, lastActivity: now, completedAt: now }], now + 1);
	assert.equal(parseParentManifest(nested).agents["legacy-nested"]!.canonicalName, "/Feature_2/Nested-Task");
});

async function temporaryStore(options: ConstructorParameters<typeof TurnManifestStore>[1] = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-turn-manifest-")); return { dir, store: new TurnManifestStore(dir, options) };
}

test("store writes private unique atomic files and cleans temporary artifacts", async () => {
	const { dir, store } = await temporaryStore({ uuid: (() => { let n = 0; return () => `u${++n}`; })(), pid: () => 123, now: () => now });
	try {
		const manifest = createParentManifest(parent, "epoch-a", now); store.writeAtomic(manifest); store.writeAtomic(manifest);
		assert.deepEqual(store.read(), manifest);
		assert.equal((await stat(join(dir, TURN_MANIFEST_FILE))).mode & 0o777, 0o600);
		assert.equal(existsSync(join(dir, `${TURN_MANIFEST_FILE}.123.u1.tmp`)), false);
		assert.equal(existsSync(join(dir, `${TURN_MANIFEST_FILE}.123.u2.tmp`)), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("lock contention, dead-pid grace reclaim, nonce release, and epoch rejection fail safely", async () => {
	const { dir, store } = await temporaryStore({ now: () => 10_000, uuid: (() => { let n = 0; return () => `n${++n}`; })(), pid: () => 77, processAlive: (pid) => pid === 77, lockGraceMs: 100 });
	try {
		store.writeAtomic(createParentManifest(parent, "epoch-a", now));
		const lock = store.acquire("epoch-a");
		assert.equal((await stat(join(dir, TURN_MANIFEST_LOCK_FILE))).mode & 0o777, 0o600);
		assert.throws(() => store.acquire("epoch-a"), /lock is held/); store.release(lock);
		writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), JSON.stringify({ epoch: "epoch-a", nonce: "extra", pid: 88, createdAt: 9_000, extra: true }), { mode: 0o600 });
		assert.throws(() => store.acquire("epoch-a"), /corrupt/); unlinkSync(join(dir, TURN_MANIFEST_LOCK_FILE));
		writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), JSON.stringify({ epoch: "epoch-a", nonce: "dead", pid: 88, createdAt: 9_000 }), { mode: 0o600 });
		const reclaimed = store.acquire("epoch-a"); store.release(reclaimed);
		writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), JSON.stringify({ epoch: "epoch-a", nonce: "young", pid: 88, createdAt: 9_950 }), { mode: 0o600 });
		assert.throws(() => store.acquire("epoch-a"), /lock is held/); writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), JSON.stringify({ epoch: "epoch-a", nonce: "other", pid: 77, createdAt: 10_000 }), { mode: 0o600 });
		assert.throws(() => store.release({ epoch: "epoch-a", nonce: "not-other", pid: 77, createdAt: 10_000 }), /nonce changed/);
		store.release({ epoch: "epoch-a", nonce: "other", pid: 77, createdAt: 10_000 });
		assert.throws(() => store.acquire("wrong-epoch"), /epoch changed/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("reclaim guard fails closed without deleting a stale main lock, then guarded reclaim is safe", async () => {
	const { dir, store } = await temporaryStore({ now: () => 10_000, uuid: (() => { let n = 0; return () => `guard-${++n}`; })(), pid: () => 77, processAlive: () => false, lockGraceMs: 100 });
	try {
		store.writeAtomic(createParentManifest(parent, "epoch-a", now));
		const stale = { epoch: "epoch-a", nonce: "stale-owner", pid: 88, createdAt: 9_000 };
		writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), JSON.stringify(stale), { mode: 0o600 });
		writeFileSync(join(dir, TURN_MANIFEST_RECLAIM_FILE), JSON.stringify({ epoch: "reclaim", nonce: "abandoned-guard", pid: 89, createdAt: 1 }), { mode: 0o600 });
		assert.throws(() => store.acquire("epoch-a"), /reclaim guard.*manual recovery/);
		assert.deepEqual(JSON.parse(String(readFileSync(join(dir, TURN_MANIFEST_LOCK_FILE))) ), stale);
		unlinkSync(join(dir, TURN_MANIFEST_RECLAIM_FILE));
		const reclaimed = store.acquire("epoch-a"); store.release(reclaimed);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("initialize creates exactly once and refuses to overwrite missing or corrupt state", async () => {
	const { dir, store } = await temporaryStore({ now: () => now, uuid: (() => { let n = 0; return () => `init-${++n}`; })(), pid: () => 201, processAlive: () => false });
	try {
		const first = createParentManifest(parent, "epoch-a", now);
		assert.deepEqual(store.initialize(first), first);
		const competing = createParentManifest(parent, "epoch-b", now);
		assert.deepEqual(store.initialize(competing), first, "a same-parent initializer must read, not overwrite");
		assert.throws(() => store.initialize(createParentManifest("other-parent", "epoch-b", now)), /parent session differs/);
		assert.deepEqual(store.read(), first);
		writeFileSync(join(dir, TURN_MANIFEST_FILE), "{ corrupt", { mode: 0o600 });
		assert.throws(() => store.initialize(first), /corrupt/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("locked mutation rereads expected epoch and rejects async effects", async () => {
	const { dir, store } = await temporaryStore({ uuid: (() => { let n = 0; return () => `m${++n}`; })(), now: () => now, pid: () => 42, processAlive: () => false });
	try {
		store.writeAtomic(createParentManifest(parent, "epoch-a", now));
		const updated = store.mutate("epoch-a", (manifest) => ({ ...manifest, updatedAt: now + 1 })); assert.equal(updated.updatedAt, now + 1);
		assert.throws(() => store.mutate("epoch-a", (() => Promise.resolve(updated)) as any), /must not return a Promise/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});


test("store rejects unknown write keys before poisoning manifest and cleans lock after corrupt-read acquire", async () => {
	const { dir, store } = await temporaryStore({ now: () => now, uuid: (() => { let n = 0; return () => `secure${++n}`; })(), pid: () => 71, processAlive: () => false });
	try {
		const clean = createParentManifest(parent, "epoch-a", now); store.writeAtomic(clean);
		const poisoned = { ...clean, unknown: true } as any;
		assert.throws(() => store.writeAtomic(poisoned), /unsupported/);
		assert.deepEqual(store.read(), clean);
		writeFileSync(join(dir, TURN_MANIFEST_FILE), "{ not json", { mode: 0o600 });
		assert.throws(() => store.acquire("epoch-a"), /corrupt/);
		assert.equal(existsSync(join(dir, TURN_MANIFEST_LOCK_FILE)), false, "failed acquire must release its newly-created lock");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("store rejects escaped and symlinked manifest or lock paths", async () => {
	const { dir, store } = await temporaryStore({ now: () => now, uuid: () => "sym", pid: () => 72, processAlive: () => false });
	const outside = join(dir, "outside.json");
	try {
		writeFileSync(outside, JSON.stringify(createParentManifest(parent, "epoch-a", now)), { mode: 0o600 });
		symlinkSync(outside, join(dir, TURN_MANIFEST_FILE));
		assert.throws(() => store.read(), /safe regular file/);
		unlinkSync(join(dir, TURN_MANIFEST_FILE));
		store.writeAtomic(createParentManifest(parent, "epoch-a", now));
		symlinkSync(outside, join(dir, TURN_MANIFEST_LOCK_FILE));
		assert.throws(() => store.acquire("epoch-a"), /safe regular file/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("activity mutation timestamps are monotonic and terminal turns cannot be touched", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	manifest = touchTurn(manifest, "turn-a", now + 1);
	assert.equal(manifest.turns["turn-a"]!.lastActivityAt, now + 1);
	assert.throws(() => touchTurn(manifest, "turn-a", now), /precedes manifest.updatedAt/);
	manifest = transitionTurn(manifest, "turn-a", "admitted", now + 2);
	assert.throws(() => transitionTurn(manifest, "turn-a", "running", now + 1), /precedes manifest.updatedAt/);
	manifest = transitionTurn(manifest, "turn-a", "running", now + 3);
	manifest = transitionTurn(manifest, "turn-a", "terminal", now + 4, { status: "completed" });
	assert.throws(() => touchTurn(manifest, "turn-a", now + 5), /cannot touch terminal/);

	let cursor = seeded(1, "cursor"); cursor.manifest = queue(cursor.manifest, cursor.ids[0]!, "old", "cursor");
	cursor.manifest = transitionTurn(cursor.manifest, "old", "admitted", now + 1);
	cursor.manifest = transitionTurn(cursor.manifest, "old", "running", now + 2);
	assert.throws(() => replaceCursorTurn(cursor.manifest, "old", "new", execution("cursor"), now + 1), /precedes manifest.updatedAt/);
	assert.throws(() => reconcileManifest(cursor.manifest, "epoch-b", now + 1), /precedes manifest.updatedAt/);
});

test("parser enforces exact sequence, manifest timestamp, normalized task identity, and backend session paths", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.nextSequence = 3; })), /exactly follow/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.updatedAt = now - 1; })), /precedes agent|precedes turn/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[ids[0]].taskName = "Not Normalized"; })), /public task syntax/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[ids[0]].canonicalName = "/other"; })), /canonicalName/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[ids[0]].sessionFile = "/run/wrong.session.jsonl"; value.turns["turn-a"].execution.sessionFile = "/run/wrong.session.jsonl"; })), /backend session path/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[ids[0]].acpSessionId = "not-for-pi"; })), /only valid for Cursor/);
	const resolvedResponse = mutateJson(manifest, (value) => { value.turns["turn-a"].response = undefined; value.turns["turn-a"].state = "terminal"; value.turns["turn-a"].terminalStatus = "completed"; value.turns["turn-a"].completedAt = now; value.turns["turn-a"].response = { turnId: "turn-a", path: `/run/x/../${ids[0]}.response.txt` }; });
	assert.doesNotThrow(() => parseParentManifest(resolvedResponse));
	let cursor = seeded(1, "cursor"); cursor.manifest = queue(cursor.manifest, cursor.ids[0]!, "cursor-turn", "cursor");
	assert.throws(() => parseParentManifest(mutateJson(cursor.manifest, (value) => { value.agents[cursor.ids[0]].sessionFile = "/run/nope.session.jsonl"; value.turns["cursor-turn"].execution.sessionFile = "/run/nope.session.jsonl"; })), /backend session path/);
});

test("admission cannot raise the parent-global four-turn limit", () => {
	const { manifest } = seeded();
	assert.throws(() => admitFifo(manifest, now, DEFAULT_ACTIVE_TURN_LIMIT + 1), /no greater than 4/);
});

test("runtime resource update is narrow, pairs/clears viewer IDs, and closing atomically settles queued work", () => {
	let { manifest, ids } = seeded(1, "cursor"); manifest = queue(manifest, ids[0]!, "turn-a", "cursor");
	manifest = updateAgentRuntimeResources(manifest, ids[0]!, { viewerPaneId: "pane", viewerTabId: "tab", acpSessionId: "acp", acpCapabilities: { loadSession: true } }, now + 1);
	assert.deepEqual(manifest.agents[ids[0]!]!.acpCapabilities, { loadSession: true });
	assert.throws(() => updateAgentRuntimeResources(manifest, ids[0]!, { viewerPaneId: "only-pane" }, now + 2), /updated as a pair/);
	assert.throws(() => updateAgentRuntimeResources(manifest, ids[0]!, { acpCapabilities: { unsafe: true } } as any, now + 2), /unsupported/);
	const closed = closeAgent(manifest, ids[0]!, "explicit-close", now + 2);
	const cleared = updateAgentRuntimeResources(closed, ids[0]!, { viewerPaneId: null, viewerTabId: null }, now + 3);
	assert.equal(cleared.agents[ids[0]!]!.viewerPaneId, undefined); assert.equal(cleared.agents[ids[0]!]!.viewerTabId, undefined);
	assert.equal(cleared.agents[ids[0]!]!.closed, true);
	assert.equal(cleared.turns["turn-a"]!.terminalStatus, "interrupted");
	assert.equal(cleared.turns["turn-a"]!.terminalReason, "explicit-close");
	assert.throws(() => closeAgent(cleared, ids[0]!, "again", now + 4), /already closed/);
	const pi = seeded();
	assert.throws(() => updateAgentRuntimeResources(pi.manifest, pi.ids[0]!, { acpSessionId: "not-for-pi" }, now + 1), /only valid for Cursor/);
});

test("store rejects oversized manifest and lock data before parsing", async () => {
	const { dir, store } = await temporaryStore({ now: () => now, uuid: () => "large", pid: () => 101, processAlive: () => false });
	try {
		writeFileSync(join(dir, TURN_MANIFEST_FILE), "x".repeat(MAX_MANIFEST_BYTES + 1), { mode: 0o600 });
		assert.throws(() => store.read(), /exceeds .* bytes before read/);
		unlinkSync(join(dir, TURN_MANIFEST_FILE)); store.writeAtomic(createParentManifest(parent, "epoch-a", now));
		writeFileSync(join(dir, TURN_MANIFEST_LOCK_FILE), "x".repeat(MAX_LOCK_BYTES + 1), { mode: 0o600 });
		assert.throws(() => store.acquire("epoch-a"), /exceeds .* bytes before read/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("v1/v2 upgrade to strict v3 and Pi-only metrics reject Cursor and payload fields", () => {
	let { manifest, ids } = seeded(); manifest = queue(manifest, ids[0]!, "turn-a");
	const v2: any = JSON.parse(JSON.stringify(manifest)); v2.version = 2; for (const value of Object.values<any>(v2.agents)) delete value.isolation;
	const upgradedV2 = parseParentManifest(v2); assert.equal(upgradedV2.version, 3); assert.equal(upgradedV2.agents[ids[0]!]!.isolation, "shared");
	const v1: any = JSON.parse(JSON.stringify(v2)); v1.version = 1;
	const upgraded = parseParentManifest(v1);
	assert.equal(upgraded.version, 3);
	assert.throws(() => parseParentManifest({ ...v1, agents: { ...v1.agents, [ids[0]!]: { ...v1.agents[ids[0]!], metrics: {} } } }), /v1 manifest/);
	assert.throws(() => parseParentManifest({ ...v2, agents: { ...v2.agents, [ids[0]!]: { ...v2.agents[ids[0]!], worktree: {} } } }), /v2 manifest/);
	const metrics = { sampledAt: now, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0, contextUsage: { tokens: null, contextWindow: 100, percent: null }, compactionCount: 1 };
	assert.doesNotThrow(() => parseParentManifest({ ...upgraded, agents: { ...upgraded.agents, [ids[0]!]: { ...upgraded.agents[ids[0]!], metrics } } }));
	assert.throws(() => parseParentManifest({ ...upgraded, agents: { ...upgraded.agents, [ids[0]!]: { ...upgraded.agents[ids[0]!], metrics: { ...metrics, sessionId: "forbidden" } } } }), /unsupported/);
});

test("managed worktree identity is strict, projected, and lifecycle-updated narrowly", () => {
	const id = "worktree-agent"; const worktree = { sourceRepoRoot: "/repo", sourceCwd: "/repo/packages/api", sourceSubdir: "packages/api", gitCommonDir: "/repo/.git", baseCommit: "a".repeat(40), sourceBranch: "main", branch: "pi-bstn/scope/worktree-agent-turn-uuid", worktreeRoot: "/managed/worktree-agent", cwd: "/managed/worktree-agent/packages/api", createdAt: now, phase: "planned" as const };
	let manifest = createParentManifest(parent, "epoch-a", now); manifest = addAgent(manifest, { ...agent(id), isolation: "worktree", worktree, cwd: worktree.cwd }, now); manifest = queue(manifest, id, "worktree-turn");
	assert.equal(materializeAgentProjections(manifest)[0]!.isolation, "worktree"); assert.deepEqual(materializeAgentProjections(manifest)[0]!.worktree, worktree);
	manifest = updateAgentWorktree(manifest, id, { phase: "active" }, now + 1); manifest = updateAgentWorktree(manifest, id, { phase: "retained-both", reason: "dirty", finalCommit: "b".repeat(40), finalBranch: worktree.branch, changedFiles: 2, untrackedFiles: 1 }, now + 2);
	assert.equal(manifest.agents[id]!.worktree!.reason, "dirty"); assert.throws(() => updateAgentWorktree(manifest, id, { phase: "removed", reason: "clean-unchanged" }, now + 3), /illegal worktree transition/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[id].cwd = "/repo"; value.turns["worktree-turn"].execution.cwd = "/repo"; })), /cwd must equal worktree cwd/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[id].worktree.branch = "user-owned"; })), /branch is not package-owned/);
	assert.throws(() => parseParentManifest(mutateJson(manifest, (value) => { value.agents[id].isolation = "shared"; })), /must not have worktree/);
});
