import type { AgentToolResult, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  discoverCursorModels,
  type DiscoverCursorModelsOptions,
  type DiscoveredCursorModel,
} from "#src/cursor/discover-cursor-models";
import {
  buildListSubagentModelsDetails,
  type ListSubagentModelsDetails,
} from "#src/tools/list-subagent-models-details";
import {
  capLookupMatchesPerBackend,
  filterCursorModels,
  filterPiModels,
  formatListSubagentModelsContent,
  resolveListSubagentModelsLimit,
} from "#src/tools/list-subagent-models-format";
import { renderListSubagentModelsResult } from "#src/tools/list-subagent-models-renderer";
import type { ModelRegistry } from "#src/session/model-resolver";
import type { Theme } from "#src/ui/display";

type BackendFilter = "pi" | "cursor";
type CursorModelDiscoverer = (options: DiscoverCursorModelsOptions) => Promise<DiscoveredCursorModel[]>;

export interface ListSubagentModelsToolDeps {
  discoverCursorModels?: CursorModelDiscoverer;
}

/**
 * Parent-only discovery tool. Pi choices come from the current authenticated
 * registry; Cursor choices come from a newly negotiated, disposable ACP session.
 */
export class ListSubagentModelsTool {
  private readonly discoverCursorModels: CursorModelDiscoverer;

  constructor(private readonly deps: ListSubagentModelsToolDeps = {}) {
    this.discoverCursorModels = deps.discoverCursorModels ?? discoverCursorModels;
  }

  async execute(
    params: { backend?: BackendFilter; query?: string; limit?: number },
    signal: AbortSignal | undefined,
    ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
  ) {
    const backend = params.backend;
    const includePi = backend !== "cursor";
    const includeCursor = backend !== "pi";
    const limit = resolveListSubagentModelsLimit(params.limit);
    const rawQuery = params.query;
    const trimmedQuery = rawQuery?.trim();
    const mode = trimmedQuery ? "lookup" as const : "browse" as const;

    let cursorModels: DiscoveredCursorModel[] | undefined;
    let cursorWarning: string | undefined;

    if (includeCursor) {
      try {
        cursorModels = await this.discoverCursorModels({ cwd: ctx.cwd, signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        cursorWarning = `Cursor model discovery failed: ${errorMessage(error)}`;
      }
    }

    const piCatalog = includePi
      ? buildListSubagentModelsDetails({
          mode: "browse",
          backend: "pi",
          limit,
          registry: ctx.modelRegistry as ModelRegistry | undefined,
        }).pi
      : undefined;

    const cursorCatalog = includeCursor && cursorModels
      ? buildListSubagentModelsDetails({
          mode: "browse",
          backend: "cursor",
          limit,
          cursorModels,
        }).cursor
      : undefined;

    let lookupMatches;
    let lookupCatalogCount = 0;
    let lookupStats;
    if (mode === "lookup" && trimmedQuery) {
      const matches = [];
      if (includePi && piCatalog && !piCatalog.unavailable) {
        matches.push(...filterPiModels(piCatalog.models, trimmedQuery));
      }
      if (includeCursor && cursorCatalog) {
        matches.push(...filterCursorModels(cursorCatalog.models, trimmedQuery));
      }
      lookupMatches = matches;
      lookupCatalogCount =
        (includePi && piCatalog && !piCatalog.unavailable ? piCatalog.total : 0)
        + (includeCursor && cursorCatalog ? cursorCatalog.total : 0);
      lookupStats = capLookupMatchesPerBackend(matches, limit);
    }

    const details = buildListSubagentModelsDetails({
      mode,
      backend,
      query: mode === "lookup" ? rawQuery : undefined,
      limit,
      registry: ctx.modelRegistry as ModelRegistry | undefined,
      cursorModels,
      cursorWarning,
      lookupMatches,
      lookupCatalogCount,
      lookupStats,
    });

    return {
      content: [{ type: "text" as const, text: formatListSubagentModelsContent(details) }],
      details,
    };
  }

  toToolDefinition() {
    return defineTool({
      name: "list_subagent_models" as const,
      label: "List Subagent Models",
      promptSnippet:
        "list_subagent_models: Prefer list_subagent_models({ backend: \"cursor\", query: \"<name>\" }) for exact values; browse without query only when needed.",
      promptGuidelines: [
        "Prefer list_subagent_models({ backend: \"cursor\", query: \"<name>\" }) before spawning; use unfiltered browse only to scan choices.",
        "Reuse a returned exact value for subsequent spawns in the same task instead of rediscovering before every spawn.",
        "Do not guess Cursor model values.",
      ],
      description: `Discover models for subagents.

Prefer lookup over browse:
- list_subagent_models({ backend: "cursor", query: "Composer" }) returns compact name → exact value matches plus one spawn hint.
- Omit query to browse compactly. Cursor browse shows display names only; call again with backend + query for exact values.

Pi uses authenticated registry entries (provider/id). Cursor uses one disposable live ACP session. Omit backend to include both. limit defaults to 10 per backend section (max 20).

Reuse returned exact values for later spawns in the same task. Do not include Pi-only model, thinking, or max_turns in Cursor spawns.`,
      parameters: Type.Object({
        backend: Type.Optional(StringEnum(["pi", "cursor"] as const, {
          description: "Optional backend filter. Omit to include both Pi and Cursor.",
        })),
        query: Type.Optional(Type.String({
          description: "Case-insensitive lookup by Pi provider/id or display name, or Cursor display name or exact value.",
        })),
        limit: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "Max models per backend section in browse or lookup. Default 10.",
        })),
      }),
      renderResult(
        result: AgentToolResult<ListSubagentModelsDetails>,
        { expanded }: ToolRenderResultOptions,
        theme: Theme,
      ) {
        if (!result.details) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(text, 0, 0);
        }
        return new Text(renderListSubagentModelsResult(result.details, expanded, theme), 0, 0);
      },
      execute: (
        _toolCallId: string,
        params: { backend?: BackendFilter; query?: string; limit?: number },
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) => this.execute(params, signal, ctx),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
