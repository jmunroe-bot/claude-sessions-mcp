# claude-sessions-mcp

An MCP server for creating and driving Claude Code sessions inside a **running**
Remote Control server, over the REST API the bridge itself uses.

An agent can call in a colleague that is not running yet, hand it a prompt, and
have it start working — as a session that belongs to the project's server, with
its worker under that server, visible in claude.ai and reachable from the other
sessions on the machine. The same tools let you survey and steer every agent
running there from a session opened on a phone.

Runs as a single process per machine (streamable-HTTP on `127.0.0.1`), not as a
stdio subprocess per session.

See [the design](docs/superpowers/specs/2026-09-18-claude-sessions-mcp-design.md)
for the verified API surface, how bridge servers are discovered without any
host-specific configuration, the tools, and the safety rails around spawning
agents.

## Usage

### Build

```bash
npm install
npm run build
```

### Install as a systemd user service

Copy the unit into your systemd user directory and adjust the two paths to
where you checked out this repository:

```bash
cp deploy/claude-sessions-mcp.service ~/.config/systemd/user/
```

Edit `WorkingDirectory=` and `ExecStart=` in the copied unit if the repository
does not live directly under your home directory (the shipped unit assumes
`~/claude-sessions-mcp`). Then enable and start it:

```bash
systemctl --user enable --now claude-sessions-mcp
```

### Register it with Claude Code

```bash
claude mcp add --transport http --scope user sessions http://127.0.0.1:8765/mcp
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Only `127.0.0.1`, `localhost` and `::1` are accepted — the server spawns agents, so it refuses to start on any other address. Requests carrying a foreign `Host` header are rejected as well. |
| `PORT` | `8765` | Port the server listens on (loopback only). |
| `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` | `3` | Ceiling on sessions this server may have spawned and left active per bridge. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its config, including bridge pointer files. |
| `CLAUDE_CREDENTIALS_PATH` | `<CLAUDE_CONFIG_DIR>/.credentials.json` | Path to the claude.ai OAuth credentials file. |

### Requirements

Node.js 22 or newer (the code is ESM and uses ES2023 library features).

Linux only — bridge discovery reads `/proc` to find running Remote Control
servers and their workers. The server must run as the same user as the
bridges it talks to: it reads their process table and the shared credentials
file, both of which are only visible to that user.

The server keeps no state between calls: no session registry, no database, no
files of its own. `wait_for_idle` holds an event stream open for the duration
of that one call, and alongside it polls the session's status, because
archiving a session cuts its turn short without emitting anything on the
stream. Both end with the call: nothing is subscribed or watched between
calls.

### After a bridge restart

A stopped bridge does not release the work leases of its sessions. When it
comes back, it re-queues only the one session its pointer file names; every
other session stays without a worker until the old lease expires (about six
minutes, measured on CLI 2.1.284) **and** a client re-opens it. A user message
alone never gets it a worker. In the claude.ai client this looks like
"Remote Control disconnected" for a bridge that is in fact up.

`claude-sessions reattach <instance>` hands the bridge back every live session
of its environment that has no worker, through the same
`/v1/environments/<env>/bridge/reconnect` call the bridge makes for its own
anchor, which does not wait for the lease. It waits up to a minute for the
bridge to show up, so it can run as an `ExecStartPost=` of the unit that runs
the bridge:

```ini
ExecStartPost=-/path/to/claude-sessions reattach %i
```

It prints a JSON report (`reattached`, `failed`) and exits non-zero only when
the bridge never appeared. `send_message` does the same for the one session it
writes to, when that session has no worker (`reattached: true` in its result).

### Scheduled task runs

`claude-sessions run <instance>--<task>` runs one task from the project's
`.claude/background/tasks.json`: it spawns a session tagged
`role:vector-prime` on that bridge, waits for its turn to end (`timeout_min`,
default 60), archives it, prints a JSON report and exits non-zero on failure.
`model` picks the session's model; without it the bridge's default applies.

A task can declare a `precheck`, a shell command run in the project directory
(with `WORKDIR` set) before anything is spawned. Its stdout lists the work
there is. The run is skipped (`outcome: "skipped"`, exit 0) when that output is
empty, or identical to what it was at the last successful run; state lives in
`$XDG_STATE_HOME/vector-task/<instance>--<task>.json`, written only after a
successful run, so failed work is retried on the next firing. A precheck that
exits non-zero, or runs over 60 s, lets the task run as if it had none.
`precheck_max_skip_h` forces a run when that many hours passed since the last
real one, as a guard against a precheck that wrongly reports no work.

```json
"zabbix-watch": {
  "cron": "*/30 * * * *", "prompt_file": "zabbix-watch.md",
  "model": "claude-haiku-4-5",
  "precheck": "$HOME/dev/.config/claude-background/prechecks/zabbix-watch.sh",
  "precheck_max_skip_h": 24
}
```

### Safety rails

- `permission_mode` accepts `auto`, `acceptEdits`, `plan`, `manual` or
  `dontAsk` only. `bypassPermissions` is refused outright, never downgraded.
- Bridge workers ignore the permission mode in the create call and start in the
  bridge host's `defaultMode`, so `spawn_session` sets the mode (`auto` when none
  is given) on the worker with a `set_permission_mode` control request and waits
  for the worker to confirm it before posting the prompt. If the worker refuses,
  reports another mode or does not answer within 60s, the session is deleted and
  the spawn fails; it never runs in a mode other than the one asked for.
- Sessions can be spawned only in bridges discovered on this machine, never in
  a raw environment id.
- `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` bounds how many active sessions this server
  may have created per bridge; if that count cannot be established completely,
  the spawn is refused rather than allowed.
- Every created session is tagged `mcp:claude-sessions-mcp` and
  `spawned-by:<caller>`.

## Releasing

The version lives in one place, `package.json`; the server reports it in the
MCP handshake, and a test asserts the two agree.

```
npm run release -- patch | minor | major | X.Y.Z
```

The script refuses a dirty tree or a branch other than `master`, checks that
the target tag is free and that `origin` is not ahead, runs the build and the
tests, then bumps the version, commits and tags `vX.Y.Z`. Pushing is left to
you — it prints the command.

Pushing the tag opens a **draft** release with generated notes
(`.github/workflows/release-draft.yml`); edit it into something worth reading
and publish it by hand. Nothing else reacts to a tag: there is no build to
trigger and nothing to deploy.

Every push and pull request runs the build and the test suite
(`.github/workflows/ci.yml`).

Inside Claude Code, `/build [patch|minor|major|X.Y.Z]` walks the whole cycle:
release script, tag push, both workflows, the draft notes, and a restart of the
local service if one is installed. It stops short of publishing the release.

## License

MIT — see [LICENSE](LICENSE).
