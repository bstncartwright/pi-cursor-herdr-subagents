# Cursor ACP backend

Cursor is a first-class execution backend selected with `backend: "cursor"` in
the `subagent` tool, custom-agent frontmatter, or `SubagentsService.spawn()`.
Pi remains the default.

## Runtime lifecycle

Each Cursor subagent owns one `agent acp` subprocess and one ACP session:

1. Spawn `agent acp` in the resolved workspace directory.
2. Negotiate the ACP protocol and capabilities.
3. Authenticate with `cursor_login` when Cursor advertises it.
4. Create a session, or use `session/resume`/`session/load` only when the
   corresponding capability is advertised.
5. Inspect the session's advertised configuration options and apply
   `cursor_model` by standard `model` category, option value, or display name.
6. Send `session/prompt` and normalize message, thought, tool, usage, and
   context updates into the shared subagent state.
7. On cancellation, send `session/cancel` and continue accepting final updates
   until Cursor settles the prompt.
8. On release, use `session/close` when advertised, then terminate the process
   with TERM/KILL fallback.

Processes are deliberately not multiplexed. A Cursor crash affects one
subagent, permission requests cannot cross session routes, and cleanup remains
deterministic.

## Permission policy

Cursor executes its own tools; Pi's built-in tool allowlist does not constrain
them. ACP permission handling is therefore mandatory and separate:

- `prompt` (default for tool calls) asks through Pi's UI and validates the
  selected ID against the options Cursor actually offered.
- `allow-once` automatically selects only an offered `allow_once` option. It
  never escalates to `allow_always`.
- `deny` selects an offered rejection option, otherwise cancels the request.
- Cross-extension service spawns default to `deny` because they have no safe UI
  context.
- Cancellation resolves outstanding permission requests as cancelled.

Read-only instructions in an agent prompt are not a sandbox. Do not combine a
supposedly read-only Cursor agent with automatic approvals unless that risk is
intentional.

## Capability differences

| Capability | Pi | Cursor ACP |
| --- | --- | --- |
| Foreground/background queue | yes | yes |
| Cancellation | yes | `session/cancel` |
| Native mid-turn steering | yes | no; explicitly rejected |
| Graceful `max_turns` | yes | unavailable; ACP has no Pi turn boundaries |
| Session continuation while retained | yes | yes |
| Cross-process resume/load | n/a | capability-gated |
| Rich Pi transcript rendering | yes | normalized text/tool transcript |

Cursor ACP does not expose Pi-style model-turn boundaries, so Cursor agents do
not display Pi's `turn N/M` metric in widgets, inline results, or notifications.
| Token/context metrics | Pi session events | shown only when ACP reports usage |
| Compaction metrics | yes | not fabricated |

## Model selection

There is no static model catalog in this package. Before selecting a model, a
parent session calls `list_subagent_models({ backend: "cursor", query: "<name>" })`
when it knows the intended Cursor display name, or browses without `query` to
scan choices. The tool opens one disposable ACP client/session. The discovery
client advertises no MCP servers or client-provided ACP filesystem/terminal
capabilities and sends no prompt; it reads the advertised model config, then
closes in `finally`.

Compact tool output stays small: browse shows Cursor display names only and,
when Cursor is included or Pi is truncated, hints with concrete
`list_subagent_models({ backend: "cursor", query: "<name>" })` or
`list_subagent_models({ backend: "pi", query: "<name>" })` calls; lookup
returns `name → exact value` matches plus one shared spawn hint. Expanded TUI
rendering (`details`) preserves full catalogs with exact values, current
selection, and ACP option groups. This is not a sandbox: the Cursor subprocess
runs in the chosen cwd with the invoking user's permissions.

`cursor_model` is resolved against the configuration returned by the active
Cursor version. Invalid values fail with the currently advertised choices.
Omitting it leaves Cursor's current default untouched. If an unfiltered model
listing cannot reach Cursor, it retains the authenticated Pi list and appends a
warning; a Cursor-only listing returns that warning. Cancellation propagates
after session/process cleanup rather than waiting for ACP request timeouts.

An explicit `model` value always targets the default Pi backend. When that
lookup fails and the intended model may be a Cursor display name, the spawn
boundary tells the caller to list live Cursor values with
`list_subagent_models({ backend: "cursor", query: "<intended name>" })`, then
retry with `backend: "cursor"` and `cursor_model: "<exact value>"`, omitting
Pi-only `model`, `thinking`, and `max_turns` fields.

After `session/new`, `session/load`, or `session/resume` (and after an optional
model config update), the final advertised model option's `currentValue` is
captured as the resolved Cursor model identity. Compact surfaces show its ACP
display name; persisted records, events, notifications, and expanded results
also retain that exact `currentValue`. Before an omitted-model session finishes
negotiating, background output omits a model rather than inventing `default`.

## Testing

The normal suite uses a subprocess mock that exercises initialization,
authentication, model selection, permissions, streaming, cancellation,
resume, close, and crash cleanup.

Run a real installed-CLI smoke explicitly:

```bash
CURSOR_ACP_LIVE=1 npm run test:cursor:live
```
