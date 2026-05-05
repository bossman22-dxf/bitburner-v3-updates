/** @param {NS} ns **/
/*
  repairServerScripts.js
  - Periodically ensures core scripts exist on purchased servers.
  - Compatible with Bitburner 3.0.0 APIs.
  - Copies only from home, verifies results, and logs outcomes.
*/

export async function main(ns) {
  const scripts = ["hack.js", "grow.js", "weaken.js"];
  const INTERVAL_MS = 180_000; // 3 minutes

  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.print("🛡️ Self-Healing Script Monitor active — scanning every 3 minutes");

  // Ensure home has the required scripts before entering loop
  while (true) {
    // Confirm all scripts exist on home
    const missingOnHome = scripts.filter(s => !ns.fileExists(s, "home"));
    if (missingOnHome.length > 0) {
      ns.print(`❌ Missing on home: ${missingOnHome.join(", ")}`);
      await ns.sleep(INTERVAL_MS);
      continue;
    }

    // Get purchased servers (cloud API) or fallback to getPurchasedServers
    let servers = [];
    try {
      if (typeof ns.cloud?.getServerNames === "function") {
        servers = ns.cloud.getServerNames();
      } else if (typeof ns.getPurchasedServers === "function") {
        servers = ns.getPurchasedServers();
      } else {
        servers = [];
      }
    } catch (e) {
      ns.print(`⚠️ Failed to list purchased servers: ${String(e)}`);
      servers = [];
    }

    let repaired = 0;

    for (const server of servers) {
      // Defensive checks
      if (!server) continue;
      if (!ns.serverExists(server)) {
        ns.print(`⏭️ Skipping ${server} — server does not exist`);
        continue;
      }
      if (!ns.hasRootAccess(server)) {
        ns.print(`⏭️ Skipping ${server} — no root access`);
        continue;
      }
      const maxRam = ns.getServerMaxRam(server);
      if (maxRam === 0) {
        ns.print(`⏭️ Skipping ${server} — no RAM`);
        continue;
      }

      const missing = scripts.filter(s => !ns.fileExists(s, server));
      if (missing.length === 0) continue;

      const copied = [];
      for (const script of missing) {
        try {
          // Copy from home to server
          await ns.scp(script, server);
          // small pause to allow file system to update
          await ns.sleep(10);
          if (ns.fileExists(script, server)) {
            copied.push(script);
          } else {
            ns.print(`❌ ${script} failed to copy to ${server}`);
          }
        } catch (e) {
          ns.print(`❌ Error copying ${script} to ${server}: ${String(e)}`);
        }
      }

      if (copied.length === missing.length) {
        ns.print(`🔧 Repaired ${server}: copied ${copied.join(", ")}`);
        repaired++;
      } else {
        const stillMissing = missing.filter(s => !copied.includes(s));
        ns.print(`❌ Copy incomplete on ${server}: still missing ${stillMissing.join(", ")}`);
      }
    }

    ns.print(`✅ Scan complete: ${repaired} servers repaired`);
    await ns.sleep(INTERVAL_MS);
  }
}
