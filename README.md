# pi-cursor-herdr-subagents

A [Pi](https://pi.dev) package that manages interactive [Cursor](https://cursor.com) agents over ACP, with each subagent visualized in a dedicated background [Herdr](https://herdr.dev) event-viewer tab.

Spawn and follow-up return immediately after submission. Structured ACP thoughts, tool calls, todos, and streamed messages appear in the Herdr viewer (via `tail -F` on a private event log). A Pi widget tracks managed sessions, and the parent Pi pane remains `working` in Herdr while any subagent turn is outstanding, including after Pi's own foreground turn has ended. Cursor ACP sessions are **not** registered as Herdr agents and carry no agent badge/`display-agent` metadata — the viewer tab is named only via `tab create --label`. When a turn ends, the result is steered back into Pi. Pi should stop the session when no more follow-up is needed; otherwise it stays open for follow-ups and closes automatically after 15 idle minutes.

## Prerequisites

- **Pi** with extension/package support (`pi --version`)
- **[Herdr](https://herdr.dev)** on `PATH`, with Pi running inside a Herdr-managed pane (`HERDR_ENV=1` and `HERDR_WORKSPACE_ID` set)
- **Cursor agent CLI** on `PATH` (`agent --version`), authenticated for ACP (`agent acp`)
- Node.js `>=22` for local development and tests

## Install

Pinned v0.1.1 from Git:

```bash
pi install git:github.com/bstncartwright/pi-cursor-herdr-subagents@v0.1.1
```

Project-local:

```bash
pi install -l git:github.com/bstncartwright/pi-cursor-herdr-subagents@v0.1.1
```

Try for one run without installing:

```bash
pi -e git:github.com/bstncartwright/pi-cursor-herdr-subagents@v0.1.1
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-cursor-herdr-subagents
# or
pi -e /absolute/path/to/pi-cursor-herdr-subagents
```

If Pi is already running, reload with `/reload`.

### Migration from the old local extension

If you previously used the auto-discovered copy at `~/.pi/agent/extensions/cursor-herdr-subagents/`, **remove that directory** (or move it aside) before relying on this package. Otherwise Pi can load both the old auto-allowing extension and this package, and behavior will be confusing or unsafe. After removal, install the package above and `/reload`.

When upgrading from `v0.1.0`, stop existing subagents and restart Pi once. The old runtime registered those viewer panes as Herdr agents; a full restart clears that legacy state before `v0.1.1` creates viewer-only tabs.

## Usage

The package registers a `subagent` tool (generic name kept for compatibility) with actions:

| Action | Purpose |
|--------|---------|
| `spawn` | Start a Cursor ACP session and Herdr viewer; submit the initial task |
| `send` | Follow up on an existing session by id or exact display name |
| `steer` | Cancel an active turn, then immediately start a corrective prompt |
| `list` | List managed sessions (includes `permissionMode` and pending approval ids) |
| `read` | Read the structured event log (defaults to 200 lines) |
| `stop` | Terminate the ACP session and close its Herdr viewer |
| `approve` / `reject` | Answer a pending approval routed to the parent Pi agent |

Models:

- `Auto` (default)
- `Grok 4.5 High` — sets `model=grok-4.5`, `effort=high`, and `fast=false`

### Parent check-ins and steering

Each spawn has a `checkInMinutes` setting. It defaults to `5`; set it to `0` to disable or to an integer from `1` through `60` to change the interval. While a turn remains active, each interval steers a message to the parent Pi agent asking it to read that subagent's event log. Pi can let the turn continue, stop it, or use `action=steer` with a corrective message.

`action=steer` sends ACP `session/cancel`, suppresses the interrupted turn's normal result, and starts the corrective prompt after Cursor acknowledges cancellation. Use `send` for a ready subagent and `steer` only for one that is currently working.

### Permission modes

`permissionMode` is set per `spawn` (default **`agent`**):

| Mode | Behavior |
|------|----------|
| `agent` | **Default.** Steer the request to the parent Pi agent. Pi must call `subagent action=approve` or `action=reject` with the supplied approval id. Approval selects only `allow-once`; persistent approval is impossible through this flow. Requests time out and reject after two minutes. |
| `prompt` | Ask via Pi UI when `hasUI` is available. Cancel / timeout / non-UI rejects via offered `reject-once`, or `cancelled` if that option is absent. `allow-always` is never auto-selected; the user may still choose it explicitly in the UI. |
| `allow-once` | Automatically select `allow-once` when offered (never `allow-always`). |
| `deny` | Automatically select `reject-once` when offered, otherwise `cancelled`. |

Single-select `cursor/ask_question` prompts are shown in Pi UI when feasible. Multi-select (`allowMultiple`) and non-UI / cancel cases are skipped with an explicit reason — answers are never fabricated.

Example prompts for the parent Pi agent:

- “Spawn a Cursor subagent named `reviewer` to review the current diff.”
- “Spawn a Cursor subagent with permissionMode deny for a read-only check.”
- “Spawn a Cursor subagent with permissionMode agent and decide its approval requests.”
- “Send follow-up to subagent `reviewer`: also check the tests.”
- “Steer subagent `reviewer`: stop editing the shared file and only review the diff.”
- “List Cursor subagents.”
- “Stop subagent `reviewer`.”

`spawn` and `send` return after submission. Do not poll; completed turns are delivered automatically via steered custom messages (`cursor_subagent_result` / `cursor_subagent_status`).

After handling a completed result, the parent Pi agent should call `stop` if it does not need a follow-up. A ready session that receives no follow-up is automatically stopped after 15 minutes, terminating Cursor ACP and closing its Herdr viewer. Sending a follow-up clears the old timeout; a new 15-minute timeout starts when that turn completes.

Event logs are stored under Pi’s agent directory with private modes (`0700` dirs / `0600` logs):

```text
~/.pi/agent/pi-cursor-herdr-subagents/<id>/events.log
```

Logs intentionally omit raw tool inputs and redact permission payloads to title/kind. They can still contain prompts, streamed thoughts/assistant text, and paths you should treat as sensitive.

## Security

Pi packages run with your **full system permissions**. There is **no sandbox**: this extension spawns Cursor ACP in the requested working directory and can create/control Herdr viewer tabs (named with `tab create --label` only; no agent registration or badge metadata) in the current workspace.

Additional notes:

- Temporarily snapshots and restores `~/.cursor/cli-config.json` around ACP startup so model selection does not permanently change your Cursor CLI defaults. If the file did not exist beforehand, a file created during startup is removed on restore. Restoration **applies, waits briefly, and verifies** (original content or absence), retrying about **5** times before throwing an error that names the config path.
- **Config race limitation:** restores are serialized inside this extension and verified with retries, but other Cursor/CLI processes can still rewrite `cli-config.json` concurrently and cause restore verification to fail. Treat that file as shared mutable state.
- Default `permissionMode=agent` asks the parent model to approve once or reject. Existing sessions keep the mode they were spawned with.
- `permissionMode=agent` delegates each decision to the parent model. Treat it as less restrictive than human `prompt`; although it cannot grant persistent access, an approved Cursor operation still runs with your full system permissions.
- Plan-creation requests (`cursor/create_plan`) are still auto-accepted so planning turns can proceed; review plans in the Herdr viewer / final result.

Only install from sources you trust. Review the extension code before enabling it on sensitive repositories.

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `Cursor subagents require Pi to be running inside Herdr` | Start Pi from a Herdr pane so `HERDR_ENV=1` is set |
| `HERDR_WORKSPACE_ID is unavailable` | Confirm Herdr injected workspace env; run `herdr pane current --current` |
| `herdr CLI is unavailable` | Ensure `herdr` is on `PATH` (`herdr --version`) |
| `Cursor agent CLI is unavailable` | Ensure `agent` is on `PATH` (`agent --version`) and you are logged in |
| Permissions always rejected | Need Pi UI (`hasUI`) for human `prompt`, use `permissionMode=agent` for parent-agent decisions, or pass `permissionMode=allow-once` intentionally |
| Duplicate / unexpected subagent tool | Remove `~/.pi/agent/extensions/cursor-herdr-subagents/` and reload |
| Grok High config rejected / Fast forced | This package requests Cursor’s `parameterizedModelPicker` capability and asserts `fast=false`; update Cursor CLI if options are missing |
| Viewer tab empty | Check the event log path returned by `spawn` / `list`; Herdr runs `tail -F` on that file |
| Parent never receives a result | Confirm the session was not stopped early; use `subagent action=read` or inspect the event log |

## Development

```bash
npm install
npm run check
```

`npm run check` typechecks with strict TypeScript and runs unit tests for the ACP client (mock stdio agent) and pure helpers.

## License

MIT
