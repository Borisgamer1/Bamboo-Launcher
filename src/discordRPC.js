const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";
const rpc = new RPC.Client({ clientId });
let startTimestamp = new Date();
let lastActivityJson = null;
let _connected = false;
let _reconnectTimer = null;

// ===== Transport-Level Error Handler =====
// Prevents EPIPE crashes when Discord disconnects or isn't running.
rpc.on('error', (err) => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE') || err.message?.includes('pipe')) {
    _connected = false;
    console.warn('[DiscordRPC] Connection lost (EPIPE) — Discord closed the pipe.');
    // Attempt reconnection after 30s in case Discord comes back
    if (!_reconnectTimer) {
      _reconnectTimer = setTimeout(async () => {
        _reconnectTimer = null;
        try {
          await rpc.login();
          _connected = true;
          console.log('[DiscordRPC] Reconnected.');
          if (lastActivityJson && rpc.user) {
            rpc.user.setActivity(JSON.parse(lastActivityJson)).catch(() => {});
          }
        } catch {
          console.warn('[DiscordRPC] Reconnect failed — Discord might still be closed.');
        }
      }, 30000);
    }
  } else {
    console.warn('[DiscordRPC] Transport error:', err.message);
  }
});

rpc.on('connected', () => {
  _connected = true;
  console.log('[DiscordRPC] Connected.');
  if (lastActivityJson && rpc.user) {
    rpc.user.setActivity(JSON.parse(lastActivityJson)).catch(() => {});
  }
});

async function startRPC() {
  try {
    await rpc.login();
    _connected = true;
    console.log('[DiscordRPC] Connected.');
  } catch (err) {
    console.warn('[DiscordRPC] Login failed:', err.message);
  }
}

/**
 * Set Discord Rich Presence activity.
 * ONLY sends to Discord if:
 *   1. The RPC client is connected (Discord running)
 *   2. The activity text actually changed (deduplication)
 * Prevents pointless API calls, flickering, and EPIPE crashes.
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

  // Guard: skip if not connected (avoids EPIPE writes to closed pipe)
  if (!_connected || !rpc.user) {
    return;
  }

  rpc.user.setActivity(payload).catch((err) => {
    // EPIPE inside setActivity itself — mark disconnected
    if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) {
      _connected = false;
    }
    console.warn('[DiscordRPC] setActivity failed:', err.message);
  });
}

module.exports = {
  startRPC,
  setActivity,
  rpc,
};
