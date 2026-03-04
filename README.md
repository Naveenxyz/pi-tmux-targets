# pi-tmux-targets

Tmux targeting + subagent layout extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

It adds:
- `tmux_list_targets` tool
- `tmux_track_pane` tool
- `tmux_launch_subagent` tool (interactive/steerable tmux subagent pane)
- `tmux_subagent_job` tool (async jobs with callbacks)
- `/tmux-targets` command (interactive target picker)
- `/tmux-launch-subagent` command

## What it does

- Tracks tmux panes by pane id (`%6`, `%7`, ...)
- Auto-untracks panes that were killed
- Shows tracked count in status line
- Launches subagents in tmux
- Runs async subagent jobs with `jobId` tracking
- Sends automatic follow-up message back to parent session when job finishes
- Auto-kills worker pane on completion by default (configurable)
- **Smart default layout for subagents**:
  - first launch: split current pane into 50/50 left-right
  - next launches: stack subagents in the right column

## Install

### Option 1: Global install (all projects)

```bash
pi install git:github.com/Naveenxyz/pi-tmux-targets
```

### Option 2: Project-local install

```bash
pi install -l git:github.com/Naveenxyz/pi-tmux-targets
```

### Option 3: Manual file copy

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/tmux-target.ts ~/.pi/agent/extensions/tmux-target.ts
```

Then reload pi:

```text
/reload
```

## Uninstall

### If installed via `pi install` (global)

```bash
pi remove git:github.com/Naveenxyz/pi-tmux-targets
```

### If installed via `pi install -l` (project-local)

Run from the project where you installed it:

```bash
pi remove -l git:github.com/Naveenxyz/pi-tmux-targets
```

### If manually copied extension file

```bash
rm -f ~/.pi/agent/extensions/tmux-target.ts
```

Then reload pi:

```text
/reload
```

## Usage

- List targets: ask pi to call `tmux_list_targets`
- Open `/tmux-targets`: Tab cycles scopes (`current` → `all` → `tracked`), `t` toggles, Enter applies+closes
- Track/untrack pane:
  - `tmux_track_pane` with `pane: "%6"`
  - `tmux_track_pane` with `pane: "%6", untrack: true` (or with `regex`)
- Launch interactive subagent pane:
  - use `tmux_launch_subagent` tool or `/tmux-launch-subagent` command
  - optional `horizontal: true` to force side split
  - optional `horizontal: false` to force vertical split
  - omit `horizontal` to use smart layout mode

- Launch async subagent job (background, non-interactive worker):
  - `tmux_subagent_job` with `action: "start"` and `task`
  - optional `name`, `model`, `tools`, `autoKillOnDone` (default `true`)
  - returns `jobId` and spawned `paneId`

- Monitor jobs:
  - `tmux_subagent_job` with `action: "list"`
  - `tmux_subagent_job` with `action: "progress"` (optional `jobId`)
  - `tmux_subagent_job` with `action: "cancel"` and `jobId`
  - by default, job list/progress/cancel are scoped to the current session; use `allSessions: true` to override

## Notes

- Requires running inside tmux.
- Pane ids are stable while panes live, but can be reused by tmux after panes are killed.
- Extension state is stored in the session using custom entries.
- Async job artifacts are stored in `~/.pi/agent/tmux-target-jobs/` (`jobs/`, `logs/`, `tasks/`, `scripts/`).

## License

MIT
