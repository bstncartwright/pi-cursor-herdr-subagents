import { describe, expect, it, vi } from "vitest";
import type { ListSubagentModelsDetails } from "#src/tools/list-subagent-models-details";
import {
  filterCursorModels,
  filterPiModels,
  formatListSubagentModelsContent,
  matchesModelQuery,
  normalizeModelQuery,
  resolveListSubagentModelsLimit,
} from "#src/tools/list-subagent-models-format";
import { renderListSubagentModelsResult } from "#src/tools/list-subagent-models-renderer";
import { ListSubagentModelsTool, type ListSubagentModelsToolDeps } from "#src/tools/list-subagent-models-tool";
import { makeModel } from "#test/helpers/make-model";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function createTool(overrides: Partial<ListSubagentModelsToolDeps> = {}) {
  return new ListSubagentModelsTool({
    discoverCursorModels: vi.fn(async () => [
      { value: "auto", name: "Auto", current: true },
      { value: "composer-2.5[fast=true]", name: "Composer 2.5", current: false },
      { value: "grok-4.5[effort=high,fast=true]", name: "Grok 4.5 High", current: false, group: { id: "grok", name: "Grok" } },
    ]),
    ...overrides,
  });
}

function context() {
  return {
    cwd: "/project",
    modelRegistry: {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => [
        makeModel({ provider: "zeta", id: "last", name: "Zeta Last" }),
        makeModel({ provider: "anthropic", id: "first", name: "Anthropic First" }),
        makeModel({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }),
      ]),
    },
  };
}

async function run(
  tool: ListSubagentModelsTool,
  params: { backend?: "pi" | "cursor"; query?: string; limit?: number } = {},
  signal?: AbortSignal,
  ctx = context(),
) {
  return tool.execute(params, signal, ctx as never);
}

describe("list subagent models format helpers", () => {
  it("clamps limit defaults and bounds", () => {
    expect(resolveListSubagentModelsLimit()).toBe(10);
    expect(resolveListSubagentModelsLimit(0)).toBe(1);
    expect(resolveListSubagentModelsLimit(99)).toBe(20);
    expect(resolveListSubagentModelsLimit(3.7)).toBe(3);
  });

  it("normalizes separators for contiguous matching", () => {
    expect(normalizeModelQuery("Composer 2.5")).toBe(normalizeModelQuery("composer-2.5"));
    expect(matchesModelQuery("composer 2.5", "Composer 2.5")).toBe(true);
    expect(matchesModelQuery("gpt.5.6.sol", "openai-codex/gpt-5.6-sol")).toBe(true);
  });

  it("matches token-wise across combined Cursor name and exact value", () => {
    const matches = filterCursorModels([
      { name: "Grok 4.5 High", value: "grok-4.5[effort=high,fast=true]", current: false },
    ], "Grok 4.5 High");

    expect(matches).toEqual([
      {
        backend: "cursor",
        name: "Grok 4.5 High",
        value: "grok-4.5[effort=high,fast=true]",
      },
    ]);
  });

  it("rejects pathological punctuation-only queries", () => {
    expect(matchesModelQuery(".", "Composer 2.5")).toBe(false);
    expect(matchesModelQuery("-", "Composer 2.5")).toBe(false);
    expect(matchesModelQuery("   ", "Composer 2.5")).toBe(false);
  });
});

