# Agent Pet

[English](README.md) · [Español](README_ES.md)

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
- For Linux packaging (`npm run pack:linux`) only: `appimagetool` and
  `mksquashfs` on `$PATH`.

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
Drag it anywhere with the mouse. Right-click for a tray menu (show/hide, quit).

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
agent-pet status                show current state (last action, pid, start time,
                                idle timeout, frame rate, click-through info)
agent-pet show | hide           toggle window visibility
agent-pet quit                  shut down the GUI

Debugging / tuning:
agent-pet debug-hitbox          toggle the click-region overlay (dashed outline)
agent-pet devtools              toggle the renderer DevTools window
agent-pet set-idle [ms]         show (no args) or set the idle sleep timeout;
                                0 disables auto-sleep
agent-pet set-fps [fps]         show (no args) or set the draw rate, 1–240;
                                default 60 (use 30 to halve CPU usage)

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

## Desktop behaviour

The window is intentionally minimal, so most of the host logic in
`src/main/main.js` is about keeping a transparent, click-through,
always-on-top surface usable:

- **Click-through**: only the robot silhouette should capture the mouse;
  everything else lets clicks reach the desktop. The renderer samples the
  avatar's SVG head outline into a polygon (plus a circle for the antenna)
  and reports it. The main process polls the global pointer and toggles
  `setIgnoreMouseEvents`, with a small margin so the animating edge doesn't
  flicker. On Wayland — where Electron can't read the global pointer — it can
  instead read it from a GNOME Shell extension ("QueryPointerServer") over
  local HTTP; otherwise it falls back to Electron.
- **Gaze / head follow**: a click-through window rarely receives real pointer
  events, so the main process forwards the global cursor position to the
  renderer, keeping the avatar's eyes/head following the cursor anywhere on
  screen.
- **Idle sleep / wake**: after a period without pointer activity the pet plays
  `sleep`; moving the cursor over it plays `wake`. The timeout is configurable
  with `set-idle` / `$AGENT_PET_IDLE_MS` (default 5 minutes; `0` disables it).
- **Frame rate**: the upstream component caps itself at ~30 fps. `set-fps`
  (persisted) lets the pet run higher (default 60). The vendored copy under
  `src/renderer/vendor/` carries a small local patch for this — look for
  `PATCH(agent-pet)` markers if you bump the upstream component.

## Configuration

Environment variables:

- `AGENT_PET_GUI_BIN` — path to the GUI binary (overrides auto-discovery).
- `AGENT_PET_EXTRA_ARGS` — extra flags passed to the GUI at launch, e.g.
  `AGENT_PET_EXTRA_ARGS=--no-sandbox`.
- `AGENT_PET_IDLE_MS` — idle timeout in ms; takes precedence over `set-idle`
  until restart.
- `AGENT_PET_FRAME_RATE` — draw rate; takes precedence over `set-fps` until
  restart (default 60).
- `AGENT_PET_SOFTWARE_GPU` — set to `1` to force software rendering (Linux),
  for boxes without a working GPU process.
- `AGENT_PET_NO_CLICK_THROUGH` — set to `1` to keep the window always
  interactive (disable silhouette-based click-through).
- `AGENT_PET_POINTER_URL` / `AGENT_PET_POINTER_INFO` /
  `AGENT_PET_POINTER_POLL_MS` — override Wayland pointer discovery/polling.

Files (under the platform config dir, `~/.config/agent-pet/` on Linux):

- `config.json` — caches the discovered GUI binary path.
- `settings.json` — persisted `idleTimeoutMs` and `frameRate`.
- `window-state.json` — saved window position and size.
- `gui.log` — GUI stdout/stderr; `apprun.log` — CLI shim trace.

## Project layout

```
bin/
├── agent-pet             # bash shim; the npm `bin` entry (CLI vs GUI routing)
├── agent-pet.js          # Node dispatcher: classifies args, spawns the target
└── agent-pet-cli.js      # the actual CLI client (socket, auto-start, config)
src/
├── main/
│   ├── main.js           # Electron entry: window, lifecycle, command dispatcher
│   ├── preload.js        # contextBridge -> window.pet (the renderer API)
│   └── socket-server.js  # NDJSON IPC server
└── renderer/
    ├── index.html        # transparent stage; loads vendor + renderer as ESM
    ├── renderer.js       # mounts the avatar; exposes window.__pet
    └── vendor/           # vendored (+ patched) copy of agent-robot-avatar,
                          #   loaded by <script type=module> so import
                          #   resolution works inside Electron's loadFile
scripts/
├── prepare-appdir.js     # stage dist/appdir/ for AppImage packaging
└── pack-appdir.js        # build the AppImage (appimagetool + mksquashfs)
assets/                   # icon and .desktop entry
test/
├── smoke.js              # end-to-end IPC test (no Electron needed)
└── dispatcher.test.js    # dispatcher unit-ish test
```

> Note: a stale `main.js` from the initial bootstrap still sits at the repository
> root. It is **not** used — the Electron entry point is `src/main/main.js` (the
> `main` field in `package.json`).

## Development & tests

```bash
npm test                        # runs test/smoke.js (headless, no Electron)
node test/dispatcher.test.js    # command validation tests
```

Both tests spin up the real IPC server with a fake dispatcher, so they run
without a display.

## Packaging (multi-platform)

`electron-builder` is configured in `package.json` (appId
`com.cxartlab.agentpet`, product name "Agent Pet", output `dist/`). It produces
per platform:

- **Linux**: AppImage (built via a two-stage appdir flow — see below).
- **macOS**: `.dmg`.
- **Windows**: `.nsis` installer.

```bash
npm run dist          # electron-builder with the host's default targets
npm run dist:linux    # stage the appdir, then build the AppImage
npm run dist:mac      # only dmg
npm run dist:win      # only nsis
```

The Linux path is deliberately split:

- `npm run stage:linux` → `electron-builder --linux dir` (unpacked build) plus
  `scripts/prepare-appdir.js`, which reorganises the output into
  `dist/appdir/` (the Electron runtime under `resources/gui/`, the CLI under
  `resources/cli/`, plus the `AppRun` shim and `agent-pet.js` dispatcher).
- `npm run pack:linux` → `scripts/pack-appdir.js`, which packs that AppDir into
  `dist/Agent Pet-0.1.0-x86_64.AppImage` using `appimagetool` and
  `mksquashfs` (both must be on `$PATH`).

`npm run dist:linux` runs both stages. Note that the plain `electron-builder`
config only declares the Linux `dir` target; the AppImage comes from this
custom flow, not from `npm run dist`.

> **Note**: the binaries are unsigned by default. macOS Gatekeeper and
> Windows SmartScreen will warn on first launch until you sign them. The
> Linux AppImage is fully self-contained.

## Acknowledgements

Avatar component © [CX ArtLab / agent-robot-avatar](https://github.com/CX-ArtLab/agent-robot-avatar),
MIT licensed. The character is their original design; this project just
gives it a floating desktop window and a CLI handle.

## License

MIT (same as upstream). See `LICENSE`.
