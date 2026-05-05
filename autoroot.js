/** @param {NS} ns **/
/**
 * autoroot.js
 *
 * Lightweight autoroot for early-run automation.
 *
 * Usage:
 *   run autoroot.js [--dry] [--deploy] [--maxTargets=10] [--targets=host1,host2]
 *
 * Notes:
 * - Worker scripts (if deploying) are expected at home/scripts/hack.js, grow.js, weaken.js
 * - This script does not use Singularity APIs and will not attempt to install backdoors.
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("scp");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const deploy = flags.deploy === true || flags.deploy === "true";
  const maxTargets = Number(flags.maxTargets) || 20;
  const explicitTargets = (flags.targets && typeof flags.targets === "string") ? flags.targets.split(",").map(s => s.trim()).filter(Boolean) : [];

  ns.tprint(`autoroot: start (dry=${dry}) deploy=${deploy} maxTargets=${maxTargets}`);

  // Worker script paths (for optional deploy)
  const workerFiles = ["scripts/hack.js", "scripts/grow.js", "scripts/weaken.js"];

  // Validate worker scripts exist if deploy requested
  if (deploy) {
    for (const f of workerFiles) {
      if (!ns.fileExists(f, "home")) {
        ns.tprint(`autoroot: deploy requested but missing worker script: ${f}. Aborting deploy.`);
        return;
      }
    }
  }

  // Build list of available port openers on home
  const portOpeners = [
    { exe: "BruteSSH.exe", fn: ns.brutessh },
    { exe: "FTPCrack.exe", fn: ns.ftpcrack },
    { exe: "relaySMTP.exe", fn: ns.relaysmtp },
    { exe: "HTTPWorm.exe", fn: ns.httpworm },
    { exe: "SQLInject.exe", fn: ns.sqlinject },
  ];
  const availableOpeners = portOpeners.filter(o => ns.fileExists(o.exe, "home") && typeof o.fn === "function");

  // Lock to avoid overlapping autoroot runs
  const lockFile = "autoroot.lock";
  if (isLocked(ns, lockFile, 10 * 60 * 1000)) {
    ns.tprint("autoroot: another autoroot appears to be running. Exiting.");
    return;
  }
  writeLock(ns, lockFile);

  try {
    // Build candidate list
    let targets = explicitTargets.slice();
    if (targets.length === 0) {
      targets = discoverServers(ns, availableOpeners, maxTargets);
    } else {
      targets = targets.filter(t => {
        try { ns.getServer(t); return true; } catch { ns.print(`autoroot: explicit target not found: ${t}`); return false; }
      }).slice(0, maxTargets);
    }

    if (targets.length === 0) {
      ns.tprint("autoroot: no candidate targets found.");
      return;
    }

    ns.tprint(`autoroot: candidates: ${targets.join(", ")}`);

    for (const target of targets) {
      ns.print(`autoroot: processing ${target}`);

      // Skip home and purchased servers
      if (target === "home" || ns.getPurchasedServers().includes(target)) {
        ns.print(`autoroot: skipping ${target} (home or purchased)`);
        continue;
      }

      // If already have root, optionally deploy workers
      if (ns.hasRootAccess(target)) {
        ns.print(`autoroot: already have root on ${target}`);
        if (deploy && !dry) await deployWorkersTo(ns, target, workerFiles);
        continue;
      }

      // Attempt to open ports using available openers
      let opened = 0;
      for (const o of availableOpeners) {
        try {
          o.fn(target);
          opened++;
          ns.print(`autoroot: ran ${o.exe} on ${target}`);
        } catch (e) {
          ns.print(`autoroot: ${o.exe} failed on ${target}: ${e}`);
        }
        await ns.sleep(50);
      }

      // Check required ports and nuke if possible
      try {
        const required = ns.getServerNumPortsRequired(target);
        if (opened >= required) {
          ns.nuke(target);
          ns.tprint(`autoroot: nuked ${target}`);
          if (deploy && !dry) await deployWorkersTo(ns, target, workerFiles);
        } else {
          ns.tprint(`autoroot: not enough ports opened for ${target} (opened ${opened}, required ${required})`);
        }
      } catch (e) {
        ns.tprint(`autoroot: error checking/nuking ${target}: ${e}`);
      }

      // small pause between targets
      await ns.sleep(200);
    }
  } finally {
    removeLock(ns, lockFile);
  }

  ns.tprint("autoroot: finished.");
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

function discoverServers(ns, availableOpeners, maxTargets) {
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
        // skip servers with no money or special servers
        if (srv.moneyMax <= 0) continue;
        // prefer servers we can nuke (enough openers)
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

async function deployWorkersTo(ns, host, workerFiles) {
  try {
    for (const src of workerFiles) {
      try {
        const ok = ns.scp(src, host, "home");
        if (!ok) ns.print(`autoroot: scp failed for ${src} -> ${host}`);
        else ns.print(`autoroot: scp succeeded for ${src} -> ${host}`);
      } catch (e) {
        ns.print(`autoroot: scp exception for ${src} -> ${host}: ${e}`);
      }
      await ns.sleep(50);
    }
  } catch (e) {
    ns.print(`autoroot: deployWorkersTo error for ${host}: ${e}`);
  }
}

/** Lock helpers */
function writeLock(ns, lockFile) {
  try { ns.write(lockFile, JSON.stringify({ ts: Date.now() }), "w"); } catch (e) { ns.print(`writeLock failed: ${e}`); }
}
function removeLock(ns, lockFile) {
  try { ns.write(lockFile, "", "w"); } catch (e) { ns.print(`removeLock failed: ${e}`); }
}
function isLocked(ns, lockFile, ttlMs) {
  try {
    if (!ns.fileExists(lockFile, "home")) return false;
    const content = ns.read(lockFile);
    if (!content) return false;
    const obj = JSON.parse(content);
    if (!obj.ts) return false;
    return (Date.now() - obj.ts) < ttlMs;
  } catch (e) {
    ns.print(`isLocked error: ${e}`);
    return false;
  }
}
