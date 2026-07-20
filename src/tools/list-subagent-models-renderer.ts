import type { ListSubagentModelsDetails } from "#src/tools/list-subagent-models-details";
import { formatListSubagentModelsContent } from "#src/tools/list-subagent-models-format";
import type { Theme } from "#src/ui/display";

const EXPANDED_MODEL_CAP = 40;

function renderExpandedPi(details: ListSubagentModelsDetails, theme: Theme): string[] {
  const pi = details.pi;
  if (!pi) return [];

  const lines = [theme.fg("accent", "Pi models")];
  if (pi.unavailable) {
    lines.push(theme.fg("warning", `  unavailable: ${pi.unavailableReason ?? "unknown"}`));
    return lines;
  }

  lines.push(theme.fg("dim", `  total ${pi.total}`));
  for (const model of pi.models.slice(0, EXPANDED_MODEL_CAP)) {
    lines.push(theme.fg("text", `  ${model.displayName} → ${model.value}`));
  }
  if (pi.total > EXPANDED_MODEL_CAP) {
    lines.push(theme.fg("muted", `  … ${pi.total - EXPANDED_MODEL_CAP} more`));
  }
  return lines;
}

function renderExpandedCursor(details: ListSubagentModelsDetails, theme: Theme): string[] {
  const cursor = details.cursor;
  if (!cursor) return [];

  const lines = [theme.fg("accent", "Cursor models")];
  if (cursor.warning) lines.push(theme.fg("warning", `  warning: ${cursor.warning}`));
  lines.push(theme.fg("dim", `  total ${cursor.total}`));

  for (const model of cursor.models.slice(0, EXPANDED_MODEL_CAP)) {
    const current = model.current ? theme.fg("success", " current") : "";
    const group = model.group ? theme.fg("muted", ` · group ${model.group.name} (${model.group.id})`) : "";
    lines.push(
      theme.fg("text", `  ${model.name} → ${model.value}`) + current + group,
    );
  }
  if (cursor.total > EXPANDED_MODEL_CAP) {
    lines.push(theme.fg("muted", `  … ${cursor.total - EXPANDED_MODEL_CAP} more`));
  }
  return lines;
}

function renderExpandedLookup(details: ListSubagentModelsDetails, theme: Theme): string[] {
  const lookup = details.lookup;
  if (!lookup || lookup.matchCount === 0) return [];

  const lines = [
    theme.fg("accent", `Lookup (${lookup.matchCount} of ${lookup.catalogCount})`),
  ];
  for (const match of lookup.matches.slice(0, EXPANDED_MODEL_CAP)) {
    lines.push(theme.fg("text", `  [${match.backend}] ${match.name} → ${match.value}`));
  }
  if (lookup.matchCount > EXPANDED_MODEL_CAP) {
    lines.push(theme.fg("muted", `  … ${lookup.matchCount - EXPANDED_MODEL_CAP} more`));
  }
  return lines;
}

/** Collapsed TUI mirrors compact LLM-visible content; expanded shows full catalogs. */
export function renderListSubagentModelsResult(
  details: ListSubagentModelsDetails,
  expanded: boolean,
  theme: Theme,
): string {
  if (!expanded) {
    return formatListSubagentModelsContent(details);
  }

  const lines = [
    theme.fg("toolTitle", theme.bold("Subagent models")),
    theme.fg("dim", `mode ${details.mode}${details.backend ? ` · backend ${details.backend}` : ""}${details.query ? ` · query ${details.query}` : ""}`),
    "",
    ...renderExpandedPi(details, theme),
  ];

  const cursorLines = renderExpandedCursor(details, theme);
  if (cursorLines.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...cursorLines);
  }

  const lookupLines = renderExpandedLookup(details, theme);
  if (lookupLines.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...lookupLines);
  }

  if (details.warnings.length > 0) {
    lines.push("");
    for (const warning of details.warnings) {
      lines.push(theme.fg("warning", `Warning: ${warning}`));
    }
  }

  return lines.join("\n");
}
