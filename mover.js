/** @param {NS} ns **/
/*
  mover.js
  - Moves non-ready batch targets to prepTargets and writes updated batch list.
  - Updated for Bitburner 3.0.0 compatibility and defensive checks.
*/

export async function main(ns) {
  ns.disableLog("ALL");

  const BATCH_FILE = "/data/batchTargets.txt";
  const PREP_FILE = "/data/prepTargets.txt";

  ns.ui.openTail();
  ns.print("🔀 mover.js starting");

  // Read current batch targets
  const batchTargets = await readList(ns, BATCH_FILE);
  if (batchTargets.length === 0) {
    ns.tprint("ℹ️ No batch targets found.");
    return;
  }

  const ready = [];
  const notReady = [];

  for (const target of batchTargets) {
    try {
      if (!ns.serverExists(target)) {
        ns.print(`⚠️ Skipping ${target} — server does not exist`);
        notReady.push(target);
        continue;
      }

      const sec = ns.getServerSecurityLevel(target);
      const minSec = ns.getServerMinSecurityLevel(target);
      const money = ns.getServerMoneyAvailable(target);
      const maxMoney = ns.getServerMaxMoney(target);

      const isReady = (typeof sec === "number" && typeof minSec === "number" && typeof money === "number" && typeof maxMoney === "number")
        ? (sec <= minSec + 0.5 && money >= maxMoney * 0.95)
        : false;

      if (isReady) ready.push(target);
      else notReady.push(target);
    } catch (e) {
      ns.print(`❌ Error checking ${target}: ${String(e)}`);
      notReady.push(target);
    }
  }

  // Persist remaining ready batch targets
  await ns.write(BATCH_FILE, ready.join("\n") + (ready.length ? "\n" : ""), "w");

  // Merge notReady into prep file (dedupe)
  const currentPrep = await readList(ns, PREP_FILE);
  const updatedPrepSet = new Set([...currentPrep, ...notReady]);
  const updatedPrep = Array.from(updatedPrepSet);
  await ns.write(PREP_FILE, updatedPrep.join("\n") + (updatedPrep.length ? "\n" : ""), "w");

  ns.tprint(`✅ Moved ${notReady.length} non-ready targets to ${PREP_FILE}`);
  ns.tprint(`📦 Remaining batch targets: ${ready.length}`);
}

/* ---------- Helpers ---------- */

async function readList(ns, file) {
  try {
    if (!ns.fileExists(file)) return [];
    const raw = ns.read(file);
    if (!raw) return [];
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
