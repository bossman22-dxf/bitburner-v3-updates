/** @param {NS} ns **/
/**
 * serverAllocator.js
 *
 * Scans purchased servers and home, computes usable RAM, and allocates threads
 * for minimal worker scripts (scripts/hack.js, scripts/grow.js, scripts/weaken.js).
 *
 * Usage:
 *   run serverAllocator.js [--dry] [--exec] [--reservedPerHost=2] [--reservedHomeRam=2] [--ratio=1,2,2]
 *
 * Notes:
 * - Worker scripts are expected at home under scripts/<name>.
 * - --dry prints allocation plan; --exec will attempt to scp and exec on each host.
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
  const reservedHomeRam = Number(flags.reservedHomeRam) || 2;
  const ratioArg = flags.ratio || "1,2,2";
  const ratioParts = ratioArg.split(",").map(s => Number(s.trim()) || 0);
  const ratio = { hack: ratioParts[0] || 1, grow: ratioParts[1] || 2, weaken: ratioParts[2] || 2 };

  const hackScript = "scripts/hack.js";
  const growScript = "scripts/grow.js";
  const weakenScript = "scripts/weaken.js";

  // Validate worker scripts exist on home
  for (const f of [hackScript, growScript, weakenScript]) {
    if (!ns.fileExists(f, "home")) {
      ns.tprint(`serverAllocator: missing worker script on home: ${f}. Place workers in home/scripts and retry.`);
      return;
    }
  }

  // Build host list: home + purchased servers
  let hosts = ["home"];
  try {
    const purchased = ns.getPurchasedServers();
    if (purchased && purchased.length) hosts = hosts.concat(purchased);
  } catch (e) {
    ns.tprint(`serverAllocator: error retrieving purchased servers: ${e}`);
  }

  // Compute usable RAM and script RAM per host
  const hostInfo = [];
  for (const h of hosts) {
    try {
      const maxRam = ns.getServerMaxRam(h);
      const usedRam = ns.getServerUsedRam(h);
      const reserved = (h === "home") ? reservedHomeRam : reservedPerHost;
      const usable = Math.max(0, maxRam - usedRam - reserved);
      const ramHack = ns.getScriptRam(hackScript, "home");
      const ramGrow = ns.getScriptRam(growScript, "home");
      const ramWeaken = ns.getScriptRam(weakenScript, "home");
      hostInfo.push({ host: h, maxRam, usedRam, reserved, usable, ramHack, ramGrow, ramWeaken });
    } catch (e) {
      ns.print(`serverAllocator: error querying ${h}: ${e}`);
    }
  }

  // Sort hosts by usable RAM descending
  hostInfo.sort((a, b) => b.usable - a.usable);

  // Build allocation plan
  const plan = [];
  for (const h of hostInfo) {
    const perBatchRam = ratio.hack * h.ramHack + ratio.grow * h.ramGrow + ratio.weaken * h.ramWeaken;
    if (perBatchRam <= 0 || h.usable < Math.min(h.ramHack, h.ramGrow, h.ramWeaken)) {
      plan.push({ host: h.host, usable: h.usable, hack: 0, grow: 0, weaken: 0 });
      continue;
    }
    // Fit as many batches as possible
    const batches = Math.max(1, Math.floor(h.usable / perBatchRam));
    const hackThreads = Math.max(0, Math.floor(ratio.hack * batches));
    const growThreads = Math.max(0, Math.floor(ratio.grow * batches));
    const weakenThreads = Math.max(0, Math.floor(ratio.weaken * batches));
    plan.push({ host: h.host, usable: h.usable, hack: hackThreads, grow: growThreads, weaken: weakenThreads, totalRam: hackThreads*h.ramHack + growThreads*h.ramGrow + weakenThreads*h.ramWeaken });
  }

  // Print plan summary
  ns.tprint("serverAllocator: allocation plan:");
  for (const p of plan) {
    ns.print(`  ${p.host}: usable=${p.usable} -> hack=${p.hack} grow=${p.grow} weaken=${p.weaken} ram=${p.totalRam ?? 0}`);
  }

  if (dry || !execMode) {
    ns.tprint("serverAllocator: dry mode or exec not enabled; not executing scripts.");
    return;
  }

  // Exec mode: scp workers to hosts and launch scripts
  for (const p of plan) {
    if (p.host === "home") {
      ns.print("serverAllocator: skipping exec on home (workers run from home by bootstrap/batchEngine).");
      continue;
    }
    // Ensure scripts present on host
    for (const src of [hackScript, growScript, weakenScript]) {
      try {
        const ok = ns.scp(src, p.host, "home");
        if (!ok) ns.print(`serverAllocator: scp failed for ${src} -> ${p.host}`);
      } catch (e) {
        ns.print(`serverAllocator: scp exception for ${src} -> ${p.host}: ${e}`);
      }
      await ns.sleep(50);
    }

    // Launch weaken -> grow -> hack with small offsets
    try {
      if (p.weaken > 0) {
        const pidW = ns.exec(weakenScript, p.host, p.weaken, p.host === "home" ? p.host : p.host); // target arg is the target host; orchestrator may override
        if (!pidW) ns.print(`serverAllocator: failed to exec weaken on ${p.host}`);
      }
      await ns.sleep(200);
      if (p.grow > 0) {
        const pidG = ns.exec(growScript, p.host, p.grow, p.host);
        if (!pidG) ns.print(`serverAllocator: failed to exec grow on ${p.host}`);
      }
      await ns.sleep(200);
      if (p.hack > 0) {
        const pidH = ns.exec(hackScript, p.host, p.hack, p.host);
        if (!pidH) ns.print(`serverAllocator: failed to exec hack on ${p.host}`);
      }
      ns.tprint(`serverAllocator: launched workers on ${p.host} (hack:${p.hack} grow:${p.grow} weaken:${p.weaken})`);
    } catch (e) {
      ns.print(`serverAllocator: error launching on ${p.host}: ${e}`);
    }
    await ns.sleep(200);
  }

  ns.tprint("serverAllocator: finished.");
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
