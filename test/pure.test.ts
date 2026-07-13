import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendBounded,
	contentText,
	formatElapsed,
	parseJson,
	shellQuote,
	summarize,
	toolLabel,
	SUBAGENT_IDLE_TIMEOUT_MS,
} from "../extensions/index.ts";

test("ready subagents use a 15-minute idle timeout", async () => {
	assert.equal(SUBAGENT_IDLE_TIMEOUT_MS, 15 * 60 * 1000);
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
	assert.match(source, /scheduleIdleClose\(agent\)/);
	assert.match(source, /action=stop when no more follow-up is needed/);
});

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

test("extension uses plain viewer tabs without Herdr agent identity", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /report-agent/);
	assert.doesNotMatch(source, /release-agent/);
	assert.doesNotMatch(source, /report-metadata/);
	assert.doesNotMatch(source, /--display-agent/);
	assert.match(source, /"--label"/);
	assert.match(source, /tail -n 200 -F/);
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
