/** @param {NS} ns **/
/*
  deployScripts.js
  - Scans reachable, rooted servers and copies core scripts from home to them.
  - Compatible with Bitburner 3.0.0 APIs (scp signature, cloud/purchased servers).
  - Persists a list of deployed servers to /data/deployedServers.txt to avoid redundant copies.
*/

export async function main(ns) {
  ns.disableLog("ALL");
  ns.clearLog();
  ns.ui.openTail();

  const scripts = ["hack.js", "grow.js", "weaken.js", "share.js"];
  const memoryFile = "/data/deployedServers.txt";

  // Ensure required scripts exist on home
  const missingOnHome = scripts.filter(s => !ns.fileExists(s, "home"));
  if (missingOnHome.length > 0) {
    ns.tprint(`❌ Missing on home: ${missingOnHome.join(", ")} — place them on home and re-run.`);
    return;
  }

  // Load memory of previously deployed servers
  let deployed = [];
  try {
    if (ns.fileExists(memoryFile)) {
      deployed = ns.read(memoryFile).split("\n").map(s => s.trim()).filter(Boolean);
    }
  } catch (e) {
    ns.print(`⚠️ Failed to read ${memoryFile}: ${String(e)}`);
    deployed = [];
  }

  // Scan all reachable servers and include purchased servers
  const allServers = scanAll(ns)
    .filter(s => s !== "home" && ns.serverExists(s) && ns.hasRootAccess(s));

  for (const server of allServers) {
    try {
      if (deployed.includes(server)) {
        ns.print(`✅ Already deployed to ${server}`);
        continue;
      }

      // Skip servers with no RAM
      const maxRam = ns.getServerMaxRam(server);
      if (maxRam <= 0) {
        ns.print(`⏭️ Skipping ${server} — no RAM`);
        deployed.push(server); // mark as deployed to avoid repeated attempts
        continue;
      }

      // Determine which scripts are missing on the target
      const missingScripts = scripts.filter(script => !ns.fileExists(script, server));
      if (missingScripts.length === 0) {
        ns.print(`✅ ${server} already has all scripts`);
        deployed.push(server);
        continue;
      }

      // Copy missing scripts from home to server
      try {
        // ns.scp accepts an array of files and a destination host
        await ns.scp(missingScripts, server);
        // small pause to allow filesystem to update
        await ns.sleep(20);
      } catch (e) {
        ns.print(`❌ Failed to scp to ${server}: ${String(e)}`);
      }

      // Verify results
      const stillMissing = missingScripts.filter(s => !ns.fileExists(s, server));
      if (stillMissing.length === 0) {
        ns.print(`📦 Copied ${missingScripts.join(", ")} to ${server}`);
        deployed.push(server);
      } else {
        ns.print(`❌ Copy incomplete on ${server}: still missing ${stillMissing.join(", ")}`);
        // Do not add to deployed so we can retry later
      }
    } catch (e) {
      ns.print(`⚠️ Error processing ${server}: ${String(e)}`);
    }
  }

  // Save updated memory (one host per line)
  try {
    await ns.write(memoryFile, deployed.join("\n") + (deployed.length ? "\n" : ""), "w");
  } catch (e) {
    ns.print(`⚠️ Failed to write ${memoryFile}: ${String(e)}`);
  }

  ns.print("🧠 Deployment complete.");
}

/* ---------- Helpers ---------- */

function scanAll(ns) {
  const seen = new Set(["home"]);
  const stack = ["home"];

  while (stack.length) {
    const host = String(stack.pop()).trim();
    if (!host) continue;
    try {
      for (const neighbor of ns.scan(host)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    } catch {
      // ignore scan errors for special nodes
    }
  }

  // Include purchased/cloud servers
  try {
    if (typeof ns.cloud?.getServerNames === "function") {
      for (const p of ns.cloud.getServerNames()) if (!seen.has(p)) seen.add(p);
    } else if (typeof ns.getPurchasedServers === "function") {
      for (const p of ns.getPurchasedServers()) if (!seen.has(p)) seen.add(p);
    }
  } catch {
    // ignore
  }

  return Array.from(seen);
}
