import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isCursorModel, PACKAGE_NAME, type CursorModel } from "./acp.ts";
import { normalizePermissionMode, type PermissionMode } from "./helpers.ts";

export type AgentTemplateBackend = "pi" | "cursor";
export type AgentTemplateThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentTemplateScope = "global" | "project";

export interface AgentTemplate {
	name: string;
	description?: string;
	hint?: string;
	backend?: AgentTemplateBackend;
	provider?: string;
	model?: string;
	thinking?: AgentTemplateThinking;
	tools?: string;
	skills?: string[];
	extensions?: string[];
	cursorModel?: CursorModel;
	permissionMode?: PermissionMode;
	prompt?: string;
}

export interface AgentTemplateRecord extends AgentTemplate {
	scope: AgentTemplateScope;
	source: string;
	shadowsGlobal: boolean;
}

export interface AgentTemplateDiagnostic {
	scope: AgentTemplateScope | "config";
	code: "invalid-name" | "invalid-template" | "duplicate-name" | "unsafe-entry" | "invalid-allowlist-entry";
	name?: string;
	source?: string;
}

export type ProjectTemplateStatus = "trusted" | "not-present" | "blocked-pi-trust" | "blocked-package-allowlist" | "unsafe-directory";

export interface AgentTemplateCatalog {
	templates: AgentTemplateRecord[];
	diagnostics: AgentTemplateDiagnostic[];
	projectStatus: ProjectTemplateStatus;
	projectRoot: string;
	conflictedNames: string[];
}

export interface AgentTemplateCatalogOptions {
	globalAgentsDir: string;
	configPath: string;
	cwd: string;
	piProjectTrusted: boolean;
}

const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const TEMPLATE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

function stringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const result = raw.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
	return result.length ? [...new Set(result)] : undefined;
}

function thinkingLevel(value: unknown): AgentTemplateThinking | undefined {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
		? value as AgentTemplateThinking
		: undefined;
}

export function validAgentTemplateName(value: string): boolean { return TEMPLATE_NAME.test(value); }

export function parseAgentTemplateText(text: string, fallbackName: string): AgentTemplate {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
	const backend = frontmatter.backend === "pi" || frontmatter.backend === "cursor" ? frontmatter.backend : undefined;
	const cursorModel = isCursorModel(frontmatter.cursor_model) ? frontmatter.cursor_model : undefined;
	const permissionMode = ["agent", "prompt", "allow-once", "deny"].includes(String(frontmatter.permission_mode))
		? normalizePermissionMode(frontmatter.permission_mode)
		: undefined;
	return {
		name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : fallbackName,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		hint: typeof frontmatter.hint === "string" ? frontmatter.hint : undefined,
		backend,
		provider: typeof frontmatter.provider === "string" ? frontmatter.provider : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: thinkingLevel(frontmatter.thinking),
		tools: typeof frontmatter.tools === "string" ? frontmatter.tools : undefined,
		skills: stringList(frontmatter.skills),
		extensions: stringList(frontmatter.extensions),
		cursorModel,
		permissionMode,
		prompt: body.trim() || undefined,
	};
}

function codepointCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function canonicalDirectory(path: string): string | undefined {
	try {
		if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) return undefined;
		return realpathSync(path);
	} catch { return undefined; }
}

function safeTemplateFiles(directory: string, scope: AgentTemplateScope, diagnostics: AgentTemplateDiagnostic[]): string[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.name.toLowerCase().endsWith(".md"))
		.flatMap((entry) => {
			if (!entry.isFile() || entry.isSymbolicLink()) {
				diagnostics.push({ scope, code: "unsafe-entry", source: entry.name }); return [];
			}
			return [entry.name];
		})
		.sort(codepointCompare);
}

function readTemplateFile(directory: string, source: string): string {
	const path = join(directory, source);
	if (lstatSync(path).isSymbolicLink() || dirname(realpathSync(path)) !== directory) throw new Error("unsafe template path");
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile() || metadata.size > MAX_TEMPLATE_BYTES) throw new Error("invalid template file");
		return readFileSync(descriptor, "utf8");
	} finally { closeSync(descriptor); }
}

