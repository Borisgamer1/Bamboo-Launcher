const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";
const rpc = new RPC.Client({ clientId });
let startTimestamp = new Date();
let currentActivity = null;

rpc.on('connected', () => {
  if (currentActivity && rpc.user) {
    rpc.user.setActivity(currentActivity).catch((err) => console.error("Discord RPC setActivity failed:", err));
  }
});

async function startRPC() {
  try {
    await rpc.login();
    console.log("Discord RPC verbunden.");
    if (currentActivity && rpc.user) {
      await rpc.user.setActivity(currentActivity);
    }
  } catch (err) {
    console.error("Discord RPC login failed:", err);
  }
}

function setActivity(activity) {
  if (!activity || typeof activity !== 'object') return;
  currentActivity = {
    ...activity,
    startTimestamp: activity.startTimestamp || startTimestamp,
    instance: false,
    buttons: activity.buttons || [
      { label: "Bamboo Launcher", url: "https://github.com" },
      { label: "Discord Server", url: "https://discord.gg" }
    ]
  };

  if (!rpc.user) {
    console.warn("Discord RPC user not ready yet, activity queued.");
    return;
  }

  rpc.user.setActivity(currentActivity).catch((err) => console.error("Discord RPC setActivity failed:", err));
}

module.exports = {
  startRPC,
  setActivity,
  rpc,
};