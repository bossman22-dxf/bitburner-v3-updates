/** @param {NS} ns **/
/**
 * prepEngine.js
 *
 * Lightweight preparatory engine for early-run automation.
 * - Uses worker scripts in home/scripts (hack/grow/weaken).
 * - Attempts to open ports and nuke candidate targets from home.
 * - Optionally deploys worker scripts to purchased servers (--deploy).
 * - Schedules a conservative prep batch from home for newly rooted targets.
 *
 * Usage:
 *   run prepEngine.js [--dry] [--deploy] [--reservedHomeRam=2] [--maxTargets=5] [--targets=host1,host2]
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("scp");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const deploy = flags.deploy === true || flags.deploy === "true";
  const reservedHomeRam = Number(flags.reservedHomeRam) || 2;
  const maxTargets = Number(flags.maxTargets) || 5;
  const explicitTargets = (flags.targets && typeof flags.targets === "string") ? flags.targets.split(",").map(s => s.trim()).filter(Boolean) : [];

  ns.tprint(`prepEngine: start (dry=${dry}) deploy=${deploy} reservedHomeRam=${reservedHomeRam} maxTargets=${maxTargets}`);

  // Worker script paths (expected under home/scripts)
  const hackScript = "scripts/hack.js";
  const growScript = "scripts/grow.js";
  const weakenScript = "scripts/weaken.js";

  // Validate worker scripts exist on home/scripts
  for (const f of [hackScript, growScript, weakenScript]) {
    if (!ns.fileExists(f, "home")) {
      ns.tprint(`prepEngine: missing worker script on home: ${f}. Place workers in home/scripts and retry.`);
      return;
    }
  }

  // Build list of port openers available on home
  const portOpeners = [
    { exe: "BruteSSH.exe", fn: ns.brutessh },
    { exe: "FTPCrack.exe", fn: ns.ftpcrack },
    { exe: "relaySMTP.exe", fn: ns.relaysmtp },
    { exe: "HTTPWorm.exe", fn: ns.httpworm },
    { exe: "SQLInject.exe", fn: ns.sqlinject },
  ];
  const availableOpeners = portOpeners.filter(o => ns.fileExists(o.exe, "home") && typeof o.fn === "function");

  // Build candidate target list
  let targets = explicitTargets.slice();
  if (targets.length === 0) {
    targets = discoverCandidateTargets(ns, availableOpeners, maxTargets);
  } else {
    targets = targets.filter(t => {
      try { ns.getServer(t); return true; } catch { ns.print(`prepEngine: explicit target not found: ${t}`); return false; }
    }).slice(0, maxTargets);
  }

  if (targets.length === 0) {
    ns.tprint("prepEngine: no candidate targets found.");
    return;
  }

  ns.tprint(`prepEngine: targets: ${targets.join(", ")}`);

  // Optionally deploy worker scripts to purchased servers
  const purchased = ns.getPurchasedServers();
  if (deploy && purchased.length > 0) {
    ns.tprint(`prepEngine: deploying workers to ${purchased.length} purchased servers`);
    for (const host of purchased) {
      for (const src of [hackScript, growScript, weakenScript]) {
        try {
          const ok = ns.scp(src, host, "home");
          if (!ok) ns.print(`prepEngine: scp failed for ${src} -> ${host}`);
          else ns.print(`prepEngine: scp succeeded for ${src} -> ${host}`);
        } catch (e) {
          ns.print(`prepEngine: scp exception for ${src} -> ${host}: ${e}`);
        }
        await ns.sleep(50);
      }
    }
  }

  // For each target: try to open ports and nuke; then optionally schedule a small prep batch from home
  for (const target of targets) {
    ns.print(`prepEngine: processing ${target}`);

    // Skip special servers
    if (target === "home" || ns.getPurchasedServers().includes(target)) {
      ns.print(`prepEngine: skipping ${target} (home or purchased)`);
      continue;
    }

    // If we don't have root, try to open ports and nuke
    if (!ns.hasRootAccess(target)) {
      let opened = 0;
      for (const o of availableOpeners) {
        try {
          o.fn(target);
          opened++;
          ns.print(`prepEngine: ran ${o.exe} on ${target}`);
        } catch (e) {
          ns.print(`prepEngine: ${o.exe} failed on ${target}: ${e}`);
        }
        await ns.sleep(50);
      }

      try {
        const required = ns.getServerNumPortsRequired(target);
        if (opened >= required) {
          ns.nuke(target);
          ns.tprint(`prepEngine: nuked ${target}`);
        } else {
          ns.tprint(`prepEngine: not enough ports opened for ${target} (opened ${opened}, required ${required})`);
          continue;
        }
      } catch (e) {
        ns.tprint(`prepEngine: nuke attempt error for ${target}: ${e}`);
        continue;
      }
    } else {
      ns.print(`prepEngine: already have root on ${target}`);
    }

    // Schedule a conservative prep batch from home to improve money/security
    try {
      const homeMax = ns.getServerMaxRam("home");
      const homeUsed = ns.getServerUsedRam("home");
      const usable = Math.max(0, homeMax - homeUsed - reservedHomeRam);
      const ramHack = ns.getScriptRam(hackScript, "home");
      const ramGrow = ns.getScriptRam(growScript, "home");
      const ramWeaken = ns.getScriptRam(weakenScript, "home");

      // Conservative ratio for prep: hack:grow:weaken = 1:2:2
      const ratio = { hack: 1, grow: 2, weaken: 2 };
      const perBatchRam = ratio.hack * ramHack + ratio.grow * ramGrow + ratio.weaken * ramWeaken;
      if (perBatchRam <= 0) {
        ns.tprint("prepEngine: invalid script RAM calculation; skipping batch scheduling.");
        continue;
      }

      const maxBatches = Math.max(1, Math.floor(usable / perBatchRam));
      const hackThreads = Math.max(1, Math.floor(ratio.hack * maxBatches));
      const growThreads = Math.max(1, Math.floor(ratio.grow * maxBatches));
      const weakenThreads = Math.max(1, Math.floor(ratio.weaken * maxBatches));
      const totalRamNeeded = hackThreads * ramHack + growThreads * ramGrow + weakenThreads * ramWeaken;

      ns.tprint(`prepEngine: scheduling prep batch for ${target} (hack:${hackThreads} grow:${growThreads} weaken:${weakenThreads}) uses ${totalRamNeeded} RAM on home`);

      if (dry) {
        ns.print("prepEngine: dry mode - not executing batch.");
        continue;
      }

      // Launch weaken -> grow -> hack with small offsets so weaken finishes last
      const home = "home";
      const pidW = ns.exec(weakenScript, home, weakenThreads, target);
      if (!pidW) ns.print(`prepEngine: failed to exec weaken on ${home}`);
      await ns.sleep(200);

      const pidG = ns.exec(growScript, home, growThreads, target);
      if (!pidG) ns.print(`prepEngine: failed to exec grow on ${home}`);
      await ns.sleep(200);

      const pidH = ns.exec(hackScript, home, hackThreads, target);
      if (!pidH) ns.print(`prepEngine: failed to exec hack on ${home}`);

      ns.tprint(`prepEngine: launched prep batch for ${target} pids weaken=${pidW} grow=${pidG} hack=${pidH}`);
      await ns.sleep(500);
    } catch (e) {
      ns.print(`prepEngine: scheduling error for ${target}: ${e}`);
    }
  }

  ns.tprint("prepEngine: finished.");
}

/* -------------------- Helpers -------------------- */

function parseFlags(args) {
  const out = {};
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function discoverCandidateTargets(ns, availableOpeners, maxTargets) {
  const visited = new Set(["home"]);
  const queue = ["home"];
  const candidates = [];
  const purchased = ns.getPurchasedServers();
  while (queue.length && candidates.length < maxTargets) {
    const node = queue.shift();
    for (const n of ns.scan(node)) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
      try {
        if (n === "home" || purchased.includes(n)) continue;
        const srv = ns.getServer(n);
        if (!srv) continue;
        if (srv.moneyMax <= 0) continue;
        const required = ns.getServerNumPortsRequired(n);
        if (availableOpeners.length >= required) {
          candidates.push(n);
          if (candidates.length >= maxTargets) break;
        }
      } catch (e) {
        // ignore
      }
    }
  }
  return candidates;
}
