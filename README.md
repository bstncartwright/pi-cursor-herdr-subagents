# pi-bstn-subagents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.dev/)

A [pi](https://pi.dev) extension with first-class **Pi** and **Cursor ACP** subagents behind one native scheduler, lifecycle, result, notification, widget, and transcript surface.

- Pi children run in-process through Pi's SDK.
- Cursor children run in isolated `agent acp` subprocesses using the official Agent Client Protocol SDK.
- Both backends support foreground and queued background execution, cancellation, result collection, custom agent types, workspaces, lifecycle events, and the built-in UI.

This repository vendors and adapts `@gotgenes/pi-subagents` at upstream commit
`67eda5ac9add1cb6bb6240495090b5ecf1a1fb29`. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for provenance.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/gotgenes/pi-subagents/raw/main/media/screenshot.png" />

<https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543>

## Features

- **Two native backends** — in-process Pi sessions and process-isolated Cursor sessions over ACP share one `subagent` tool and lifecycle
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and individual completion notifications
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons
- **Session transcripts** — open any subagent's full session transcript (running or with its session released) in pi's native read-only viewer via `/subagents:sessions`
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Capability-honest control** — Pi supports mid-run steering; Cursor steering is rejected because Cursor ACP does not currently advertise an equivalent operation
- **Session resume** — continue retained Pi or Cursor sessions; ACP load/resume is used only when Cursor advertises it
- **Graceful Pi turn limits** — Pi agents get a "wrap up" warning before hard abort; Cursor rejects `max_turns` because ACP does not expose equivalent boundaries
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work.
  Unknown types fall back to general-purpose with a note
- **Backend-native model selection** — Pi supports fuzzy configured-model selection; Cursor resolves against the model options advertised by ACP at session creation
- **Resolved model identity** — every live, completed, transcript, event, and service record shows the model actually negotiated for that child session; compact UI uses its display name and durable details retain the exact Pi `provider/id` or Cursor ACP value
- **Live model discovery** — parent sessions can list authenticated Pi models and disposable-session Cursor ACP values before selecting either backend
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML.
  Expandable to show full output
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity

## Install

```bash
pi install git:github.com/bstncartwright/pi-bstn-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Quick Start

The parent agent spawns sub-agents using the `subagent` tool:

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline.
Background agents return an ID immediately and notify you on completion.

### Cursor quick start

Cursor's `agent` CLI must be installed and authenticated (`agent --version`).

Discover the live Cursor values first; Cursor's display names are not a stable
package catalog:

```text
list_subagent_models({ backend: "cursor", query: "Composer" })
```

```text
subagent({
  backend: "cursor",
  subagent_type: "general-purpose",
  prompt: "Review this repository and identify the highest-risk defect",
  description: "Cursor risk review",
  permission_mode: "prompt",
  run_in_background: true,
})
```

`cursor_model` is optional. When provided, copy the advertised exact `value` from
lookup output; browse mode shows Cursor display names only. The extension does
not maintain a hard-coded Cursor model list. When omitted, Cursor's actual ACP
current value is captured after session creation and shown as the resolved
model; the UI never claims a fabricated `default` model while that session is
still being negotiated.

## UI

The extension renders a persistent widget above the editor showing active background agents (foreground runs are rendered inline by the `subagent` tool's progress stream):

```text
● Agents
├─ ⠹ Agent (pi)  Refactor auth module · gpt-5.6-sol · turn 5/30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore (cursor)  Find auth files · Auto · 3 tool uses · 12.4k token · 4.1s
│    ⎿  searching…
├─ ⠹ Agent (pi)  Long-running task · turn 42 · 38 tool uses · 91.0k token (84% · ↻2) · 2m17s
│    ⎿  reading…
└─ 2 queued · 1 pi · 1 cursor
```

The token field is annotated with two optional signals inside parens:

- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error).
  Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`↻N`** — number of times the session has compacted, when > 0.
  Stays dim; the percent's color carries urgency.

Individual agent results render inline in the conversation:

| State          | Example                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Running**    | `⠹ turn 3/30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…`             |
| **Completed**  | `✓ turn 8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done`                              |
| **Wrapped up** | `✓ turn 50/50 · 50 tool uses · 89.1k token (84% · ↻2) · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped**    | `■ turn 3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped`                                    |
| **Error**      | `✗ turn 3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout`                             |
| **Aborted**    | `✗ turn 55/50 · 55 tool uses · 102.3k token (95% · ↻3)` / `⎿ Aborted (max turns exceeded)`   |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  turn 3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Default Agent Types

| Type              | Tools                      | Model                         | Prompt Mode            | Description                                                                                      |
| ----------------- | -------------------------- | ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `general-purpose` | all 7                      | inherit                       | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions            |
| `Explore`         | read, bash, grep, find, ls | haiku (falls back to inherit) | `replace`              | Fast codebase exploration (read-only); inherits the parent prompt as a base                      |
| `Plan`            | read, bash, grep, find, ls | inherit                       | `replace`              | Software architect for implementation planning (read-only); inherits the parent prompt as a base |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does.
Explore and Plan use `replace` mode: the parent prompt is the cacheable base and their specialist read-only instructions are appended last, giving them the final say.

Default agents can be **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files.
The filename becomes the agent type name.
Any name is allowed — using a default agent's name overrides it.

Agents are discovered from two locations (higher priority wins):

| Priority    | Location                                                                         | Scope                         |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------- |
| 1 (highest) | `.pi/agents/<name>.md`                                                           | Project — per-repo agents     |
| 2           | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.
The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor.
Review code for vulnerabilities including:

- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```text
subagent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Example: `.pi/agents/cursor-reviewer.md`

```markdown
---
description: Cursor Code Reviewer
backend: cursor
cursor_model: Composer 2.5
permission_mode: prompt
run_in_background: true
---

Review the requested code. Report concrete defects with file paths and line
numbers. Do not modify files unless the task explicitly asks for changes.
```

Cursor agent prompts still use the custom body and parent prompt composition,
but `tools`, `model`, `thinking`, and `max_turns` are Pi-specific. Cursor tool
access is governed by ACP permission requests, not Pi's built-in tool allowlist.

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field               | Default        | Description                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | filename       | Agent description shown in tool listings                                                                                                                                                                                                                                                                                |
| `backend`           | `pi`           | `pi` for an in-process child or `cursor` for Cursor over ACP                                                                                                                                                                                                                                                            |
| `display_name`      | —              | Display name for UI (e.g. widget, agent list)                                                                                                                                                                                                                                                                           |
| `tools`             | all 7          | Comma-separated built-in tools: read, bash, edit, write, grep, find, ls. `none` for no tools                                                                                                                                                                                                                            |
| `model`             | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`)                                                                                                                                                                                                                                                        |
| `cursor_model`      | Cursor default | Cursor model name/value advertised by ACP; only valid with `backend: cursor`                                                                                                                                                                                                                                            |
| `permission_mode`   | `prompt`       | Cursor ACP permissions: `prompt`, `allow-once`, or `deny`. Automatic mode never chooses an `allow_always` option                                                                                                                                                                                                        |
| `thinking`          | inherit        | off, minimal, low, medium, high, xhigh                                                                                                                                                                                                                                                                                  |
| `max_turns`         | unlimited      | Max agentic turns before graceful shutdown. `0` or omit for unlimited                                                                                                                                                                                                                                                   |
| `prompt_mode`       | `append`       | `replace`: parent prompt is the cacheable base; body is appended last with full control (no `<sub_agent_context>` bridge, no `<agent_instructions>` wrapper). `append`: parent prompt is the base; body is wrapped in `<agent_instructions>` and a sub-agent context bridge is injected (agent acts as a "parent twin") |
| `inherit_context`   | `false`        | Fork parent conversation into agent                                                                                                                                                                                                                                                                                     |
| `run_in_background` | `false`        | Run in background by default                                                                                                                                                                                                                                                                                            |
| `enabled`           | `true`         | Set to `false` to disable an agent (useful for hiding a default agent per-project)                                                                                                                                                                                                                                      |

