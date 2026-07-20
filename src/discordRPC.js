const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";
const rpc = new RPC.Client({ clientId });
let startTimestamp = new Date();
let lastActivityJson = null;

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
