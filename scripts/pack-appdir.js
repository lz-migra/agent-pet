/**
 * Capa 2: package `dist/appdir/` into the platform's portable format.
 *
 * Linux  → AppImage  (PRIMARY; define the format decided at project start)
 * macOS  → .dmg/.zip via electron-builder (not implemented yet)
 * Win    → nsis via electron-builder (not implemented yet)
 *
 * Required tooling on Linux:
 *
 *   - appimagetool (https://github.com/AppImage/AppImageKit/releases)
 *     installed somewhere on $PATH.
 *   - mksquashfs  (apt install squashfs-tools)
 *
 * Both are required; without them the script refuses to run rather than
 * silently producing a non-portable fallback.
 *
 * AppImage structure we build:
 *
 *   Agent Pet-0.1.0-x86_64.AppImage
 *     AppRun                       (a generated shim that execs ./appdir/agent-pet)
 *     agent-pet.desktop            (so file managers show the app)
 *     agent-pet.svg                (icon — optional)
 *     appdir/
 *       agent-pet                  (POSIX shim)
 *       agent-pet.js               (Node dispatcher)
 *       resources/
 *         ├── app.asar
 *         ├── gui/
 *         └── cli/agent-pet-cli
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT = path.join(__dirname, '..');
const APPDIR = path.join(PROJECT, 'dist', 'appdir');
const OUT_DIR = path.join(PROJECT, 'dist');

if (!fs.existsSync(APPDIR)) {
  console.error('expected ' + APPDIR + ' — run prepare-appdir.js first.');
  process.exit(1);
}

function detectBinaryPlatform() {
  const candidates = [
    path.join(APPDIR, 'resources', 'gui', 'agent-pet-gui'),
    path.join(APPDIR, 'resources', 'gui', 'Agent Pet.exe'),
    path.join(APPDIR, 'resources', 'gui', 'Agent Pet')
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      return { name: 'agent-pet-gui', platform: 'linux' };
    }
    if (buf[0] === 0x4d && buf[1] === 0x5a) {
      return { name: 'Agent Pet.exe', platform: 'windows' };
    }
    if ((buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) ||
        (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce)) {
      return { name: 'Agent Pet', platform: 'mac' };
    }
  }
  return { name: null, platform: null };
}

function whichOrFail(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  const path_ = (r.stdout || '').trim();
  if (!path_) {
    throw new Error('required tool "' + name + '" is not on $PATH');
  }
  return path_;
}

function execOrFail(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error('command failed: ' + cmd + ' ' + args.join(' ') + ' (exit ' + r.status + ')');
  }
}

/**
 * Build an AppImage from the appdir using the AppImage convention:
 * the AppDir is the directory we pass to appimagetool.
 *
 * appimagetool will:
 *   - generate AppRun (a wrapper that execs the main executable)
 *   - generate the .desktop file (if missing)
 *   - run mksquashfs to pack the AppDir
 *   - prepend the runtime squashfs+elf header
 */
function buildAppImage() {
  if (process.platform !== 'linux') {
    console.log('[pack] not on linux; skipping AppImage.');
    return null;
  }
  const appimagetool = whichOrFail('appimagetool');
  console.log('[pack] using appimagetool:', appimagetool);

  // Verify the AppDir layout: appimagetool needs `agent-pet` (or
  // AppRun / a .desktop file pointing to one of these) at its root.
  const rootNames = fs.readdirSync(APPDIR);
  const hasExe = rootNames.includes('agent-pet') ||
                 rootNames.some(n => isExecutableFile(path.join(APPDIR, n)));
  if (!hasExe) {
    throw new Error('AppDir must contain an executable at its root (run prepare-appdir.js first).');
  }

  const out = path.join(OUT_DIR, `Agent Pet-0.1.0-x86_64.AppImage`);
  // appimagetool syntax:
  //   appimagetool <AppDir> <output>
  // It will:
  //   - generate a default AppRun that execs ./agent-pet
  //   - generate a default <name>.desktop alongside the chosen exe
  //   - run mksquashfs on the AppDir
  //   - prepend the runtime/elf header
  execOrFail(appimagetool, [APPDIR, out]);
  return out;
}

(function main() {
  const { platform } = detectBinaryPlatform();
  if (!platform) {
    console.error('[pack] could not detect platform from appdir binary.');
    process.exit(1);
  }
  console.log('[pack] detected platform:', platform);

  if (platform === 'linux') {
    const out = buildAppImage();
    if (out) console.log('[pack] AppImage written:', out);
    return;
  }

  // Fallbacks for non-Linux targets use electron-builder directly; we
  // don't ship those flows yet. Run `npm run dist:mac` / `dist:win`.
  console.log('[pack] not linux; run `npm run dist:' + platform + '` to build that platform.');
})();
