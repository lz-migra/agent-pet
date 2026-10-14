/**
 * Stage the unpacked agent-pet distribution into `dist/appdir/`.
 *
 * The output IS a valid AppDir — the very same directory we hand to
 * appimagetool to produce the AppImage. It can also be run directly
 * on a Linux machine that already has Node: `cd dist/appdir && ./agent-pet list`.
 *
 * Layout (identical across platforms; this is the canonical format):
 *
 *   dist/appdir/                       (== the AppDir)
 *   ├── AppRun                         (NOT created here; appimagetool generates it
 *   │                                   by default — we disable that with a flag
 *   │                                   and let our shim act as the entry)
 *   ├── agent-pet                      POSIX shim: `exec node ./agent-pet.js "$@"`
 *   ├── agent-pet.js                   Node dispatcher (CLI vs GUI)
 *   ├── agent-pet.desktop              file-manager metadata (optional)
 *   ├── resources/
 *   │   ├── app.asar
 *   │   ├── gui/
 *   │   │   ├── agent-pet-gui          Electron binary (.exe on Windows)
 *   │   │   ├── chrome-sandbox, *.pak, lib*.so, icudtl.dat, locales/, ...
 *   │   └── cli/
 *   │       └── agent-pet-cli
 *
 * Each artefact is produced by electron-builder once, with the right
 * name; this stage only REORGANISES the unpacked output without
 * renaming anything.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT = path.join(__dirname, '..');
const UNPACKED = path.join(PROJECT, 'dist', 'linux-unpacked');
const APPDIR = path.join(PROJECT, 'dist', 'appdir');

const POSIX_SHIM_SRC = path.join(PROJECT, 'bin', 'agent-pet');
const NODE_ENTRY_SRC = path.join(PROJECT, 'bin', 'agent-pet.js');
const DESKTOP_SRC = path.join(PROJECT, 'assets', 'agent-pet.desktop');

function rmrf(p) { return fs.rmSync(p, { recursive: true, force: true }); }
function mkdirs(p) { fs.mkdirSync(p, { recursive: true }); }
function copyFile(src, dest) {
  mkdirs(path.dirname(dest));
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, fs.statSync(src).mode);
}
function copyDirContents(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirContents(sp, dp);
    else if (entry.isFile()) copyFile(sp, dp);
  }
}
function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch (_) { return false; }
}
function hasElfMagic(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch (_) { return false; }
}

function stageLinux() {
  if (!fs.existsSync(UNPACKED)) {
    throw new Error('expected ' + UNPACKED + ' — run `electron-builder --linux dir` first');
  }
  console.log('[stage] source:', UNPACKED);

  rmrf(APPDIR);
  mkdirs(APPDIR);
  mkdirs(path.join(APPDIR, 'resources', 'gui'));
  mkdirs(path.join(APPDIR, 'resources', 'cli'));

  // 1. Detect the Electron binary. With our executableName=agent-pet-gui
  //    config it lands at the unpacked root named exactly that.
  const electronNames = ['agent-pet-gui', 'Agent Pet', 'agent-pet'];
  let electronBin = null;
  for (const name of electronNames) {
    const cand = path.join(UNPACKED, name);
    if (fs.existsSync(cand) && isExecutableFile(cand) && hasElfMagic(cand)) {
      electronBin = cand;
      break;
    }
  }
  if (!electronBin) {
    throw new Error('could not find Electron binary under ' + UNPACKED);
  }
  console.log('[stage] electron binary detected:', path.basename(electronBin));

  // 2. Copy every Electron runtime file (chrome-sandbox, *.pak, lib*.so,
  //    icudtl.dat, locales/, ..., app.asar) into resources/gui/.
  for (const entry of fs.readdirSync(UNPACKED)) {
    if (entry === path.basename(electronBin)) continue;
    if (entry === 'resources') continue;
    const src = path.join(UNPACKED, entry);
    const dest = path.join(APPDIR, 'resources', 'gui', entry);
    if (fs.statSync(src).isDirectory()) {
      copyDirContents(src, dest);
    } else {
      copyFile(src, dest);
    }
  }
  copyFile(electronBin, path.join(APPDIR, 'resources', 'gui', 'agent-pet-gui'));
  console.log('[stage] resources/gui/ ok');

  // 3. Place app.asar at <root>/resources/gui/resources/app.asar so Electron
  //    finds it via its default lookup: binary-dir/resources/app.asar.
  const unpackedResources = path.join(UNPACKED, 'resources');
  if (fs.existsSync(unpackedResources)) {
    for (const entry of fs.readdirSync(unpackedResources)) {
      const src = path.join(unpackedResources, entry);
      if (entry === 'app.asar') {
        copyFile(src, path.join(APPDIR, 'resources', 'gui', 'resources', 'app.asar'));
        console.log('[stage] app.asar -> resources/gui/resources/app.asar');
      } else if (entry === 'bin') {
        // extraResources: agent-pet (sh), agent-pet.js, agent-pet-cli.js.
        // We only need the CLI here — the dispatcher and shim live at
        // the AppDir root.
        const cliJs = path.join(src, 'agent-pet-cli.js');
        if (fs.existsSync(cliJs)) {
          copyFile(cliJs, path.join(APPDIR, 'resources', 'cli', 'agent-pet-cli'));
          fs.chmodSync(path.join(APPDIR, 'resources', 'cli', 'agent-pet-cli'), 0o755);
        }
      }
    }
  }

  // 4. Drop the dispatcher + POSIX shim at the AppDir root.
  //
  //    We name the shim "AppRun" (the standard AppImage entry convention)
  //    so appimagetool picks it up automatically without having to
  //    interpret the desktop file. A symlink with the conventional
  //    `agent-pet` name is added too so the user can invoke the AppImage
  //    by either path.
  copyFile(POSIX_SHIM_SRC, path.join(APPDIR, 'AppRun'));
  fs.symlinkSync('AppRun', path.join(APPDIR, 'agent-pet'));
  copyFile(NODE_ENTRY_SRC, path.join(APPDIR, 'agent-pet.js'));
  console.log('[stage] wrote AppRun and agent-pet.js (and agent-pet symlink)');

  // 5. Drop a .desktop file + icon for file-manager integration.
  if (fs.existsSync(DESKTOP_SRC)) {
    copyFile(DESKTOP_SRC, path.join(APPDIR, 'agent-pet.desktop'));
    console.log('[stage] wrote agent-pet.desktop');
  }
  const iconSrc = path.join(PROJECT, 'assets', 'agent-pet.png');
  if (fs.existsSync(iconSrc)) {
    copyFile(iconSrc, path.join(APPDIR, 'agent-pet.png'));
    console.log('[stage] wrote agent-pet.png');
  }

  console.log('[stage] done -> ' + APPDIR);
}

function main() {
  const platform = process.argv[2] || 'linux';
  if (platform === 'linux') return stageLinux();
  if (platform === 'mac' || platform === 'windows') {
    throw new Error('staging for ' + platform + ' is not implemented yet');
  }
  throw new Error('unknown platform: ' + platform);
}

main();
