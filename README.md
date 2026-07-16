# pi-bstn-subagents

A [Pi](https://pi.dev) package for session-scoped **Pi** and **Cursor ACP** subagents. Both backends share the same explicit spawn/wait/send/interrupt/close workflow, persisted metadata, Herdr viewers, and Pi overlays. Cursor remains connected exclusively through ACP.

## Requirements

- Pi `>=0.80.4`
- Node.js `>=22.19`
- [Herdr](https://herdr.dev), with Pi running in a Herdr pane
- Cursor agent CLI (`agent acp`) for the `cursor` backend

## Install

```bash
pi install git:github.com/bstncartwright/pi-bstn-subagents@v0.2.0
```

Project-local:

```bash
pi install -l git:github.com/bstncartwright/pi-bstn-subagents@v0.2.0
```

Local checkout:

```bash
pi install /absolute/path/to/pi-bstn-subagents
```

Run `/reload` after changing the installed package.

## Tools

| Tool | Purpose |
|---|---|
| `list_subagent_models` | Discover exact backend-specific model and thinking parameters with filtering and pagination |
| `spawn_agent` | Spawn a fresh-context Pi or Cursor ACP agent; `backend` is required and Pi model/thinking overrides are optional |
| `wait_agent` | Wait for one completion or Cursor permission request |
| `wait_all_agents` | Wait for all selected agents; returns early for a permission request |
| `list_agents` | List current-session agents or read-only history |
| `read_agent_response` | Read the latest final response |
| `send_message` | Steer Pi, cancel-and-correct Cursor, or start another settled turn |
| `interrupt_agent` | Abort the active turn without closing the session |
| `close_agent` | Permanently close the process and Herdr viewer |
| `respond_agent_permission` | Approve once or reject a pending Cursor ACP permission request |


### Model discovery

Use `list_subagent_models` before selecting a non-inherited model. List the first page across all backends:

```json
{}
```

Filter Pi models by a case-insensitive substring:

```json
{
  "backend": "pi",
  "search": "terra",
  "limit": 20
}
```

Continue a page using the returned `next_offset`:

```json
{
  "offset": 50,
  "limit": 50
}
```

`backend` is an open string validated against `supported_backends`. `search` is trimmed and matched as a case-insensitive substring over `backend`, `model`, and `display_name`. Results are deterministically sorted by backend and model using codepoint order, then paginated. `offset` defaults to `0`; `limit` defaults to `50` and accepts `1` through `100`. `total` is the filtered count before pagination, `has_more` reports whether another page exists, and `next_offset` is the next offset or `null`. Searches with no matches return the same envelope with an empty `models` array.

Both tool text (pretty-printed JSON) and `details` use exactly this envelope:

```json
{
  "models": [
    {
      "backend": "pi",
      "model": "openai-codex/gpt-5.6-terra",
      "display_name": "GPT-5.6 Terra",
      "spawn_parameter": "pi_model",
      "thinking_parameter": "pi_thinking",
      "supported_thinking_levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "fixed_thinking_level": null,
      "current_parent": true,
      "availability_source": "configured_auth"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50,
  "has_more": false,
  "next_offset": null,
  "supported_backends": ["pi", "cursor"],
  "warnings": []
}
```

Pi discovery reads the live `ctx.modelRegistry.getAvailable()` list. `configured_auth` means Pi sees configured authentication; it does not refresh OAuth or make a remote credential/model-availability request. A `models.json` registry error appears in `warnings` while available Pi models are still returned. Cursor discovery lists the package's static `Auto` and `Grok 4.5 High` presets without starting ACP. `static_preset` means the package supports that configuration; it does not prove the Cursor CLI is installed or logged in.

### Spawn examples

Pi backend:

```json
{
  "task_name": "review/api",
  "message": "Review the API changes and return findings with file paths.",
  "backend": "pi",
  "pi_model": "openai-codex/gpt-5.6-terra",
  "pi_thinking": "high"
}
```

Cursor ACP backend:

```json
{
  "task_name": "cursor-review",
  "message": "Review the current diff.",
  "backend": "cursor",
  "cursor_model": "Grok 4.5 High",
  "permission_mode": "agent"
}
```

There is deliberately no default backend. Callers must choose `pi` or `cursor` explicitly. `pi_model` and `pi_thinking` are rejected when `backend` is `cursor`.

`cursor_model` intentionally uses an open-string schema to avoid biasing discovery. Its value must exactly match `list_subagent_models` output; Cursor validates it before prerequisites or ACP start. For compatibility, Pi ignores `cursor_model`, including invalid values.

### Pi model and thinking precedence

Both Pi settings are optional and resolve independently:

1. Explicit `spawn_agent` field (`pi_model` or `pi_thinking`)
2. Selected template (`provider` + `model`, or `thinking`)
3. Active parent Pi model or thinking level

`pi_thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `pi_model` uses exact `provider/model-id` format. It is trimmed and split at the first slash, so later slashes and colons remain in the model ID (for example, `openrouter/anthropic/claude:beta`). Explicit and template model pairs must exactly match `ctx.modelRegistry.find(provider, modelId)`. Inherited parent models are not revalidated. A complete explicit or template model works without an active parent model; the parent model is required only when model selection falls through to inheritance.

Persisted metadata and UI continue to display Pi models as `provider:modelId`.

## Workflow

`spawn_agent` returns after the child starts and accepts its task:

1. Use `list_subagent_models` before choosing any non-inherited model.
2. Spawn one or more agents.
3. Continue independent parent work if useful.
4. Call `wait_agent` or `wait_all_agents` when a result must block the current workflow.
5. Use `send_message` for follow-up work.
6. Call `close_agent` when the session is no longer needed.

Wait tools have no model-facing timeout and honor cancellation of their tool call. Never tell the parent model to sleep or poll. If no active wait consumes a completion, the extension automatically delivers the result as a Pi `followUp` message and triggers a parent turn. An active wait receives the event directly instead, avoiding duplicate delivery. Cursor permission requests use the same rule.

Completed, failed, or interrupted subagents remain available for follow-up work for 15 minutes. Starting another turn resets that window; after 15 idle minutes the backend process and Herdr viewer close automatically while persisted result history remains available.

### Cursor permissions

`permission_mode` applies only to Cursor:

| Mode | Behavior |
|---|---|
| `agent` | Default. `wait_agent`/`wait_all_agents` returns a permission event; answer with `respond_agent_permission` and wait again |
| `prompt` | Show a Pi UI selection when available |
| `allow-once` | Automatically select only an offered one-time approval |
| `deny` | Reject the request |

Parent-agent approval can never grant persistent access. Requests time out and reject after two minutes.

### Steering differences

Pi RPC supports queued steering during an active run. Cursor ACP currently does not expose equivalent steering, so `send_message` cancels the active Cursor prompt and starts the corrective prompt on the same ACP session after cancellation settles. `interrupt_agent` only cancels.

## Session ownership and persistence

Agent names are unique within a parent Pi session. `/reviewer` can exist in two parent sessions, but not twice in one session. Mutating tools only access the current parent session. `list_agents({"include_all": true})` is the sole cross-session operation and is read-only.

Runtime data is stored under:

```text
~/.pi/agent/pi-bstn-subagents/
├── config.json
├── agents/*.md
└── runs/<parent-session-hash>/
    ├── <id>.info.json
    ├── <id>.events.log
    ├── <id>.response.txt
    └── <id>.session.jsonl   # Pi backend
```

Pi children reopen their persisted Pi session. Cursor sessions reconnect through ACP `session/load` when supported. Cursor CLI `2026.07.09` advertises `loadSession`, but not ACP resume/close, so closing terminates the ACP process.

Optional `config.json`:

```json
{
  "storageDir": "~/tmp/pi-agent-runs",
  "defaults": {
    "skills": ["web-investigate"],
    "extensions": ["@scope/pi-extra-tools"]
  }
}
```

Relative storage paths resolve from `~/.pi/agent/pi-bstn-subagents/`.

## Agent templates

Templates live in `~/.pi/agent/pi-bstn-subagents/agents/*.md`.

Pi template:

```md
---
name: reviewer
backend: pi
description: Focused code reviewer
provider: openai-codex
model: gpt-5.6-sol
thinking: high
tools: read,bash,grep,find,ls
skills: web-investigate
extensions: @scope/pi-extra-tools
hint: Give this reviewer exact paths and a narrow scope.
---

Review the requested code. Return concise findings with exact file paths.
```

Cursor template:

```md
---
name: cursor-reviewer
backend: cursor
description: Cursor ACP reviewer
cursor_model: Grok 4.5 High
permission_mode: agent
---

Review the requested code and prioritize correctness defects.
```

The explicit `backend` passed to `spawn_agent` must agree with the template. Pi templates may set provider/model, thinking, tools, skills, and installed extensions. Explicit `pi_model` and `pi_thinking` override those template values independently; otherwise the template overrides parent inheritance. A selected template that specifies either `provider` or `model` must provide a complete nonempty pair unless an explicit `pi_model` overrides it. Automatic child extension, skill, and prompt-template discovery is disabled.

## UI and Herdr

Every live backend gets a background Herdr event-viewer tab. These tabs are viewers only and are not registered as Herdr agents.

- `/agents` browses current-session agents; press Tab for read-only history. Each agent has a live activity subline that switches to a compact final-response summary after settlement.
- `/subagent <task-name>` opens one current-session agent.
- The persistent editor widget uses the same two-line format and elapsed runtime, retaining the `[pi]`/`[cursor]` backend prefix. Pi metadata shows `model · thinking <level> · status · elapsed` (or `thinking unknown` for legacy records); Cursor metadata omits thinking. Activity phases include `Thinking`, `Writing response`, `Tool · bash`, and `Awaiting approval`.
- In the overlay: Left/Right changes agents, `j`/`k` scrolls, `g`/`G` jumps, and `q` closes.

The parent Herdr pane remains `working` while either backend has an outstanding turn.

## Security

This package and every child agent run with your full system permissions. There is no sandbox.

- Pi children load only explicitly selected skills/extensions, but their tools can still mutate the working tree.
- Cursor ACP permission handling does not sandbox approved operations.
- Event logs can contain prompts, thoughts, output, and paths. Permission payloads are redacted to summaries.
- Cursor model changes temporarily touch `~/.cursor/cli-config.json`; the package restores and verifies the previous content.

## Migration from 0.1.x

- Stop old Cursor subagents before reloading.
- Replace `subagent action=spawn/send/steer/...` with the focused tools.
- Choose `backend` explicitly for every spawn.
- Use `wait_agent` or `wait_all_agents` when the parent must block; otherwise completion arrives automatically as a follow-up.
- Existing flat event logs remain legacy history and are not imported into parent-session ownership.

If the package was installed under `pi-cursor-herdr-subagents`, remove that package entry to avoid duplicate tools.

## Development

```bash
npm install
npm run check
```

## Attribution

The session-scoped tool and child-Pi process design is based on the MIT-licensed [`@ogulcancelik/pi-codex-subagents`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents). See `THIRD_PARTY_NOTICES.md`.

## License

MIT
