/**
 * Phase 6 managed Git worktree helpers. Pure commandRunner argv-only Git operations;
 * callers persist durable plans — this module never writes manifests or commits/merges/stashes.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CommandRunner, CommandResult } from "./unified-deps.ts";

export const MANAGED_WORKTREE_BRANCH_PREFIX = "pi-bstn";
export const MANAGED_WORKTREE_DIR = "worktrees";
export const MANAGED_WORKTREE_SHORT_ID_LEN = 8;
export const MANAGED_WORKTREE_GIT_TIMEOUT_MS = 10_000;
export const MAX_DIRTY_COUNT = 10_000;

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Same shape as turn-manifest opaqueId: 1..128 safe chars. */
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const FORBIDDEN_GIT_VERBS = new Set(["commit", "merge", "stash", "rebase", "cherry-pick", "am", "revert", "reset"]);

export type ManagedWorktreeErrorCode =
	| "invalid-input"
	| "not-a-repository"
	| "bare-repository"
	| "unborn-repository"
	| "detached-head"
	| "dirty-source"
	| "symlink-escape"
	| "path-exists"
	| "ref-exists"
	| "head-changed"
	| "verification-failed"
	| "not-owned"
	| "not-listed"
	| "inspection-uncertainty"
	| "command-failed";

export class ManagedWorktreeError extends Error {
	readonly code: ManagedWorktreeErrorCode;
	constructor(code: ManagedWorktreeErrorCode, message: string) {
		super(message);
		this.name = "ManagedWorktreeError";
		this.code = code;
	}
}

export interface ManagedWorktreeDirtyCounts {
	tracked: number;
	staged: number;
	untracked: number;
}

export interface ManagedWorktreePlan {
	packageRoot: string;
	sourceRoot: string;
	sourceSubdir: string;
	commonDir: string;
	baseCommit: string;
	sourceBranch: string;
	worktreePath: string;
	branchName: string;
	childCwd: string;
	scopeKey: string;
	agentId: string;
}

export type ManagedWorktreeRetainReason =
	| "dirty"
	| "branch-changed"
	| "detached"
	| "ownership"
	| "symlink"
	| "not-listed"
	| "inspection-uncertainty";

export type ManagedWorktreeDisposition =
	| "remove-path-and-branch"
	| "remove-path-retain-branch"
	| "retain-path-and-branch";

export interface ManagedWorktreeClassification {
	disposition: ManagedWorktreeDisposition;
	reason: "clean-unchanged" | "clean-with-commits" | ManagedWorktreeRetainReason;
	owned: boolean;
	listed: boolean;
	head?: string;
	branch?: string | null;
	dirty?: ManagedWorktreeDirtyCounts;
}

export type ManagedWorktreeApplied =
	| "removed-path-and-branch"
	| "removed-path-retained-branch"
	| "retained-path-and-branch"
	| "noop";

export interface ManagedWorktreeFinalizeResult {
	classification: ManagedWorktreeClassification;
	applied: ManagedWorktreeApplied;
}

export interface PlanManagedWorktreeInput {
	sourceCwd: string;
	packageRoot: string;
	scopeKey: string;
	agentId: string;
	agentSlug: string;
	turnId: string;
	collisionId: string;
}

export interface ManagedWorktreeGitOptions {
	commandRunner: CommandRunner;
	gitCommand?: string;
	timeoutMs?: number;
}

function fail(code: ManagedWorktreeErrorCode, message: string): never {
	throw new ManagedWorktreeError(code, message);
}

function shortId(value: string, label: string): string {
	if (!OPAQUE_ID_RE.test(value)) fail("invalid-input", `${label} must be an opaque id`);
	return value.slice(0, Math.min(MANAGED_WORKTREE_SHORT_ID_LEN, value.length));
}

/** Reject the final worktree path when it is any symlink, even if the target stays under root. */
export function assertWorktreePathNotSymlink(path: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) fail("symlink-escape", "worktree path must not be a symlink");
	} catch (error) {
		if (error instanceof ManagedWorktreeError) throw error;
	}
}

