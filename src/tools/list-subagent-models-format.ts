import type {
  ListSubagentModelsBackend,
  ListSubagentModelsDetails,
  ListSubagentModelsLookupMatch,
  ListSubagentModelsPiEntry,
  ListSubagentModelsCursorEntry,
} from "#src/tools/list-subagent-models-details";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;

export function resolveListSubagentModelsLimit(limit?: number): number {
  if (limit == null || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limit)));
}

/** Normalize harmless separators/punctuation for case-insensitive matching. */
export function normalizeModelQuery(text: string): string {
  return text.toLowerCase().replace(/[\s_\-./[\]=,+:[\]]+/g, "");
}

export function extractQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s_\-./[\]=,+:[\]]+/)
    .map((part) => normalizeModelQuery(part))
    .filter((token) => token.length >= 2 || /\d/.test(token));
}

export function matchesModelQuery(query: string, ...targets: string[]): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  const normalizedQuery = normalizeModelQuery(trimmed);
  const normalizedTargets = targets.map((target) => normalizeModelQuery(target));
  const combined = normalizedTargets.join("");

  if (normalizedQuery.length >= 2) {
    if (normalizedTargets.some((target) => target.includes(normalizedQuery))) return true;
    if (combined.includes(normalizedQuery)) return true;
  }

  const tokens = extractQueryTokens(trimmed);
  if (tokens.length === 0) return false;
  return tokens.every((token) => combined.includes(token));
}

export function filterPiModels(
  models: readonly ListSubagentModelsPiEntry[],
  query: string,
): ListSubagentModelsLookupMatch[] {
  return models
    .filter((model) => matchesModelQuery(query, model.value, model.id, model.displayName, model.provider))
    .map((model) => ({
      backend: "pi" as const,
      name: model.displayName,
      value: model.value,
    }));
}

export function filterCursorModels(
  models: readonly ListSubagentModelsCursorEntry[],
  query: string,
): ListSubagentModelsLookupMatch[] {
  return models
    .filter((model) => matchesModelQuery(query, model.name, model.value))
    .map((model) => ({
      backend: "cursor" as const,
      name: model.name,
      value: model.value,
    }));
}

export function capLookupMatchesPerBackend(
  matches: readonly ListSubagentModelsLookupMatch[],
  limit: number,
): {
  shown: ListSubagentModelsLookupMatch[];
  shownCount: number;
  piMatchCount: number;
  cursorMatchCount: number;
  shownPiCount: number;
  shownCursorCount: number;
} {
  const piMatches = matches.filter((match) => match.backend === "pi");
  const cursorMatches = matches.filter((match) => match.backend === "cursor");
  const shownPi = piMatches.slice(0, limit);
  const shownCursor = cursorMatches.slice(0, limit);
  return {
    shown: [...shownPi, ...shownCursor],
    shownCount: shownPi.length + shownCursor.length,
    piMatchCount: piMatches.length,
    cursorMatchCount: cursorMatches.length,
    shownPiCount: shownPi.length,
    shownCursorCount: shownCursor.length,
  };
}

function formatBrowsePiSection(details: ListSubagentModelsDetails): string {
  const pi = details.pi;
  if (!pi) return "";

  if (pi.unavailable) {
    return `Pi: unavailable (${pi.unavailableReason ?? "unknown"})`;
  }

  if (pi.total === 0) {
    return "Pi (0): none";
  }

  const limit = details.limit;
  const shown = pi.models.slice(0, limit);
  const truncated = pi.total > shown.length;
  const countLabel = truncated ? `${pi.total}, showing ${shown.length}` : String(pi.total);
  const values = shown.map((model) => model.value).join(", ");
  return `Pi (${countLabel}): ${values}`;
}

function formatBrowseCursorSection(details: ListSubagentModelsDetails): string {
  const cursor = details.cursor;
  if (!cursor) return "";

  if (cursor.warning && cursor.total === 0) {
    return "";
  }

  if (cursor.total === 0) {
    return "Cursor (0): none";
  }

  const limit = details.limit;
  const shown = cursor.models.slice(0, limit);
  const truncated = cursor.total > shown.length;
  const current = cursor.models.find((model) => model.current)?.name;
  const countParts = [truncated ? `${cursor.total}, showing ${shown.length}` : String(cursor.total)];
  if (current) countParts.push(`current ${current}`);
  const names = shown.map((model) => model.name).join(", ");
  return `Cursor (${countParts.join(", ")}): ${names}`;
}

