/** @param {NS} ns **/
/*
  programCheck.js
  - Reports which hacking and utility programs you own on home.
  - Compatible with Bitburner 3.0.0 APIs and defensive against missing helpers.
  - Prints next affordable missing program and a short purchase hint.
*/

export async function main(ns) {
  ns.disableLog("ALL");

  const hackingPrograms = [
    { name: "BruteSSH.exe", cost: 500_000 },
    { name: "FTPCrack.exe", cost: 1_500_000 },
    { name: "relaySMTP.exe", cost: 5_000_000 },
    { name: "HTTPWorm.exe", cost: 30_000_000 },
    { name: "SQLInject.exe", cost: 250_000_000 }
  ];

  const utilityPrograms = [
    { name: "DeepscanV2.exe", cost: 500_000 },
    { name: "AutoLink.exe", cost: 1_000_000 },
    { name: "ServerProfiler.exe", cost: 500_000 }
  ];

  const allPrograms = [...hackingPrograms, ...utilityPrograms];

  // Get player money defensively
  let money = 0;
  try {
    const player = ns.getPlayer?.();
    money = player?.money ?? 0;
  } catch {
    try { money = ns.getServerMoneyAvailable("home"); } catch { money = 0; }
  }

  ns.tprint("🧠 Program Ownership Check:");
  ns.tprint(`TOR Router: ${ns.hasTorRouter ? (ns.hasTorRouter() ? "✅ Owned" : "❌ Missing (buy manually)") : "❓ Unknown"}`);
  ns.tprint("────────────────────────────────────────────");

  for (const { name, cost } of allPrograms) {
    const owned = ns.fileExists(name, "home");
    const status = owned ? "✅ Owned" : `❌ Missing (${formatMoney(ns, cost)})`;
    ns.tprint(`${name.padEnd(22)} | ${status}`);
  }

  ns.tprint("────────────────────────────────────────────");

  // Suggest next affordable and missing program
  const missing = allPrograms.filter(p => !ns.fileExists(p.name, "home"));
  const affordable = missing.filter(p => p.cost <= money);

  if (affordable.length > 0) {
    const next = affordable.sort((a, b) => a.cost - b.cost)[0];
    ns.tprint(`💡 You can afford: ${next.name} (${formatMoney(ns, next.cost)})`);
    ns.tprint(`👉 Hint: purchase it from the dark web or use your usual in-game method.`);
  } else if (missing.length > 0) {
    const next = missing.sort((a, b) => a.cost - b.cost)[0];
    ns.tprint(`🔒 Next unlockable: ${next.name} (${formatMoney(ns, next.cost)})`);
  } else {
    ns.tprint("🎉 All programs owned. You're fully equipped!");
  }
}

/* ---------- Helpers ---------- */

function formatMoney(ns, value) {
  // Prefer ns.nFormat if available, otherwise fallback to Intl
  try {
    if (typeof ns.nFormat === "function") return ns.nFormat(value, "$0.000a");
    if (ns.format && typeof ns.format.number === "function") return ns.format.number(value, "$0.000a");
  } catch {}
  try {
    return "$" + Number(value).toLocaleString();
  } catch {
    return "$" + String(value);
  }
}