function ensurePrivateParentDirs(worktreePath: string): void {
	const scopeDir = dirname(worktreePath);
	const worktreesDir = dirname(scopeDir);
	mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
	for (const dir of [worktreesDir, scopeDir]) {
		try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
	}
}

/** Sanitize task_name-like values into a single branch path segment. */
export function sanitizeManagedWorktreeSlug(taskName: string): string {
	const slug = taskName.trim().replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
	if (!SLUG_RE.test(slug)) fail("invalid-input", "agent slug must be lowercase/uppercase letters, digits, underscores, or dashes");
	return slug;
}

export function managedWorktreeBranchName(scopeKey: string, agentSlug: string, turnId: string, collisionId: string): string {
	if (!SCOPE_RE.test(scopeKey)) fail("invalid-input", "scopeKey is invalid");
	const slug = sanitizeManagedWorktreeSlug(agentSlug);
	return `${MANAGED_WORKTREE_BRANCH_PREFIX}/${scopeKey}/${slug}-${shortId(turnId, "turnId")}-${shortId(collisionId, "collisionId")}`;
}

export function managedWorktreePath(packageRoot: string, scopeKey: string, agentId: string): string {
	if (!SCOPE_RE.test(scopeKey)) fail("invalid-input", "scopeKey is invalid");
	if (!OPAQUE_ID_RE.test(agentId)) fail("invalid-input", "agentId must be an opaque id");
	const root = resolveAbsolute(packageRoot, "packageRoot");
	let canonical = root;
	try { canonical = realpathSync(root); } catch { /* package root may be created by caller */ }
	return join(canonical, MANAGED_WORKTREE_DIR, scopeKey, agentId);
}

export function managedWorktreesRoot(packageRoot: string, scopeKey: string): string {
	if (!SCOPE_RE.test(scopeKey)) fail("invalid-input", "scopeKey is invalid");
	const root = resolveAbsolute(packageRoot, "packageRoot");
	let canonical = root;
	try { canonical = realpathSync(root); } catch { /* package root may be created by caller */ }
	return join(canonical, MANAGED_WORKTREE_DIR, scopeKey);
}

function resolveAbsolute(path: string, label: string): string {
	if (typeof path !== "string" || !path.trim()) fail("invalid-input", `${label} is required`);
	const absolute = isAbsolute(path) ? normalize(path) : resolve(path);
	return absolute;
}

function pathIsInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Fail closed if path resolves outside trustedRoot or a beneath-root symlink escapes it. */
export function assertNoSymlinkEscape(path: string, trustedRoot: string): void {
	const logicalRoot = resolveAbsolute(trustedRoot, "trustedRoot");
	let realRoot: string;
	try { realRoot = realpathSync(logicalRoot); } catch { fail("symlink-escape", "trusted root is unavailable"); }

	const absolute = resolveAbsolute(path, "path");
	try {
		const realPath = realpathSync(absolute);
		if (realPath !== realRoot && !pathIsInside(realPath, realRoot)) fail("symlink-escape", "path escapes trusted root");
		return;
	} catch {
		/* leaf or intermediate may not exist yet */
	}

	let rel: string;
	if (absolute === logicalRoot || pathIsInside(absolute, logicalRoot)) {
		rel = absolute === logicalRoot ? "" : relative(logicalRoot, absolute);
	} else if (absolute === realRoot || pathIsInside(absolute, realRoot)) {
		rel = absolute === realRoot ? "" : relative(realRoot, absolute);
	} else {
		fail("symlink-escape", "path escapes trusted root");
	}
	if (!rel) return;
	if (rel.startsWith("..") || isAbsolute(rel)) fail("symlink-escape", "path escapes trusted root");

	let current = realRoot;
	for (const part of rel.split(sep)) {
		if (!part || part === ".") continue;
		if (part === "..") fail("symlink-escape", "path escapes trusted root");
		current = join(current, part);
		let stat;
		try { stat = lstatSync(current); } catch { return; }
		if (!stat.isSymbolicLink()) continue;
		let target: string;
		try { target = realpathSync(current); } catch { fail("symlink-escape", "symlink target is unavailable"); }
		if (target !== realRoot && !pathIsInside(target, realRoot)) fail("symlink-escape", "symlink escapes trusted root");
		current = target;
	}
}

