import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAgentTemplateCatalog,
	publicAgentTemplateCatalog,
	resolveAgentTemplate,
} from "../extensions/agent-templates.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-templates-"));
	const project = join(root, "project"); const globalAgentsDir = join(root, "global-agents"); const configPath = join(root, "config.json");
	mkdirSync(project); mkdirSync(globalAgentsDir); mkdirSync(join(project, ".pi", "pi-bstn-subagents", "agents"), { recursive: true });
	const build = (piProjectTrusted = true) => buildAgentTemplateCatalog({ globalAgentsDir, configPath, cwd: project, piProjectTrusted });
	return { root, project, globalAgentsDir, configPath, projectAgentsDir: join(project, ".pi", "pi-bstn-subagents", "agents"), build, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function template(name: string, description: string, prompt = "private prompt"): string {
	return `---\nname: ${name}\nbackend: pi\ndescription: ${description}\nhint: use narrowly\n---\n${prompt}\n`;
}

test("project templates require both Pi trust and the canonical package allowlist", () => {
	const f = fixture(); try {
		writeFileSync(join(f.globalAgentsDir, "global.md"), template("global", "global template"));
		writeFileSync(join(f.projectAgentsDir, "project.md"), template("project", "project template"));
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		const piBlocked = f.build(false); assert.equal(piBlocked.projectStatus, "blocked-pi-trust"); assert.deepEqual(piBlocked.templates.map((entry) => entry.name), ["global"]);
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [] }));
		const packageBlocked = f.build(true); assert.equal(packageBlocked.projectStatus, "blocked-package-allowlist"); assert.deepEqual(packageBlocked.templates.map((entry) => entry.name), ["global"]);
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: ["."] })); const relativeBlocked = f.build(true); assert.equal(relativeBlocked.projectStatus, "blocked-package-allowlist"); assert.ok(relativeBlocked.diagnostics.some((entry) => entry.code === "invalid-allowlist-entry"));
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		const allowed = f.build(true); assert.equal(allowed.projectStatus, "trusted"); assert.deepEqual(allowed.templates.map((entry) => entry.name), ["global", "project"]);
	} finally { f.cleanup(); }
});

test("trusted project templates override global templates without exposing prompts", () => {
	const f = fixture(); try {
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		writeFileSync(join(f.globalAgentsDir, "reviewer.md"), template("reviewer", "global"));
		writeFileSync(join(f.projectAgentsDir, "reviewer.md"), template("reviewer", "project", "secret project instruction"));
		const catalog = f.build(); const selected = resolveAgentTemplate(catalog, "reviewer");
		assert.equal(selected.scope, "project"); assert.equal(selected.shadowsGlobal, true); assert.equal(selected.prompt, "secret project instruction");
		const listing = JSON.stringify(publicAgentTemplateCatalog(catalog)); assert.match(listing, /project/); assert.doesNotMatch(listing, /secret project instruction|private prompt/);
	} finally { f.cleanup(); }
});

test("same-tier and case-folded conflicts fail closed without global fallback", () => {
	const f = fixture(); try {
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		writeFileSync(join(f.globalAgentsDir, "reviewer.md"), template("reviewer", "global"));
		writeFileSync(join(f.projectAgentsDir, "a.md"), template("reviewer", "one"));
		writeFileSync(join(f.projectAgentsDir, "b.md"), template("Reviewer", "two"));
		const catalog = f.build(); assert.equal(catalog.templates.some((entry) => entry.name === "reviewer"), false); assert.deepEqual(catalog.conflictedNames, ["reviewer"]);
		assert.throws(() => resolveAgentTemplate(catalog, "reviewer"), /conflicted/);
	} finally { f.cleanup(); }
});

test("a valid project template may replace a conflicted global name", () => {
	const f = fixture(); try {
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		writeFileSync(join(f.globalAgentsDir, "a.md"), template("reviewer", "one")); writeFileSync(join(f.globalAgentsDir, "b.md"), template("reviewer", "two"));
		writeFileSync(join(f.projectAgentsDir, "reviewer.md"), template("reviewer", "project"));
		assert.equal(resolveAgentTemplate(f.build(), "reviewer").scope, "project");
	} finally { f.cleanup(); }
});

test("unsafe files, symlinks, oversized files, and non-lowercase names are unavailable", () => {
	const f = fixture(); try {
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] }));
		writeFileSync(join(f.projectAgentsDir, "Upper.md"), template("Upper", "bad"));
		writeFileSync(join(f.projectAgentsDir, "huge.md"), template("huge", "x", "x".repeat(70 * 1024)));
		const outside = join(f.root, "outside.md"); writeFileSync(outside, template("linked", "bad")); symlinkSync(outside, join(f.projectAgentsDir, "linked.md"));
		const catalog = f.build(); assert.deepEqual(catalog.templates, []); assert.ok(catalog.diagnostics.some((entry) => entry.code === "unsafe-entry")); assert.ok(catalog.diagnostics.some((entry) => entry.code === "invalid-name"));
		assert.throws(() => resolveAgentTemplate(catalog, "Upper"), /lowercase ASCII/);
	} finally { f.cleanup(); }
});

test("catalogs hot-read edits without a watcher or reload", () => {
	const f = fixture(); try {
		writeFileSync(f.configPath, JSON.stringify({ trustedProjects: [f.project] })); const path = join(f.projectAgentsDir, "reviewer.md");
		writeFileSync(path, template("reviewer", "first")); assert.equal(resolveAgentTemplate(f.build(), "reviewer").description, "first");
		writeFileSync(path, template("reviewer", "second")); assert.equal(resolveAgentTemplate(f.build(), "reviewer").description, "second");
	} finally { f.cleanup(); }
});
