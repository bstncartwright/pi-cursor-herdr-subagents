import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const CODEX_CONVERSION_PACKAGE = "@howaboua/pi-codex-conversion";
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_EXTENSION_ENTRIES = 64;
const MAX_ENTRY_LENGTH = 1024;

function containedBy(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

/** The configured agent directory may itself be an alias; canonicalize it before descent. */
function canonicalAgentDirectory(path: string): string | undefined {
	try { return statSync(path).isDirectory() ? realpathSync(path) : undefined; }
	catch { return undefined; }
}
/** Accept only a non-symlink directory that remains this parent's direct child after realpath. */
function canonicalDirectDirectory(parent: string, name: string): string | undefined {
	const expected = join(parent, name);
	try {
		if (!lstatSync(expected).isDirectory() || lstatSync(expected).isSymbolicLink()) return undefined;
		const canonical = realpathSync(expected);
		return canonical === expected ? canonical : undefined;
	} catch { return undefined; }
}

/** Reject a declared package entry if any component is a symlink or leaves the package. */
function canonicalRegularEntry(root: string, entry: string): string | undefined {
	if (!entry || entry.length > MAX_ENTRY_LENGTH || isAbsolute(entry)) return undefined;
	const lexical = resolve(root, entry);
	if (!containedBy(lexical, root)) return undefined;
	const parts = relative(root, lexical).split(sep).filter(Boolean);
	if (!parts.length) return undefined;
	let current = root;
	try {
		for (const part of parts) {
			current = join(current, part);
			if (lstatSync(current).isSymbolicLink()) return undefined;
		}
		if (!statSync(current).isFile()) return undefined;
		const canonical = realpathSync(current);
		return containedBy(canonical, root) ? canonical : undefined;
	} catch { return undefined; }
}

/**
 * Validate only the globally installed conversion package below a supplied Pi agent directory.
 * It performs no package lookup, PATH lookup, project lookup, or network access.
 */
export function resolveCodexExtensionAtAgentDir(agentDir: string): string | undefined {
	const canonicalAgentDir = canonicalAgentDirectory(agentDir);
	if (!canonicalAgentDir) return undefined;
	const npmDir = canonicalDirectDirectory(canonicalAgentDir, "npm");
	const npmRoot = npmDir && canonicalDirectDirectory(npmDir, "node_modules");
	const scopeDir = npmRoot && canonicalDirectDirectory(npmRoot, "@howaboua");
	const packageRoot = scopeDir && canonicalDirectDirectory(scopeDir, "pi-codex-conversion");
	if (!npmRoot || !packageRoot || !containedBy(packageRoot, npmRoot)) return undefined;
	const packageJson = join(packageRoot, "package.json");
	let parsed: unknown;
	try {
		if (lstatSync(packageJson).isSymbolicLink() || !statSync(packageJson).isFile() || statSync(packageJson).size > MAX_PACKAGE_JSON_BYTES) return undefined;
		parsed = JSON.parse(readFileSync(packageJson, "utf8"));
	} catch { return undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const value = parsed as { name?: unknown; pi?: { extensions?: unknown } };
	if (value.name !== CODEX_CONVERSION_PACKAGE || !value.pi || typeof value.pi !== "object" || Array.isArray(value.pi)) return undefined;
	const entries = value.pi.extensions;
	if (!Array.isArray(entries) || !entries.length || entries.length > MAX_EXTENSION_ENTRIES || entries.some((entry) => typeof entry !== "string" || !entry.trim())) return undefined;
	for (const entry of entries) if (!canonicalRegularEntry(packageRoot, entry as string)) return undefined;
	return packageRoot;
}

/** Production resolver: the Codex conversion is intentionally npm-global-only. */
export function resolveInstalledCodexExtension(): string | undefined {
	return resolveCodexExtensionAtAgentDir(getAgentDir());
}