function boundedCount(value: number): number {
	return Math.min(Math.max(0, value), MAX_DIRTY_COUNT);
}

/** Parse `git status --porcelain=v1 -uall` into bounded counts; never returns raw lines. */
export function parsePorcelainDirtyCounts(porcelain: string): ManagedWorktreeDirtyCounts {
	let tracked = 0; let staged = 0; let untracked = 0;
	for (const line of porcelain.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("??") || line.startsWith("!")) { untracked++; continue; }
		if (line.length < 2) { tracked++; continue; }
		const x = line[0]!; const y = line[1]!;
		if (x !== " " && x !== "?") staged++;
		if (y !== " " && y !== "?") tracked++;
		if (x === " " && y === " ") tracked++;
	}
	return { tracked: boundedCount(tracked), staged: boundedCount(staged), untracked: boundedCount(untracked) };
}

function dirtyTotal(counts: ManagedWorktreeDirtyCounts): number {
	return counts.tracked + counts.staged + counts.untracked;
}

async function git(
	options: ManagedWorktreeGitOptions,
	args: string[],
	cwd: string,
): Promise<CommandResult> {
	const verb = args.find((arg) => !arg.startsWith("-"));
	if (verb && FORBIDDEN_GIT_VERBS.has(verb)) fail("command-failed", `git ${verb} is forbidden`);
	const command = options.gitCommand ?? "git";
	return options.commandRunner(command, args, cwd, options.timeoutMs ?? MANAGED_WORKTREE_GIT_TIMEOUT_MS);
}

async function gitOk(options: ManagedWorktreeGitOptions, args: string[], cwd: string, code: ManagedWorktreeErrorCode, message: string): Promise<string> {
	const result = await git(options, args, cwd);
	if (result.code !== 0 || result.killed) fail(code, message);
	return result.stdout;
}

async function gitText(options: ManagedWorktreeGitOptions, args: string[], cwd: string, code: ManagedWorktreeErrorCode, message: string): Promise<string> {
	return (await gitOk(options, args, cwd, code, message)).trim();
}

