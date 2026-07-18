import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../extensions/unified-deps.ts";
import {
	allocateManagedWorktree,
	classifyManagedWorktree,
	finalizeManagedWorktree,
	managedWorktreeBranchName,
	managedWorktreePath,
	ManagedWorktreeError,
	planManagedWorktree,
	type ManagedWorktreePlan,
} from "../extensions/git-worktree.ts";

const commandRunner: CommandRunner = (command, args, cwd, timeoutMs = 10_000) => new Promise((done) => {
	const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; let stderr = ""; let killed = false; let settled = false;
	const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); done({ stdout, stderr, code, killed } satisfies CommandResult); };
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	child.on("error", (error) => { stderr += error.message; finish(1); });
	child.on("exit", (code) => finish(code ?? 0));
	const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); finish(1); }, timeoutMs);
	timer.unref?.();
});

const gitOpts = { commandRunner };

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await commandRunner("git", args, cwd, 10_000);
	assert.equal(result.code, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-git-worktree-"));
	const repo = join(root, "repo");
	const packageRoot = join(root, "package");
	mkdirSync(repo); mkdirSync(packageRoot);
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	return { root, repo, packageRoot, cleanup };
}

async function initRepo(repo: string, withSubdir = false): Promise<string> {
	await git(repo, ["init"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "test"]);
	writeFileSync(join(repo, "README.md"), "root\n");
	if (withSubdir) {
		mkdirSync(join(repo, "packages", "app"), { recursive: true });
		writeFileSync(join(repo, "packages", "app", "main.ts"), "export {};\n");
	}
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-m", "init"]);
	return withSubdir ? join(repo, "packages", "app") : repo;
}

function ids() {
	return {
		scopeKey: "abc123def456abc123def456",
		agentId: "11111111-2222-4333-8444-555555555555",
		agentSlug: "reviewer",
		turnId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		collisionId: "ffffffff-0000-4111-8222-333333333333",
	};
}

async function planFor(repoCwd: string, packageRoot: string, overrides: Partial<ReturnType<typeof ids>> = {}): Promise<ManagedWorktreePlan> {
	const base = { ...ids(), ...overrides };
	return planManagedWorktree({ sourceCwd: repoCwd, packageRoot, ...base }, gitOpts);
}

test("branch name uses pi-bstn/scope/slug-turnshort-uuidshort", () => {
	const id = ids();
	assert.equal(
		managedWorktreeBranchName(id.scopeKey, id.agentSlug, id.turnId, id.collisionId),
		`pi-bstn/${id.scopeKey}/reviewer-aaaaaaaa-ffffffff`,
	);
	assert.equal(managedWorktreeBranchName(id.scopeKey, "x", "ab", "c"), `pi-bstn/${id.scopeKey}/x-ab-c`);
});

test("plan rejects dirty tracked, staged, and untracked source trees", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		writeFileSync(join(f.repo, "README.md"), "dirty tracked\n");
		await assert.rejects(() => planFor(cwd, f.packageRoot), (error: unknown) => error instanceof ManagedWorktreeError && error.code === "dirty-source");

		await git(f.repo, ["checkout", "--", "README.md"]);
		writeFileSync(join(f.repo, "staged.txt"), "staged\n");
		await git(f.repo, ["add", "staged.txt"]);
		await assert.rejects(() => planFor(cwd, f.packageRoot), (error: unknown) => error instanceof ManagedWorktreeError && error.code === "dirty-source");

		await git(f.repo, ["reset", "HEAD", "staged.txt"]);
		rmSync(join(f.repo, "staged.txt"), { force: true });
		writeFileSync(join(f.repo, "untracked.txt"), "nope\n");
		await assert.rejects(() => planFor(cwd, f.packageRoot), (error: unknown) => error instanceof ManagedWorktreeError && error.code === "dirty-source");
	} finally { f.cleanup(); }
});

