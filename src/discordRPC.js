const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";
const rpc = new RPC.Client({ clientId });
let startTimestamp = new Date();
let lastActivityJson = null;

// ===== Process-Level EPIPE Shield =====
// The @xhayper/discord-rpc library's IPCTransport creates a socket and uses
// .once('error', onError). When the socket connects, onConnect removes the
// error handler. If socket.write() then fails with EPIPE (Discord closed
// the pipe), there's NO error handler left → uncaught exception.
// 
// We catch it here at the process level before it crashes the main process.
const _origOException = process.listeners('uncaughtException').pop();
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err) => {
  const isEpipe = err.code === 'EPIPE' || err.message?.includes('EPIPE');
  const isDiscord = err.stack?.includes('discord-rpc') || err.stack?.includes('IPCTransport');
  if (isEpipe && isDiscord) {
    console.warn('[DiscordRPC] Suppressed EPIPE (Discord pipe closed)');
    return;
  }
  if (_origOException) _origOException(err);
  else {
    console.error('Uncaught Exception:', err);
    process.exit(1);
  }
});

rpc.on('connected', () => {
  if (lastActivityJson && rpc.user) {
    rpc.user.setActivity(JSON.parse(lastActivityJson)).catch(() => {});
  }
});

/**
 * Try to connect to Discord RPC with a race-against-timeout+close.
 * The library doesn't propagate EPIPE to the connection promise,
 * so we detect transport close and reject immediately.
 */
async function tryLogin() {
  rpc.connectionPromise = undefined;

  return Promise.race([
    rpc.login(),
    new Promise((_, reject) => {
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error('Discord pipe closed before ready'));
      };
      rpc.transport.once('close', onClose);
      const timer = setTimeout(() => {
        rpc.transport.removeListener('close', onClose);
        reject(new Error('RPC connection timed out'));
      }, 3000);
    }),
  ]);
}

async function startRPC() {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await tryLogin();
      console.log("[DiscordRPC] Connected.");
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 2) {
        console.log(`[DiscordRPC] Retry ${attempt}/2...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  const msg = (lastError.message || '').toLowerCase();
  console.warn("[DiscordRPC] Login failed after 2 attempts:", lastError.message);
  if (msg.includes('pipe') || msg.includes('refused') || msg.includes('epipe')) {
    console.warn("[DiscordRPC] 💡 Discord prüfen: Einstellungen → Aktivität & Privatsphäre →");
    console.warn("[DiscordRPC] 💡 'Aktuelle Aktivität anzeigen' EINSCHALTEN");
    console.warn("[DiscordRPC] 💡 Oder Discord einmal neustarten & Launcher neu starten");
  }
}

function setActivity(activity) {
  if (!activity || typeof activity !== 'object') return;

  const payload = {
    ...activity,
    startTimestamp: activity.startTimestamp || startTimestamp,
    instance: false,
    buttons: activity.buttons || [
      { label: "Bamboo Launcher", url: "https://github.com" },
      { label: "Discord Server", url: "https://discord.gg" },
    ],
  };

  const json = JSON.stringify(payload, Object.keys(payload).sort());

  if (json === lastActivityJson) return;
  lastActivityJson = json;

  if (!rpc.user) return;

  rpc.user.setActivity(payload).catch((err) =>
    console.warn("[DiscordRPC] setActivity failed:", err.message)
  );
}

module.exports = {
  startRPC,
  setActivity,
  rpc,
};
