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
// This is the most reliable fix — no monkey-patching, no internal module access.
const _origOException = process.listeners('uncaughtException').pop();
process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (err) => {
  const isEpipe = err.code === 'EPIPE' || err.message?.includes('EPIPE');
  const isDiscord = err.stack?.includes('discord-rpc') || err.stack?.includes('IPCTransport');
  if (isEpipe && isDiscord) {
    console.warn('[DiscordRPC] Suppressed EPIPE (Discord pipe closed)');
    return;
  }
  // Pass through to any existing handler
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

async function startRPC() {
  try {
    await rpc.login();
    console.log("[DiscordRPC] Connected.");
  } catch (err) {
    console.warn("[DiscordRPC] Login failed:", err.message);
  }
}

/**
 * Set Discord Rich Presence activity.
 * ONLY sends to Discord if the activity text actually changed,
 * preventing pointless API calls and flickering.
 */
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

  // Deduplicate: skip if activity text hasn't changed
  if (json === lastActivityJson) return;

  lastActivityJson = json;

  if (!rpc.user) {
    // Queue for when RPC connects
    return;
  }

  rpc.user.setActivity(payload).catch((err) =>
    console.warn("[DiscordRPC] setActivity failed:", err.message)
  );
}

module.exports = {
  startRPC,
  setActivity,
  rpc,
};