function parseWorktreePorcelain(stdout: string): Array<{ path?: string; head?: string; branch?: string | null; bare?: boolean }> {
	const entries: Array<{ path?: string; head?: string; branch?: string | null; bare?: boolean }> = [];
	let current: { path?: string; head?: string; branch?: string | null; bare?: boolean } = {};
	const push = () => { if (current.path || current.head || current.branch !== undefined || current.bare) entries.push(current); current = {}; };
	for (const raw of stdout.split(/\r?\n/)) {
		if (!raw) { push(); continue; }
		if (raw.startsWith("worktree ")) current.path = raw.slice("worktree ".length);
		else if (raw.startsWith("HEAD ")) current.head = raw.slice("HEAD ".length).toLowerCase();
		else if (raw.startsWith("branch ")) current.branch = raw.slice("branch ".length).replace(/^refs\/heads\//, "");
		else if (raw === "detached") current.branch = null;
		else if (raw === "bare") current.bare = true;
	}
	push();
	return entries;
}

async function inspectSource(options: ManagedWorktreeGitOptions, sourceCwd: string): Promise<{
	sourceRoot: string; commonDir: string; baseCommit: string; sourceBranch: string; sourceSubdir: string; childAbs: string;
}> {
	const cwd = resolveAbsolute(sourceCwd, "sourceCwd");
	await gitOk(options, ["rev-parse", "--git-dir"], cwd, "not-a-repository", "source cwd is not a Git repository");
	const bare = await gitText(options, ["rev-parse", "--is-bare-repository"], cwd, "command-failed", "unable to inspect repository");
	if (bare === "true") fail("bare-repository", "bare repositories cannot host managed worktrees");

	const toplevel = await gitText(options, ["rev-parse", "--show-toplevel"], cwd, "not-a-repository", "source cwd is not a Git repository");
	let sourceRoot = resolve(toplevel);
	try { sourceRoot = realpathSync(sourceRoot); } catch { fail("symlink-escape", "source root is unavailable"); }
	assertNoSymlinkEscape(cwd, sourceRoot);
	let childReal: string;
	try { childReal = realpathSync(cwd); } catch { fail("symlink-escape", "source cwd is unavailable"); }
	if (!pathIsInside(childReal, sourceRoot) && childReal !== sourceRoot) fail("symlink-escape", "source cwd escapes repository root");

	const commonRaw = await gitText(options, ["rev-parse", "--git-common-dir"], sourceRoot, "command-failed", "unable to resolve git common dir");
	let commonDir = resolve(sourceRoot, commonRaw);
	try { commonDir = realpathSync(commonDir); } catch { fail("symlink-escape", "git common dir is unavailable"); }
	try { if (!lstatSync(commonDir).isDirectory()) fail("verification-failed", "git common dir is not a directory"); } catch (error) { if (error instanceof ManagedWorktreeError) throw error; fail("symlink-escape", "git common dir is unavailable"); }

	let sourceBranch: string;
	try {
		sourceBranch = await gitText(options, ["symbolic-ref", "--short", "HEAD"], sourceRoot, "detached-head", "source repository must be on a named branch");
	} catch (error) {
		if (error instanceof ManagedWorktreeError) throw error;
		fail("detached-head", "source repository must be on a named branch");
	}
	if (!sourceBranch || sourceBranch.includes("..")) fail("detached-head", "source repository must be on a named branch");

	let baseCommit: string;
	try {
		baseCommit = (await gitText(options, ["rev-parse", "HEAD"], sourceRoot, "unborn-repository", "source repository has no commits")).toLowerCase();
	} catch {
		fail("unborn-repository", "source repository has no commits");
	}
	if (!FULL_SHA_RE.test(baseCommit)) fail("inspection-uncertainty", "source HEAD is not a full commit sha");

	const porcelain = await gitOk(options, ["status", "--porcelain=v1", "-uall"], sourceRoot, "command-failed", "unable to inspect source cleanliness");
	const dirty = parsePorcelainDirtyCounts(porcelain);
	if (dirtyTotal(dirty) > 0) fail("dirty-source", "source repository must be clean (tracked, staged, and untracked changes reject)");

	const sourceSubdir = childReal === sourceRoot ? "" : relative(sourceRoot, childReal).split(sep).join("/");
	if (sourceSubdir.startsWith("..") || isAbsolute(sourceSubdir)) fail("symlink-escape", "source subdir escapes repository root");
	return { sourceRoot, commonDir, baseCommit, sourceBranch, sourceSubdir, childAbs: childReal };
}

export async function planManagedWorktree(input: PlanManagedWorktreeInput, options: ManagedWorktreeGitOptions): Promise<ManagedWorktreePlan> {
	const inspected = await inspectSource(options, input.sourceCwd);
	const branchName = managedWorktreeBranchName(input.scopeKey, input.agentSlug, input.turnId, input.collisionId);
	const worktreePath = managedWorktreePath(input.packageRoot, input.scopeKey, input.agentId);
	assertNoSymlinkEscape(worktreePath, resolveAbsolute(input.packageRoot, "packageRoot"));
	assertWorktreePathNotSymlink(worktreePath);
	if (existsSync(worktreePath)) fail("path-exists", "managed worktree path already exists");

	const showRef = await git(options, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], inspected.sourceRoot);
	if (showRef.code === 0) fail("ref-exists", "managed worktree branch already exists");

	const childCwd = inspected.sourceSubdir ? join(worktreePath, ...inspected.sourceSubdir.split("/")) : worktreePath;
	return {
		packageRoot: realpathSync(resolveAbsolute(input.packageRoot, "packageRoot")),
		sourceRoot: inspected.sourceRoot,
		sourceSubdir: inspected.sourceSubdir,
		commonDir: inspected.commonDir,
		baseCommit: inspected.baseCommit,
		sourceBranch: inspected.sourceBranch,
		worktreePath,
		branchName,
		childCwd,
		scopeKey: input.scopeKey,
		agentId: input.agentId,
	};
}

