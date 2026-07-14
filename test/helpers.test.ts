import assert from "node:assert/strict";
import test from "node:test";
import {
	ALLOW_ALWAYS_IDS,
	answeredAskQuestion,
	applyCursorConfigRestore,
	askQuestionPromptability,
	cancelledPermissionResult,
	findPermissionOptionId,
	normalizeAskQuestions,
	normalizePermissionMode,
	normalizePermissionOptions,
	permissionSelectLabels,
	planCursorConfigRestore,
	redactPermissionPayload,
	rejectPermissionResult,
	resolveAgentPermissionDecision,
	resolveAutomaticPermission,
	resolvePromptPermissionSelection,
	restoreCursorConfigVerified,
	skippedAskQuestion,
	type CursorConfigFs,
} from "../extensions/helpers.ts";

const standardOptions = normalizePermissionOptions({
	options: [
		{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
		{ optionId: "allow-always", name: "Allow always", kind: "allow_always" },
		{ optionId: "reject-once", name: "Reject once", kind: "reject_once" },
	],
	toolCall: { title: "Edit package.json", kind: "edit" },
	title: "Edit package.json",
	kind: "edit",
});

test("normalizePermissionMode defaults to parent agent approval", () => {
	assert.equal(normalizePermissionMode(undefined), "agent");
	assert.equal(normalizePermissionMode("agent"), "agent");
	assert.equal(normalizePermissionMode("allow-once"), "allow-once");
	assert.equal(normalizePermissionMode("deny"), "deny");
	assert.equal(normalizePermissionMode("nope"), "agent");
});

test("Pi agent approval can only grant allow-once", () => {
	assert.deepEqual(resolveAgentPermissionDecision("approve", standardOptions), {
		outcome: { outcome: "selected", optionId: "allow-once" },
	});
	assert.deepEqual(resolveAgentPermissionDecision("reject", standardOptions), {
		outcome: { outcome: "selected", optionId: "reject-once" },
	});
	assert.throws(
		() => resolveAgentPermissionDecision("approve", [{ optionId: "allow-always" }]),
		/offer an allow-once/,
	);
});

test("turn interruption cancels permission without selecting an option", () => {
	assert.deepEqual(cancelledPermissionResult(), { outcome: { outcome: "cancelled" } });
});

test("allow-once mode never auto-selects allow-always", () => {
	const result = resolveAutomaticPermission("allow-once", standardOptions);
	assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow-once" } });
	assert.equal(findPermissionOptionId(standardOptions, ALLOW_ALWAYS_IDS), "allow-always");

	assert.deepEqual(
		resolveAutomaticPermission("allow-once", [
			{ optionId: "allow-always" },
			{ optionId: "reject-once" },
		]),
		{ outcome: { outcome: "selected", optionId: "reject-once" } },
	);
});

test("deny mode prefers reject-once and falls back to cancelled", () => {
	assert.deepEqual(resolveAutomaticPermission("deny", standardOptions), {
		outcome: { outcome: "selected", optionId: "reject-once" },
	});
	assert.deepEqual(rejectPermissionResult([{ optionId: "allow-once" }]), {
		outcome: { outcome: "cancelled" },
	});
});

test("prompt cancel/timeout resolves to reject-once when offered", () => {
	assert.deepEqual(resolvePromptPermissionSelection(standardOptions, undefined), {
		outcome: { outcome: "selected", optionId: "reject-once" },
	});
});

test("prompt UI may explicitly select allow-always", () => {
	const labels = permissionSelectLabels(standardOptions);
	const alwaysLabel = labels[1];
	assert.deepEqual(resolvePromptPermissionSelection(standardOptions, alwaysLabel), {
		outcome: { outcome: "selected", optionId: "allow-always" },
	});
});

test("redactPermissionPayload keeps only title/kind", () => {
	const redacted = redactPermissionPayload({
		title: "Edit secrets.env",
		kind: "edit",
		toolCall: {
			title: "Edit secrets.env",
			kind: "edit",
			rawInput: { path: "/secret", contents: "TOKEN=abc" },
		},
		options: standardOptions,
	});
	assert.equal(redacted, "title=Edit secrets.env kind=edit");
	assert.doesNotMatch(redacted, /TOKEN|rawInput|contents/);
});

test("ask_question skips allowMultiple without fabricating answers", () => {
	const questions = normalizeAskQuestions({
		questions: [
			{
				id: "q1",
				prompt: "Pick many",
				allowMultiple: true,
				options: [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				],
			},
		],
	});
	const promptable = askQuestionPromptability(questions);
	assert.equal(promptable.ok, false);
	if (!promptable.ok) {
		assert.match(promptable.reason, /allowMultiple|Multi-select/);
		assert.deepEqual(skippedAskQuestion(promptable.reason).outcome.outcome, "skipped");
	}
});

test("ask_question answered helper records selected option ids", () => {
	assert.deepEqual(
		answeredAskQuestion([{ questionId: "q1", selectedOptionIds: ["agent"] }]),
		{
			outcome: {
				outcome: "answered",
				answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
			},
		},
	);
});

test("planCursorConfigRestore unlinks files created during startup", () => {
	assert.deepEqual(planCursorConfigRestore(true, '{"a":1}', true), {
		action: "write",
		content: '{"a":1}',
	});
	assert.deepEqual(planCursorConfigRestore(false, undefined, true), { action: "unlink" });
	assert.deepEqual(planCursorConfigRestore(false, undefined, false), { action: "noop" });
});

test("restoreCursorConfigVerified retries after a dirty first verify then succeeds", async () => {
	const path = "/tmp/fake-cli-config.json";
	const original = '{"theme":"dark"}';
	let content = '{"theme":"dirty"}';
	let writes = 0;
	const sleeps: number[] = [];

	const fs: CursorConfigFs = {
		exists: () => true,
		read: () => content,
		write: (_path, next) => {
			writes += 1;
			content = next;
		},
		unlink: () => {
			throw new Error("unlink should not be called when the file existed before");
		},
	};

	await restoreCursorConfigVerified({
		path,
		existedBefore: true,
		originalContent: original,
		attempts: 5,
		delayMs: 10,
		sleep: async (ms) => {
			sleeps.push(ms);
			// Simulate a concurrent writer dirtying the file after the first restore.
			if (writes === 1) content = '{"theme":"dirty-again"}';
		},
		fs,
	});

	assert.equal(writes, 2);
	assert.deepEqual(sleeps, [10, 10]);
	assert.equal(content, original);
});

test("restoreCursorConfigVerified throws naming the path after exhaustion", async () => {
	const path = "/Users/example/.cursor/cli-config.json";
	const fs: CursorConfigFs = {
		exists: () => true,
		read: () => '{"stolen":true}',
		write: () => undefined,
		unlink: () => undefined,
	};

	await assert.rejects(
		() =>
			restoreCursorConfigVerified({
				path,
				existedBefore: true,
				originalContent: '{"ok":true}',
				attempts: 3,
				delayMs: 1,
				sleep: async () => undefined,
				fs,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Failed to restore Cursor CLI config/);
			assert.match(error.message, /cli-config\.json/);
			assert.match(error.message, /3 attempts/);
			return true;
		},
	);
});

test("applyCursorConfigRestore only swallows ENOENT on unlink", () => {
	assert.doesNotThrow(() =>
		applyCursorConfigRestore("/missing.json", false, undefined, {
			exists: () => true,
			read: () => "",
			write: () => undefined,
			unlink: () => {
				const error = new Error("gone") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			},
		}),
	);

	assert.throws(
		() =>
			applyCursorConfigRestore("/locked.json", false, undefined, {
				exists: () => true,
				read: () => "",
				write: () => undefined,
				unlink: () => {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				},
			}),
		/busy/,
	);
});

test("normalizePermissionOptions accepts underscore option ids", () => {
	const options = normalizePermissionOptions({
		options: [{ option_id: "reject_once", name: "Reject" }],
	});
	assert.equal(findPermissionOptionId(options, ["reject-once", "reject_once"]), "reject_once");
});
