/** @param {NS} ns **/
/*
  profitTracker.js
  - Tracks a rolling WINDOW of player money snapshots and reports a rate.
  - Updated for Bitburner 3.0.0 APIs and defensive access to player money.
  - No external suggestions or behavior changes beyond compatibility fixes.
*/

export async function main(ns) {
  const INTERVAL = 60_000; // 1 minute
  const WINDOW = 600_000;  // 10 minutes
  const history = [];

  ns.disableLog("ALL");
  ns.clearLog();
  ns.ui.openTail();
  ns.print("📈 Profit Tracker started (10-min rolling average)");

  while (true) {
    const now = Date.now();

    // Defensive: get player money
    let money = 0;
    try {
      const player = ns.getPlayer?.();
      money = (player && typeof player.money === "number") ? player.money : 0;
    } catch {
      try {
        money = ns.getServerMoneyAvailable?.("home") || 0;
      } catch {
        money = 0;
      }
    }

    // Add snapshot and trim old entries
    history.push({ time: now, money });
    while (history.length > 0 && now - history[0].time > WINDOW) history.shift();

    // Compute rate using oldest snapshot in window
    ns.clearLog();
    ns.print(`🕒 Snapshot: ${new Date(now).toLocaleTimeString()}  Balance: ${formatMoney(ns, money)}`);
    if (history.length >= 2) {
      const oldest = history[0];
      const deltaMoney = money - oldest.money;
      const deltaTimeSec = Math.max(1, (now - oldest.time) / 1000);

      const perSec = deltaMoney / deltaTimeSec;
      const perMin = perSec * 60;

      ns.print(`⏱️ Window: ${Math.round(deltaTimeSec / 60)} min (${history.length} samples)`);
      ns.print(`💰 Total Gain: ${formatMoney(ns, deltaMoney)}`);
      ns.print(`📊 Rate: ${formatMoney(ns, perSec)}/sec | ${formatMoney(ns, perMin)}/min`);
    } else {
      ns.print("ℹ️ Waiting for more samples to compute rate...");
    }

    await ns.sleep(INTERVAL);
  }
}

/* ---------- Helpers ---------- */

function formatMoney(ns, value) {
  try {
    if (typeof ns.nFormat === "function") return ns.nFormat(value, "$0.000a");
    if (ns.format && typeof ns.format.number === "function") return ns.format.number(value, "$0.000a");
  } catch {}
  try {
    return "$" + Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return "$" + String(value);
  }
}
