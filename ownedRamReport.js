/** @param {NS} ns **/
/*
  ownedRamReport.js
  - Reports RAM usage for player-owned (purchased/cloud) servers.
  - Updated for Bitburner 3.0.0 compatibility and defensive APIs.
*/

export async function main(ns) {
  ns.disableLog("ALL");

  // Get purchased/cloud servers (support both APIs)
  let servers = [];
  try {
    if (typeof ns.cloud?.getServerNames === "function") {
      servers = ns.cloud.getServerNames();
    } else if (typeof ns.getPurchasedServers === "function") {
      servers = ns.getPurchasedServers();
    } else {
      servers = [];
    }
  } catch {
    servers = [];
  }

  if (!servers || servers.length === 0) {
    ns.tprint("⚠️ You don't own any servers yet.");
    return;
  }

  ns.tprint("🧠 Player-Owned Server RAM Report:");
  for (const host of servers) {
    try {
      const max = ns.getServerMaxRam(host) || 0;
      const used = ns.getServerUsedRam(host) || 0;
      const free = Math.max(0, max - used);
      ns.tprint(`🖥️ ${host}: ${used.toFixed(2)}GB used / ${max.toFixed(2)}GB total (${free.toFixed(2)}GB free)`);
    } catch (e) {
      ns.tprint(`⚠️ Could not read ${host}: ${String(e)}`);
    }
  }
}
