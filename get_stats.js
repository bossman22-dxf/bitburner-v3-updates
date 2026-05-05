/** @param {NS} ns **/
/*
  get_stats.js
  - Updated for Bitburner 3.0.0 compatibility.
  - Scans reachable servers (optionally accepts explicit server args),
    gathers money/security/RAM/action info, sorts by max money, and prints.
  - Keeps memory usage low by avoiding ns.getServer() and using individual getters.
*/

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
      // ignore scan errors
    }
  }

  return out;
}

function getAllServers(ns, all = false) {
  const scanned = scanAll(ns);
  const result = [];

  for (const host of scanned) {
    try {
      if (!ns.serverExists(host)) continue;
      const maxMoney = ns.getServerMaxMoney(host) || 0;
      if (all || (ns.hasRootAccess(host) && maxMoney > 0)) {
        result.push(host);
      }
    } catch {
      // defensive: skip hosts that throw
    }
  }

  return result;
}

function getAction(ns, host) {
  try {
    const procs = ns.ps(host) || [];
    if (procs.length === 0) return null;
    const filename = procs[0].filename || procs[0].file || "";
    return String(filename).replace(/^scripts\//, "").replace(/\.js$/, "");
  } catch {
    return null;
  }
}

function padStr(str, len) {
  const pad = " ".repeat(Math.max(0, len));
  return String(pad + String(str)).slice(-len);
}

function getServerData(ns, server) {
  try {
    const moneyAvailable = ns.getServerMoneyAvailable(server) || 0;
    const moneyMax = ns.getServerMaxMoney(server) || 0;
    const securityLvl = ns.getServerSecurityLevel(server) || 0;
    const securityMin = ns.getServerMinSecurityLevel(server) || 0;
    const ram = ns.getServerMaxRam(server) || 0;
    const action = getAction(ns, server) || "idle";

    const moneyAvailInt = parseInt(moneyAvailable, 10);
    const moneyMaxInt = parseInt(moneyMax, 10);
    const moneyPct = moneyMax > 0 ? (moneyAvailable / moneyMax).toFixed(2) : "0.00";

    return {
      key: moneyMaxInt,
      line:
        `${padStr(server, 17)}` +
        ` money:${padStr(moneyAvailInt, 12)}/${padStr(moneyMaxInt, 12)}(${padStr(moneyPct, 4)})` +
        ` security:${padStr(securityLvl.toFixed(2), 6)}(${padStr(securityMin.toFixed(2), 6)})` +
        ` RAM:${padStr(parseInt(ram, 10), 6)}` +
        ` Action:${padStr(action, 10)}`
    };
  } catch (e) {
    return { key: 0, line: `${padStr(server, 17)}  ⚠️ Error reading server: ${String(e)}` };
  }
}

function getServersFromArgsOrScan(ns) {
  if (ns.args && ns.args.length >= 1) {
    return ns.args.map(a => String(a));
  }
  return getAllServers(ns, false);
}

export async function main(ns) {
  ns.disableLog("ALL");

  const servers = getServersFromArgsOrScan(ns);
  if (!servers || servers.length === 0) {
    ns.tprint("ℹ️ No servers found (no args and scan returned none).");
    return;
  }

  const stats = [];
  for (const server of servers) {
    // Defensive: skip invalid names
    if (!server) continue;
    if (!ns.serverExists(server)) {
      ns.tprint(`⚠️ Skipping unknown server: ${server}`);
      continue;
    }
    stats.push(getServerData(ns, server));
  }

  // Sort by max money descending
  stats.sort((a, b) => b.key - a.key);

  for (const entry of stats) {
    ns.tprint(entry.line);
  }
}
