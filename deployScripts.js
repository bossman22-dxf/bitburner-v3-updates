/** @param {NS} ns **/
/**
 * deployScripts.js
 *
 * Copies worker scripts from home/scripts to target hosts and optionally launches them.
 *
 * Usage:
 *   run deployScripts.js [--dry] [--exec] [--targets=host1,host2] [--reservedPerHost=2] [--ratio=1,2,2]
 *
 * Notes:
 * - Worker scripts expected at home/scripts/hack.js, grow.js, weaken.js
 * - By default targets = purchased servers
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("scp");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const execMode = flags.exec === true || flags.exec === "true";
  const reservedPerHost = Number(flags.reservedPerHost) || 2;
  const targetsFlag = flags.targets || "";
  const ratioArg = flags.ratio || "1,2,2";
  const ratioParts = ratioArg.split(",").map(s => Number(s.trim()) || 0);
  const ratio = { hack: ratioParts[0] || 1, grow: ratioParts[1] || 2, weaken: ratioParts[2] || 2 };

  const hackSrc = "scripts/hack.js";
  const growSrc = "scripts/grow.js";
  const weakenSrc = "scripts/weaken.js";

  // Validate worker scripts exist on home/scripts
  for (const f of [hackSrc, growSrc, weakenSrc]) {
    if (!ns.fileExists(f, "home")) {
      ns.tprint(`deployScripts: missing worker script on home: ${f}. Place workers in home/scripts and retry.`);
      return;
    }
  }

  // Build target list
  let targets = [];
  if (targetsFlag) {
    targets = targetsFlag.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    try {
      targets = ns.getPurchasedServers();
    } catch (e) {
      ns.tprint(`deployScripts: error retrieving purchased servers: ${e}`);
      return;
    }
  }

  if (!targets || targets.length === 0) {
    ns.tprint("deployScripts: no target hosts found.");
    return;
  }

  ns.tprint(`deployScripts: targets=${targets.join(", ")} exec=${execMode} dry=${dry}`);

  for (const host of targets) {
    try {
      const maxRam = ns.getServerMaxRam(host);
      const usedRam = ns.getServerUsedRam(host);
      const usable = Math.max(0, maxRam - usedRam - reservedPerHost);
      ns.print(`deployScripts: host=${host} max=${maxRam} used=${usedRam} usable=${usable}`);
    } catch (e) {
      ns.print(`deployScripts: cannot query ${host}: ${e}`);
      continue;
    }

    // Copy worker scripts to host
    for (const src of [hackSrc, growSrc, weakenSrc]) {
      try {
        const ok = ns.scp(src, host, "home");
        if (!ok) ns.print(`deployScripts: scp failed for ${src} -> ${host}`);
        else ns.print(`deployScripts: scp succeeded for ${src} -> ${host}`);
      } catch (e) {
        ns.print(`deployScripts: scp exception for ${src} -> ${host}: ${e}`);
      }
      await ns.sleep(50);
    }

    // Compute threads that fit on host for the ratio
    try {
      const ramHack = ns.getScriptRam(hackSrc, host);
      const ramGrow = ns.getScriptRam(growSrc, host);
      const ramWeaken = ns.getScriptRam(weakenSrc, host);
      const perBatchRam = ratio.hack * ramHack + ratio.grow * ramGrow + ratio.weaken * ramWeaken;
      if (perBatchRam <= 0) {
        ns.print(`deployScripts: invalid per-batch RAM calculation on ${host}`);
        continue;
      }
      const maxBatches = Math.max(1, Math.floor((ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reservedPerHost) / perBatchRam));
      const hackThreads = Math.max(0, Math.floor(ratio.hack * maxBatches));
      const growThreads = Math.max(0, Math.floor(ratio.grow * maxBatches));
      const weakenThreads = Math.max(0, Math.floor(ratio.weaken * maxBatches));
      const totalRam = hackThreads * ramHack + growThreads * ramGrow + weakenThreads * ramWeaken;

      ns.tprint(`deployScripts: plan for ${host} -> hack:${hackThreads} grow:${growThreads} weaken:${weakenThreads} RAM=${totalRam}`);

      if (!execMode || dry) {
        ns.print(`deployScripts: dry/exec disabled; skipping launch on ${host}`);
        continue;
      }

      // Launch weaken -> grow -> hack with small offsets
      if (weakenThreads > 0) {
        const pidW = ns.exec(weakenSrc, host, weakenThreads, host);
        if (!pidW) ns.print(`deployScripts: failed to exec weaken on ${host}`);
      }
      await ns.sleep(200);
      if (growThreads > 0) {
        const pidG = ns.exec(growSrc, host, growThreads, host);
        if (!pidG) ns.print(`deployScripts: failed to exec grow on ${host}`);
      }
      await ns.sleep(200);
      if (hackThreads > 0) {
        const pidH = ns.exec(hackSrc, host, hackThreads, host);
        if (!pidH) ns.print(`deployScripts: failed to exec hack on ${host}`);
      }

      ns.tprint(`deployScripts: launched workers on ${host}`);
    } catch (e) {
      ns.print(`deployScripts: error planning/executing on ${host}: ${e}`);
    }

    await ns.sleep(200);
  }

  ns.tprint("deployScripts: finished.");
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