function loadTier(directory: string, scope: AgentTemplateScope, diagnostics: AgentTemplateDiagnostic[]): { records: Map<string, AgentTemplateRecord>; conflicted: Set<string> } {
	const candidates = new Map<string, Array<{ source: string; template?: AgentTemplate }>>();
	for (const source of safeTemplateFiles(directory, scope, diagnostics)) {
		const fallback = source.slice(0, -3); let template: AgentTemplate | undefined;
		try {
			template = parseAgentTemplateText(readTemplateFile(directory, source), fallback);
		} catch { diagnostics.push({ scope, code: "invalid-template", source }); }
		const key = (template?.name ?? fallback).toLowerCase();
		const entries = candidates.get(key) ?? []; entries.push({ source, template }); candidates.set(key, entries);
	}
	const records = new Map<string, AgentTemplateRecord>(); const conflicted = new Set<string>();
	for (const [key, entries] of candidates) {
		if (entries.length !== 1) {
			conflicted.add(key); diagnostics.push({ scope, code: "duplicate-name", name: key }); continue;
		}
		const [{ source, template }] = entries;
		if (!template) { conflicted.add(key); continue; }
		if (!validAgentTemplateName(template.name)) {
			conflicted.add(key); diagnostics.push({ scope, code: "invalid-name", name: key, source }); continue;
		}
		records.set(template.name, { ...template, scope, source, shadowsGlobal: false });
	}
	return { records, conflicted };
}

function configuredTrustedProjects(configPath: string, diagnostics: AgentTemplateDiagnostic[]): Set<string> {
	let parsed: unknown;
	try {
		const metadata = statSync(configPath); if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES) return new Set();
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch { return new Set(); }
	const values = parsed && typeof parsed === "object" && Array.isArray((parsed as { trustedProjects?: unknown }).trustedProjects)
		? (parsed as { trustedProjects: unknown[] }).trustedProjects : [];
	const result = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string" || !value.trim()) { diagnostics.push({ scope: "config", code: "invalid-allowlist-entry" }); continue; }
		const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
		if (!isAbsolute(expanded)) { diagnostics.push({ scope: "config", code: "invalid-allowlist-entry" }); continue; }
		const candidate = expanded;
		try { result.add(realpathSync(candidate)); } catch { diagnostics.push({ scope: "config", code: "invalid-allowlist-entry" }); }
	}
	return result;
}

export function buildAgentTemplateCatalog(options: AgentTemplateCatalogOptions): AgentTemplateCatalog {
	const diagnostics: AgentTemplateDiagnostic[] = [];
	let projectRoot: string;
	try { projectRoot = realpathSync(options.cwd); } catch { projectRoot = resolve(options.cwd); }
	const globalDirectory = canonicalDirectory(options.globalAgentsDir);
	const globalTier = globalDirectory ? loadTier(globalDirectory, "global", diagnostics) : { records: new Map<string, AgentTemplateRecord>(), conflicted: new Set<string>() };
	let projectStatus: ProjectTemplateStatus = "blocked-pi-trust";
	let projectTier = { records: new Map<string, AgentTemplateRecord>(), conflicted: new Set<string>() };
	if (options.piProjectTrusted) {
		const allowed = configuredTrustedProjects(options.configPath, diagnostics).has(projectRoot);
		if (!allowed) projectStatus = "blocked-package-allowlist";
		else {
			const projectDirectoryPath = join(projectRoot, CONFIG_DIR_NAME, PACKAGE_NAME, "agents");
			try {
				const metadata = lstatSync(projectDirectoryPath);
				if (metadata.isSymbolicLink() || !metadata.isDirectory()) projectStatus = "unsafe-directory";
				else { const directory = realpathSync(projectDirectoryPath); projectTier = loadTier(directory, "project", diagnostics); projectStatus = "trusted"; }
			} catch { projectStatus = "not-present"; }
		}
	}
	const effective = new Map(globalTier.records);
	for (const name of projectTier.conflicted) effective.delete(name);
	for (const [name, record] of projectTier.records) effective.set(name, { ...record, shadowsGlobal: globalTier.records.has(name) });
	const unresolvedGlobalConflicts = [...globalTier.conflicted].filter((name) => !projectTier.records.has(name));
	const conflictedNames = [...new Set([...unresolvedGlobalConflicts, ...projectTier.conflicted])].sort(codepointCompare);
	return { templates: [...effective.values()].sort((a, b) => codepointCompare(a.name, b.name)), diagnostics, projectStatus, projectRoot, conflictedNames };
}

export function resolveAgentTemplate(catalog: AgentTemplateCatalog, name: string): AgentTemplateRecord {
	if (!validAgentTemplateName(name)) throw new Error("agent_type must be a lowercase ASCII template name.");
	if (catalog.conflictedNames.includes(name)) throw new Error(`Agent template is conflicted and unavailable: ${name}`);
	const template = catalog.templates.find((entry) => entry.name === name);
	if (!template) throw new Error(`Agent template not found: ${name}`);
	return template;
}

export function publicAgentTemplateCatalog(catalog: AgentTemplateCatalog): Record<string, unknown> {
	return {
		templates: catalog.templates.map(({ name, scope, backend, description, hint, source, shadowsGlobal }) => ({ name, scope, backend: backend ?? null, description: description ?? null, hint: hint ?? null, source, shadows_global: shadowsGlobal })),
		project_status: catalog.projectStatus,
		conflicted_names: catalog.conflictedNames,
		diagnostics: catalog.diagnostics,
	};
}
