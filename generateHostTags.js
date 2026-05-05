/** @param {NS} ns **/
/*
  generateHostTags.js
  - Scans reachable servers and generates /data/hostTags.txt
  - Tags: batch, prep, flex
  - Updated for Bitburner 3.0.0 APIs and defensive checks
*/

export async function main(ns) {
  ns.disableLog("ALL");

  // Gather purchased servers (support cloud API and legacy API)
  let purchased = [];
  try {
    if (typeof ns.cloud?.getServerNames === "function") {
      purchased = ns.cloud.getServerNames();
    } else if (typeof ns.getPurchasedServers === "function") {
      purchased = ns.getPurchasedServers();
    } else {
      purchased = [];
    }
  } catch {
    purchased = [];
  }
  const purchasedSet = new Set(purchased);

  const scanned = scanAll(ns);
  const lines = [];

  for (const host of scanned) {
    try {
      if (!ns.serverExists(host)) continue;
      const ram = ns.getServerMaxRam(host);
      if (!ram || ram === 0) continue; // skip non-executable servers

      let tag = "flex";

      if (host === "home" || host === "worker0" || host === "worker1") {
        tag = "prep";
      } else if (host.startsWith("worker")) {
        // workerN -> batch for worker2..worker24, else flex
        const idx = Number(host.slice("worker".length));
        if (!Number.isNaN(idx) && idx >= 2 && idx <= 24) tag = "batch";
        else tag = "flex";
      } else if (purchasedSet.has(host)) {
        tag = "batch";
      } else if (ram < 32) {
        tag = "prep";
      }

      lines.push(`${host},${tag}`);
    } catch (e) {
      // Defensive: skip hosts that throw
      ns.print(`⚠️ Skipping ${host} due to error: ${String(e)}`);
    }
  }

  // Write file (one host per line)
  await ns.write("/data/hostTags.txt", lines.join("\n") + (lines.length ? "\n" : ""), "w");
  ns.tprint("✅ /data/hostTags.txt generated");
}

/* ---------- Helpers ---------- */

function scanAll(ns) {
  const seen = new Set();
  const stack = ["home"];
  while (stack.length) {
    const node = String(stack.pop()).trim();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    try {
      const neighbors = ns.scan(node);
      for (const n of neighbors) {
        if (!seen.has(n)) stack.push(n);
      }
    } catch {
      // ignore scan errors
    }
  }
  return Array.from(seen);
}
