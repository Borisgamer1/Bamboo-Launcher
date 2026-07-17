// server/stop.js — Cross-platform shutdown for Bamboo Backend
// 1. Sweeps configured ports (ADMIN_PORT, FRIENDS_PORT, FRIENDS_WS_PORT) to find & kill any processes listening on them.
// 2. Kills leftover PIDs from .bamboo-pids.json (created by start.js).
// Works on Windows (PowerShell + taskkill), macOS (lsof + kill -9) and Linux.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, '.bamboo-pids.json');
const PORTS = [
  parseInt(process.env.ADMIN_PORT        || '3005'),
  parseInt(process.env.FRIENDS_PORT      || '3400'),
  parseInt(process.env.FRIENDS_WS_PORT   || '3401'),
];

const log = (...a) => console.log('[stop]', ...a);

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function killPort(port) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (!out) return [];
      return out.split(/\r?\n/).filter(s => /^\d+$/.test(s.trim()));
    } catch {
      return [];
    }
  } else {
    try {
      const out = execSync(`lsof -ti tcp:${port} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
      return out ? out.split(/\r?\n/).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
}

let totalKilled = 0;

// 1. First: port sweep (cleanup anything currently listening on our ports)
//    We do this BEFORE the PID file because stale PIDs might be wrong
for (const port of PORTS) {
  const pids = killPort(port);
  let portKilled = 0;
  pids.forEach(p => { if (killPid(p)) { log(`✓ Port ${port}: Prozess ${p} beendet`); portKilled++; } });
  if (portKilled === 0) log(`  Port ${port}: nicht belegt`);
  totalKilled += portKilled;
}

// 2. Kill from PID file (clean shutdown path for orphaned children not on ports)
// New .bamboo-pids.json shape from start.js: { admin: {pid, log}, friends: {pid, log} }
// Legacy flat-number shape (older start.js) is also supported as a fallback.
let savedPids = {};
try { savedPids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch {}
for (const [name, entry] of Object.entries(savedPids)) {
  const pid = (typeof entry === 'object' && entry !== null) ? entry.pid : entry;
  if (!pid || typeof pid !== 'number') continue;
  // Versuche zu killen — killPid hat intern try/catch und schlägt nicht fehl
  if (killPid(pid)) {
    log(`✓ ${name} (PID ${pid}) beendet`);
    totalKilled++;
  }
}
try { fs.unlinkSync(PID_FILE); } catch {}

console.log(totalKilled > 0 ? `✅ ${totalKilled} Prozess(e) gestoppt` : '✅ Keine laufenden Prozesse gefunden');
