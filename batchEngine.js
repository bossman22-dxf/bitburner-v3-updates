/** @param {NS} ns **/
/**
 * batchEngine.js
 *
 * Purpose: schedule simple hack/grow/weaken batches against a target.
 * - Conservative defaults; use config or args to tune.
 * - Dry run mode prints planned actions without executing.
 * - Uses lock files on home to avoid overlapping batches from multiple controllers.
 *
 * Usage:
 *   run batchEngine.js <target> [--dry] [--threadsPerBatch=...]
 *
 * Notes:
 * - This script assumes the helper scripts (hack.js, grow.js, weaken.js) exist on home.
 * - It does not rely on Singularity APIs.
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const args = ns.args.slice();
  const target = (args[0] && typeof args[0] === "string") ? args[0] : ns.args[0] ?? "n00dles";

  // Parse flags from args (simple)
  const flags = parseFlags(ns.args);
  const dryRun = flags.dry === true || flags.dry === "true";
  const threadsPerBatch = Number(flags.threadsPerBatch) || 0; // 0 = auto-calc
  const batchGapMs = Number(flags.batchGapMs) || 2000; // gap between batches
  const lockTtlMs = Number(flags.lockTtlMs) || 5 * 60 * 1000; // lock expiry

  ns.tprint(`batchEngine: target=${target} dryRun=${dryRun} threadsPerBatch=${threadsPerBatch || "auto"} batchGapMs=${batchGapMs}`);

  // Basic validation
  if (!ns.serverExists(target)) {
    ns.tprint(`batchEngine: target ${target} does not exist`);
    return;
  }

  // Ensure we have the three worker scripts on home
  const scripts = { hack: "hack.js", grow: "grow.js", weaken: "weaken.js" };
  for (const s of Object.values(scripts)) {
    if (!ns.fileExists(s, "home")) {
      ns.tprint(`batchEngine: missing required script on home: ${s}. Upload or create it first.`);
      return;
    }
  }

  // Lock file to avoid overlapping batches
  const lockFile = `batchLock_${target}.lock`;
  if (isLocked(ns, lockFile, lockTtlMs)) {
    ns.tprint(`batchEngine: another controller appears to be running for ${target}. Exiting.`);
    return;
  }
  writeLock(ns, lockFile);

  try {
    // Compute timings
    const hackTime = ns.getHackTime(target);
    const growTime = ns.getGrowTime(target);
    const weakenTime = ns.getWeakenTime(target);

    // Determine thread counts
    const scriptRamHack = ns.getScriptRam(scripts.hack, "home");
    const scriptRamGrow = ns.getScriptRam(scripts.grow, "home");
    const scriptRamWeaken = ns.getScriptRam(scripts.weaken, "home");

    // Available RAM on home (conservative)
    const homeMax = ns.getServerMaxRam("home");
    const homeUsed = ns.getServerUsedRam("home");
    const reservedHome = Number(flags.reservedHomeRam) || 8; // keep some RAM free
    const usableHomeRam = Math.max(0, homeMax - homeUsed - reservedHome);

    // If threadsPerBatch provided, use it to compute per-script threads proportionally
    let planned = {};
    if (threadsPerBatch > 0) {
      // Simple proportional split: hack : grow : weaken = 1 : 2 : 2 (tunable)
      const ratio = { hack: 1, grow: 2, weaken: 2 };
      const totalRatio = ratio.hack + ratio.grow + ratio.weaken;
      planned.hackThreads = Math.max(1, Math.floor((threadsPerBatch * ratio.hack) / totalRatio));
      planned.growThreads = Math.max(1, Math.floor((threadsPerBatch * ratio.grow) / totalRatio));
      planned.weakenThreads = Math.max(1, Math.floor((threadsPerBatch * ratio.weaken) / totalRatio));
    } else {
      // Auto-calc: fit as many full batches as possible on home using script RAM
      // We'll compute a single batch sized to use up to usableHomeRam (conservative)
      // Use ratio hack:grow:weaken = 1:2:2 (common safe starting point)
      const ratio = { hack: 1, grow: 2, weaken: 2 };
      const perBatchRam = ratio.hack * scriptRamHack + ratio.grow * scriptRamGrow + ratio.weaken * scriptRamWeaken;
      if (perBatchRam <= 0) {
        ns.tprint("batchEngine: invalid script RAM calculation");
        return;
      }
      const maxBatches = Math.max(1, Math.floor(usableHomeRam / perBatchRam));
      // We'll run one batch at a time by default; compute threads for a single batch
      planned.hackThreads = Math.max(1, Math.floor((ratio.hack * 1)));
      planned.growThreads = Math.max(1, Math.floor((ratio.grow * 1)));
      planned.weakenThreads = Math.max(1, Math.floor((ratio.weaken * 1)));
      // If usableHomeRam allows more aggressive threads, scale up proportionally
      const scale = Math.floor(usableHomeRam / perBatchRam);
      if (scale > 1) {
        planned.hackThreads *= scale;
        planned.growThreads *= scale;
        planned.weakenThreads *= scale;
      }
    }

    // Final safety: ensure planned threads fit in usableHomeRam
    const totalRamNeeded = planned.hackThreads * scriptRamHack + planned.growThreads * scriptRamGrow + planned.weakenThreads * scriptRamWeaken;
    if (totalRamNeeded > usableHomeRam) {
      ns.tprint(`batchEngine: planned RAM ${totalRamNeeded} exceeds usable home RAM ${usableHomeRam}. Scaling down.`);
      const scale = Math.floor(usableHomeRam / Math.max(1, (scriptRamHack * planned.hackThreads + scriptRamGrow * planned.growThreads + scriptRamWeaken * planned.weakenThreads)));
      if (scale <= 0) {
        ns.tprint("batchEngine: not enough RAM to run a single scaled batch. Exiting.");
        return;
      }
      planned.hackThreads = Math.max(1, Math.floor(planned.hackThreads * scale));
      planned.growThreads = Math.max(1, Math.floor(planned.growThreads * scale));
      planned.weakenThreads = Math.max(1, Math.floor(planned.weakenThreads * scale));
    }

    ns.tprint(`batchEngine: planned threads -> hack:${planned.hackThreads} grow:${planned.growThreads} weaken:${planned.weakenThreads}`);
    ns.print(`batchEngine: timings (ms) hack:${Math.round(hackTime)} grow:${Math.round(growTime)} weaken:${Math.round(weakenTime)}`);

    // Dry run prints plan and exits
    if (dryRun) {
      ns.tprint("batchEngine: dryRun enabled — no scripts will be executed.");
      return;
    }

    // Schedule a single batch with conservative offsets so weaken finishes last
    // Offsets chosen so: weaken finishes slightly after grow and hack
    const now = Date.now();
    const weakenFinish = now + weakenTime;
    const hackOffset = Math.max(0, weakenTime - hackTime - 150);   // hack should finish ~150ms before weaken
    const growOffset = Math.max(0, weakenTime - growTime - 300);   // grow should finish ~300ms before weaken
    const weakenOffset = Math.max(0, 0); // start weaken immediately so it finishes at weakenFinish

    // Launch weaken (first instance)
    const home = "home";
    const weakenPid = await safeExec(ns, scripts.weaken, home, planned.weakenThreads, [target]);
    ns.print(`batchEngine: launched weaken pid=${weakenPid} threads=${planned.weakenThreads} offset=${weakenOffset}`);

    // Sleep until time to launch grow
    await ns.sleep(Math.max(0, growOffset));
    const growPid = await safeExec(ns, scripts.grow, home, planned.growThreads, [target]);
    ns.print(`batchEngine: launched grow pid=${growPid} threads=${planned.growThreads} offset=${growOffset}`);

    // Sleep until time to launch hack
    await ns.sleep(Math.max(0, hackOffset - growOffset));
    const hackPid = await safeExec(ns, scripts.hack, home, planned.hackThreads, [target]);
    ns.print(`batchEngine: launched hack pid=${hackPid} threads=${planned.hackThreads} offset=${hackOffset}`);

    ns.tprint(`batchEngine: batch scheduled for ${target}. PIDs: weaken=${weakenPid} grow=${growPid} hack=${hackPid}`);
    // Wait a small gap before releasing lock so other controllers can schedule later
    await ns.sleep(batchGapMs);
  } finally {
    // Remove lock
    removeLock(ns, lockFile);
  }
}

/* -------------------- Helpers -------------------- */

