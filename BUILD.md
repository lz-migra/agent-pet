# Cómo se compila Agent Pet

Este documento registra el sistema de build del proyecto para que quede como
referencia. Está verificado contra el estado actual del repo
(Electron **32.3.3**, electron-builder **25.1.8**, Node **v24**).

## Resumen

Agent Pet **no usa los targets "listos" de electron-builder en Linux**. Se apoya
en electron-builder solo para armar el runtime de Electron y el `app.asar`; la
reestructuración final y el empaquetado del AppImage los hacen scripts propios
en dos etapas.

- **macOS** y **Windows** van por electron-builder directo (`--mac` / `--win`).
- **Linux** pasa por un flujo propio de dos etapas (staging + packing).

## Requisitos

- Node.js ≥ 18 y npm ≥ 9.
- `electron` y `electron-builder` (devDependencies del repo).
- Para el AppImage de Linux, **ambos** en el `$PATH`:
  - `appimagetool` (AppImageKit)
  - `mksquashfs` (paquete `squashfs-tools`)
- Nota de este entorno: el `.npmrc` avisa de que los *postinstall scripts* están
  bloqueados, así que el paso nativo de Electron (`postinstall` =
  `electron-builder install-app-deps`) puede necesitar el override que documenta
  ese archivo.

## Comandos

| Comando | Qué hace | Resultado |
|---|---|---|
| `npm run dev` / `npm start` | `electron .` desde `src/` | ventana en vivo, sin empaquetar |
| `npm run dist` | `electron-builder` | en Linux **solo** `dist/linux-unpacked/` (no AppImage) |
| `npm run stage:linux` | `electron-builder --linux dir` **+** `scripts/prepare-appdir.js` | `dist/linux-unpacked/` y `dist/appdir/` |
| `npm run pack:linux` | `scripts/pack-appdir.js` | `dist/Agent Pet-0.1.0-x86_64.AppImage` |
| `npm run dist:linux` | las dos etapas anteriores | AppImage final |
| `npm run dist:mac` | `electron-builder --mac` | `.dmg` |
| `npm run dist:win` | `electron-builder --win` | instalador `.nsis` |

## Flujo (Linux, dos etapas)

```
npm run dist:linux
        │
        ├─ ETAPA 1  (npm run stage:linux)
        │   ├─ electron-builder --linux dir      →  dist/linux-unpacked/   (binario: agent-pet-gui)
        │   └─ node scripts/prepare-appdir.js    →  dist/appdir/           (reorganiza todo)
        │
        └─ ETAPA 2  (npm run pack:linux)
            └─ node scripts/pack-appdir.js       →  appimagetool + mksquashfs
                                                 →  dist/Agent Pet-0.1.0-x86_64.AppImage  (~95 MB)
```

## Layout que produce `dist/appdir`

```
dist/appdir/
├── AppRun                 # el shim bash, copiado desde bin/agent-pet
├── agent-pet              # symlink -> AppRun
├── agent-pet.js           # dispatcher Node (CLI vs GUI)
├── agent-pet.desktop
├── agent-pet.png
└── resources/
    ├── cli/
    │   └── agent-pet-cli  # = bin/agent-pet-cli.js, renombrado + chmod 755
    └── gui/               # TODO el runtime de Electron, movido aquí
        ├── agent-pet-gui  # binario Electron (~185 MB)
        ├── chrome-sandbox, *.pak, lib*.so, locales/ …
        └── resources/
            └── app.asar   # movido aquí (no en gui/ directamente)
```

## Particularidades

1. **`npm run dist` no genera el AppImage en Linux.** El `build.linux.target`
   de `package.json` solo declara `"dir"`. Todo el AppImage sale del flujo propio
   de dos etapas. Es fácil creer que `npm run dist` es "el build" y quedarse con
   un `linux-unpacked/` sin AppImage.

2. **`appimagetool` no está instalado en este entorno.** Verificado con
   `which appimagetool mksquashfs`: solo existe `mksquashfs`. `pack-appdir.js`
   hace `whichOrFail('appimagetool')` y aborta si falta. Instálalo antes de
   `pack:linux` / `dist:linux`.

3. **El layout es no estándar a propósito.** `prepare-appdir.js` mueve **todo**
   el runtime de Electron dentro de `resources/gui/`, y coloca el `app.asar` en
   `resources/gui/resources/app.asar` en vez de `resources/app.asar`. La razón:
   Electron busca `resources/app.asar` relativo al directorio del binario; como
   el binario está movido, el asar debe moverse con él. Por eso el CLI acepta
   tantos nombres/layouts en `findGuiBin()`.