Frontmatter is authoritative.
If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, or `run_in_background`, those values are locked for that agent.
`subagent` tool parameters only fill fields the agent config leaves unspecified.

## Tools

### `list_subagent_models`

Discover models before setting `model` or `cursor_model`. Prefer lookup with
`query` over unfiltered browse. Omit `backend` to include both authenticated Pi
models and live Cursor ACP choices.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `backend` | string | no | `pi` or `cursor`; omit for both |
| `query` | string | no | Case-insensitive lookup by Pi provider/id or display name, or Cursor display name or exact value |
| `limit` | integer | no | Max models per backend section in browse or lookup. Default 10, max 20 |

Browse mode (omit `query`) returns compact sections: Pi lists exact
`provider/id` values; Cursor lists display names only and marks the current
choice compactly. When Cursor is included or a section is truncated, the output
hints to call again with `backend` + `query` for exact values.

Lookup mode returns capped `name → exact value` lines per backend (up to `limit`
Pi matches plus up to `limit` Cursor matches) plus one shared spawn hint. Full
match totals remain in `details`. Zero matches returns `0 matches of N` with
guidance to broaden or browse.

Cursor discovery opens one disposable ACP session, sends no prompt, and closes
it before returning. Expanded TUI view (`details`) includes full catalogs with
Cursor exact values, current selection, and groups. If Cursor discovery fails in
an unfiltered call, available Pi models are still returned with a warning.

