/** Pure, privacy-preserving presentation for non-spawn subagent tools. */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { formatCompactTokens, renderCompletionMessage, safeDisplayText, type CompletionRenderDetails } from "./agent-message-render.ts";
export { safeDisplayText } from "./agent-message-render.ts";

export type AgentToolTheme = Pick<Theme, "fg" | "bold">;
type RecordValue = Record<string, unknown>;
const STATUS = new Set(["queued", "starting", "running", "completed", "failed", "interrupted", "paused", "closed"]);
const BACKEND = new Set(["pi", "cursor"]);
const ISOLATION = new Set(["shared", "worktree"]);
const DELIVERY = new Set(["steer", "cancel-and-prompt", "prompt"]);
const DECISION = new Set(["approve", "reject"]);
const WORKTREE_PHASE = new Set(["planned", "active", "removed", "retained-branch", "retained-both", "failed"]);
const WORKTREE_REASON = new Set(["clean-unchanged", "commits-preserved", "dirty", "branch-changed", "detached", "ownership-uncertain", "inspection-failed", "allocation-failed", "cleanup-failed", "missing"]);
const PROJECT_STATUS = new Set(["trusted", "not-present", "blocked-pi-trust", "blocked-package-allowlist", "unsafe-directory"]);
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function rec(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function enumText(value: unknown, values: Set<string>): string { return typeof value === "string" && values.has(value) ? value : "—"; }
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function line(label: string, scope: string, theme: AgentToolTheme): string { return `${theme.fg("toolTitle", "▸")} ${theme.fg("toolTitle", theme.bold(label))}${scope ? `  ${theme.fg("accent", scope)}` : ""}`; }
function resultLine(text: string, color: ThemeColor, theme: AgentToolTheme): string { return theme.fg(color, `  ⎿  ${text}`); }
function header(text: string, color: ThemeColor, theme: AgentToolTheme): string { return theme.fg(color, text); }
function genericError(label: string, theme: AgentToolTheme): string { return header(`✗ ${label} failed`, "error", theme); }
function statusColor(status: string): ThemeColor { return status === "completed" ? "success" : status === "failed" ? "error" : status === "running" || status === "starting" || status === "queued" ? "warning" : "muted"; }
function statusIcon(status: string): string { return status === "completed" ? "✓" : status === "failed" ? "✗" : status === "running" ? "●" : status === "starting" ? "◌" : status === "queued" ? "○" : "■"; }
function statusText(value: unknown): string { return enumText(value, STATUS); }
function backendText(value: unknown): string { return enumText(value, BACKEND); }
function isolationText(value: unknown): string { return enumText(value, ISOLATION); }
function rows(lines: string[], extra: number, theme: AgentToolTheme): string[] { if (extra) lines.push(theme.fg("muted", `  ⎿  … ${extra} more`)); return lines; }
function optionsExpanded(options: unknown): boolean { return !!rec(options).expanded; }

export function renderTemplatesCall(_args: unknown, theme: AgentToolTheme): string { return line("Templates", "", theme); }
export function renderModelsCall(args: unknown, theme: AgentToolTheme): string {
	const value = rec(args); const backend = value.backend === undefined ? "all" : backendText(value.backend); const query = typeof value.search === "string" ? safeDisplayText(value.search, 48, "all") : "all";
	return line("Models", `${backend} · ${query}`, theme);
}
export function renderWaitCall(args: unknown, theme: AgentToolTheme): string { const targets = Array.isArray(rec(args).targets) ? (rec(args).targets as unknown[]).slice(0, 8).map((x) => safeDisplayText(x, 32)).join(", ") : ""; return line("Wait", targets || "any", theme); }
export function renderWaitAllCall(args: unknown, theme: AgentToolTheme): string { const targets = Array.isArray(rec(args).targets) ? (rec(args).targets as unknown[]).slice(0, 8).map((x) => safeDisplayText(x, 32)).join(", ") : ""; return line("Wait all", targets || "all", theme); }
export function renderAgentsCall(args: unknown, theme: AgentToolTheme): string { const value = rec(args); const prefix = typeof value.path_prefix === "string" ? safeDisplayText(value.path_prefix, 48) : ""; return line("Agents", `${value.include_all === true ? "all" : "current"}${prefix ? ` · ${prefix}` : ""}`, theme); }
export function renderTargetCall(label: "Read" | "Send" | "Interrupt" | "Close", args: unknown, theme: AgentToolTheme): string { return line(label, safeDisplayText(rec(args).target, 48), theme); }
export function renderPermissionCall(args: unknown, theme: AgentToolTheme): string { const value = rec(args); return line("Permission", `${safeDisplayText(value.target, 48)} · ${enumText(value.decision, DECISION)}`, theme); }

export function renderTemplatesResult(result: unknown, options: unknown, theme: AgentToolTheme): string {
	const value = rec(result); if (value.isError) return genericError("Template listing", theme); const details = rec(value.details); const templates = Array.isArray(details.templates) ? details.templates : []; const diagnostics = Array.isArray(details.diagnostics) ? details.diagnostics : [];
	const conflictCount = Array.isArray(details.conflicted_names) ? details.conflicted_names.length : 0;
	const projectStatus = enumText(details.project_status, PROJECT_STATUS);
	const summary = [`✓ ${templates.length} template${templates.length === 1 ? "" : "s"}`, projectStatus];
	if (conflictCount) summary.push(`${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`);
	if (diagnostics.length) summary.push(`${diagnostics.length} warning${diagnostics.length === 1 ? "" : "s"}`);
	const lines = [header(summary.join(" · "), "success", theme)];
	if (!optionsExpanded(options)) return lines.join("\n");
	for (const item of templates.slice(0, 12)) { const row = rec(item); const fields = [safeDisplayText(row.name, 48), enumText(row.scope, new Set(["global", "project"]))]; if (row.backend !== null && row.backend !== undefined) fields.push(backendText(row.backend)); if (row.isolation !== null && row.isolation !== undefined) fields.push(isolationText(row.isolation)); if (typeof row.hint === "string") fields.push(safeDisplayText(row.hint, 80)); lines.push(resultLine(fields.join(" · "), "dim", theme)); }
	return rows(lines, templates.length - Math.min(templates.length, 12), theme).join("\n");
}
export function renderModelsResult(result: unknown, options: unknown, theme: AgentToolTheme): string {
	const value = rec(result); if (value.isError) return genericError("Model listing", theme); const details = rec(value.details); const models = Array.isArray(details.models) ? details.models : []; const total = count(details.total); const warnings = Array.isArray(details.warnings) ? details.warnings.length : 0;
	const lines = [header(`✓ ${models.length}/${total} models${warnings ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`, "success", theme)];
	if (!optionsExpanded(options)) return lines.join("\n");
	for (const item of models.slice(0, 12)) { const row = rec(item); const current = row.current_parent === true ? " · current" : ""; lines.push(resultLine(`${backendText(row.backend)} · ${safeDisplayText(row.model, 72)}${current} · ${safeDisplayText(row.spawn_parameter, 32)}`, "dim", theme)); }
	return rows(lines, models.length - Math.min(models.length, 12), theme).join("\n");
}

function validProgress(value: unknown): RecordValue | undefined {
	const p = rec(value); const c = rec(p.counts);
	if (p.v !== 1 || (p.mode !== "one" && p.mode !== "all") || !Array.isArray(p.agents) || typeof p.elapsedMs !== "number" || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0) return undefined;
	if (!["total", "queued", "active", "settled", "permissionPending"].every((key) => typeof c[key] === "number" && Number.isFinite(c[key]) && (c[key] as number) >= 0)) return undefined;
	return p;
}
function usage(row: RecordValue): string { if (backendText(row.backend) !== "pi") return "usage —"; const metrics = rec(row.metrics); return typeof metrics.totalTokens === "number" && Number.isFinite(metrics.totalTokens) && metrics.totalTokens >= 0 ? `usage ${formatCompactTokens(metrics.totalTokens)}` : "usage —"; }
export function renderWaitProgress(value: unknown, _options: unknown, theme: AgentToolTheme): string {
	const p = validProgress(value); if (!p) return header("Waiting · —", "dim", theme); const c = rec(p.counts); const seconds = Math.floor((p.elapsedMs as number) / 1000); const progressHeader = `${BRAILLE[seconds % BRAILLE.length]} Waiting ${count(c.settled)}/${count(c.total)} settled · ${count(c.active)} active · ${count(c.queued)} queued${count(c.permissionPending) ? ` · ${count(c.permissionPending)} approval` : ""} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	const agents = p.agents as unknown[]; const lines = [`${theme.fg("accent", progressHeader.slice(0, 1))}${theme.fg("dim", progressHeader.slice(1))}`];
	const max = 8;
	for (const entry of agents.slice(0, max)) { const row = rec(entry); const status = statusText(row.status); const detail = typeof row.queuePosition === "number" && Number.isFinite(row.queuePosition) && row.queuePosition >= 0 ? `queue #${Math.floor(row.queuePosition)}` : safeDisplayText(row.activity, 64); lines.push(resultLine(`${statusIcon(status)} ${safeDisplayText(row.agentName, 48)} · ${backendText(row.backend)} · ${status} · ${detail} · ${usage(row)}`, statusColor(status), theme)); }
	return rows(lines, agents.length - Math.min(agents.length, max), theme).join("\n");
}
function permissionSummary(value: unknown): string {
	return safeDisplayText(value, 120, "Permission details unavailable").replace(/\b(token|secret|password|authorization)\s*[=:]\s*[^\s,&;]+/gi, "$1=[REDACTED]");
}
export function renderPermissionCard(message: unknown, theme: AgentToolTheme): string {
	const d = rec(rec(message).details); const name = safeDisplayText(d.agentName, 48, "Subagent"); const summary = permissionSummary(d.summary); return `${header(`⚿ ${name} permission required`, "warning", theme)}\n${resultLine(summary, "dim", theme)}`;
}
export function renderWaitResult(result: unknown, options: unknown, theme: AgentToolTheme): string {
	const value = rec(result); if (value.isError) return genericError("Wait", theme); const details = rec(value.details); if (optionsExpanded(options) || rec(options).isPartial) { if (Object.hasOwn(details, "wait_progress")) return renderWaitProgress(details.wait_progress, options, theme); }
	if (details.kind === "permission") return renderPermissionCard({ details }, theme);
	if (details.kind === "completion") return renderCompletionMessage({ details: details as CompletionRenderDetails }, optionsExpanded(options) ? { expanded: true } : { expanded: false }, theme);
	return resultLine("Wait complete", "success", theme);
}
export function renderWaitAllResult(result: unknown, options: unknown, theme: AgentToolTheme): string {
	const value = rec(result); if (value.isError) return genericError("Wait", theme); const details = rec(value.details); if (rec(options).isPartial || Object.hasOwn(details, "wait_progress")) return renderWaitProgress(details.wait_progress, options, theme); if (details.kind === "permission") return renderPermissionCard({ details }, theme);
	const responses = Array.isArray(details.responses) ? details.responses : []; const histogram = new Map<string, number>(); for (const item of responses) { const status = statusText(rec(item).status); histogram.set(status, (histogram.get(status) ?? 0) + 1); }
	const summary = [...histogram.entries()].map(([s, n]) => `${n} ${s}`).join(" · ") || "0 agents"; const lines = [header(`✓ ${responses.length} agents · ${summary}`, "success", theme)];
	if (!optionsExpanded(options)) return lines.join("\n"); for (const item of responses.slice(0, 12)) { const row = rec(item); const status = statusText(row.status); lines.push(resultLine(`${statusIcon(status)} ${safeDisplayText(row.agent_name, 48)} · ${backendText(row.backend)} · ${status}`, statusColor(status), theme)); } return rows(lines, responses.length - Math.min(responses.length, 12), theme).join("\n");
}
export function renderAgentsResult(result: unknown, options: unknown, theme: AgentToolTheme): string {
	const value = rec(result); if (value.isError) return genericError("Agent listing", theme); const agents = Array.isArray(rec(value.details).agents) ? rec(value.details).agents as unknown[] : []; const histogram = new Map<string, number>(); for (const item of agents) { const status = statusText(rec(item).agent_status); histogram.set(status, (histogram.get(status) ?? 0) + 1); } const summary = [...histogram.entries()].map(([s, n]) => `${n} ${s}`).join(" · ") || "0 agents"; const lines = [header(`✓ ${agents.length} agents · ${summary}`, "success", theme)];
	if (!optionsExpanded(options)) return lines.join("\n");
	for (const item of agents.slice(0, 12)) { const row = rec(item); const status = statusText(row.agent_status); const fields = [safeDisplayText(row.agent_name, 48), backendText(row.backend), status, safeDisplayText(row.model, 64)]; for (const value of [row.activity_summary ?? row.current_activity, row.elapsed, row.terminal_reason]) { const text = safeDisplayText(value, 64, ""); if (text) fields.push(text); } const wt = rec(row.worktree); if (wt.phase !== undefined) { const phase = enumText(wt.phase, WORKTREE_PHASE); const reason = wt.reason === undefined ? undefined : enumText(wt.reason, WORKTREE_REASON); fields.push(`worktree ${phase}${reason === undefined ? "" : ` · ${reason}`}`); } lines.push(resultLine(`${statusIcon(status)} ${fields.join(" · ")}`, statusColor(status), theme)); }
	return rows(lines, agents.length - Math.min(agents.length, 12), theme).join("\n");
}
function outputLines(output: unknown): string[] { return typeof output === "string" ? output.split(/\r?\n/).map((line) => safeDisplayText(line, 160, "")).filter(Boolean) : []; }
export function renderReadResult(result: unknown, options: unknown, theme: AgentToolTheme): string { const value = rec(result); if (value.isError) return genericError("Read", theme); const details = rec(value.details); const output = outputLines(details.output); const lines = [header(`✓ ${safeDisplayText(details.agent_name, 48)} · ${statusText(details.status)}`, "success", theme)]; if (optionsExpanded(options)) { for (const item of output.slice(0, 30)) lines.push(resultLine(item, "customMessageText", theme)); rows(lines, output.length - Math.min(output.length, 30), theme); } else lines.push(resultLine(output[0] ?? "No output", "dim", theme)); if (details.truncated === true) lines.push(resultLine("Output truncated", "muted", theme)); return lines.join("\n"); }
export function renderSendResult(result: unknown, theme: AgentToolTheme): string { const value = rec(result); if (value.isError) return genericError("Send", theme); const delivery = enumText(rec(value.details).delivery, DELIVERY); const text = delivery === "steer" ? "Delivered · steer" : delivery === "cancel-and-prompt" ? "Cursor turn replaced" : delivery === "prompt" ? "New turn queued" : "—"; return resultLine(text, delivery === "—" ? "muted" : "success", theme); }
export function renderInterruptResult(result: unknown, theme: AgentToolTheme): string { const value = rec(result); if (value.isError) return genericError("Interrupt", theme); const d = rec(value.details); return resultLine(`Interrupted · previously ${statusText(d.previous_status)}`, "warning", theme); }
export function renderCloseResult(result: unknown, theme: AgentToolTheme): string { const value = rec(result); if (value.isError) return genericError("Close", theme); const d = rec(value.details); const lines = [resultLine(`Closed · previously ${statusText(d.previous_status)}`, "muted", theme)]; const wt = rec(d.worktree); if (wt.phase !== undefined) { const phase = enumText(wt.phase, WORKTREE_PHASE); const reason = wt.reason === undefined ? undefined : enumText(wt.reason, WORKTREE_REASON); lines.push(resultLine(`Worktree ${phase}${reason === undefined ? "" : ` · ${reason}`}`, "muted", theme)); } return lines.join("\n"); }
export function renderPermissionResult(result: unknown, theme: AgentToolTheme): string { const value = rec(result); if (value.isError) return genericError("Permission", theme); const decision = enumText(rec(value.details).decision, DECISION); return resultLine(decision === "approve" ? "Approved once" : decision === "reject" ? "Rejected" : "—", decision === "approve" ? "success" : decision === "reject" ? "warning" : "muted", theme); }
