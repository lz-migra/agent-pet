#!/usr/bin/env bash
# Test completo del AppImage. Ejecuta esto desde tu terminal interactiva
# (NO con Ctrl-C en medio; deja que termine).
set -e
APP="/home/lordloro05/GitHub/agent-pet/dist/Agent Pet-0.1.0-x86_64.AppImage"
APPDIR="/home/lordloro05/GitHub/agent-pet/dist/appdir"

echo "==> Limpiando estado previo"
pkill -9 -f agent-pet-gui 2>/dev/null || true
pkill -9 -f "Agent Pet" 2>/dev/null || true
rm -f /run/user/1000/agent-pet.sock
rm -f ~/.config/agent-pet/Singleton*

echo
echo "==> Test 1: ayuda y version"
"$APP" --version
echo "---"
"$APP" --help | head -8

echo
echo "==> Test 2: arranca GUI en foreground (Ctrl-C para salir)"
echo "   Esto abrira la ventana del robot. Si la ves, perfecto."
echo "   El socket y los singletons deben aparecer en /run y ~/.config"
"$APPDIR/AppRun" &
GUIPID=$!
sleep 4
echo "socket?    $(ls -la /run/user/1000/agent-pet.sock 2>/dev/null | awk '{print $NF}' || echo no)"
echo "procesos?  $(pgrep -af 'resources/gui/agent-pet-gui' | head -1 || echo no)"
kill -9 $GUIPID 2>/dev/null
wait 2>/dev/null
pkill -9 -f agent-pet-gui 2>/dev/null || true