describe("ListSubagentModelsTool browse mode", () => {
  it("returns compact Pi and Cursor browse sections by default", async () => {
    const { content, details } = await run(createTool());

    const text = content[0]?.text ?? "";
    expect(text).toContain("Pi (3): anthropic/first, openai-codex/gpt-5.6-sol, zeta/last");
    expect(text).toContain("Cursor (3, current Auto): Auto, Composer 2.5, Grok 4.5 High");
    expect(text).toContain('list_subagent_models({ backend: "cursor", query: "<name>" })');
    expect(text).not.toContain("Auto*");
    expect(text).not.toContain("composer-2.5[fast=true]");
    expect(text).not.toContain("group:");
    expect(text).not.toContain("spawn:");
    expect(text).not.toContain("current: yes");
    expect(details?.mode).toBe("browse");
    expect(details?.pi?.models).toHaveLength(3);
    expect(details?.cursor?.models[0]?.value).toBe("auto");
  });

  it("treats whitespace-only query as browse without storing query", async () => {
    const { content, details } = await run(createTool(), { query: "   " });
    expect(details?.mode).toBe("browse");
    expect(details?.query).toBeUndefined();
    expect(content[0]?.text).toContain("Pi (3):");
  });

  it("applies browse limits per backend section with default and clamp", async () => {
    const manyPi = Array.from({ length: 15 }, (_, index) =>
      makeModel({ provider: "p", id: `m${index}`, name: `Model ${index}` }),
    );
    const manyCursor = Array.from({ length: 25 }, (_, index) => ({
      value: `model-${index}`,
      name: `Model ${index}`,
      current: index === 0,
    }));
    const ctx = context();
    ctx.modelRegistry.getAvailable.mockReturnValue(manyPi);
    const tool = createTool({
      discoverCursorModels: vi.fn(async () => manyCursor),
    });

    const defaulted = await run(tool, {}, undefined, ctx);
    expect(defaulted.content[0]?.text).toContain("Pi (15, showing 10):");
    expect(defaulted.content[0]?.text).toContain("Cursor (25, showing 10");
    expect(defaulted.content[0]?.text).toContain('Search Pi models: list_subagent_models({ backend: "pi", query: "<name>" })');

    const clamped = await run(tool, { limit: 99 }, undefined, ctx);
    expect(clamped.details?.limit).toBe(20);
    expect(clamped.content[0]?.text).toContain("Pi (15):");
    expect(clamped.content[0]?.text).toContain("Cursor (25, showing 20");
  });

  it("filters Pi and Cursor discovery independently", async () => {
    const discoverCursorModels = vi.fn(async () => [
      { value: "auto", name: "Auto", current: true },
      { value: "composer-2.5[fast=true]", name: "Composer 2.5", current: false },
    ]);
    const tool = createTool({ discoverCursorModels });

    const piOnly = await run(tool, { backend: "pi" });
    expect(piOnly.content[0]?.text).toContain("Pi (3):");
    expect(piOnly.content[0]?.text).not.toContain("Cursor");
    expect(discoverCursorModels).not.toHaveBeenCalled();

    const cursorOnly = await run(tool, { backend: "cursor" });
    expect(cursorOnly.content[0]?.text).toContain("Cursor (2, current Auto):");
    expect(cursorOnly.content[0]?.text).not.toContain("Pi (");
    expect(discoverCursorModels).toHaveBeenCalledWith({ cwd: "/project", signal: undefined });
  });
});

describe("ListSubagentModelsTool lookup mode", () => {
  it("preserves raw query while matching on trimmed text", async () => {
    const { details } = await run(createTool(), { query: "  grok  " });
    expect(details?.mode).toBe("lookup");
    expect(details?.query).toBe("  grok  ");
    expect(details?.lookup?.matches).toEqual([
      {
        backend: "cursor",
        name: "Grok 4.5 High",
        value: "grok-4.5[effort=high,fast=true]",
      },
    ]);
  });

  it("matches Pi display names and provider/id values", async () => {
    const { content, details } = await run(createTool(), { backend: "pi", query: "gpt 5.6 sol" });

    expect(content[0]?.text).toContain("pi (1 match of 3)");
    expect(content[0]?.text).toContain("GPT 5.6 Sol → openai-codex/gpt-5.6-sol");
    expect(content[0]?.text).toContain('subagent({ model: "<provider/id>"');
    expect(details?.lookup?.matches).toEqual([
      { backend: "pi", name: "GPT 5.6 Sol", value: "openai-codex/gpt-5.6-sol" },
    ]);
  });

  it("matches Cursor display names and exact values with separator normalization", async () => {
    const { content } = await run(createTool(), { backend: "cursor", query: "composer-2.5" });
    expect(content[0]?.text).toContain("cursor (1 match of 3)");
    expect(content[0]?.text).toContain("Composer 2.5 → composer-2.5[fast=true]");
    expect(content[0]?.text).toContain('subagent({ backend: "cursor", cursor_model: "<exact value>"');
    expect(content[0]?.text.match(/subagent\(/g)).toHaveLength(1);
  });

  it("returns zero-match guidance without spawn recipe", async () => {
    const { content } = await run(createTool(), { backend: "cursor", query: "missing-model" });
    expect(content[0]?.text).toContain("cursor (0 matches of 3)");
    expect(content[0]?.text).toContain("Broaden query or omit query to browse.");
    expect(content[0]?.text).not.toContain("subagent({");
  });

  it("caps lookup matches per backend without Pi crowding out Cursor", async () => {
    const ctx = context();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      ...Array.from({ length: 4 }, (_, index) =>
        makeModel({ provider: "openai-codex", id: `gpt-${index}`, name: `GPT Model ${index}` }),
      ),
      makeModel({ provider: "anthropic", id: "other", name: "Other Name" }),
    ]);
    const tool = createTool({
      discoverCursorModels: vi.fn(async () => [
        { value: "composer-2.5[fast=true]", name: "Composer 2.5", current: false },
        { value: "composer-2[fast=true]", name: "Composer 2", current: false },
        { value: "auto", name: "Auto", current: true },
      ]),
    });

    const { content, details } = await run(tool, { query: "composer", limit: 1 }, undefined, ctx);

    expect(details?.lookup?.matchCount).toBe(2);
    expect(details?.lookup?.piMatchCount).toBe(0);
    expect(details?.lookup?.cursorMatchCount).toBe(2);
    expect(details?.lookup?.shownCount).toBe(1);
    expect(content[0]?.text).toContain("models (2 matches of 8, showing 1)");
    expect(content[0]?.text.split("\n").filter((line) => line.includes("→"))).toHaveLength(1);
    expect(content[0]?.text).toContain("Composer 2.5 → composer-2.5[fast=true]");
  });

  it("caps mixed-backend lookup at limit per backend", async () => {
    const ctx = context();
    ctx.modelRegistry.getAvailable.mockReturnValue([
      makeModel({ provider: "openai-codex", id: "gpt-a", name: "Composer GPT Alpha" }),
      makeModel({ provider: "openai-codex", id: "gpt-b", name: "Composer GPT Beta" }),
    ]);
    const tool = createTool({
      discoverCursorModels: vi.fn(async () => [
        { value: "composer-2.5[fast=true]", name: "Composer 2.5", current: false },
        { value: "composer-2[fast=true]", name: "Composer 2", current: false },
      ]),
    });

    const { content, details } = await run(tool, { query: "composer", limit: 1 }, undefined, ctx);

    expect(details?.lookup?.matchCount).toBe(4);
    expect(details?.lookup?.piMatchCount).toBe(2);
    expect(details?.lookup?.cursorMatchCount).toBe(2);
    expect(details?.lookup?.shownCount).toBe(2);
    expect(content[0]?.text).toContain("models (4 matches of 4, showing 2)");
    const lines = content[0]?.text.split("\n").filter((line) => line.includes("→")) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("Composer GPT Alpha"))).toBe(true);
    expect(lines.some((line) => line.includes("Composer 2.5"))).toBe(true);
  });
});

