import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const extension = join(root, "extensions", "index.ts");
const captureExtension = join(here, "fixtures", "capture-parent-tools.ts");
const fakeCodexExtension = join(here, "fixtures", "fake-codex-conversion.ts");
const codexGuard = join(root, "extensions", "codex-child-guard.ts");
const expectedTools = ["spawn_agent", "list_agent_templates", "list_subagent_models", "wait_agent", "wait_all_agents", "list_agents", "read_agent_response", "send_message", "interrupt_agent", "close_agent", "respond_agent_permission"].sort();

test("real offline parent Pi loads package tools, schemas, and commands under isolated HOME", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-parent-load-")); const home = join(temporary, "home"); const cwd = join(temporary, "project"); const capture = join(temporary, "tools.json"); await mkdir(home); await mkdir(cwd);
	const scrubbedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|_TOKEN)$|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$/.test(key)));
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--extension", extension, "--extension", captureExtension, "--no-skills", "--no-prompt-templates", "--no-context-files"], {
		cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...scrubbedEnv, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi-agent-test"), PI_OFFLINE: "1", PI_TEST_TOOL_CAPTURE: capture },
	});
	let stdout = ""; let stderr = ""; const records: any[] = []; let readyResolve!: () => void; const ready = new Promise<void>((done) => { readyResolve = done; });
	child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); for (;;) { const index = stdout.indexOf("\n"); if (index < 0) break; const line = stdout.slice(0, index).replace(/\r$/, ""); stdout = stdout.slice(index + 1); if (line) records.push(JSON.parse(line)); } if (records.some((entry) => entry.id === "state") && records.some((entry) => entry.id === "commands")) readyResolve(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
	const exited = new Promise<number | null>((done) => child.once("exit", done));
	const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000); timeout.unref?.();
	try {
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`); child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		let responseTimer!: ReturnType<typeof setTimeout>; try { await Promise.race([ready, new Promise((_, reject) => { responseTimer = setTimeout(() => reject(new Error("Timed out waiting for parent Pi RPC responses")), 10_000); })]); } finally { clearTimeout(responseTimer); }
		assert.ok(records.some((entry) => entry.id === "state" && entry.success === true), stderr);
		const commands = records.find((entry) => entry.id === "commands"); assert.ok(commands?.success, stderr); const names = commands.data.commands.filter((entry: any) => entry.source === "extension").map((entry: any) => entry.name); assert.ok(names.includes("agents")); assert.ok(names.includes("subagent"));
		assert.equal(records.some((entry) => entry.type === "extension_error"), false, JSON.stringify(records));
		const captured = JSON.parse(readFileSync(capture, "utf8")); const tools = captured.tools.filter((entry: any) => expectedTools.includes(entry.name)); assert.deepEqual(tools.map((entry: any) => entry.name).sort(), expectedTools); for (const tool of tools) assert.ok(tool.parameters && typeof tool.parameters === "object", `${tool.name} schema`);
	} finally {
		child.stdin.end(); let exitTimer!: ReturnType<typeof setTimeout>; try { await Promise.race([exited, new Promise((done) => { exitTimer = setTimeout(done, 1500); })]); } finally { clearTimeout(exitTimer); } if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } clearTimeout(timeout); await rm(temporary, { recursive: true, force: true });
	}
});

test("real offline Pi loads the installed-style Codex conversion before the guard and retains all Codex tools", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-codex-child-load-")); const home = join(temporary, "home"); const cwd = join(temporary, "project"); const capture = join(temporary, "tools.json"); const packageRoot = join(temporary, "npm", "node_modules", "@howaboua", "pi-codex-conversion"); await mkdir(home); await mkdir(cwd); await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@howaboua/pi-codex-conversion", pi: { extensions: ["./extension.ts"] } })); await writeFile(join(packageRoot, "extension.ts"), readFileSync(fakeCodexExtension, "utf8")); await symlink(join(root, "node_modules"), join(packageRoot, "node_modules"), "dir");
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", "--no-extensions", "--extension", packageRoot, "--extension", codexGuard, "--extension", captureExtension, "--no-skills", "--no-prompt-templates", "--no-context-files"], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi-agent-test"), PI_OFFLINE: "1", PI_TEST_TOOL_CAPTURE: capture } });
	let stdout = ""; let stderr = ""; const records: any[] = []; let readyResolve!: () => void; const ready = new Promise<void>((resolveReady) => { readyResolve = resolveReady; });
	child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); for (;;) { const index = stdout.indexOf("\n"); if (index < 0) break; const line = stdout.slice(0, index).replace(/\r$/, ""); stdout = stdout.slice(index + 1); if (line) records.push(JSON.parse(line)); } if (records.some((entry) => entry.id === "state")) readyResolve(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); }); const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	try {
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`); let timer!: ReturnType<typeof setTimeout>; try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for Codex child state")), 10_000); })]); } finally { clearTimeout(timer); }
		assert.equal(records.some((entry) => entry.type === "extension_error"), false, stderr || JSON.stringify(records)); const captured = JSON.parse(readFileSync(capture, "utf8")); assert.deepEqual(captured.activeTools, ["exec_command", "write_stdin", "apply_patch", "web_run", "imagegen", "view_image"]);
	} finally { child.stdin.end(); await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 1500))]); if (child.exitCode === null) child.kill("SIGKILL"); await rm(temporary, { recursive: true, force: true }); }
});
