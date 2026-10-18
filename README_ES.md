# Agent Pet

[English](README.md) · [Español](README_ES.md)

Una mascota de escritorio flotante y con ventana transparente, impulsada por
[`agent-robot-avatar`](https://github.com/CX-ArtLab/agent-robot-avatar),
envuelta en Electron y controlable desde cualquier terminal con una sola CLI:

```bash
agent-pet                 # inicia el GUI en segundo plano
agent-pet react success   # la mascota reproduce la animación de éxito
agent-pet react warning
agent-pet quit            # lo apaga
```

La mascota vive en una ventana sin marco, transparente y siempre encima.
La CLI se comunica con ella por un socket Unix / named pipe local.

## Requisitos

- Node.js ≥ 18
- npm ≥ 9
- Un entorno de escritorio con composición en Linux (X11 + un compositor, o
  Wayland) para que `transparent: true` se vea bien. En Windows y macOS
  funciona directamente.
- Solo para el empaquetado en Linux (`npm run pack:linux`): `appimagetool` y
  `mksquashfs` en el `$PATH`.

## Inicio rápido (desarrollo)

```bash
git clone <this repo>
cd agent-pet
npm install

# En una terminal: enlaza la CLI para que funcione desde cualquier sitio.
npm link

# Arranca la mascota flotante. La CLI lanza el GUI automáticamente si no
# está corriendo, así que `agent-pet react success` "simplemente funciona".
agent-pet                       # alias de `agent-pet init`
agent-pet react success
agent-pet react warning
agent-pet quit                  # lo apaga
```

El avatar aparece en una ventana sin marco, transparente y siempre encima.
Arrástralo a cualquier parte con el ratón. Clic derecho para el menú de la
bandeja (mostrar/ocultar, salir).

También puedes ejecutar el GUI en modo desarrollo (recarga al editar):

```bash
npm run dev       # la misma ventana, servida desde src/ en vez de app.asar
```

## Referencia de la CLI

```
agent-pet                       inicia el GUI en segundo plano (alias de init)
agent-pet init                  igual que arriba; idempotente
agent-pet play <action>         ejecuta una acción y espera a que termine
agent-pet react <action>        alias de play
agent-pet reset                 detiene la acción y vuelve a idle
agent-pet list                  lista las acciones conocidas
agent-pet status                muestra el estado actual (última acción, pid, hora de
                                inicio, timeout de idle, frame rate, click-through)
agent-pet show | hide           alterna la visibilidad de la ventana
agent-pet quit                  apaga el GUI

Depuración / ajuste:
agent-pet debug-hitbox          alterna el contorno de la región de clic
agent-pet devtools              abre/cierra las DevTools del renderer
agent-pet set-idle [ms]         muestra (sin args) o fija el timeout de idle;
                                0 desactiva el auto-sleep
agent-pet set-fps [fps]         muestra (sin args) o fija la tasa de dibujo, 1–240;
                                por defecto 60 (usa 30 para reducir la CPU a la mitad)

agent-pet --help
agent-pet --version
```

Cualquier comando que hable con el GUI (`play`, `reset`, …) **arranca el GUI
automáticamente** si no está corriendo. Así `agent-pet react success` funciona
incluso tras un arranque limpio, siempre que `agent-pet` esté en tu `$PATH`.

Acciones disponibles (refleja `agent-robot-avatar` v0.5.2):

```
idle, bored, waiting, waiting-wrap, input, send,
success, failure, warning, inspect, blocked, error,
surprise, love, random, slot, sleep, wake
```

Códigos de salida:

- `0` éxito
- `2` error de uso
- `75` el GUI no puede arrancar / IPC no disponible
- `1` el servidor respondió con un error

## Cómo funciona el IPC

- **Linux/macOS**: socket de dominio Unix en
  `$XDG_RUNTIME_DIR/agent-pet.sock` (alternativa `~/.cache/agent-pet/agent-pet.sock`).
- **Windows**: named pipe `\\.\pipe\agent-pet`.
- Protocolo: NDJSON (un objeto JSON por línea), estilo petición/respuesta.

Ejemplo de petición (lo que envía la CLI internamente):

```json
{"id":"1","cmd":"play","args":["success"]}
```

Respuesta:

```json
{"id":"1","ok":true,"result":{"ok":true}}
```

El proceso main espera a que `avatar.play(...)` termine antes de responder, así
que `agent-pet react success` bloquea hasta que la animación acaba. Útil en
pipelines de shell:

```bash
agent-pet react waiting
some_long_command
agent-pet react success
```

## Comportamiento en el escritorio

La ventana es deliberadamente mínima, así que la mayor parte de la lógica del
host en `src/main/main.js` consiste en mantener utilizable una superficie
transparente, click-through y siempre encima:

- **Arrastrar para mover**: agarra la mascota y muévela a cualquier parte de la
  pantalla. Un pequeño umbral de movimiento mantiene funcionando los clics
  normales (y deja pasar los gestos de la cabeza), y la posición se recuerda
  entre arranques.
- **Click-through**: solo la silueta del robot debe capturar el ratón; el resto
  deja pasar los clics al escritorio. El renderer muestrea el contorno SVG de la
  cabeza del avatar en un polígono (más un círculo para la antena) y lo reporta.
  El proceso main sondea el puntero global y alterna `setIgnoreMouseEvents`, con
  un pequeño margen para que el borde animado no parpadee. En Wayland —donde
  Electron no puede leer el puntero global— puede leerlo en su lugar de una
  extensión de GNOME Shell ("QueryPointerServer") por HTTP local; si no, recurre
  a Electron.
- **Seguimiento de mirada/cabeza**: una ventana click-through rara vez recibe
  eventos reales de puntero, así que el proceso main reenvía al renderer la
  posición del cursor global, manteniendo los ojos/cabeza del avatar siguiendo el
  cursor en cualquier parte de la pantalla.
- **Sueño/despertar por inactividad**: tras un periodo sin actividad del puntero,
  la mascota reproduce `sleep`; mover el cursor sobre ella reproduce `wake`. El
  timeout se configura con `set-idle` / `$AGENT_PET_IDLE_MS` (por defecto 5
  minutos; `0` lo desactiva).
- **Frame rate**: el componente upstream se limita a ~30 fps. `set-fps`
  (persistido) permite que la mascota corra más rápido (por defecto 60). La copia
  vendorizada en `src/renderer/vendor/` lleva un pequeño parche local para esto —
  busca los marcadores `PATCH(agent-pet)` si actualizas el componente upstream.

## Configuración

Variables de entorno:

- `AGENT_PET_GUI_BIN` — ruta al binario del GUI (anula la autodetección).
- `AGENT_PET_EXTRA_ARGS` — flags extra que se pasan al GUI al lanzarlo, p. ej.
  `AGENT_PET_EXTRA_ARGS=--no-sandbox`.
- `AGENT_PET_IDLE_MS` — timeout de idle en ms; tiene prioridad sobre `set-idle`
  hasta reiniciar.
- `AGENT_PET_FRAME_RATE` — tasa de dibujo; tiene prioridad sobre `set-fps` hasta
  reiniciar (por defecto 60).
- `AGENT_PET_SOFTWARE_GPU` — ponlo a `1` para forzar render por software (Linux),
  en equipos sin un proceso GPU funcional.
- `AGENT_PET_NO_CLICK_THROUGH` — ponlo a `1` para que la ventana sea siempre
  interactiva (desactiva el click-through por silueta).
- `AGENT_PET_POINTER_URL` / `AGENT_PET_POINTER_INFO` /
  `AGENT_PET_POINTER_POLL_MS` — anulan el descubrimiento/sondeo del puntero en
  Wayland.

Archivos (bajo el directorio de config de la plataforma, `~/.config/agent-pet/`
en Linux):

- `config.json` — cachea la ruta del binario del GUI descubierta.
- `settings.json` — `idleTimeoutMs` y `frameRate` persistidos.
- `window-state.json` — posición y tamaño de la ventana guardados.
- `gui.log` — stdout/stderr del GUI; `apprun.log` — traza del shim de la CLI.

## Estructura del proyecto

```
bin/
├── agent-pet             # shim de bash; la entrada `bin` de npm (enruta CLI vs GUI)
├── agent-pet.js          # dispatcher de Node: clasifica los args, lanza el destino
└── agent-pet-cli.js      # el cliente real de la CLI (socket, auto-arranque, config)
src/
├── main/
│   ├── main.js           # entrada de Electron: ventana, ciclo de vida, dispatcher
│   ├── preload.js        # contextBridge -> window.pet (la API del renderer)
│   └── socket-server.js  # servidor IPC NDJSON
└── renderer/
    ├── index.html        # escenario transparente; carga vendor + renderer como ESM
    ├── renderer.js       # monta el avatar; expone window.__pet
    └── vendor/           # copia vendorizada (+ parcheada) de agent-robot-avatar,
                          #   cargada con <script type=module> para que la
                          #   resolución de imports funcione en loadFile de Electron
scripts/
├── prepare-appdir.js     # prepara dist/appdir/ para el empaquetado AppImage
└── pack-appdir.js        # construye el AppImage (appimagetool + mksquashfs)
assets/                   # icono y entrada .desktop
test/
├── smoke.js              # test IPC de extremo a extremo (sin Electron)
└── dispatcher.test.js    # test del dispatcher
```

> Nota: en la raíz del repositorio queda un `main.js` obsoleto del bootstrap
> inicial. **No** se usa — el punto de entrada de Electron es `src/main/main.js`
> (el campo `main` de `package.json`).

## Desarrollo y pruebas

```bash
npm test                        # ejecuta test/smoke.js (headless, sin Electron)
node test/dispatcher.test.js    # pruebas de validación de comandos
```

Ambos tests levantan el servidor IPC real con un dispatcher falso, así que corren
sin pantalla.

## Empaquetado (multiplataforma)

`electron-builder` está configurado en `package.json` (appId
`com.cxartlab.agentpet`, nombre de producto "Agent Pet", salida `dist/`). Produce
por plataforma:

- **Linux**: AppImage (construido con un flujo appdir en dos etapas — ver abajo).
- **macOS**: `.dmg`.
- **Windows**: instalador `.nsis`.

```bash
npm run dist          # electron-builder con los targets por defecto del host
npm run dist:linux    # prepara el appdir y luego construye el AppImage
npm run dist:mac      # solo dmg
npm run dist:win      # solo nsis
```

La ruta de Linux está dividida a propósito:

- `npm run stage:linux` → `electron-builder --linux dir` (build sin empaquetar)
  más `scripts/prepare-appdir.js`, que reorganiza la salida en `dist/appdir/`
  (el runtime de Electron bajo `resources/gui/`, la CLI bajo `resources/cli/`,
  más el shim `AppRun` y el dispatcher `agent-pet.js`).
- `npm run pack:linux` → `scripts/pack-appdir.js`, que empaqueta ese AppDir en
  `dist/Agent Pet-0.1.0-x86_64.AppImage` usando `appimagetool` y `mksquashfs`
  (ambos deben estar en `$PATH`).

`npm run dist:linux` ejecuta las dos etapas. Ojo: la config normal de
`electron-builder` solo declara el target Linux `dir`; el AppImage viene de este
flujo propio, no de `npm run dist`.

> **Nota**: los binarios no están firmados por defecto. Gatekeeper en macOS y
> SmartScreen en Windows avisarán en el primer arranque hasta que los firmes. El
> AppImage de Linux es completamente autocontenido.

## Agradecimientos

Componente de avatar © [CX ArtLab / agent-robot-avatar](https://github.com/CX-ArtLab/agent-robot-avatar),
con licencia MIT. El personaje es su diseño original; este proyecto solo le da
una ventana de escritorio flotante y un mando de CLI.

## Licencia

MIT (igual que upstream). Ver `LICENSE`.