test("plan and allocate preserve subdir child cwd with exact verification", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo, true);
		const plan = await planFor(cwd, f.packageRoot);
		assert.equal(plan.sourceSubdir, "packages/app");
		assert.equal(plan.childCwd, join(plan.worktreePath, "packages", "app"));
		assert.match(plan.branchName, /^pi-bstn\/abc123def456abc123def456\/reviewer-aaaaaaaa-ffffffff$/);
		const allocated = await allocateManagedWorktree(plan, gitOpts);
		assert.equal(allocated.childCwd, plan.childCwd);
		assert.ok(existsSync(join(allocated.worktreePath, "packages", "app", "main.ts")));
		assert.equal((await git(allocated.worktreePath, ["rev-parse", "HEAD"])).toLowerCase(), plan.baseCommit);
		assert.equal(await git(allocated.worktreePath, ["symbolic-ref", "--short", "HEAD"]), plan.branchName);
		const common = await git(allocated.worktreePath, ["rev-parse", "--git-common-dir"]);
		const resolvedCommon = common.startsWith("/") ? common : join(allocated.worktreePath, common);
		assert.equal(realpathSync(resolvedCommon), realpathSync(plan.commonDir));
	} finally { f.cleanup(); }
});

test("finalize removes clean unchanged path and branch; second finalize is noop", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		const plan = await allocateManagedWorktree(await planFor(cwd, f.packageRoot), gitOpts);
		const first = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(first.classification.reason, "clean-unchanged");
		assert.equal(first.applied, "removed-path-and-branch");
		assert.equal(existsSync(plan.worktreePath), false);
		const branch = await commandRunner("git", ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branchName}`], plan.sourceRoot);
		assert.notEqual(branch.code, 0);
		const second = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(second.applied, "noop");
	} finally { f.cleanup(); }
});

test("finalize removes path but retains branch when worktree has commits", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		const plan = await allocateManagedWorktree(await planFor(cwd, f.packageRoot), gitOpts);
		writeFileSync(join(plan.worktreePath, "feature.txt"), "work\n");
		await git(plan.worktreePath, ["add", "feature.txt"]);
		await git(plan.worktreePath, ["commit", "-m", "agent work"]);
		const tip = await git(plan.worktreePath, ["rev-parse", "HEAD"]);
		assert.notEqual(tip, plan.baseCommit);
		const result = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(result.classification.reason, "clean-with-commits");
		assert.equal(result.applied, "removed-path-retained-branch");
		assert.equal(existsSync(plan.worktreePath), false);
		assert.equal(await git(plan.sourceRoot, ["rev-parse", plan.branchName]), tip);
	} finally { f.cleanup(); }
});

test("finalize retains path and branch when worktree is dirty", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		const plan = await allocateManagedWorktree(await planFor(cwd, f.packageRoot), gitOpts);
		writeFileSync(join(plan.worktreePath, "README.md"), "dirty\n");
		const result = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(result.classification.reason, "dirty");
		assert.equal(result.applied, "retained-path-and-branch");
		assert.ok(existsSync(plan.worktreePath));
		assert.equal(await git(plan.sourceRoot, ["rev-parse", plan.branchName]), plan.baseCommit);
		assert.ok(result.classification.dirty);
		assert.ok((result.classification.dirty?.tracked ?? 0) >= 1);
	} finally { f.cleanup(); }
});

test("finalize retains path and branch when branch changes or detaches", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		const plan = await allocateManagedWorktree(await planFor(cwd, f.packageRoot), gitOpts);
		await git(plan.worktreePath, ["checkout", "-b", "other-branch"]);
		const changed = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(changed.classification.reason, "branch-changed");
		assert.equal(changed.applied, "retained-path-and-branch");
		assert.ok(existsSync(plan.worktreePath));

		await git(plan.worktreePath, ["checkout", "--detach", "HEAD"]);
		const detached = await finalizeManagedWorktree(plan, gitOpts);
		assert.equal(detached.classification.reason, "detached");
		assert.equal(detached.applied, "retained-path-and-branch");
		assert.ok(existsSync(plan.worktreePath));
		const show = await commandRunner("git", ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branchName}`], plan.sourceRoot);
		assert.equal(show.code, 0);
	} finally { f.cleanup(); }
});

