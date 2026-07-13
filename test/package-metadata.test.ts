import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as {
	name: string;
	version: string;
	keywords: string[];
	license: string;
	type: string;
	pi?: { extensions?: string[] };
	peerDependencies?: Record<string, string>;
	files?: string[];
};

test("package.json declares a git-installable pi package", () => {
	assert.equal(pkg.name, "pi-cursor-herdr-subagents");
	assert.equal(pkg.license, "MIT");
	assert.equal(pkg.type, "module");
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.ok(pkg.keywords.includes("pi-extension"));
	assert.deepEqual(pkg.pi?.extensions, ["./extensions/index.ts"]);
	assert.ok(pkg.files?.includes("extensions"));
	assert.ok(pkg.files?.includes("LICENSE"));
});

test("peerDependencies follow Pi package guidance", () => {
	const peers = pkg.peerDependencies ?? {};
	const meta = (pkg as { peerDependenciesMeta?: Record<string, { optional?: boolean }> })
		.peerDependenciesMeta;
	for (const name of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	]) {
		assert.equal(peers[name], "*", `peer ${name} should be *`);
		assert.equal(meta?.[name]?.optional, true, `peerDependenciesMeta.${name}.optional`);
	}
});

test("ACP clientInfo version matches package.json", () => {
	const acpSource = readFileSync(new URL("../extensions/acp.ts", import.meta.url), "utf8");
	assert.match(acpSource, /PACKAGE_NAME/);
	assert.match(acpSource, /PACKAGE_VERSION/);
	assert.doesNotMatch(acpSource, /version:\s*"0\.1\.0"/);
});