async function verifyAllocated(plan: ManagedWorktreePlan, options: ManagedWorktreeGitOptions): Promise<void> {
	if (!existsSync(plan.worktreePath)) fail("verification-failed", "worktree path missing after allocation");
	const packageRoot = plan.packageRoot;
	if (resolve(managedWorktreePath(packageRoot, plan.scopeKey, plan.agentId)) !== resolve(plan.worktreePath)) {
		fail("verification-failed", "worktree path is not package-owned");
	}
	assertNoSymlinkEscape(plan.worktreePath, packageRoot);
	assertNoSymlinkEscape(plan.worktreePath, managedWorktreesRoot(packageRoot, plan.scopeKey));
	assertWorktreePathNotSymlink(plan.worktreePath);

	const commonRaw = await gitText(options, ["rev-parse", "--git-common-dir"], plan.worktreePath, "verification-failed", "unable to verify worktree common dir");
	let commonDir = resolve(plan.worktreePath, commonRaw);
	try { commonDir = realpathSync(commonDir); } catch { fail("verification-failed", "worktree common dir unavailable"); }
	let expectedCommon = plan.commonDir;
	try { expectedCommon = realpathSync(plan.commonDir); } catch { /* keep planned */ }
	if (commonDir !== expectedCommon) fail("verification-failed", "worktree common dir mismatch");

	const head = (await gitText(options, ["rev-parse", "HEAD"], plan.worktreePath, "verification-failed", "unable to verify worktree HEAD")).toLowerCase();
	if (head !== plan.baseCommit.toLowerCase()) fail("verification-failed", "worktree HEAD does not match planned base");

	const branch = await gitText(options, ["symbolic-ref", "--short", "HEAD"], plan.worktreePath, "verification-failed", "worktree is not on the managed branch");
	if (branch !== plan.branchName) fail("verification-failed", "worktree branch mismatch");

	if (plan.sourceSubdir) {
		const expected = join(plan.worktreePath, ...plan.sourceSubdir.split("/"));
		if (!existsSync(expected) || resolve(expected) !== resolve(plan.childCwd)) fail("verification-failed", "worktree subdir mismatch");
	} else if (resolve(plan.childCwd) !== resolve(plan.worktreePath)) {
		fail("verification-failed", "worktree root cwd mismatch");
	}

	const listed = await listOwnedEntry(plan, options);
	if (!listed) fail("verification-failed", "allocated worktree is not listed");
	if ((listed.head ?? "").toLowerCase() !== plan.baseCommit.toLowerCase()) fail("verification-failed", "listed worktree HEAD mismatch");
	if (listed.branch !== plan.branchName) fail("verification-failed", "listed worktree branch mismatch");
}

async function listOwnedEntry(plan: ManagedWorktreePlan, options: ManagedWorktreeGitOptions): Promise<{ path: string; head?: string; branch?: string | null } | undefined> {
	const stdout = await gitOk(options, ["worktree", "list", "--porcelain"], plan.sourceRoot, "inspection-uncertainty", "unable to list worktrees");
	let want: string;
	try { want = realpathSync(plan.worktreePath); } catch { want = resolve(plan.worktreePath); }
	for (const entry of parseWorktreePorcelain(stdout)) {
		if (!entry.path) continue;
		let got: string;
		try { got = realpathSync(entry.path); } catch { got = resolve(entry.path); }
		if (got === want || resolve(entry.path) === resolve(plan.worktreePath)) return { path: entry.path, head: entry.head, branch: entry.branch };
	}
	return undefined;
}

