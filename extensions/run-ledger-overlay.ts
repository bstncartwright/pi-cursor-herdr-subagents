import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import {
	buildRunLedgerPresentation,
	sanitizeResponseText,
	sanitizeTerminalText,
	type RunLedgerLine,
	type RunLedgerRole,
	type RunLedgerState,
} from "./run-ledger.ts";
import type { AgentStateSnapshot } from "./unified-deps.ts";

export interface LedgerOverlaySource {
	readonly readOnly: boolean;
	getAgent(): AgentStateSnapshot | undefined;
	getLedger(): RunLedgerState | undefined;
	subscribe(listener: () => void): () => void;
	send(message: string): Promise<unknown>;
	interrupt(): Promise<unknown>;
	readRawDiagnostics(): string[];
}

export type LedgerOverlayResult = "previous" | "next" | undefined;
const STOP_ARM_MS = 2_000;
const ROLE_COLORS: Partial<Record<RunLedgerRole, Parameters<Theme["fg"]>[0]>> = {
	identity: "accent", state: "warning", elapsed: "dim", turn: "dim", muted: "dim", task: "text",
	timestamp: "dim", thought: "accent", response: "text", tool: "toolTitle", success: "success",
	warning: "warning", error: "error", completion: "success",
};

function colorLine(line: RunLedgerLine, theme: Theme): string {
	return line.tokens.map((token) => theme.fg(ROLE_COLORS[token.role] ?? "text", token.text)).join("");
}
function isTerminal(status: AgentStateSnapshot["status"]): boolean { return ["completed", "failed", "interrupted", "paused", "closed"].includes(status); }
function sendLabel(agent: AgentStateSnapshot): string | undefined {
	if (agent.status === "running") return agent.backend === "pi" ? "Steer Pi — current turn" : "Correct Cursor — replaces current turn";
	if (["completed", "failed", "interrupted", "paused"].includes(agent.status)) return "Follow up — queues a new turn";
	return undefined;
}

