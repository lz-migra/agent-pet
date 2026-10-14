/**
 * IPC server: receives commands from `agent-pet` CLI and forwards them
 * to the renderer (where the avatar lives).
 *
 * Transport:
 *  - Linux/macOS: Unix domain socket in XDG_RUNTIME_DIR (fallback ~/.cache)
 *  - Windows:     named pipe `\\.\pipe\agent-pet`
 *
 * Protocol: NDJSON (one JSON object per line), request/response with ids.
 *
 *   --> {"id":"1","cmd":"play","args":["success"]}
 *   <-- {"id":"1","ok":true,"result":null}
 *
 * The handler is async: we await the renderer's reply before responding,
 * so the CLI can know when a play() has finished its animation.
 */
'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KNOWN_COMMANDS = ['play', 'reset', 'status', 'list', 'react'];

function isWindows() {
  return process.platform === 'win32';
}

function getSocketPath() {
  if (isWindows()) return '\\\\.\\pipe\\agent-pet';
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && fs.existsSync(runtime)) {
    return path.join(runtime, 'agent-pet.sock');
  }
  const cache = path.join(os.homedir(), '.cache', 'agent-pet');
  fs.mkdirSync(cache, { recursive: true });
  return path.join(cache, 'agent-pet.sock');
}

/**
 * @param {(req: {id:string,cmd:string,args:string[]}) => Promise<any>} dispatcher
 *        invoked in main; must return a JSON-serializable value OR throw.
 *        Throw → reply { ok:false, error: <message> }.
 * @returns {{ address: string, listen: () => Promise<{close:()=>void}> }}
 */
function createIpcServer(dispatcher) {
  const address = getSocketPath();

  // Windows cleanup
  if (!isWindows() && fs.existsSync(address)) {
    try { fs.unlinkSync(address); } catch (_) {}
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', async (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch (err) {
          const reply = JSON.stringify({ ok: false, error: 'invalid json: ' + err.message }) + '\n';
          socket.write(reply);
          continue;
        }
        const respond = (payload) => {
          const reply = JSON.stringify({ id: req.id, ...payload }) + '\n';
          if (socket.writable) socket.write(reply);
        };
        try {
          const result = await dispatcher(req);
          respond({ ok: true, result: result ?? null });
        } catch (err) {
          respond({ ok: false, error: err && err.message ? err.message : String(err) });
        }
      }
    });

    socket.on('error', () => { /* swallow peer errors */ });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        if (!isWindows()) {
          try { fs.chmodSync(address, 0o600); } catch (_) {}
        }
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(address);
    });
  }

  function close() {
    return new Promise((resolve) => {
      // Force any lingering connections closed; `server.close` alone
      // waits indefinitely if peer FDs are stuck.
      if (typeof server.closeAllConnections === 'function') {
        try { server.closeAllConnections(); } catch (_) {}
      }
      server.close(() => {
        if (!isWindows() && fs.existsSync(address)) {
          try { fs.unlinkSync(address); } catch (_) {}
        }
        resolve();
      });
    });
  }

  return { address, listen, close };
}

module.exports = { createIpcServer, getSocketPath, KNOWN_COMMANDS };
