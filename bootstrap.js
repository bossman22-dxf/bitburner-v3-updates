/** @param {NS} ns **/
/**
 * bootstrap.js
 *
 * Lightweight autoroot + batch launcher for the early run.
 * - Worker scripts must be in home/scripts: hack.js, grow.js, weaken.js
 * - No references to other orchestrators; intended for first-hour startup.
 *
 * Usage:
 *   run bootstrap.js [--dry] [--reservedHomeRam=2] [--maxTargets=5] [--targets=host1,host2]
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("scp");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const reservedHomeRam = Number(flags.reservedHomeRam) || 2;
  const maxTargets = Number(flags.maxTargets) || 5;
  const explicitTargets = (flags.targets && typeof flags.targets === "string") ? flags.targets.split(",").map(s => s.trim()).filter(Boolean) : [];

  ns.tprint(`bootstrap: start (dry=${dry}) reservedHomeRam=${reservedHomeRam} maxTargets=${maxTargets}`);

  // Worker script paths (expected under home/scripts)
  const hackScript = "scripts/hack.js";
  const growScript = "scripts/grow.js";
  const weakenScript = "scripts/weaken.js";

  // Verify worker scripts exist in home/scripts
  for (const f of [hackScript, growScript, weakenScript]) {
    if (!ns.fileExists(f, "home")) {
      ns.tprint(`bootstrap: missing worker script on home: ${f}. Place workers in home/scripts and retry.`);
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

  // Lock to avoid overlapping bootstrap runs
  const lockFile = "bootstrap.lock";
  if (isLocked(ns, lockFile, 10 * 60 * 1000)) {
    ns.tprint("bootstrap: another bootstrap appears to be running. Exiting.");
    return;
  }
  writeLock(ns, lockFile);

  try {
    // Determine candidate targets
    let targets = explicitTargets.slice();
    if (targets.length === 0) {
      targets = discoverTargets(ns, availableOpeners, maxTargets);
    } else {
      // validate explicit targets
      targets = targets.filter(t => {
        try { ns.getServer(t); return true; } catch { ns.print(`bootstrap: explicit target not found: ${t}`); return false; }
      }).slice(0, maxTargets);
    }

    if (targets.length === 0) {
      ns.tprint("bootstrap: no candidate targets found.");
      return;
    }

    ns.tprint(`bootstrap: targets to process: ${targets.join(", ")}`);

    // For each target: try to open ports and nuke; then schedule a single batch from home
    for (const target of targets) {
      ns.print(`bootstrap: processing ${target}`);

      // If we already have root, skip port openers but still may schedule batch
      if (!ns.hasRootAccess(target)) {
        let opened = 0;
        for (const o of availableOpeners) {
          try {
            o.fn(target);
            opened++;
            ns.print(`bootstrap: ran ${o.exe} on ${target}`);
          } catch (e) {
            ns.print(`bootstrap: ${o.exe} failed on ${target}: ${e}`);
          }
          await ns.sleep(50);
        }

        try {
          const required = ns.getServerNumPortsRequired(target);
          if (opened >= required) {
            ns.nuke(target);
            ns.tprint(`bootstrap: nuked ${target}`);
          } else {
            ns.tprint(`bootstrap: not enough ports opened for ${target} (opened ${opened}, required ${required})`);
            // skip scheduling if we couldn't nuke
            continue;
          }
        } catch (e) {
          ns.tprint(`bootstrap: nuke attempt error for ${target}: ${e}`);
          continue;
        }
      } else {
        ns.print(`bootstrap: already have root on ${target}`);
      }

      // Schedule a single conservative batch from home
      try {
        const homeMax = ns.getServerMaxRam("home");
        const homeUsed = ns.getServerUsedRam("home");
        const usable = Math.max(0, homeMax - homeUsed - reservedHomeRam);
        const ramHack = ns.getScriptRam(hackScript, "home");
        const ramGrow = ns.getScriptRam(growScript, "home");
        const ramWeaken = ns.getScriptRam(weakenScript, "home");

        // Ratio 1:2:2
        const ratio = { hack: 1, grow: 2, weaken: 2 };
        const perBatchRam = ratio.hack * ramHack + ratio.grow * ramGrow + ratio.weaken * ramWeaken;
        if (perBatchRam <= 0) {
          ns.tprint("bootstrap: invalid script RAM calculation; aborting batch scheduling.");
          continue;
        }

        // Fit as many scaled batches as possible but keep at least one small batch
        const maxBatches = Math.max(1, Math.floor(usable / perBatchRam));
        const hackThreads = Math.max(1, Math.floor(ratio.hack * maxBatches));
        const growThreads = Math.max(1, Math.floor(ratio.grow * maxBatches));
        const weakenThreads = Math.max(1, Math.floor(ratio.weaken * maxBatches));
        const totalRamNeeded = hackThreads * ramHack + growThreads * ramGrow + weakenThreads * ramWeaken;

        ns.tprint(`bootstrap: scheduling batch on ${target} (threads hack:${hackThreads} grow:${growThreads} weaken:${weakenThreads}) uses ${totalRamNeeded} RAM on home`);

        if (dry) {
          ns.print("bootstrap: dry mode - not executing batch.");
          continue;
        }

        // Launch weaken -> grow -> hack with small offsets so weaken finishes last
        const home = "home";
        const pidW = ns.exec(weakenScript, home, weakenThreads, target);
        if (!pidW) ns.print(`bootstrap: failed to exec weaken on ${home}`);
        await ns.sleep(200);

        const pidG = ns.exec(growScript, home, growThreads, target);
        if (!pidG) ns.print(`bootstrap: failed to exec grow on ${home}`);
        await ns.sleep(200);

        const pidH = ns.exec(hackScript, home, hackThreads, target);
        if (!pidH) ns.print(`bootstrap: failed to exec hack on ${home}`);

        ns.tprint(`bootstrap: launched batch for ${target} pids weaken=${pidW} grow=${pidG} hack=${pidH}`);
        // small pause between targets
        await ns.sleep(1000);
      } catch (e) {
        ns.print(`bootstrap: scheduling error for ${target}: ${e}`);
      }
    }
  } finally {
    removeLock(ns, lockFile);
  }

  ns.tprint("bootstrap: finished.");
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

function discoverTargets(ns, availableOpeners, maxTargets) {
  // Find servers with money and that are not purchased/home/system
  const visited = new Set(["home"]);
  const queue = ["home"];
  const candidates = [];
  while (queue.length && candidates.length < maxTargets) {
    const node = queue.shift();
    for (const n of ns.scan(node)) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
      try {
        if (n === "home" || ns.getPurchasedServers().includes(n)) continue;
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