/** Native, semantic-only Run Ledger overlay. Raw diagnostics require an explicit double confirmation. */
export class RunLedgerOverlay implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly source: LedgerOverlaySource;
	private readonly done: (result: LedgerOverlayResult) => void;
	private readonly now: () => number;
	private _focused = false;
	private disposed = false;
	private unsubscribe?: () => void;
	private tick?: ReturnType<typeof setInterval>;
	private stopTimer?: ReturnType<typeof setTimeout>;
	private composer?: Input;
	private sending = false;
	private actionError?: string;
	private stopArmed = false;
	private stopping = false;
	private rawConfirm = false;
	private rawActive = false;
	private rawLines: string[] = [];
	private scrollBack = 0;
	private unseen = 0;
	private blockKeys: string[] = [];
	private agent?: AgentStateSnapshot;
	private ledger?: RunLedgerState;
	private lastWidth = 80;
	private generation = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		source: LedgerOverlaySource,
		done: (result: LedgerOverlayResult) => void,
		now: () => number = Date.now,
	) {
		this.tui = tui; this.theme = theme; this.keybindings = keybindings; this.source = source; this.done = done; this.now = now;
		this.refresh(true);
		this.unsubscribe = source.subscribe(() => this.refresh(false));
		this.tick = setInterval(() => { if (!this.disposed) this.tui.requestRender(); }, 1_000);
		this.tick.unref?.();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; if (this.composer) this.composer.focused = value; }

	private refresh(initial: boolean): void {
		if (this.disposed) return;
		const agent = this.source.getAgent();
		const ledger = this.source.getLedger(); this.agent = agent; this.ledger = ledger;
		const keys = ledger ? buildRunLedgerPresentation(ledger, { width: Math.max(1, this.lastWidth - 4), now: this.now() }).blocks.map((block) => block.key) : [];
		if (!initial && this.scrollBack > 0) {
			const previous = new Set(this.blockKeys); const added = keys.filter((key) => !previous.has(key)).length;
			this.unseen += added; this.scrollBack = Math.min(keys.length, this.scrollBack + added);
		}
		this.blockKeys = keys;
		if (agent && isTerminal(agent.status)) this.disarmStop();
		this.tui.requestRender();
	}

	private close(result?: Exclude<LedgerOverlayResult, undefined>): void { if (this.disposed) return; this.dispose(); this.done(result); }
	private disarmStop(): void { this.stopArmed = false; if (this.stopTimer) clearTimeout(this.stopTimer); this.stopTimer = undefined; }
	private armStop(): void {
		this.stopArmed = true; if (this.stopTimer) clearTimeout(this.stopTimer);
		this.stopTimer = setTimeout(() => { this.stopArmed = false; this.stopTimer = undefined; this.tui.requestRender(); }, STOP_ARM_MS);
		this.stopTimer.unref?.();
	}

	private openComposer(agent: AgentStateSnapshot): void {
		if (this.source.readOnly || !sendLabel(agent) || this.sending || this.stopping) return;
		this.actionError = undefined; this.disarmStop(); this.rawConfirm = false;
		const input = new Input(); input.focused = this.focused;
		input.onSubmit = (value) => { const message = value.trim(); if (message) void this.submit(message); };
		input.onEscape = () => { if (this.sending) return; this.composer = undefined; this.tui.requestRender(); };
		this.composer = input; this.tui.requestRender();
	}
	private async submit(message: string): Promise<void> {
		if (this.sending || this.disposed) return; this.sending = true; this.actionError = undefined; const generation = this.generation; this.tui.requestRender();
		try { await this.source.send(message); if (!this.disposed && generation === this.generation) this.composer = undefined; }
		catch (error) { if (!this.disposed && generation === this.generation) this.actionError = sanitizeTerminalText(sanitizeResponseText(error instanceof Error ? error.message : String(error), 180), 180) || "Send failed"; }
		finally { if (!this.disposed && generation === this.generation) { this.sending = false; this.tui.requestRender(); } }
	}
	private async confirmStop(): Promise<void> {
		if (this.stopping || this.disposed) return; this.disarmStop(); this.stopping = true; this.actionError = undefined; const generation = this.generation; this.tui.requestRender();
		try { await this.source.interrupt(); }
		catch (error) { if (!this.disposed && generation === this.generation) this.actionError = sanitizeTerminalText(sanitizeResponseText(error instanceof Error ? error.message : String(error), 180), 180) || "Interrupt failed"; }
		finally { if (!this.disposed && generation === this.generation) { this.stopping = false; this.tui.requestRender(); } }
	}

	handleInput(data: string): void {
		if (this.composer && this.sending) {
			if (matchesKey(data, "escape") || data === "q") this.close();
			else if (matchesKey(data, "left")) this.close("previous");
			else if (matchesKey(data, "right")) this.close("next");
			return;
		}
		if (this.composer) { this.composer.handleInput(data); this.tui.requestRender(); return; }
		const agent = this.agent;
		if (matchesKey(data, "escape") || data === "q") { this.close(); return; }
		if (matchesKey(data, "left")) { this.close("previous"); return; }
		if (matchesKey(data, "right")) { this.close("next"); return; }
		if (matchesKey(data, "return") && agent) { this.openComposer(agent); return; }
		if (data === "x" && agent && !this.source.readOnly && ["queued", "starting", "running"].includes(agent.status)) {
			this.rawConfirm = false; if (this.stopArmed) void this.confirmStop(); else this.armStop(); this.tui.requestRender(); return;
		}
		if (data === "r") {
			this.disarmStop();
			if (this.rawActive) { this.rawActive = false; this.rawLines = []; }
			else if (this.rawConfirm) { this.rawConfirm = false; this.rawActive = true; this.rawLines = this.source.readRawDiagnostics(); }
			else this.rawConfirm = true;
			this.tui.requestRender(); return;
		}
		this.disarmStop(); this.rawConfirm = false;
		const page = Math.max(1, Math.floor(this.tui.terminal.rows / 3));
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") this.scrollBack = Math.min(this.blockKeys.length, this.scrollBack + 1);
		else if (this.keybindings.matches(data, "tui.select.down") || data === "j") this.scrollBack = Math.max(0, this.scrollBack - 1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scrollBack = Math.min(this.blockKeys.length, this.scrollBack + page);
		else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scrollBack = Math.max(0, this.scrollBack - page);
		else if (matchesKey(data, "home") || data === "g") this.scrollBack = this.blockKeys.length;
		else if (matchesKey(data, "end") || data === "G") { this.scrollBack = 0; this.unseen = 0; }
		if (this.scrollBack === 0) this.unseen = 0; this.tui.requestRender();
	}

	private row(content: string, inner: number): string { const text = truncateToWidth(content, inner); return `${this.theme.fg("border", "│")} ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${this.theme.fg("border", "│")}`; }
	render(width: number): string[] {
		this.lastWidth = Math.max(1, width); const agent = this.agent; const ledger = this.ledger;
		if (width < 6) return [truncateToWidth(agent?.agentName ?? "Ledger", width)];
		const terminalBudget = Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
		if (terminalBudget < 5) return [truncateToWidth(`${agent?.agentName ?? "Ledger"} · ${agent?.status ?? "unavailable"}`, width)];
		const inner = Math.max(1, width - 4); const maxRows = terminalBudget;
		const top = this.theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`); const bottom = this.theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
		const actionRows = this.composer ? 2 : 1; const errorRows = this.actionError ? 1 : 0; const contentBudget = Math.max(1, maxRows - 2 - actionRows - errorRows);
		const content: string[] = [];
		if (this.rawActive) {
			content.push(this.theme.fg("error", "RAW DIAGNOSTICS — may contain prompts, reasoning, commands, output, paths, and secrets"));
			content.push(...this.rawLines.slice(-Math.max(0, contentBudget - 1)).map((line) => this.theme.fg("dim", line)));
		} else if (!ledger) content.push(this.theme.fg("warning", `${agent?.agentName ?? "Agent"} · ${agent?.status ?? "unavailable"} · Semantic Run Ledger unavailable. Press r twice for raw diagnostics.`));
		else {
			const presentation = buildRunLedgerPresentation(ledger, { width: inner, now: this.now() });
			const footerReserve = presentation.footer ? 1 : 0; const stickyLimit = Math.max(1, contentBudget - footerReserve);
			const sticky = presentation.sticky.slice(0, stickyLimit).map((line) => colorLine(line, this.theme)); content.push(...sticky);
			let remaining = Math.max(0, contentBudget - sticky.length - footerReserve); const end = Math.max(0, presentation.blocks.length - this.scrollBack); const selected: RunLedgerLine[][] = [];
			for (let index = end - 1; index >= 0 && remaining > 0; index--) { const lines = presentation.blocks[index]!.lines; if (lines.length <= remaining) { selected.unshift(lines); remaining -= lines.length; } else if (!selected.length) { selected.unshift(lines.slice(-remaining)); remaining = 0; } }
			content.push(...selected.flat().map((line) => colorLine(line, this.theme))); if (presentation.footer) content.push(colorLine(presentation.footer, this.theme));
		}
		if (!this.rawActive && agent?.permissionPending && !ledger?.permission) content.unshift(this.theme.fg("warning", "Awaiting parent-agent approval"));
		if (this.rawConfirm && !this.rawActive) content.unshift(this.theme.fg("warning", "Raw diagnostics may expose prompts, reasoning, commands, output, paths, and secrets. Press r again to open."));
		while (content.length < contentBudget) content.push("");
		const lines = [top, ...content.slice(0, contentBudget).map((line) => this.row(line, inner))];
		if (this.actionError) lines.push(this.row(this.theme.fg("error", `Action failed · ${this.actionError}`), inner));
		if (this.composer) { lines.push(this.row(this.composer.render(inner)[0] ?? "", inner)); lines.push(this.row(this.theme.fg("dim", `${this.sending ? "Sending…" : agent ? sendLabel(agent) ?? "Message" : "Message"} · Enter send · Esc cancel`), inner)); }
		else {
			const actions = [agent && sendLabel(agent) && !this.source.readOnly ? "Enter message" : undefined, agent && ["queued", "starting", "running"].includes(agent.status) && !this.source.readOnly ? (this.stopArmed ? "x again to STOP" : this.stopping ? "Stopping…" : "x stop") : undefined, this.rawActive ? "r semantic" : this.rawConfirm ? "r again RAW" : "r raw", this.unseen ? `${this.unseen} new · G follow` : undefined, "←/→ agent", "j/k scroll", "q close"].filter(Boolean).join(" · ");
			lines.push(this.row(this.theme.fg(this.stopArmed || this.rawConfirm ? "warning" : "dim", actions), inner));
		}
		lines.push(bottom); return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void { this.composer?.invalidate(); }
	dispose(): void {
		if (this.disposed) return; this.disposed = true; this.generation++; this.unsubscribe?.(); this.unsubscribe = undefined;
		if (this.tick) clearInterval(this.tick); this.tick = undefined; this.disarmStop(); this.composer = undefined; this.rawLines = [];
	}
}
