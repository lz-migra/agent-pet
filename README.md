# Agent Pet

A floating, transparent-window desktop pet powered by
[`agent-robot-avatar`](https://github.com/CX-ArtLab/agent-robot-avatar),
wrapped in Electron, and drivable from any terminal via a single CLI:

```bash
agent-pet                 # start the GUI in the background
agent-pet react success   # the mascot plays the success animation
agent-pet react warning
agent-pet quit            # shut it down
```

The desktop pet lives in a frameless, transparent, always-on-top window.
The CLI talks to it over a local Unix socket / named pipe.

## Requirements

- Node.js ≥ 18
- npm ≥ 9
- A compositing desktop environment on Linux (X11 + a compositor, or Wayland)
  for `transparent: true` to look right. On Windows and macOS it works out of
  the box.

## Quick start (development)

```bash
git clone <this repo>
cd agent-pet
npm install

# In one terminal: link the CLI so it works from anywhere.
npm link

# Start the floating mascot. The CLI auto-launches the GUI if it isn't
# running, so `agent-pet react success` "just works" after.
agent-pet                       # alias of `agent-pet init`
agent-pet react success
agent-pet react warning
agent-pet quit                  # shut it down
```

The avatar appears in a frameless, transparent, always-on-top window.
Drag it anywhere with the mouse. Right-click for a quit menu.

You can also run the GUI in dev mode (live rebuild on edit):

```bash
npm run dev       # the same window, served from src/ instead of app.asar
```

## CLI reference

```
agent-pet                       start the GUI in the background (alias of init)
agent-pet init                  same as above; idempotent
agent-pet play <action>         run an action, wait until it finishes
agent-pet react <action>        alias of play
agent-pet reset                 stop and return to idle
agent-pet list                  list known actions
agent-pet status                show the pet's current action + uptime
agent-pet show | hide           toggle window visibility
agent-pet quit                  shut down the GUI

agent-pet --help
agent-pet --version
```

Any command that talks to the GUI (`play`, `reset`, …) **auto-starts
the GUI** if it isn't running. So `agent-pet react success` works even
after a fresh boot, as long as `agent-pet` is on your `$PATH`.

Available actions (mirrors `agent-robot-avatar` v0.5.2):

```
idle, bored, waiting, waiting-wrap, input, send,
success, failure, warning, inspect, blocked, error,
surprise, love, random, slot, sleep, wake
```

Exit codes:

- `0` success
- `2` usage error
- `75` GUI cannot start / IPC unavailable
- `1` server replied with an error

## How the IPC works

- **Linux/macOS**: Unix domain socket at
  `$XDG_RUNTIME_DIR/agent-pet.sock` (fallback `~/.cache/agent-pet/agent-pet.sock`).
- **Windows**: named pipe `\\.\pipe\agent-pet`.
- Protocol: NDJSON (one JSON object per line), request/response style.

Request example (what the CLI sends internally):

```json
{"id":"1","cmd":"play","args":["success"]}
```

Response:

```json
{"id":"1","ok":true,"result":{"ok":true}}
```

The main process awaits `avatar.play(...)` to finish before replying, so
`agent-pet react success` blocks until the animation is complete. Useful in
shell pipelines:

```bash
agent-pet react waiting
some_long_command
agent-pet react success
```

The CLI remembers the GUI binary path between invocations in
`~/.config/agent-pet/config.json`. Override it with `$AGENT_PET_GUI_BIN`
if you're hacking on the project from a different location.

## Project layout

```
src/
├── main/
│   ├── main.js           # Electron entry, window, IPC dispatch
│   ├── preload.js        # contextBridge: tiny renderer API
│   └── socket-server.js  # NDJSON IPC server
└── renderer/
    ├── index.html        # CSP-friendly markup with the avatar mounted
    ├── renderer.js       # exposes window.__pet.{play,reset,handle}
    └── vendor/           # vendored copy of agent-robot-avatar (loaded
                          #   by <script>, so import resolution works
                          #   inside Electron's loadFile)
bin/
└── agent-pet             # the unified CLI (auto-starts the GUI on demand)
```

## Packaging (multi-platform)

electron-builder is configured to produce:

- **Linux**: AppImage + `.deb`
- **macOS**: `.dmg` (universal)
- **Windows**: `.nsis` installer

```bash
npm run dist          # all targets supported on the host
npm run dist:linux    # only AppImage + deb
npm run dist:mac      # only dmg
npm run dist:win      # only nsis
```

Outputs land in `dist/`.

> **Note**: the binaries are unsigned by default. macOS Gatekeeper and
> Windows SmartScreen will warn on first launch until you sign them. The
> Linux AppImage is fully self-contained.

## Acknowledgements

Avatar component © [CX ArtLab / agent-robot-avatar](https://github.com/CX-ArtLab/agent-robot-avatar),
MIT licensed. The character is their original design; this project just
gives it a floating desktop window and a CLI handle.

## License

MIT (same as upstream). See `LICENSE`.
