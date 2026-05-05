/** @param {NS} ns **/
/**
 * buyserver.js
 *
 * Conservative purchased-server manager.
 *
 * Usage examples:
 *   run buyserver.js --dry
 *   run buyserver.js --maxSpendPercent=0.6 --minRam=16 --replace=true
 *   run buyserver.js --mpsPerGB=0.05 --paybackDays=7
 */
export async function main(ns) {
  ns.disableLog("sleep");
  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const maxSpendPercent = Number(flags.maxSpendPercent) || 0.5;
  const minRam = Number(flags.minRam) || 8;
  const allowReplace = flags.replace === "false" ? false : true;
  const mpsPerGB = flags.mpsPerGB ? Number(flags.mpsPerGB) : null;
  const paybackDaysThreshold = flags.paybackDays ? Number(flags.paybackDays) : null;

  ns.tprint(`buyserver: start (dry=${dry}) maxSpendPercent=${maxSpendPercent} minRam=${minRam} replace=${allowReplace}`);

  // Basic environment checks
  let funds = 0;
  try {
    funds = ns.getServerMoneyAvailable("home");
  } catch (e) {
    ns.tprint(`buyserver: cannot query home money: ${e}`);
    return;
  }

  const budget = funds * Math.max(0, Math.min(1, maxSpendPercent));
  ns.print(`buyserver: home funds=${formatMoney(funds)} budget for purchase=${formatMoney(budget)}`);

  // Purchased server limits and list
  const limit = ns.getPurchasedServerLimit();
  const owned = ns.getPurchasedServers();
  ns.print(`buyserver: purchased ${owned.length}/${limit}`);

  // Find largest affordable power-of-two RAM within budget
  const maxPower = 20; // 2^20 = 1,048,576 GB upper bound (safe cap)
  let bestRam = 0;
  for (let p = 1; p <= maxPower; p++) {
    const ram = Math.pow(2, p);
    if (ram < minRam) continue;
    const cost = ns.getPurchasedServerCost(ram);
    if (cost <= budget) bestRam = ram;
    else break;
  }

  if (bestRam === 0) {
    ns.tprint("buyserver: no affordable server meets minRam and budget constraints.");
    return;
  }

  const costForBest = ns.getPurchasedServerCost(bestRam);
  const costPerGB = costForBest / bestRam;
  ns.tprint(`buyserver: candidate purchase -> RAM=${bestRam} cost=${formatMoney(costForBest)} cost/GB=${formatMoney(costPerGB)}`);

  if (mpsPerGB) {
    const secondsToPayback = costPerGB / mpsPerGB;
    const days = secondsToPayback / (60 * 60 * 24);
    ns.tprint(`buyserver: estimated payback for 1GB at ${mpsPerGB}/s = ${days.toFixed(2)} days`);
    if (paybackDaysThreshold && days > paybackDaysThreshold) {
      ns.tprint(`buyserver: payback ${days.toFixed(2)} days exceeds threshold ${paybackDaysThreshold} days — aborting purchase.`);
      return;
    }
  }

  // If we have room to buy more servers, just buy
  if (owned.length < limit) {
    ns.tprint(`buyserver: space available (${owned.length}/${limit}). Proceeding to purchase.`);
    if (dry) {
      ns.tprint(`buyserver: dry run - would purchase server with RAM=${bestRam} for ${formatMoney(costForBest)}`);
      return;
    }
    const name = `pserv-${Date.now()}-${bestRam}`;
    try {
      const ok = ns.purchaseServer(name, bestRam);
      if (ok) ns.tprint(`buyserver: purchased ${name} with ${bestRam} GB`);
      else ns.tprint("buyserver: purchaseServer returned falsy value; purchase may have failed.");
    } catch (e) {
      ns.tprint(`buyserver: purchase failed: ${e}`);
    }
    return;
  }

  // At limit: consider replacing the smallest server if allowed and beneficial
  if (!allowReplace) {
    ns.tprint("buyserver: at server limit and replace disabled. No action taken.");
    return;
  }

  // Find smallest owned server
  let smallest = null;
  for (const h of owned) {
    try {
      const r = ns.getServerMaxRam(h);
      if (!smallest || r < smallest.ram) smallest = { host: h, ram: r };
    } catch (e) {
      ns.print(`buyserver: error querying ${h}: ${e}`);
    }
  }

  if (!smallest) {
    ns.tprint("buyserver: could not determine smallest purchased server; aborting.");
    return;
  }

  ns.print(`buyserver: smallest purchased server is ${smallest.host} with ${smallest.ram} GB`);

  if (bestRam <= smallest.ram) {
    ns.tprint(`buyserver: candidate RAM ${bestRam} is not larger than smallest owned ${smallest.ram}; no replacement beneficial.`);
    return;
  }

  // Replacement decision: ensure cost is affordable
  if (costForBest > budget) {
    ns.tprint(`buyserver: candidate cost ${formatMoney(costForBest)} exceeds budget ${formatMoney(budget)}; aborting replacement.`);
    return;
  }

  // Proceed with replacement
  ns.tprint(`buyserver: will replace ${smallest.host} (${smallest.ram}GB) with new server ${bestRam}GB for ${formatMoney(costForBest)}`);
  if (dry) {
    ns.tprint("buyserver: dry run - not performing delete/purchase.");
    return;
  }

  try {
    // Delete smallest server
    ns.killall(smallest.host);
    const deleted = ns.deleteServer(smallest.host);
    if (!deleted) {
      ns.tprint(`buyserver: failed to delete ${smallest.host}; aborting purchase.`);
      return;
    }
    ns.tprint(`buyserver: deleted ${smallest.host}`);
  } catch (e) {
    ns.tprint(`buyserver: error deleting ${smallest.host}: ${e}`);
    return;
  }

  // Purchase new server
  try {
    const name = `pserv-${Date.now()}-${bestRam}`;
    const ok = ns.purchaseServer(name, bestRam);
    if (ok) ns.tprint(`buyserver: purchased ${name} with ${bestRam} GB`);
    else ns.tprint("buyserver: purchaseServer returned falsy value; purchase may have failed.");
  } catch (e) {
    ns.tprint(`buyserver: purchase failed: ${e}`);
  }
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

function formatMoney(n) {
  if (n === undefined || n === null) return String(n);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return `${n}`;
}
