/** @param {NS} ns **/
/*
  RamReport.js
  - Live RAM usage heatmap for rooted servers with >= MIN_RAM.
  - Compatible with Bitburner 3.0.0 APIs and defensive against scan/file issues.
*/

export async function main(ns) {
  const BAR_LEN = 20;
  const FULL = "█";
  const EMPTY = "·";
  const MIN_RAM = 32;
  const REFRESH_MS = 1000;

  ns.disableLog("ALL");
  ns.clearLog();
  ns.ui.openTail();

  while (true) {
    ns.clearLog();

    // Gather servers reachable from home (including purchased servers)
    const all = scanAll(ns)
      .filter(s => {
        try {
          return ns.hasRootAccess(s) && ns.getServerMaxRam(s) >= MIN_RAM;
        } catch {
          return false;
        }
      })
      .map(s => {
        const max = ns.getServerMaxRam(s);
        const used = ns.getServerUsedRam(s);
        const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
        return { s, pct, max, used };
      })
      .sort((a, b) => b.pct - a.pct || a.s.localeCompare(b.s));

    ns.print(`RAM usage (rooted servers ≥ ${MIN_RAM} GB):\n`);

    for (let i = 0; i < all.length; i += 2) {
      const left = all[i];
      const right = all[i + 1];
      const line = format(left) + (right ? "    " + format(right) : "");
      ns.print(line);
    }

    await ns.sleep(REFRESH_MS);
  }

  // Format a single server line
  function format(entry) {
    if (!entry) return "";
    const pctBlocks = Math.round(entry.pct / (100 / BAR_LEN));
    const bar = "[" + FULL.repeat(pctBlocks) + EMPTY.repeat(Math.max(0, BAR_LEN - pctBlocks)) + "]";
    const pctStr = String(entry.pct).padStart(3) + "%";
    const ramStr = `${entry.used.toFixed(1)}/${entry.max.toFixed(1)} GB`.padStart(14);
    return `${entry.s.padEnd(18)} ${bar} ${pctStr} ${ramStr}`;
  }

  // BFS/DFS scan that includes purchased/cloud servers and is defensive
  function scanAll(ns) {
    const seen = new Set();
    const stack = ["home"];
    const out = [];

    while (stack.length) {
      const cur = String(stack.pop()).trim();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);

      try {
        const neighbors = ns.scan(cur);
        for (const n of neighbors) {
          if (!seen.has(n)) stack.push(n);
        }
      } catch {
        // ignore scan errors for special nodes
      }
    }

    // Include purchased/cloud servers if available
    try {
      if (typeof ns.cloud?.getServerNames === "function") {
        for (const p of ns.cloud.getServerNames()) if (!seen.has(p)) { seen.add(p); out.push(p); }
      } else if (typeof ns.getPurchasedServers === "function") {
        for (const p of ns.getPurchasedServers()) if (!seen.has(p)) { seen.add(p); out.push(p); }
      }
    } catch {
      // ignore
    }

    return out;
  }
}
