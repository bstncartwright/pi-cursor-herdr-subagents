import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { CODEX_CONVERSION_PACKAGE, resolveCodexExtensionAtAgentDir } from "../extensions/codex-extension-resolver.ts";

async function packageRoot(agentDir: string): Promise<string> {
	const root = join(agentDir, "npm", "node_modules", "@howaboua", "pi-codex-conversion");
	await mkdir(root, { recursive: true });
	return root;
}
async function validPackage(root: string, extensions: unknown = ["./extension.ts"], name = CODEX_CONVERSION_PACKAGE): Promise<void> {
	await writeFile(join(root, "package.json"), JSON.stringify({ name, pi: { extensions } }));
	await writeFile(join(root, "extension.ts"), "export default () => {};\n");
}

test("Codex conversion resolver accepts only a valid canonical global npm package", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-codex-resolver-"));
	try {
		assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined, "missing npm package");
		const root = await packageRoot(temporary); await validPackage(root);
		assert.equal(resolveCodexExtensionAtAgentDir(temporary), realpathSync(root));
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Codex conversion resolver rejects malformed, oversized, mismatched, and empty declarations", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-codex-resolver-invalid-")); const root = await packageRoot(temporary);
	try {
		await writeFile(join(root, "package.json"), "{"); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await writeFile(join(root, "package.json"), " ".repeat(64 * 1024 + 1)); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, ["./extension.ts"], "wrong-name"); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, []); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, [""]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, [42]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, ["./missing.ts"]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await validPackage(root, ["."]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Codex conversion resolver rejects symlinked npm, scope, and package directory escapes", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-codex-resolver-directory-escape-"));
	try {
		const npmOutside = join(temporary, "npm-outside"); const npmPackage = await packageRoot(npmOutside); await validPackage(npmPackage); await symlink(join(npmOutside, "npm"), join(temporary, "npm"), "dir");
		assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined, "symlinked npm"); await rm(join(temporary, "npm"));
		const npmRoot = join(temporary, "npm", "node_modules"); const scopeOutside = join(temporary, "scope-outside"); await mkdir(npmRoot, { recursive: true }); await mkdir(scopeOutside); const scopePackage = join(scopeOutside, "pi-codex-conversion"); await mkdir(scopePackage); await validPackage(scopePackage); await symlink(scopeOutside, join(npmRoot, "@howaboua"), "dir");
		assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined, "symlinked scope"); await rm(join(npmRoot, "@howaboua"));
		const scope = join(npmRoot, "@howaboua"); const packageOutside = join(temporary, "package-outside"); await mkdir(scope); await mkdir(packageOutside); await validPackage(packageOutside); await symlink(packageOutside, join(scope, "pi-codex-conversion"), "dir");
		assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined, "symlinked package");
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Codex conversion resolver rejects traversal and symlink entry escapes", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "pi-codex-resolver-escape-")); const root = await packageRoot(temporary); const outside = join(temporary, "outside.ts");
	try {
		await writeFile(outside, "export default () => {};\n");
		await validPackage(root, ["../outside.ts"]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await symlink(outside, join(root, "link.ts")); await validPackage(root, ["./link.ts"]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
		await mkdir(join(root, "linked")); await symlink(join(temporary), join(root, "linked", "escape")); await validPackage(root, ["./linked/escape/outside.ts"]); assert.equal(resolveCodexExtensionAtAgentDir(temporary), undefined);
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
