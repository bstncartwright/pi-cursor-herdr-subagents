import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendBounded,
	contentText,
	formatElapsed,
	herdrSource,
	herdrState,
	parseJson,
	shellQuote,
	summarize,
	toolLabel,
} from "../extensions/index.ts";

test("shellQuote escapes single quotes for POSIX shells", () => {
	assert.equal(shellQuote("plain"), "'plain'");
	assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("formatElapsed formats mm:ss from a fixed now", () => {
	assert.equal(formatElapsed(1_000, 1_000), "0:00");
	assert.equal(formatElapsed(1_000, 1_000 + 65_000), "1:05");
	assert.equal(formatElapsed(5_000, 4_000), "0:00");
});

test("appendBounded keeps the trailing window", () => {
	assert.equal(appendBounded("abc", "de", 10), "abcde");
	assert.equal(appendBounded("abcdefgh", "ij", 8), "cdefghij");
	assert.equal(appendBounded("hello", "WORLD", 8), "lloWORLD");
});

test("herdrSource and herdrState map managed status for Herdr reporting", () => {
	assert.equal(herdrSource("abc123"), "pi:cursor-acp:abc123");
	assert.equal(herdrState("ready"), "idle");
	assert.equal(herdrState("failed"), "blocked");
	assert.equal(herdrState("starting"), "working");
	assert.equal(herdrState("working"), "working");
	assert.equal(herdrState("stopped"), "unknown");
});

test("contentText and toolLabel extract ACP update fields", () => {
	assert.equal(contentText({ type: "text", text: "hi" }), "hi");
	assert.equal(contentText({ type: "image" }), "");
	assert.equal(contentText(null), "");
	assert.equal(toolLabel({ title: "Read" }), "Read");
	assert.equal(toolLabel({ toolCall: { name: "bash" } }), "bash");
	assert.equal(toolLabel({}), "tool");
});

test("summarize truncates long payloads", () => {
	assert.equal(summarize("short"), "short");
	assert.equal(summarize("abcdefghij", 5), "abcde…");
	assert.equal(summarize({ a: 1 }), '{"a":1}');
});

test("parseJson wraps invalid payloads with context", () => {
	assert.deepEqual(parseJson<{ ok: boolean }>('{"ok":true}', "test"), { ok: true });
	assert.throws(() => parseJson("nope", "herdr tab create"), /Unexpected herdr tab create output/);
});

test("resolveCwd validates directories without machine-specific paths", async () => {
	const { resolveCwd } = await import("../extensions/index.ts");
	const root = mkdtempSync(join(tmpdir(), "pi-cursor-cwd-"));
	try {
		const nested = join(root, "nested");
		mkdirSync(nested);
		assert.equal(resolveCwd(undefined, root), root);
		assert.equal(resolveCwd("nested", root), nested);
		assert.equal(resolveCwd(nested, root), nested);
		const filePath = join(root, "file.txt");
		writeFileSync(filePath, "x");
		assert.throws(() => resolveCwd(filePath, root), /not a directory/);
		assert.throws(() => resolveCwd(join(root, "missing"), root), /not a directory/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