### `subagent`

Launch a sub-agent.

| Parameter           | Type         | Required | Description                                                      |
| ------------------- | ------------ | -------- | ---------------------------------------------------------------- |
| `prompt`            | string       | yes      | The task for the agent                                           |
| `description`       | string       | yes      | Short 3-5 word summary (shown in UI)                             |
| `subagent_type`     | string       | yes      | Agent type (built-in or custom)                                  |
| `backend`           | string       | no       | `pi` (default) or `cursor`                                       |
| `model`             | string       | no       | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `cursor_model`      | string       | no       | Model advertised by Cursor ACP; requires `backend: cursor`       |
| `permission_mode`   | string       | no       | Cursor policy: `prompt`, `allow-once`, or `deny`                 |
| `thinking`          | string       | no       | Thinking level: off, minimal, low, medium, high, xhigh           |
| `max_turns`         | number       | no       | Max agentic turns. Omit for unlimited (default)                  |
| `run_in_background` | boolean      | no       | Run without blocking                                             |
| `resume`            | string       | no       | Agent ID to resume a previous session                            |
| `inherit_context`   | boolean      | no       | Fork parent conversation into agent                              |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter  | Type    | Required | Description                   |
| ---------- | ------- | -------- | ----------------------------- |
| `agent_id` | string  | yes      | Agent ID to check             |
| `wait`     | boolean | no       | Wait for completion           |
| `verbose`  | boolean | no       | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent.
The message interrupts after the current tool execution.

This operation is Pi-only. Cursor ACP currently provides prompt and cancel but
no native mid-turn steering method, so Cursor calls return an explicit
unsupported result rather than silently implementing cancel-and-reprompt.

| Parameter  | Type   | Required | Description                               |
| ---------- | ------ | -------- | ----------------------------------------- |
| `agent_id` | string | yes      | Agent ID to steer                         |
| `message`  | string | yes      | Message to inject into agent conversation |

## Commands

| Command               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `/subagents:settings` | Configure subagent settings (concurrency, turn limits) |
| `/subagents:sessions` | View a subagent's session transcript (read-only)       |

### `/subagents:settings`