function ownershipOrUncertainty(plan: ManagedWorktreePlan): ManagedWorktreeRetainReason | undefined {
	try {
		const packageRoot = plan.packageRoot;
		const expected = managedWorktreePath(packageRoot, plan.scopeKey, plan.agentId);
		if (resolve(expected) !== resolve(plan.worktreePath)) return "ownership";
		assertNoSymlinkEscape(plan.worktreePath, packageRoot);
		assertNoSymlinkEscape(plan.worktreePath, managedWorktreesRoot(packageRoot, plan.scopeKey));
		assertWorktreePathNotSymlink(plan.worktreePath);
		return undefined;
	} catch (error) {
		if (error instanceof ManagedWorktreeError && error.code === "symlink-escape") return "symlink";
		return "ownership";
	}
}

export async function allocateManagedWorktree(plan: ManagedWorktreePlan, options: ManagedWorktreeGitOptions): Promise<ManagedWorktreePlan> {
	const inspected = await inspectSource(options, plan.sourceSubdir ? join(plan.sourceRoot, ...plan.sourceSubdir.split("/")) : plan.sourceRoot);
	if (inspected.sourceRoot !== plan.sourceRoot) fail("verification-failed", "source root changed since plan");
	if (inspected.commonDir !== plan.commonDir) fail("verification-failed", "common dir changed since plan");
	if (inspected.baseCommit.toLowerCase() !== plan.baseCommit.toLowerCase()) fail("head-changed", "source HEAD changed since plan");
	if (inspected.sourceBranch !== plan.sourceBranch) fail("head-changed", "source branch changed since plan");
	if (inspected.sourceSubdir !== plan.sourceSubdir) fail("verification-failed", "source subdir changed since plan");
	if (existsSync(plan.worktreePath)) fail("path-exists", "managed worktree path already exists");

	const showRef = await git(options, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branchName}`], plan.sourceRoot);
	if (showRef.code === 0) fail("ref-exists", "managed worktree branch already exists");

	ensurePrivateParentDirs(plan.worktreePath);
	await gitOk(
		options,
		["worktree", "add", "-b", plan.branchName, plan.worktreePath, plan.baseCommit],
		plan.sourceRoot,
		"command-failed",
		"git worktree add failed",
	);
	await verifyAllocated(plan, options);
	return { ...plan };
}

export async function classifyManagedWorktree(plan: ManagedWorktreePlan, options: ManagedWorktreeGitOptions): Promise<ManagedWorktreeClassification> {
	const retain = (reason: ManagedWorktreeRetainReason, extra?: Partial<ManagedWorktreeClassification>): ManagedWorktreeClassification => ({
		disposition: "retain-path-and-branch", reason, owned: extra?.owned ?? false, listed: extra?.listed ?? false, head: extra?.head, branch: extra?.branch, dirty: extra?.dirty,
	});

	const ownership = ownershipOrUncertainty(plan);
	if (ownership) return retain(ownership, { owned: false, listed: false });

	const pathExists = existsSync(plan.worktreePath);
	let listed: { path: string; head?: string; branch?: string | null } | undefined;
	try { listed = await listOwnedEntry(plan, options); }
	catch { return retain("inspection-uncertainty", { owned: true, listed: false }); }

	if (!pathExists && !listed) {
		return { disposition: "retain-path-and-branch", reason: "inspection-uncertainty", owned: true, listed: false };
	}
	if (!listed) return retain("not-listed", { owned: true, listed: false });
	if (!pathExists) return retain("inspection-uncertainty", { owned: true, listed: true, head: listed.head, branch: listed.branch ?? null });

	try {
		assertNoSymlinkEscape(plan.worktreePath, plan.packageRoot);
		assertWorktreePathNotSymlink(plan.worktreePath);
	} catch { return retain("symlink", { owned: true, listed: true }); }

	let head: string | undefined;
	let branch: string | null | undefined;
	let dirty: ManagedWorktreeDirtyCounts | undefined;
	try {
		head = (await gitText(options, ["rev-parse", "HEAD"], plan.worktreePath, "inspection-uncertainty", "unable to read worktree HEAD")).toLowerCase();
		const sym = await git(options, ["symbolic-ref", "--short", "HEAD"], plan.worktreePath);
		if (sym.code === 0) branch = sym.stdout.trim();
		else branch = null;
		const porcelain = await gitOk(options, ["status", "--porcelain=v1", "-uall"], plan.worktreePath, "inspection-uncertainty", "unable to inspect worktree cleanliness");
		dirty = parsePorcelainDirtyCounts(porcelain);
	} catch {
		return retain("inspection-uncertainty", { owned: true, listed: true, head: listed.head, branch: listed.branch ?? null });
	}

	if (branch === null) return retain("detached", { owned: true, listed: true, head, branch, dirty });
	if (branch !== plan.branchName) return retain("branch-changed", { owned: true, listed: true, head, branch, dirty });
	if (dirty && dirtyTotal(dirty) > 0) return retain("dirty", { owned: true, listed: true, head, branch, dirty });

	if (!head || !FULL_SHA_RE.test(head)) return retain("inspection-uncertainty", { owned: true, listed: true, head, branch, dirty });
	if (head === plan.baseCommit.toLowerCase()) {
		return { disposition: "remove-path-and-branch", reason: "clean-unchanged", owned: true, listed: true, head, branch, dirty };
	}
	return { disposition: "remove-path-retain-branch", reason: "clean-with-commits", owned: true, listed: true, head, branch, dirty };
}

export async function finalizeManagedWorktree(plan: ManagedWorktreePlan, options: ManagedWorktreeGitOptions): Promise<ManagedWorktreeFinalizeResult> {
	const pathExists = existsSync(plan.worktreePath);
	let listed: { path: string; head?: string; branch?: string | null } | undefined;
	try { listed = await listOwnedEntry(plan, options); } catch { listed = undefined; }

	if (!pathExists && !listed) {
		const branchStill = await git(options, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branchName}`], plan.sourceRoot);
		const classification: ManagedWorktreeClassification = {
			disposition: "retain-path-and-branch",
			reason: "inspection-uncertainty",
			owned: ownershipOrUncertainty(plan) === undefined,
			listed: false,
			branch: branchStill.code === 0 ? plan.branchName : null,
		};
		return { classification, applied: "noop" };
	}

	const classification = await classifyManagedWorktree(plan, options);
	if (classification.disposition === "retain-path-and-branch") {
		return { classification, applied: "retained-path-and-branch" };
	}

	if (!classification.owned || !classification.listed) {
		return { classification: { ...classification, disposition: "retain-path-and-branch", reason: classification.reason === "clean-unchanged" || classification.reason === "clean-with-commits" ? "ownership" : classification.reason }, applied: "retained-path-and-branch" };
	}

	await gitOk(options, ["worktree", "remove", plan.worktreePath], plan.sourceRoot, "command-failed", "git worktree remove failed");

	if (classification.disposition === "remove-path-and-branch") {
		const tip = await git(options, ["rev-parse", plan.branchName], plan.sourceRoot);
		if (tip.code !== 0 || tip.stdout.trim().toLowerCase() !== plan.baseCommit.toLowerCase()) {
			return {
				classification: { ...classification, disposition: "retain-path-and-branch", reason: "inspection-uncertainty", listed: false },
				applied: "removed-path-retained-branch",
			};
		}
		const deleted = await git(options, ["branch", "-D", plan.branchName], plan.sourceRoot);
		if (deleted.code !== 0 || deleted.killed) return { classification: { ...classification, disposition: "retain-path-and-branch", reason: "inspection-uncertainty", listed: false }, applied: "removed-path-retained-branch" };
		return { classification, applied: "removed-path-and-branch" };
	}

	return { classification, applied: "removed-path-retained-branch" };
}
