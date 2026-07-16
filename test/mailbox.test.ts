import assert from "node:assert/strict";
import test from "node:test";
import { Mailbox, resolveAndSettlePermission, type MailEvent, type PermissionMailKey } from "../extensions/mailbox.ts";
import { resolveAgentPermissionDecision } from "../extensions/helpers.ts";
import { requirePendingApproval } from "../extensions/unified.ts";

const parentSessionId = "parent";
const agentName = "/cursor";

function permission(approvalId: string, overrides: Partial<MailEvent> = {}): MailEvent {
	return {
		id: `mail-${approvalId}`,
		parentSessionId,
		agentName,
		kind: "permission",
		status: "running",
		approvalId,
		createdAt: 1,
		...overrides,
	};
}

function completion(): MailEvent {
	return {
		id: "completed",
		parentSessionId,
		agentName,
		kind: "completion",
		status: "completed",
		createdAt: 2,
	};
}

function key(approvalId: string): PermissionMailKey {
	return { parentSessionId, agentName, approvalId };
}

test("auto-follow-up reject removes permission mail before wait_all can claim it", () => {
	const mailbox = new Mailbox();
	const pending = new Set(["approval-1"]);
	mailbox.push(permission("approval-1")); // The automatic follow-up leaves this queued for a later wait.

	resolveAndSettlePermission(mailbox, key("approval-1"), () => "reject", () => pending.delete("approval-1"));
	mailbox.push(completion());

	assert.equal(
		mailbox.claim((event) => event.kind === "permission" && event.parentSessionId === parentSessionId, (event) => pending.has(event.approvalId!)),
		undefined,
	);
	assert.equal(
		mailbox.claim((event) => event.kind === "completion" && event.parentSessionId === parentSessionId, (event) => pending.has(event.approvalId!))?.kind,
		"completion",
	);
});

test("responded permission cannot replay through wait_agent", () => {
	const mailbox = new Mailbox();
	const pending = new Set(["approval-1"]);
	mailbox.push(permission("approval-1"));
	resolveAndSettlePermission(mailbox, key("approval-1"), () => "approve", () => pending.delete("approval-1"));

	assert.equal(
		mailbox.claim((event) => event.parentSessionId === parentSessionId && event.agentName === agentName, (event) => pending.has(event.approvalId!)),
		undefined,
	);
});

test("timeout and reject settlement eagerly remove their exact permission mail", () => {
	for (const decision of ["timeout", "reject"] as const) {
		const mailbox = new Mailbox();
		const pending = new Set<string>([decision]);
		mailbox.push(permission(decision));
		resolveAndSettlePermission(mailbox, key(decision), () => decision, () => pending.delete(decision));
		assert.equal(mailbox.claim(() => true, (event) => pending.has(event.approvalId!)), undefined, decision);
	}
});

test("settling one approval preserves a concurrent approval for the same agent", () => {
	const mailbox = new Mailbox();
	const pending = new Set(["first", "second"]);
	mailbox.push(permission("first"));
	mailbox.push(permission("second"));
	resolveAndSettlePermission(mailbox, key("first"), () => "reject", () => pending.delete("first"));

	const event = mailbox.claim((candidate) => candidate.kind === "permission", (candidate) => pending.has(candidate.approvalId!));
	assert.equal(event?.approvalId, "second");
});

test("an invalid approve leaves both pending approval and its mail intact", () => {
	const mailbox = new Mailbox();
	const pending = new Set(["approval-1"]);
	let settled = false;
	mailbox.push(permission("approval-1"));

	assert.throws(() => resolveAndSettlePermission(
		mailbox,
		key("approval-1"),
		() => resolveAgentPermissionDecision("approve", [{ optionId: "reject-once" }]),
		() => { settled = true; },
	), /allow-once/);
	assert.equal(settled, false);
	assert.equal(pending.has("approval-1"), true);
	assert.equal(
		mailbox.claim((event) => event.kind === "permission", (event) => pending.has(event.approvalId!))?.approvalId,
		"approval-1",
	);
});

test("wait claim boundaries defensively discard stale permission mail", () => {
	for (const boundary of ["wait_agent", "wait_all_agents"]) {
		const mailbox = new Mailbox();
		mailbox.push(permission("already-resolved"));
		mailbox.push(completion());
		assert.equal(mailbox.claim((event) => event.kind === "permission", () => false), undefined, boundary);
		assert.equal(mailbox.claim((event) => event.kind === "completion", () => false)?.kind, "completion", boundary);
	}
});


test("a second response remains an error after the approval is settled", () => {
	const pending = new Map([["approval-1", { id: "approval-1" }]]);
	requirePendingApproval(pending, "approval-1", agentName);
	pending.delete("approval-1");
	assert.throws(() => requirePendingApproval(pending, "approval-1", agentName), /No pending approval "approval-1" for \/cursor/);
});
