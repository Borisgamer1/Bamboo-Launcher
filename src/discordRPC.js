
const RPC = require("@xhayper/discord-rpc");

const clientId = "1520516615354056865";

let rpc = null;
let isInitialized = false;

function initializeRPC() {
  if (rpc !== null && isInitialized) return rpc;
  try {
    rpc = new RPC.Client({ clientId });
    isInitialized = true;

    rpc.on("ready", () => {
      console.log("[discordRPC] Connected to Discord.");
    });

    rpc.on("error", (err) => {
      if (err.message && (err.message.includes("discord-rpc") || err.message.includes("IPCTransport"))) {
        console.warn("[discordRPC] Discord not available — running in offline mode:", err.message);
        isInitialized = false;
      } else {
        console.error("[discordRPC] Unexpected error:", err.message);
      }
    });

    rpc.login().catch(err => {
      console.warn("[discordRPC] Failed to login to Discord (likely not running):", err.message);
      isInitialized = false;
    });

    return rpc;
  } catch (err) {
    console.warn("[discordRPC] Initialization failed, running in offline mode:", err.message);
    isInitialized = false;
    return null;
  }
}

initializeRPC();

const rpcAPI = {
  get isInitialized() {
    return isInitialized && rpc !== null;
  },

  setActivity(activity) {
    if (!isInitialized || rpc === null || !rpc.user) {
      console.debug("[discordRPC] Not initialized — skipping setActivity");
      return Promise.resolve();
    }
    try {
      return Promise.resolve(rpc.user.setActivity(activity)).catch(err => {
        console.warn("[discordRPC] setActivity error:", err.message);
      });
    } catch (err) {
      console.warn("[discordRPC] setActivity error:", err.message);
      return Promise.resolve();
    }
  },

  clearActivity() {
    if (!isInitialized || rpc === null || !rpc.user) {
      console.debug("[discordRPC] Not initialized — skipping clearActivity");
      return Promise.resolve();
    }
    try {
      return Promise.resolve(rpc.user.clearActivity()).catch(err => {
        console.warn("[discordRPC] clearActivity error:", err.message);
      });
    } catch (err) {
      console.warn("[discordRPC] clearActivity error:", err.message);
      return Promise.resolve();
    }
  },

  shutdown() {
    if (rpc !== null && isInitialized) {
      try {
        rpc.close();
        console.log("[discordRPC] RPC connection closed");
      } catch (err) {
        console.warn("[discordRPC] shutdown error:", err.message);
      }
    }
    isInitialized = false;
    rpc = null;
  },
};

module.exports = {
  ...rpcAPI,
  initializeRPC,
  startRPC: initializeRPC,
};