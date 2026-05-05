/** @param {NS} ns **/
/*
  bootstrap.js
  - Self-contained bootstrapper: scans the network, attempts to root servers,
    copies and runs a simple hack script on any server with RAM.
  - Includes ensureScriptsOnHost(ns, host, scripts) to safely copy scripts
    from home to a host (checks existence, RAM, and copies only once).
  - Compatible with Bitburner 3.0+ APIs.
*/

export async function main(ns) {
  ns.disableLog("ALL");
  ns.disableLog("sleep");
  ns.print("🚀 bootstrap starting");

  const script = "basic-hack.js";
  if (!ns.fileExists(script, "home")) {
    ns.tprint(`❌ Missing ${script} on home. Place the script on home and re-run.`);
    return;
  }

  // Scan entire reachable network
  const servers = scanAll(ns);

  for (const raw of servers) {
    const server = String(raw).trim();
    if (!server || server === "home") continue;

    // Defensive: ensure server exists
    if (!ns.serverExists(server)) continue;

    // Try to gain root if we don't already have it
    if (!ns.hasRootAccess(server)) {
      tryRoot(ns, server);
      // small pause so port tools / nuke have time to settle
      await ns.sleep(50);
    }

    // If we have root and the server can run scripts, copy and run
    if (ns.hasRootAccess(server)) {
      const maxRam = ns.getServerMaxRam(server);
      if (maxRam <= 0) {
        ns.print(`⏭️ Skipping ${server} — no RAM`);
        continue;
      }

      const scriptRam = ns.getScriptRam(script, "home");
      if (scriptRam <= 0) {
        ns.print(`⚠️ ${script} reports zero RAM usage; skipping execution on ${server}`);
        continue;
      }

      const threads = Math.floor(maxRam / scriptRam);
      if (threads <= 0) {
        ns.print(`⏭️ ${server} has insufficient RAM for ${script}`);
        continue;
      }

      // Use helper to ensure script(s) are present on the host
      const ok = await ensureScriptsOnHost(ns, server, [script]);
      if (!ok) {
        ns.print(`⚠️ Skipping execution on ${server} — failed to ensure scripts present`);
        continue;
      }

      // Kill any running scripts and start the hack script
      try {
        ns.killall(server);
      } catch (e) {
        // ignore killall failures
      }

      const pid = ns.exec(script, server, threads, server);
      if (pid > 0) {
        ns.print(`▶️ Launched ${script} on ${server} (threads=${threads}, pid=${pid})`);
      } else {
        ns.print(`⚠️ Failed to exec ${script} on ${server}`);
      }

      // small delay to avoid spamming operations
      await ns.sleep(50);
    }
  }

  ns.tprint("✅ bootstrap complete");
}

/* ---------- Helpers ---------- */

function scanAll(ns) {
  const discovered = new Set(["home"]);
  const stack = ["home"];

  while (stack.length > 0) {
    const current = String(stack.pop()).trim();
    if (!current) continue;

    let neighbors = [];
    try {
      neighbors = ns.scan(current);
    } catch (e) {
      ns.print(`⚠️ scan failed on ${current}: ${String(e)}`);
      continue;
    }

    for (const neighbor of neighbors) {
      const n = String(neighbor).trim();
      if (!n) continue;
      if (!discovered.has(n)) {
        discovered.add(n);
        stack.push(n);
      }
    }
  }

  return Array.from(discovered);
}

function tryRoot(ns, server) {
  if (!ns.serverExists(server)) return false;

  // If hacking level is too low, bail early
  const reqLevel = ns.getServerRequiredHackingLevel(server);
  if (ns.getHackingLevel() < reqLevel) return false;

  // Port tools available on home (check fileExists on home)
  const tools = [
    { file: "BruteSSH.exe", fn: ns.brutessh },
    { file: "FTPCrack.exe", fn: ns.ftpcrack },
    { file: "relaySMTP.exe", fn: ns.relaysmtp },
    { file: "HTTPWorm.exe", fn: ns.httpworm },
    { file: "SQLInject.exe", fn: ns.sqlinject },
  ];

  let opened = 0;
  for (const t of tools) {
    try {
      if (!ns.fileExists(t.file, "home")) continue;
      // Port functions now return boolean success
      const ok = t.fn(server);
      if (ok) opened++;
    } catch (e) {
      // Defensive: log to tail but continue
      ns.print(`⚠️ Port tool error on ${server} with ${t.file}: ${String(e)}`);
    }
  }

  const required = ns.getServerNumPortsRequired(server);
  if (opened >= required) {
    try {
      const nuked = ns.nuke(server);
      if (nuked && ns.hasRootAccess(server)) {
        ns.print(`🔓 Rooted ${server}`);
        return true;
      } else {
        ns.print(`⚠️ nuke failed on ${server}`);
      }
    } catch (e) {
      ns.print(`❌ Error nuking ${server}: ${String(e)}`);
    }
  } else {
    ns.print(`🔒 ${server} requires ${required} ports; opened ${opened}`);
  }

  return false;
}

/**
 * Ensure scripts exist on the target host by copying from home if needed.
 * - Only copies files that exist on home and are missing on the host.
 * - Skips hosts with no RAM.
 * - Performs a strict free-RAM check: requires at least the smallest script's RAM free.
 * - Returns true if all requested scripts are present on the host after the call.
 */
async function ensureScriptsOnHost(ns, host, scripts = []) {
  const h = String(host).trim();
  if (!h || h === "home") return true;
  if (!ns.serverExists(h) || !ns.hasRootAccess(h)) return false;

  // Only consider scripts that actually exist on home
  const toCopy = scripts.filter(s => ns.fileExists(s, "home") && !ns.fileExists(s, h));
  if (toCopy.length === 0) return true;

  // Skip non-executable hosts
  const maxRam = ns.getServerMaxRam(h);
  if (maxRam === 0) {
    ns.print(`⏭️ Skipping scp to ${h} — no RAM`);
    return false;
  }

  // Strict check: ensure host has enough free RAM for at least one script
  const scriptRams = toCopy.map(s => ns.getScriptRam(s, "home"));
  const minScriptRam = Math.min(...scriptRams);
  const usedRam = ns.getServerUsedRam(h);
  const freeRam = Math.max(0, maxRam - usedRam);
  if (freeRam < minScriptRam) {
    ns.print(`⏭️ Skipping scp to ${h} — insufficient free RAM (${freeRam} GB) for scripts (need ${minScriptRam} GB)`);
    return false;
  }

  // Attempt copy
  try {
    await ns.scp(toCopy, h);
    // Verify all copied
    for (const s of toCopy) {
      if (!ns.fileExists(s, h)) {
        ns.print(`❌ After scp, ${s} still missing on ${h}`);
        return false;
      }
    }
    return true;
  } catch (e) {
    ns.print(`❌ Failed to scp to ${h}: ${String(e)}`);
    return false;
  }
}