/** Parse simple flags from args array (supports --key=value and --flag) */
function parseFlags(args) {
  const out = {};
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out[a.slice(2)] = true;
    } else {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      out[k] = v;
    }
  }
  return out;
}

/** Safe exec wrapper: returns pid or 0 on failure */
async function safeExec(ns, script, host, threads, args = []) {
  try {
    if (threads <= 0) {
      ns.print(`safeExec: zero threads for ${script} on ${host}`);
      return 0;
    }
    const pid = ns.exec(script, host, threads, ...args);
    if (!pid) {
      ns.print(`safeExec: failed to exec ${script} on ${host} with ${threads} threads`);
      return 0;
    }
    return pid;
  } catch (e) {
    ns.print(`safeExec: exception exec ${script} on ${host}: ${e}`);
    return 0;
  }
}

/** Lock helpers: write a small lock file on home and check TTL */
function writeLock(ns, lockFile) {
  try {
    const payload = JSON.stringify({ ts: Date.now() });
    ns.write(lockFile, payload, "w");
  } catch (e) {
    ns.print(`writeLock: failed to write ${lockFile}: ${e}`);
  }
}

function removeLock(ns, lockFile) {
  try {
    // Overwrite with empty content to remove; Bitburner doesn't have unlink API
    ns.write(lockFile, "", "w");
  } catch (e) {
    ns.print(`removeLock: failed to remove ${lockFile}: ${e}`);
  }
}

function isLocked(ns, lockFile, ttlMs) {
  try {
    if (!ns.fileExists(lockFile, "home")) return false;
    const content = ns.read(lockFile);
    if (!content) return false;
    const obj = JSON.parse(content);
    if (!obj.ts) return false;
    const age = Date.now() - obj.ts;
    if (age > ttlMs) {
      // stale lock; treat as unlocked
      return false;
    }
    return true;
  } catch (e) {
    ns.print(`isLocked: error reading ${lockFile}: ${e}`);
    return false;
  }
}
