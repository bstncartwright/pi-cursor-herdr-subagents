import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUnifiedSubagents } from "./unified.ts";

export default function bstnSubagents(pi: ExtensionAPI): void {
	registerUnifiedSubagents(pi);
}