4. **Un solo binario cumple dos roles.** El shim (`bin/agent-pet`, copiado a
   `AppRun`) decide con el primer argumento: para un subcomando conocido ejecuta
   el **mismo binario Electron** con `ELECTRON_RUN_AS_NODE=1` para que actúe como
   Node y corra la CLI; sin argumentos lo ejecuta como GUI normal. Esto evita
   empaquetar un Node aparte y explica el `ELECTRON_RUN_AS_NODE` en
   `listGuiPids()` (para no matar la propia CLI al limpiar procesos).

5. **`extraResources` copia `bin/` a `resources/bin/`**, y de ahí
   `prepare-appdir.js` toma solo `agent-pet-cli.js` y lo renombra a
   `resources/cli/agent-pet-cli` con `chmod 755`. El `agent-pet-cli` final no
   existe con ese nombre en el repo: se crea durante el staging.

6. **Redundancia en el asar.** El renderer carga la copia **vendored**
   (`src/renderer/vendor/`), pero `agent-robot-avatar` sigue siendo dependencia de
   producción, así que electron-builder mete también
   `node_modules/agent-robot-avatar/` completo (con assets y docs) en
   `app.asar`. El asar contiene las dos copias; la de `node_modules` nunca se
   importa en runtime. Además `src/renderer/vendor/index.d.ts` queda **fuera**
   del asar: el patrón por defecto de electron-builder ignora `*.d.ts`
   (visible en `dist/builder-debug.yml`). Inofensivo (son solo tipos) pero
   sorprendente.

7. **Comentarios desactualizados en los scripts.** `prepare-appdir.js` dice que
   `AppRun` "NOT created here; appimagetool generates it", pero el script **sí**
   lo crea (paso 4). Y `pack-appdir.js` describe un AppImage con una carpeta
   `appdir/` anidada; al inspeccionar el AppImage real el contenido está **plano
   en la raíz** (`AppRun`, `agent-pet`, `resources/gui/...`), sin `appdir/`.
   Fíate del código, no de esos comentarios.

8. **El staging de mac/win no está implementado.** `prepare-appdir.js` lanza
   `"staging for mac/windows is not implemented yet"`; esas plataformas van por
   electron-builder directo. Además el nombre del binario difiere:
   `agent-pet-gui` en Linux, `agent-pet` en mac/win (campo `executableName`).

9. **Detalles de empaquetado.** El `.npmrc` documenta el bloqueo de
   postinstall. electron-builder deja un `app-update.yml` aunque no haya
   configuración de publicación. Y las builds van **sin firmar** por defecto
   (Gatekeeper/SmartScreen avisarán).

## Reconstruir el AppImage

1. Asegúrate de tener `appimagetool` y `mksquashfs` en el `$PATH`.
2. Ejecuta `npm run dist:linux` (equivale a `stage:linux` + `pack:linux`).
3. Verifica el resultado:
   - Listar el contenido del AppImage. El squashfs **no empieza en el offset 0**
     (el ejecutable lleva el runtime delante), así que `unsquashfs` falla sin
     indicar el offset. Localízalo buscando el *superblock* real (los bytes
     `hsqs` seguidos de ceros y `block_size`, no el que aparece dentro del
     runtime) y pásalo con `-o`; p. ej.
     `unsquashfs -o <offset> -l "dist/Agent Pet-0.1.0-x86_64.AppImage"`.
   - Inspeccionar el `app.asar`:
     `node -e "console.log(require('@electron/asar').listPackage('dist/linux-unpacked/resources/app.asar').join('\n'))"`.

## Dónde mirar

- **Config declarativa:** el bloque `"build"` de `package.json`.
- **Reestructuración (etapa 1):** `scripts/prepare-appdir.js` — aquí está casi
  toda la "particularidad" del build.
- **Empaquetado del AppImage (etapa 2):** `scripts/pack-appdir.js`.
- **Detección del binario en runtime:** `bin/agent-pet.js` y
  `bin/agent-pet-cli.js` (`findGuiBin` / `defaultGuiBin`), que codifican
  suposiciones sobre el layout final. Si tocas `extraResources` o los nombres
  del binario, revisa los tres en cadena.
