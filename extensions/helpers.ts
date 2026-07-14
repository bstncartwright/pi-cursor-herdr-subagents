/** Permission and config helpers kept pure for unit testing. */

export type PermissionMode = "prompt" | "agent" | "allow-once" | "deny";

export const PERMISSION_MODES = ["prompt", "agent", "allow-once", "deny"] as const;

export const ALLOW_ONCE_IDS = ["allow-once", "allow_once"] as const;
export const ALLOW_ALWAYS_IDS = ["allow-always", "allow_always"] as const;
export const REJECT_ONCE_IDS = ["reject-once", "reject_once"] as const;

export interface PermissionOption {
	optionId: string;
	name?: string;
	kind?: string;
}

export type PermissionResult =
	| { outcome: { outcome: "selected"; optionId: string } }
	| { outcome: { outcome: "cancelled" } };

export interface AskQuestionOption {
	id: string;
	label: string;
}

export interface AskQuestionItem {
	id: string;
	prompt: string;
	options: AskQuestionOption[];
	allowMultiple?: boolean;
}

export type AskQuestionResult =
	| {
			outcome: {
				outcome: "answered";
				answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
			};
	  }
	| { outcome: { outcome: "skipped"; reason: string } }
	| { outcome: { outcome: "cancelled" } };

export type ConfigRestoreAction =
	| { action: "write"; content: string }
	| { action: "unlink" }
	| { action: "noop" };

export interface CursorConfigFs {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, content: string): void;
	unlink(path: string): void;
}

export interface RestoreCursorConfigOptions {
	path: string;
	existedBefore: boolean;
	originalContent?: string;
	/** Total apply→wait→verify attempts. Defaults to 5. */
	attempts?: number;
	/** Delay after each apply before verification. Defaults to 150ms. */
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	fs: CursorConfigFs;
}

export const DEFAULT_CONFIG_RESTORE_ATTEMPTS = 5;
export const DEFAULT_CONFIG_RESTORE_DELAY_MS = 150;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function optionIdOf(value: unknown): string | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	for (const key of ["optionId", "option_id", "id"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return undefined;
}

export function normalizePermissionMode(value: unknown): PermissionMode {
	if (value === "agent" || value === "allow-once" || value === "deny" || value === "prompt") return value;
	return "agent";
}

export function normalizePermissionOptions(params: unknown): PermissionOption[] {
	const root = asRecord(params);
	const rawOptions = root?.options;
	if (!Array.isArray(rawOptions)) return [];

	const options: PermissionOption[] = [];
	for (const entry of rawOptions) {
		const optionId = optionIdOf(entry);
		if (!optionId) continue;
		const record = asRecord(entry) ?? {};
		options.push({
			optionId,
			name: typeof record.name === "string" ? record.name : undefined,
			kind: typeof record.kind === "string" ? record.kind : undefined,
		});
	}
	return options;
}

export function findPermissionOptionId(
	options: PermissionOption[],
	candidates: readonly string[],
): string | undefined {
	const wanted = new Set(candidates);
	return options.find((option) => wanted.has(option.optionId))?.optionId;
}

export function permissionOptionLabel(option: PermissionOption): string {
	const named = option.name?.trim();
	if (named) return named;
	switch (option.optionId) {
		case "allow-once":
		case "allow_once":
			return "Allow once";
		case "allow-always":
		case "allow_always":
			return "Allow always";
		case "reject-once":
		case "reject_once":
			return "Reject once";
		default:
			return option.optionId;
	}
}

export function permissionSelectLabels(options: PermissionOption[]): string[] {
	const bases = options.map(permissionOptionLabel);
	return options.map((option, index) => {
		const base = bases[index]!;
		const dupes = bases.filter((label) => label === base).length;
		return dupes > 1 ? `${base} (${option.optionId})` : base;
	});
}

export function selectedPermissionResult(optionId: string): PermissionResult {
	return { outcome: { outcome: "selected", optionId } };
}

export function cancelledPermissionResult(): PermissionResult {
	return { outcome: { outcome: "cancelled" } };
}

/** Prefer reject-once when offered; otherwise cancel. Never invent allow_* outcomes. */
export function rejectPermissionResult(options: PermissionOption[]): PermissionResult {
	const rejectId = findPermissionOptionId(options, REJECT_ONCE_IDS);
	if (rejectId) return selectedPermissionResult(rejectId);
	return { outcome: { outcome: "cancelled" } };
}

/**
 * Resolve a non-interactive permission decision.
 * `allow-once` mode never auto-selects allow-always.
 */
export function resolveAutomaticPermission(
	mode: "allow-once" | "deny",
	options: PermissionOption[],
): PermissionResult {
	if (mode === "allow-once") {
		const allowOnce = findPermissionOptionId(options, ALLOW_ONCE_IDS);
		if (allowOnce) return selectedPermissionResult(allowOnce);
		return rejectPermissionResult(options);
	}
	return rejectPermissionResult(options);
}

/** Resolve a decision made by the parent Pi agent without ever granting persistent access. */
export function resolveAgentPermissionDecision(
	decision: "approve" | "reject",
	options: PermissionOption[],
): PermissionResult {
	if (decision === "reject") return rejectPermissionResult(options);
	const allowOnce = findPermissionOptionId(options, ALLOW_ONCE_IDS);
	if (!allowOnce) {
		throw new Error("Cursor did not offer an allow-once option for this approval request.");
	}
	return selectedPermissionResult(allowOnce);
}

export function resolvePromptPermissionSelection(
	options: PermissionOption[],
	selectedLabel: string | undefined,
): PermissionResult {
	if (!selectedLabel) return rejectPermissionResult(options);
	const labels = permissionSelectLabels(options);
	const index = labels.indexOf(selectedLabel);
	if (index < 0) return rejectPermissionResult(options);
	const option = options[index];
	if (!option) return rejectPermissionResult(options);
	return selectedPermissionResult(option.optionId);
}

export function redactPermissionPayload(params: unknown): string {
	const root = asRecord(params);
	const toolCall = asRecord(root?.toolCall) ?? asRecord(root?.tool_call);
	const title =
		(typeof root?.title === "string" && root.title) ||
		(typeof toolCall?.title === "string" && toolCall.title) ||
		(typeof toolCall?.name === "string" && toolCall.name) ||
		undefined;
	const kind =
		(typeof root?.kind === "string" && root.kind) ||
		(typeof toolCall?.kind === "string" && toolCall.kind) ||
		undefined;
	const parts = [title ? `title=${title}` : undefined, kind ? `kind=${kind}` : undefined].filter(
		Boolean,
	);
	return parts.length > 0 ? parts.join(" ") : "permission request";
}

export function normalizeAskQuestions(params: unknown): AskQuestionItem[] {
	const root = asRecord(params);
	const raw = root?.questions;
	if (!Array.isArray(raw)) return [];

	const questions: AskQuestionItem[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record || typeof record.id !== "string" || typeof record.prompt !== "string") continue;
		const optionsRaw = Array.isArray(record.options) ? record.options : [];
		const options: AskQuestionOption[] = [];
		for (const option of optionsRaw) {
			const optionRecord = asRecord(option);
			if (!optionRecord || typeof optionRecord.id !== "string" || typeof optionRecord.label !== "string") {
				continue;
			}
			options.push({ id: optionRecord.id, label: optionRecord.label });
		}
		questions.push({
			id: record.id,
			prompt: record.prompt,
			options,
			allowMultiple: record.allowMultiple === true,
		});
	}
	return questions;
}

