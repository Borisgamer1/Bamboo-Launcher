const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";
const rpc = new RPC.Client({ clientId });
let startTimestamp = new Date();
let lastActivityJson = null;
let _connected = false;
let _reconnectTimer = null;

// ===== Monkey-patch IPCTransport to add persistent socket error handler =====
// The @xhayper/discord-rpc library's IPCTransport.connect() calls this.send()
// after the socket connects. If the write fails with EPIPE (Discord closed the
// pipe between connect and write), there's NO error handler on the socket
// because createSocket() only uses .once('error', ...) which is removed by
// onConnect. This causes an UNCAUGHT EXCEPTION crash.
try {
  const IPCTransport = require('@xhayper/discord-rpc/dist/transport/IPC').IPCTransport;
  const origGetSocket = IPCTransport.prototype.getSocket;
  IPCTransport.prototype.getSocket = function () {
    return origGetSocket.call(this).then((socket) => {
      // Add PERSISTENT error handler to socket (not .once)
      // This catches EPIPE when socket.write() fails after connection
      socket.on('error', (_err) => {
        // Silently swallow all socket-level errors.
        // The RPC client's own error handling + _connected flag handle recovery.
      });
      return socket;
    });
  };
} catch (_e) {
  // IPCTransport not available (different version/structure) — app continues
  console.warn('[DiscordRPC] Could not patch IPCTransport, EPIPE may still crash.');
}

// ===== RPC Client Error Handler =====
// Catches errors propagated through the RPC client object.
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
