import type { DiscoveredCursorModel } from "#src/cursor/discover-cursor-models";
import type { ModelRegistry } from "#src/session/model-resolver";

export type ListSubagentModelsBackend = "pi" | "cursor";
export type ListSubagentModelsMode = "browse" | "lookup";

export interface ListSubagentModelsPiEntry {
  provider: string;
  id: string;
  /** Exact Pi spawn value: provider/id */
  value: string;
  displayName: string;
}

export interface ListSubagentModelsCursorEntry {
  name: string;
  value: string;
  current: boolean;
  group?: { id: string; name: string };
}

export interface ListSubagentModelsLookupMatch {
  backend: ListSubagentModelsBackend;
  name: string;
  value: string;
}

export interface ListSubagentModelsDetails {
  mode: ListSubagentModelsMode;
  backend?: ListSubagentModelsBackend;
  query?: string;
  limit: number;
  pi?: {
    total: number;
    shown?: number;
    unavailable?: boolean;
    unavailableReason?: string;
    models: ListSubagentModelsPiEntry[];
  };
  cursor?: {
    total: number;
    shown?: number;
    warning?: string;
    models: ListSubagentModelsCursorEntry[];
  };
  lookup?: {
    matchCount: number;
    catalogCount: number;
    matches: ListSubagentModelsLookupMatch[];
    shownCount?: number;
    piMatchCount?: number;
    cursorMatchCount?: number;
    shownPiCount?: number;
    shownCursorCount?: number;
  };
  warnings: string[];
}

export interface ListSubagentModelsLookupStats {
  shownCount: number;
  piMatchCount: number;
  cursorMatchCount: number;
  shownPiCount: number;
  shownCursorCount: number;
}

export interface BuildListSubagentModelsDetailsInput {
  mode: ListSubagentModelsMode;
  backend?: ListSubagentModelsBackend;
  query?: string;
  limit: number;
  registry?: ModelRegistry;
  cursorModels?: readonly DiscoveredCursorModel[];
  cursorWarning?: string;
  lookupMatches?: ListSubagentModelsLookupMatch[];
  lookupCatalogCount?: number;
  lookupStats?: ListSubagentModelsLookupStats;
}

export function buildPiCatalog(registry: ModelRegistry | undefined): {
  unavailable: boolean;
  unavailableReason?: string;
  models: ListSubagentModelsPiEntry[];
} {
  if (!registry) {
    return {
      unavailable: true,
      unavailableReason: "no model registry in the active session",
      models: [],
    };
  }

  const models = (registry.getAvailable?.() ?? registry.getAll())
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      value: `${model.provider}/${model.id}`,
      displayName: model.name,
    }))
    .sort((left, right) => left.value.localeCompare(right.value));

  return { unavailable: false, models };
}

export function buildCursorCatalog(models: readonly DiscoveredCursorModel[]): ListSubagentModelsCursorEntry[] {
  return models.map((model) => ({
    name: model.name,
    value: model.value,
    current: model.current,
    group: model.group,
  }));
}

export function buildListSubagentModelsDetails(
  input: BuildListSubagentModelsDetailsInput,
): ListSubagentModelsDetails {
  const warnings = input.cursorWarning ? [input.cursorWarning] : [];
  const details: ListSubagentModelsDetails = {
    mode: input.mode,
    backend: input.backend,
    query: input.query,
    limit: input.limit,
    warnings,
  };

  if (input.backend !== "cursor") {
    const piCatalog = buildPiCatalog(input.registry);
    details.pi = {
      total: piCatalog.models.length,
      unavailable: piCatalog.unavailable,
      unavailableReason: piCatalog.unavailableReason,
      models: piCatalog.models,
    };
    if (input.mode === "browse" && !piCatalog.unavailable) {
      details.pi.shown = Math.min(input.limit, piCatalog.models.length);
    }
  }

  if (input.backend !== "pi") {
    const cursorModels = buildCursorCatalog(input.cursorModels ?? []);
    details.cursor = {
      total: cursorModels.length,
      warning: input.cursorWarning,
      models: cursorModels,
    };
    if (input.mode === "browse") {
      details.cursor.shown = Math.min(input.limit, cursorModels.length);
    }
  }

  if (input.mode === "lookup") {
    const matches = input.lookupMatches ?? [];
    details.lookup = {
      matchCount: matches.length,
      catalogCount: input.lookupCatalogCount ?? matches.length,
      matches,
      shownCount: input.lookupStats?.shownCount,
      piMatchCount: input.lookupStats?.piMatchCount,
      cursorMatchCount: input.lookupStats?.cursorMatchCount,
      shownPiCount: input.lookupStats?.shownPiCount,
      shownCursorCount: input.lookupStats?.shownCursorCount,
    };
  }

  return details;
}
