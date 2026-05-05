/** @param {NS} ns **/
/*
  ServerAllocator.js
  - Scans reachable servers and assigns them to batch or prep pools.
  - Compatible with Bitburner 3.0.0 APIs.
  - Self-contained: reads/writes usage and host lists under /data/.
*/

export async function main(ns) {
  const ramThreshold = Number(ns.args[0]) || 32;
  const batchFile = "/data/batchHosts.txt";
  const prepFile = "/data/prepHosts.txt";
  const usageFile = "/data/batchUsage.txt";
  const prepTargetFile = "/data/prepTargets.txt";

  const EXCLUDED_BATCH = ["home", "worker0", "worker1"];
  const ALWAYS_PREP = new Set(EXCLUDED_BATCH);
  const USAGE_TIMEOUT = 30_000;
  const RESERVED_EXPIRY = 300_000;
  const REFRESH_MS = 10_000;

  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.print(`🧠 Allocator active | RAM threshold: ${ramThreshold}GB | refresh: ${REFRESH_MS / 1000}s`);

  let firstCycle = true;

  while (true) {
    ns.clearLog();

    // Initialize output files (overwrite each cycle)
    await ns.write(batchFile, "", "w");
    await ns.write(prepFile, "", "w");

    const now = Date.now();

    // Gather all reachable servers (including purchased)
    const all = getAllServers(ns)
      .filter(s => ns.serverExists(s) && ns.hasRootAccess(s) && ns.getServerMaxRam(s) > 0);

    ns.print(`🧠 allocator cycle @ ${new Date().toLocaleTimeString()} | threshold=${ramThreshold} | hostsSeen=${all.length}`);
    for (const s of all) {
      ns.print(`🔍 ${s} | RAM: ${ns.getServerMaxRam(s)}GB`);
    }

    // Load usage map (host -> { ts, reserved })
    let usageMap = {};
    if (!firstCycle && ns.fileExists(usageFile)) {
      try {
        const raw = ns.read(usageFile);
        if (raw && raw.trim().length) {
          const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            const parts = line.split(",").map(p => p.trim());
            const host = parts[0];
            const ts = Number(parts[1]) || 0;
            const reserved = parts[2] === "reserved";
            if (host) usageMap[host] = { ts, reserved };
          }
        }
      } catch (e) {
        ns.print(`⚠️ Failed to read/parse usage file: ${String(e)}`);
      }
    }

    // Clean up expired reservations and prepare updated usage lines
    const updatedUsageEntries = [];
    for (const [host, data] of Object.entries(usageMap)) {
      const age = now - (data.ts || 0);
      if (data.reserved && age > RESERVED_EXPIRY) {
        ns.print(`♻️ Reservation expired for ${host} (age: ${Math.floor(age / 1000)}s)`);
        data.reserved = false;
      }
      updatedUsageEntries.push(`${host},${data.ts}${data.reserved ? ",reserved" : ""}`);
    }
    // Persist usage (even if empty)
    await ns.write(usageFile, updatedUsageEntries.join("\n") + (updatedUsageEntries.length ? "\n" : ""), "w");

    // Step 1: Assign batch hosts (prioritize by free RAM)
    const batchHosts = all
      .filter(s => {
        const maxRam = ns.getServerMaxRam(s);
        const usedRam = ns.getServerUsedRam(s);
        const freeRam = Math.max(0, maxRam - usedRam);
        const isExcluded = EXCLUDED_BATCH.includes(s);
        const isReserved = usageMap[s]?.reserved;

        // If reserved and currently idle (usedRam === 0) we avoid assigning it to batch
        if (isReserved && usedRam === 0) return false;
        // If reserved but has some free RAM, allow it (helps utilize partially reserved hosts)
        if (isReserved && freeRam > 1) return true;

        return maxRam >= ramThreshold && !isExcluded;
      })
      .sort((a, b) => {
        const freeA = ns.getServerMaxRam(a) - ns.getServerUsedRam(a);
        const freeB = ns.getServerMaxRam(b) - ns.getServerUsedRam(b);
        return freeB - freeA;
      });

    const batchSet = new Set(batchHosts);

    // Step 2: Check for prep demand (prepTargets file non-empty)
    let prepNeeded = false;
    if (ns.fileExists(prepTargetFile)) {
      try {
        const rawPrep = ns.read(prepTargetFile);
        prepNeeded = rawPrep && rawPrep.trim().length > 0;
      } catch (e) {
        ns.print(`⚠️ Could not read prep target file: ${String(e)}`);
      }
    }

    // Step 3: Assign prep hosts (only if demand exists and not in batch)
    let prepHosts = [];
    if (prepNeeded) {
      prepHosts = all.filter(s => {
        const ram = ns.getServerMaxRam(s);
        if (ram < 2) return false;

        const isAlwaysAllowed = ALWAYS_PREP.has(s);
        const isAlreadyBatch = batchSet.has(s);
        const isReserved = usageMap[s]?.reserved;

        if (isReserved && isAlreadyBatch) return false;
        if (isAlreadyBatch) return false;

        if (firstCycle) {
          return isAlwaysAllowed || !isAlreadyBatch;
        }

        const lastUsed = usageMap[s]?.ts || 0;
        const idleLongEnough = now - lastUsed > USAGE_TIMEOUT;
        return isAlwaysAllowed || idleLongEnough;
      });
    } else {
      ns.print("🛑 No prep targets found — skipping prep host assignment.");
    }

    // Persist assignments (use newline-separated lists)
    await ns.write(batchFile, batchHosts.join("\n") + (batchHosts.length ? "\n" : ""), "w");
    await ns.write(prepFile, prepHosts.join("\n") + (prepHosts.length ? "\n" : ""), "w");

    ns.print(`💰 Batch Hosts (${batchHosts.length}):`);
    for (const h of batchHosts) {
      const max = ns.getServerMaxRam(h);
      const used = ns.getServerUsedRam(h);
      const free = Math.max(0, max - used);
      ns.print(`  - ${h} (${max}GB | free: ${free.toFixed(1)}GB)`);
    }

    ns.print(`🛠️ Prep Hosts (${prepHosts.length}):`);
    for (const h of prepHosts) {
      const lastUsed = usageMap[h]?.ts || 0;
      const idle = ((Date.now() - lastUsed) / 1000).toFixed(1);
      ns.print(`  - ${h} (${ns.getServerMaxRam(h)}GB)${firstCycle ? "" : ` | idle: ${idle}s`}`);
    }

    firstCycle = false;
    await ns.sleep(REFRESH_MS);
  }
}

/* ---------- Helpers ---------- */

function getAllServers(ns) {
  const seen = new Set();
  const out = [];
  const stack = ["home"];

  while (stack.length) {
    const cur = String(stack.pop()).trim();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    try {
      for (const n of ns.scan(cur)) stack.push(n);
    } catch {
      // ignore scan errors for special nodes
    }
  }

  // Include purchased servers (cloud API)
  try {
    const purchased = (typeof ns.cloud?.getServerNames === "function")
      ? ns.cloud.getServerNames()
      : (typeof ns.getPurchasedServers === "function" ? ns.getPurchasedServers() : []);
    for (const p of purchased) if (!seen.has(p)) { seen.add(p); out.push(p); }
  } catch {
    // ignore if API not present
  }

  return out;
}