Interactive list to tune runtime settings — max concurrency, default max turns, and grace turns.
Changes persist across pi restarts (see [Persistent Settings](#persistent-settings)).

### `/subagents:sessions`

Pick any subagent — running, or completed with its live session already released — and read its full session transcript in pi's native per-entry viewer. The picker and transcript header identify the producing backend and resolved model; durable details include Pi's `provider/id` or Cursor's ACP value.
Read-only: no steering, no session takeover (steering lives in the `steer_subagent` tool and the background widget).

Creating and editing agent definitions is not a command — write an agent `.md` file in your editor, or ask a pi session to generate one (see [Custom Agents](#custom-agents)).

## Graceful Max Turns

This section applies to the Pi backend only. Cursor rejects `max_turns` rather
than reporting a turn policy it cannot enforce.

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status      | Meaning                       | Icon       |
| ----------- | ----------------------------- | ---------- |
| `completed` | Finished naturally            | `✓` green  |
| `steered`   | Hit limit, wrapped up in time | `✓` yellow |
| `aborted`   | Grace period exceeded         | `✗` red    |
| `stopped`   | User-initiated abort          | `■` dim    |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4).
Excess agents are automatically queued and start as running agents complete.
The widget shows queued agents as a collapsed count.

Foreground agents bypass the queue — they block the parent anyway.

## Persistent Settings

Runtime tuning values set via `/subagents:settings` (max concurrency, default max turns, grace turns, and the two session-retention windows) persist across pi restarts.
A completed subagent's record is kept for the whole parent session (so `get_subagent_result` never misses); only its heavy in-memory session is released — after `consumedSessionRetentionMinutes` once the result has been collected, or after the `unconsumedSessionRetentionMinutes` safety cap if it never was.
Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults.
  Edit by hand; the `/subagents:settings` command never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides.
  Written by `/subagents:settings`.

**Precedence:** project overrides global on any field present in both.
Missing fields fall back to the hardcoded defaults (max concurrency `4`, default max turns unlimited, grace turns `5`, consumed-session retention `10` minutes, unconsumed-session retention `720` minutes).

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10,
  "unconsumedSessionRetentionMinutes": 1440
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the command.
Individual projects can still override via `/subagents:settings`.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/subagents:settings` toast to a warning with `(session only; failed to persist)`.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event                        | When                                                    | Key fields                                                                                                           |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `subagents:created`          | Background agent registered                             | `id`, `type`, `description`, `isBackground`                                                                          |
| `subagents:started`          | Agent transitions to running (including queued→running) | `id`, `type`, `description`                                                                                          |
| `subagents:completed`        | Agent finished successfully                             | `id`, `type`, `durationMs`, `tokens` (lifetime `{ input, output, total }`), `toolUses`, `result`, optional resolved `model` |
| `subagents:failed`           | Agent errored, stopped, or aborted                      | same as completed + `error`, `status`                                                                                |
| `subagents:steered`          | Steering message sent                                   | `id`, `message`                                                                                                      |
| `subagents:compacted`        | Agent's session successfully compacted                  | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount` |
| `subagents:settings_loaded`  | Persisted settings applied at extension init            | `settings` (merged global + project)                                                                                 |
| `subagents:settings_changed` | `/subagents:settings` mutation was applied              | `settings`, `persisted` (`boolean` — `false` on write failure)                                                       |

`tokens.total` = `input + output + cacheWrite`.
`cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it.
Use `contextUsage.percent` (surfaced as `(NN%)` in the widget) for current context size.

## Worktree Isolation

Worktree isolation lives in a companion package, not this core.
Install [`@gotgenes/pi-subagents-worktrees`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents-worktrees) and list the agent types you want isolated in its `worktreeAgents` config — opted-in agents run in a temporary git worktree, and their changes are saved to a branch on completion.
The earlier `isolation: "worktree"` spawn flag and `isolation:` frontmatter key were removed from the core.

## Removed: agent memory and skill preloading

Persistent agent memory (the `memory:` frontmatter key) and skill preloading (the `skills:` frontmatter key) were removed when the core was slimmed down.
Children now always inherit the parent's skills and extensions, so the `isolated`, `extensions`, and `skills` frontmatter keys no longer exist.

## Migrating from `disallowed_tools`

The `disallowed_tools` frontmatter field has been removed.
Use [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system)'s `permission:` frontmatter instead — it provides richer semantics (allow/ask/deny vs. binary hide):

```yaml
# Before (no longer supported)
disallowed_tools: bash

# After
permission:
  bash: deny
```

## Permission System Integration

When [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) is installed, this extension integrates automatically:

- **Per-agent permission policies** — define `permission:` in agent YAML frontmatter to set allow/ask/deny rules per agent type.
  The permission system resolves the agent name from the `<active_agent>` tag in the child system prompt.
- **Tool filtering** — the permission system's `before_agent_start` handler removes denied tools from the child session before the agent starts.
- **`ask`-state forwarding** — when a child session triggers an `ask` permission, the prompt forwards to the parent session's UI.
  The parent approves or denies, and the child resumes.
- **Deterministic child detection** — this extension publishes `subagents:child:session-created` before `bindExtensions()` fires; the permission system subscribes and registers the child session synchronously, so detection does not rely on env vars or filesystem heuristics.

No configuration is required.
When `@gotgenes/pi-permission-system` is not installed, the lifecycle events have no subscriber — a harmless no-op.

This integration governs Pi child tools. Cursor owns a separate ACP permission
surface described in [Cursor ACP backend](./docs/cursor-acp.md#permission-policy).

## For Extension Authors

This package exposes two public subpath exports for companion extensions to import from the published tarball.

### `pi-bstn-subagents` — cross-extension service contract

Access the subagent service from another extension at runtime:

```typescript
const { getSubagentsService } = await import("pi-bstn-subagents");
const svc = getSubagentsService();
svc?.spawn("Explore", "Check for stale TODOs");
```

Declare this package as an optional peer dependency.
See `src/service/service.ts` for the full `SubagentsService` interface and the `WorkspaceProvider` seam.

### `pi-bstn-subagents/settings` — layered config loader

Extensions that store configuration in JSON files can use the shared layered loader, which reads a global file (`<agentDir>/<filename>`) and a project file (`<cwd>/.pi/<filename>`) and merges them — project wins on conflicts, missing files are silent, malformed files warn and fall back:

```typescript
import { loadLayeredSettings, type LayeredSettingsSource } from "pi-bstn-subagents/settings";

interface MyConfig { enabled?: boolean; limit?: number }

function sanitize(raw: unknown): Partial<MyConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MyConfig> = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.limit === "number") out.limit = r.limit;
  return out;
}

const config = loadLayeredSettings<MyConfig>({
  agentDir,          // Pi runtime agent home directory
  cwd,               // project root — project file lives at <cwd>/.pi/<filename>
  filename: "my-extension.json",
  sanitize,
  warnLabel: "my-extension",  // prefix for the malformed-file stderr warning
});
```

`loadLayeredSettings` returns `Partial<T>` (all fields optional); apply your defaults after the call.
It never throws — all error conditions produce a `console.warn` and return `{}`.

## Architecture

This extension is a minimal, composable core: it owns agent spawning, execution, and result retrieval, and exposes a typed `SubagentsService` plus lifecycle events that other extensions build on.

See [`docs/architecture/architecture.md`](./docs/architecture/architecture.md) for the full architecture document — design principles, domain decomposition, module dependency flow, Mermaid diagrams, and the improvement roadmap.
See [`docs/cursor-acp.md`](./docs/cursor-acp.md) for the Cursor backend contract, security model, capability mapping, and protocol lifecycle.

## Relationship to upstream

This package vendors `@gotgenes/pi-subagents`, which is itself a hard fork of
[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). The base
architecture remains attributable to Chris Lasher and tintinweb. This fork adds
the backend-neutral child-session seam and Cursor ACP implementation. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