describe("ListSubagentModelsTool failure and abort behavior", () => {
  it("keeps Pi models and returns a warning when default Cursor discovery fails", async () => {
    const { content, details } = await run(createTool({
      discoverCursorModels: vi.fn().mockRejectedValue(new Error("Cursor CLI unavailable")),
    }));

    expect(content[0]?.text).toContain("Pi (3):");
    expect(content[0]?.text).toContain("Warning: Cursor model discovery failed: Cursor CLI unavailable");
    expect(details?.cursor?.warning).toContain("Cursor CLI unavailable");
    expect(details?.cursor?.models).toEqual([]);
  });

  it("returns a warning for a Cursor-only discovery failure", async () => {
    const { content } = await run(createTool({
      discoverCursorModels: vi.fn().mockRejectedValue(new Error("not authenticated")),
    }), { backend: "cursor" });

    expect(content[0]?.text).toBe("Warning: Cursor model discovery failed: not authenticated");
  });

  it("propagates abort instead of turning it into a Cursor warning", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const tool = createTool({
      discoverCursorModels: vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      }),
    });

    await expect(run(tool, {}, controller.signal)).rejects.toBe(reason);
  });
});

describe("list subagent models renderer", () => {
  const details: ListSubagentModelsDetails = {
    mode: "lookup",
    query: "  grok  ",
    limit: 10,
    warnings: [],
    lookup: {
      matchCount: 1,
      catalogCount: 3,
      matches: [{ backend: "cursor", name: "Grok 4.5 High", value: "grok-4.5[effort=high,fast=true]" }],
      shownCount: 1,
      cursorMatchCount: 1,
      shownCursorCount: 1,
    },
  };

  it("mirrors compact content when collapsed", () => {
    expect(renderListSubagentModelsResult(details, false, theme)).toBe(formatListSubagentModelsContent(details));
  });

  it("renders raw query and full catalogs when expanded", () => {
    const expanded = renderListSubagentModelsResult({
      ...details,
      mode: "browse",
      lookup: undefined,
      pi: {
        total: 1,
        shown: 1,
        models: [{ provider: "anthropic", id: "first", value: "anthropic/first", displayName: "First" }],
      },
      cursor: {
        total: 1,
        shown: 1,
        models: [{ name: "Auto", value: "auto", current: true }],
      },
    }, true, theme);
    expect(expanded).toContain("query   grok  ");
    expect(expanded).toContain("Pi models");
    expect(expanded).toContain("First → anthropic/first");
    expect(expanded).toContain("Cursor models");
    expect(expanded).toContain("Auto → auto");
    expect(expanded).toContain("current");
  });
});

describe("list subagent models filter helpers", () => {
  it("filters Pi and Cursor catalogs independently", () => {
    const piModels = filterPiModels([
      { provider: "openai-codex", id: "gpt-5.6-sol", value: "openai-codex/gpt-5.6-sol", displayName: "GPT 5.6 Sol" },
    ], "gpt.5.6");
    const cursorModels = filterCursorModels([
      { name: "Composer 2.5", value: "composer-2.5[fast=true]", current: false },
    ], "composer 2 5");

    expect(piModels).toHaveLength(1);
    expect(cursorModels).toHaveLength(1);
  });
});