test("symlink escape and non-owned paths fail closed without destructive cleanup", async () => {
	const f = fixture();
	try {
		const cwd = await initRepo(f.repo);
		const plan = await allocateManagedWorktree(await planFor(cwd, f.packageRoot), gitOpts);

		const outside = join(f.root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.txt"), "no\n");
		const escapeId = "eeeeeeee-2222-4333-8444-555555555555";
		const escapePath = managedWorktreePath(f.packageRoot, ids().scopeKey, escapeId);
		mkdirSync(join(escapePath, ".."), { recursive: true });
		symlinkSync(outside, escapePath);
		const escapePlan: ManagedWorktreePlan = { ...plan, agentId: escapeId, worktreePath: escapePath, childCwd: escapePath };
		const linked = await classifyManagedWorktree(escapePlan, gitOpts);
		assert.equal(linked.disposition, "retain-path-and-branch");
		assert.equal(linked.reason, "symlink");
		assert.equal((await finalizeManagedWorktree(escapePlan, gitOpts)).applied, "retained-path-and-branch");
		assert.ok(existsSync(escapePath));

		const insideTarget = join(f.packageRoot, "inside-target");
		mkdirSync(insideTarget);
		const insideId = "dddddddd-2222-4333-8444-555555555555";
		const insidePath = managedWorktreePath(f.packageRoot, ids().scopeKey, insideId);
		mkdirSync(join(insidePath, ".."), { recursive: true });
		symlinkSync(insideTarget, insidePath);
		const insidePlan: ManagedWorktreePlan = { ...plan, agentId: insideId, worktreePath: insidePath, childCwd: insidePath };
		assert.equal((await classifyManagedWorktree(insidePlan, gitOpts)).reason, "symlink");

		const foreign: ManagedWorktreePlan = { ...plan, worktreePath: join(f.root, "foreign-worktree"), childCwd: join(f.root, "foreign-worktree"), agentId: "99999999-2222-4333-8444-555555555555" };
		mkdirSync(foreign.worktreePath);
		writeFileSync(join(foreign.worktreePath, "x.txt"), "x\n");
		const classified = await classifyManagedWorktree(foreign, gitOpts);
		assert.equal(classified.disposition, "retain-path-and-branch");
		assert.ok(classified.reason === "ownership" || classified.reason === "not-listed" || classified.reason === "symlink");
		const finalized = await finalizeManagedWorktree(foreign, gitOpts);
		assert.equal(finalized.applied, "retained-path-and-branch");
		assert.ok(existsSync(foreign.worktreePath));
		assert.ok(existsSync(plan.worktreePath));
		assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "root\n");
	} finally { f.cleanup(); }
});

test("plan rejects bare repositories", async () => {
	const f = fixture();
	try {
		const bare = join(f.root, "bare.git");
		mkdirSync(bare);
		await git(bare, ["init", "--bare"]);
		await assert.rejects(() => planFor(bare, f.packageRoot), (error: unknown) => error instanceof ManagedWorktreeError && error.code === "bare-repository");
	} finally { f.cleanup(); }
});

test("a clean named linked worktree can be the isolation source", async () => {
	const f = fixture(); try {
		await initRepo(f.repo); const linked = join(f.root, "linked-source"); await git(f.repo, ["worktree", "add", "-b", "linked-source", linked]);
		const plan = await planFor(linked, f.packageRoot, { agentId: "linked-agent", turnId: "linked-turn", collisionId: "linked-collision" });
		assert.equal(plan.sourceRoot, realpathSync(linked)); assert.equal(plan.commonDir, realpathSync(join(f.repo, ".git")));
		await allocateManagedWorktree(plan, gitOpts); assert.ok(existsSync(plan.worktreePath)); assert.equal((await finalizeManagedWorktree(plan, gitOpts)).applied, "removed-path-and-branch");
	} finally { f.cleanup(); }
});