function browseHints(details: ListSubagentModelsDetails): string[] {
  const hints: string[] = [];
  const includePi = details.backend !== "cursor";
  const includeCursor = details.backend !== "pi";
  const piTruncated = includePi && details.pi && !details.pi.unavailable && details.pi.total > details.limit;
  const cursorIncluded = includeCursor && !!details.cursor && !details.cursor.warning && details.cursor.total > 0;

  if (cursorIncluded) {
    hints.push('For exact Cursor values: list_subagent_models({ backend: "cursor", query: "<name>" }).');
  }
  if (piTruncated) {
    hints.push('Search Pi models: list_subagent_models({ backend: "pi", query: "<name>" }).');
  }
  return hints;
}

export function formatBrowseContent(details: ListSubagentModelsDetails): string {
  const sections: string[] = [];
  const piSection = formatBrowsePiSection(details);
  const cursorSection = formatBrowseCursorSection(details);
  if (piSection) sections.push(piSection);
  if (cursorSection) sections.push(cursorSection);
  if (details.warnings.length > 0) sections.push(...details.warnings.map((warning) => `Warning: ${warning}`));

  sections.push(...browseHints(details));
  return sections.join("\n");
}

function lookupSectionLabel(
  backend: ListSubagentModelsBackend | undefined,
  matchCount: number,
  catalogCount: number,
  shownCount?: number,
): string {
  const scope = backend ?? "models";
  const capped = shownCount != null && shownCount < matchCount;
  const matchLabel = `${matchCount} match${matchCount === 1 ? "" : "es"} of ${catalogCount}`;
  return capped
    ? `${scope} (${matchLabel}, showing ${shownCount})`
    : `${scope} (${matchLabel})`;
}

function lookupInvocationHint(
  backend: ListSubagentModelsBackend | undefined,
  matches: readonly ListSubagentModelsLookupMatch[],
): string | undefined {
  if (matches.length === 0) return undefined;

  const backends = new Set(matches.map((match) => match.backend));
  if (backend === "pi" || (backends.size === 1 && backends.has("pi"))) {
    return 'subagent({ model: "<provider/id>", subagent_type: "general-purpose", prompt: "...", description: "..." })';
  }
  if (backend === "cursor" || (backends.size === 1 && backends.has("cursor"))) {
    return 'subagent({ backend: "cursor", cursor_model: "<exact value>", subagent_type: "general-purpose", prompt: "...", description: "..." })';
  }
  return 'Pi: subagent({ model: "<provider/id>", ... }). Cursor: subagent({ backend: "cursor", cursor_model: "<exact value>", ... }).';
}

export function formatLookupContent(details: ListSubagentModelsDetails): string {
  const lookup = details.lookup;
  if (!lookup) return formatBrowseContent(details);

  const lines: string[] = [];
  if (lookup.matchCount === 0) {
    lines.push(`${lookupSectionLabel(details.backend, 0, lookup.catalogCount)}`);
    lines.push("Broaden query or omit query to browse.");
    if (details.warnings.length > 0) lines.push(...details.warnings.map((warning) => `Warning: ${warning}`));
    return lines.join("\n");
  }

  const capped = capLookupMatchesPerBackend(lookup.matches, details.limit);
  lines.push(lookupSectionLabel(
    details.backend,
    lookup.matchCount,
    lookup.catalogCount,
    capped.shownCount < lookup.matchCount ? capped.shownCount : undefined,
  ));
  for (const match of capped.shown) {
    lines.push(`${match.name} → ${match.value}`);
  }
  const hint = lookupInvocationHint(details.backend, lookup.matches);
  if (hint) lines.push(hint);
  if (details.warnings.length > 0) lines.push(...details.warnings.map((warning) => `Warning: ${warning}`));
  return lines.join("\n");
}

export function formatListSubagentModelsContent(details: ListSubagentModelsDetails): string {
  return details.mode === "lookup" ? formatLookupContent(details) : formatBrowseContent(details);
}
