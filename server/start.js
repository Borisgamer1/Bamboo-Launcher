// server/start.js — Cross-platform launcher for Bamboo Backend
// Starts admin.js (HTTP :3005) and index.js (Friends HTTP :3400 + WS :3401)
// as truly detached background processes that survive the npm `start` script exit.
// Works on Windows (PowerShell/cmd), macOS and Linux — no shell `&` tricks.

require('dotenv').config();

const { spawn, execSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ROOT_LOGS_DIR = path.join(ROOT, 'logs');
const PID_FILE = path.join(ROOT, '.bamboo-pids.json');
const ADMIN_PORT       = parseInt(process.env.ADMIN_PORT        || '3005');
const FRIENDS_HTTP_PORT = parseInt(process.env.FRIENDS_PORT     || '3400');
const FRIENDS_WS_PORT   = parseInt(process.env.FRIENDS_WS_PORT  || '3401');
const READY_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 200;

const SERVERS = [
  { name: 'Admin',   script: 'admin.js', ports: [ADMIN_PORT] },
  { name: 'Friends', script: 'index.js', ports: [FRIENDS_HTTP_PORT, FRIENDS_WS_PORT] },
];

const log  = (...a) => console.log('[start]', ...a);
const warn = (...a) => console.warn('[start]', ...a);

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
  } catch {}
}

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      out.split(/\r?\n/).filter(s => /^\d+$/.test(s.trim())).forEach(killPid);
    } else {
      try {
        const out = execSync(`lsof -ti tcp:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
        out.split(/\r?\n/).filter(Boolean).forEach(killPid);
      } catch {}
    }
  } catch {}
}

// Pre-flight: clean up any previous instances (PID file + port sweep)
let previous = {};
try { previous = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch {}
log('Cleaning up any previous instances…');
Object.values(previous).forEach(entry => {
  // back-compat: older .bamboo-pids.json stored a flat number
  const pid = (typeof entry === 'object' && entry !== null) ? entry.pid : entry;
  if (typeof pid === 'number') killPid(pid);
});
[ADMIN_PORT, FRIENDS_HTTP_PORT, FRIENDS_WS_PORT].forEach(killPort);

// Give the OS a moment to release sockets after taskkill (Windows TIME_WAIT
// can briefly prevent rebinding the same port even though no LISTEN shows).
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function launchServer(script) {
  // Pipe stdout/stderr to a per-process log file so failures (EADDRINUSE,
  // missing modules, PG errors, etc.) are visible to the user afterwards.
  // `stdio: ['ignore', logFd, logFd]` keeps the child detached while still
  // capturing everything it writes.
  let logFd;
  let logPath;
  try {
    if (!fs.existsSync(ROOT_LOGS_DIR)) fs.mkdirSync(ROOT_LOGS_DIR, { recursive: true });
    logPath = path.join(ROOT_LOGS_DIR, script.replace(/\.js$/, '') + '.log');
    logFd = fs.openSync(logPath, 'a');
  } catch (err) {
    console.error('[start] Konnte Log-Verzeichnis nicht erstellen:', ROOT_LOGS_DIR, '-', err.message);
    throw err;
  }
  let proc;
  try {
    proc = spawn(process.execPath, [path.join(ROOT, 'src', script)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: ROOT,
      env: process.env,
    });
  } catch (err) {
    try { fs.closeSync(logFd); } catch {}
    console.error('[start] Konnte', script, 'nicht starten:', err.message);
    throw err;
  }
  proc.unref(); // do not keep parent alive when only children remain
  // The child has already inherited (dup'd) the fd by the time spawn() returns,
  // so the parent can safely close its own copy.
  try { fs.closeSync(logFd); } catch {}
  return { pid: proc.pid, logPath };
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (Date.now() > deadline) return reject(new Error(`port ${port}`));
      const sock = new net.Socket();
      sock.setTimeout(POLL_INTERVAL_MS);
      sock.once('connect',  () => { sock.destroy(); resolve(); });
      sock.once('error',    () => { sock.destroy(); setTimeout(tick, POLL_INTERVAL_MS); });
      sock.once('timeout',  () => { sock.destroy(); setTimeout(tick, POLL_INTERVAL_MS); });
      sock.connect(port, '127.0.0.1');
    };
    tick();
  });
}

(async () => {
  // Brief sleep so any taskkilled sockets fully release back to LISTEN-able state.
  await sleep(process.platform === 'win32' ? 1500 : 400);

  const pids = {};
  let allReady = true;

  for (const srv of SERVERS) {
    const { pid, logPath } = launchServer(srv.script);
    const key = srv.name.toLowerCase();
    pids[key] = { pid, log: logPath };
    log(`→ Started ${srv.name} (PID ${pid}), log: ${path.relative(process.cwd(), logPath) || logPath}`);
    log(`   waiting for ports ${srv.ports.join(', ')}…`);
    for (const port of srv.ports) {
      try {
        await waitForPort(port, READY_TIMEOUT_MS);
        log(`✓ ${srv.name} listening on :${port}`);
      } catch {
        allReady = false;
        warn(`✗ ${srv.name} did NOT bind :${port} within ${READY_TIMEOUT_MS / 1000}s`);
        warn(`  → log: ${path.relative(process.cwd(), logPath) || logPath}`);
        try {
          const tail = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).slice(-6).join('\n');
          if (tail) {
            warn('  → last log lines:');
            for (const line of tail.split(/\r?\n/)) warn('    ' + line);
          }
        } catch {}
        warn('  → häufigste Ursache: ein anderer Prozess belegt bereits diesen Port (z.B. eine zweite Backend-Instanz in C:\\BambooBackend oder ein hängender node-Prozess).');
        warn('  → fix: `node stop.js` (killt alles auf 3005/3400/3401) und dann erneut `node start.js`.');
      }
    }
  }

  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));

  console.log('');
  if (allReady) {
    console.log('✅ Bamboo Backend gestartet (Friends:' + FRIENDS_HTTP_PORT + ' + Admin:' + ADMIN_PORT + ')');
  } else {
    console.log('⚠ Bamboo Backend gestartet MIT FEHLERN — siehe Logs in server/logs/');
  }
  console.log('   Admin-Server:   port ' + ADMIN_PORT       + '   PID ' + ((pids.admin   && pids.admin.pid)   || '?'));
  console.log('   Friends HTTP:   port ' + FRIENDS_HTTP_PORT + '   PID ' + ((pids.friends && pids.friends.pid) || '?'));
  console.log('   Friends WS:     port '   + FRIENDS_WS_PORT);
  console.log('   Logs:           server/logs/{admin,friends}.log');
  console.log('');
  console.log('   Stoppen mit:    npm stop   (oder:  node stop.js)');
  console.log('');

  // Give the shell a moment to flush stdout before we exit (which only the children remain).
  setTimeout(() => process.exit(allReady ? 0 : 1), 150);
})();

process.on('uncaughtException', (err) => {
  console.error('[start] UNCAUGHT EXCEPTION:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[start] UNHANDLED REJECTION:', err.message);
});