export function askQuestionPromptability(questions: AskQuestionItem[]):
	| { ok: true }
	| { ok: false; reason: string } {
	if (questions.length === 0) {
		return { ok: false, reason: "No questions were provided." };
	}
	if (questions.some((question) => question.allowMultiple)) {
		return {
			ok: false,
			reason: "Multi-select questions (allowMultiple) are unsupported; skipped without fabricating answers.",
		};
	}
	if (questions.some((question) => question.options.length === 0)) {
		return { ok: false, reason: "A question had no selectable options; skipped without fabricating answers." };
	}
	return { ok: true };
}

export function skippedAskQuestion(reason: string): AskQuestionResult {
	return { outcome: { outcome: "skipped", reason } };
}

export function answeredAskQuestion(
	answers: Array<{ questionId: string; selectedOptionIds: string[] }>,
): AskQuestionResult {
	return { outcome: { outcome: "answered", answers } };
}

export function planCursorConfigRestore(
	existedBefore: boolean,
	originalContent: string | undefined,
	existsAfter: boolean,
): ConfigRestoreAction {
	if (existedBefore) {
		return { action: "write", content: originalContent ?? "" };
	}
	if (existsAfter) return { action: "unlink" };
	return { action: "noop" };
}

export function isEnoent(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

/** Apply one restore step. Unlink errors other than ENOENT are rethrown. */
export function applyCursorConfigRestore(
	path: string,
	existedBefore: boolean,
	originalContent: string | undefined,
	fs: CursorConfigFs,
): void {
	const plan = planCursorConfigRestore(existedBefore, originalContent, fs.exists(path));
	if (plan.action === "write") {
		fs.write(path, plan.content);
		return;
	}
	if (plan.action === "unlink") {
		try {
			fs.unlink(path);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
}

export function verifyCursorConfigRestore(
	path: string,
	existedBefore: boolean,
	originalContent: string | undefined,
	fs: CursorConfigFs,
): boolean {
	if (existedBefore) {
		if (!fs.exists(path)) return false;
		try {
			return fs.read(path) === (originalContent ?? "");
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}
	return !fs.exists(path);
}

/**
 * Restore Cursor CLI config, wait, verify, and retry.
 * Throws a clear error naming `path` after the attempts are exhausted.
 */
export async function restoreCursorConfigVerified(options: RestoreCursorConfigOptions): Promise<void> {
	const attempts = options.attempts ?? DEFAULT_CONFIG_RESTORE_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_CONFIG_RESTORE_DELAY_MS;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const { path, existedBefore, originalContent, fs } = options;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		applyCursorConfigRestore(path, existedBefore, originalContent, fs);
		await sleep(delayMs);
		if (verifyCursorConfigRestore(path, existedBefore, originalContent, fs)) return;
	}

	throw new Error(
		`Failed to restore Cursor CLI config at ${path} after ${attempts} attempts. ` +
			"Another process may still be rewriting the file.",
	);
}
