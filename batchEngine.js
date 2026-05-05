/** @param {NS} ns **/
/*
  batchEngine.js
  - Reads /data/batchTargets.txt and /data/prepTargets.txt
  - Uses host tags from /data/hostTags.txt to find batch-capable hosts
  - Deploys weaken/grow/hack batches across hosts, reserving hosts briefly
  - Persists usage to /data/batchUsage.txt
  - Demotes drained targets to prep list and promotes prepped targets when ready
*/

export async function main(ns) {
  const BATCH_FILE = "/data/batchTargets.txt";
  const PREP_FILE = "/data/prepTargets.txt";
  const USAGE_FILE = "/data/batchUsage.txt";
  const HOST_TAGS_FILE = "/data/hostTags.txt";
  const ALLOW_ALL_FILE = "/data/prepUseAll.txt";

  const RESERVED_EXPIRY = 150_000; // ms
  const BASE_DELAY = 150; // ms per phase offset
  const MAX_DEPLOY_PER_CYCLE = 1_000; // safety cap

  ns.disableLog("ALL");
  ns.ui.openTail();

  // Script RAM measured from home
  const SCRIPT_RAM = {
    weaken: ns.getScriptRam("weaken.js", "home"),
    grow: ns.getScriptRam("grow.js", "home"),
    hack: ns.getScriptRam("hack.js", "home")
  };

  let lastDeployTime = "—";

  while (true) {
    const now = Date.now();
    const localTime = new Date(now).toLocaleTimeString();

    const allowAll = ns.fileExists(ALLOW_ALL_FILE) &&
      ns.read(ALLOW_ALL_FILE).trim().toLowerCase() === "true";

    ns.print(`🕒 Last checked: ${localTime}`);
    if (allowAll) {
      ns.print(`⛔ Prep mode active — batchEngine throttled`);
      ns.print(`🚫 Last deployment: ${lastDeployTime}`);
      await ns.sleep(5000);
      continue;
    }

    const batchTargets = await readList(ns, BATCH_FILE);
    const prepTargets = await readList(ns, PREP_FILE);
    const usage = await readUsage(ns, USAGE_FILE);
    const hostTags = await readHostTags(ns, HOST_TAGS_FILE);

    // Build host list from tags
    let hosts = Object.entries(hostTags)
      .filter(([_, tag]) => tag === "batch" || tag === "flex")
      .map(([host]) => host)
      .filter(h => ns.serverExists(h) && ns.hasRootAccess(h));

    // Sort hosts by free RAM descending
    hosts.sort((a, b) => {
      const freeA = ns.getServerMaxRam(a) - ns.getServerUsedRam(a);
      const freeB = ns.getServerMaxRam(b) - ns.getServerUsedRam(b);
      return freeB - freeA;
    });

    let deployedAny = false;
    let deployCount = 0;

    // Iterate batch targets
    for (const target of batchTargets) {
      if (deployCount >= MAX_DEPLOY_PER_CYCLE) break;

      if (!ns.serverExists(target)) continue;
      const maxMoney = ns.getServerMaxMoney(target);
      const currentMoney = ns.getServerMoneyAvailable(target);
      if (maxMoney <= 0 || currentMoney <= maxMoney * 0.02) continue;

      // Determine thread counts for a simple batch
      const hackFraction = 0.10; // fraction of money to hack
      const hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(target, maxMoney * hackFraction)));
      // growth threads to restore money after hack
      const growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, 1.0 / (1 - hackFraction))));
      const growHeat = ns.growthAnalyzeSecurity(growThreads, target);
      const hackHeat = ns.hackAnalyzeSecurity(hackThreads);
      const weakenThreadsA = Math.ceil(hackHeat / ns.weakenAnalyze(1));
      const weakenThreadsB = Math.ceil(growHeat / ns.weakenAnalyze(1));

      const jobQueue = [
        { script: "weaken.js", threads: weakenThreadsB, ram: SCRIPT_RAM.weaken, phase: 0 },
        { script: "grow.js",   threads: growThreads,    ram: SCRIPT_RAM.grow,   phase: 1 },
        { script: "weaken.js", threads: weakenThreadsA, ram: SCRIPT_RAM.weaken, phase: 2 },
        { script: "hack.js",   threads: hackThreads,    ram: SCRIPT_RAM.hack,   phase: 3 }
      ];

      // For each job, allocate threads across hosts
      for (const job of jobQueue) {
        let remaining = job.threads;
        if (remaining <= 0) continue;

        for (const host of hosts) {
          if (remaining <= 0) break;
          if (!ns.hasRootAccess(host)) continue;

          // Ensure usage entry
          if (!usage[host]) usage[host] = { ts: 0, reserved: false };

          const lastUsed = usage[host].ts || 0;
          const reserved = usage[host].reserved || false;
          const expired = reserved && (now - lastUsed > RESERVED_EXPIRY);

          if (reserved && !expired) continue;
          if (expired) usage[host].reserved = false;

          const maxRam = ns.getServerMaxRam(host);
          const usedRam = ns.getServerUsedRam(host);
          const freeRam = Math.max(0, maxRam - usedRam);

          const possibleThreads = Math.floor(freeRam / job.ram);
          const threads = Math.min(possibleThreads, remaining);
          if (threads <= 0) continue;

          // Phase offset delay to help ordering (non-blocking for whole engine)
          const delay = BASE_DELAY * job.phase;
          if (delay > 0) await ns.sleep(delay);

          const pid = ns.exec(job.script, host, threads, target);
          if (pid > 0) {
            ns.print(`⏱️ ${job.script} x${threads} on ${host} → ${target} (phase ${job.phase})`);
            usage[host].ts = Date.now();
            usage[host].reserved = true;
            deployedAny = true;
            deployCount++;
            remaining -= threads;
            // small throttle to avoid spamming exec
            await ns.sleep(20);
          } else {
            ns.print(`⚠️ Failed to exec ${job.script} on ${host} for ${target}`);
          }

          if (deployCount >= MAX_DEPLOY_PER_CYCLE) break;
        } // end hosts loop
      } // end jobQueue loop

      if (deployCount >= MAX_DEPLOY_PER_CYCLE) break;
    } // end batchTargets loop

    if (deployedAny) {
      lastDeployTime = new Date().toLocaleTimeString();
      ns.print(`✅ Full batches deployed at ${lastDeployTime}`);
    } else {
      ns.print(`⚠️ No batch deployed this cycle`);
      ns.print(`🕒 Last deployment: ${lastDeployTime}`);
    }

    // Persist usage and manage target lists
    await writeUsage(ns, USAGE_FILE, usage);
    await demoteDrainedTargets(ns, batchTargets);
    await promotePreppedTargets(ns, batchTargets, prepTargets);

    // Short sleep before next cycle
    await ns.sleep(2000);
  }
}

/* ---------- Helpers ---------- */

async function readList(ns, file) {
  if (!ns.fileExists(file)) return [];
  const raw = ns.read(file);
  return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

async function readUsage(ns, file) {
  const usage = {};
  if (!ns.fileExists(file)) return usage;
  const lines = ns.read(file).split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [host, ts, flag] = line.split(",");
    usage[host] = {
      ts: Number(ts) || 0,
      reserved: flag === "reserved"
    };
  }
  return usage;
}

async function writeUsage(ns, file, usage) {
  const out = Object.entries(usage)
    .map(([h, { ts, reserved }]) => `${h},${ts}${reserved ? ",reserved" : ""}`)
    .join("\n");
  await ns.write(file, out + (out ? "\n" : ""), "w");
}

async function readHostTags(ns, file) {
  const tags = {};
  if (!ns.fileExists(file)) return tags;
  const lines = ns.read(file).split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [host, tag] = line.split(",");
    if (host && tag) tags[host] = tag;
  }
  return tags;
}

async function demoteDrainedTargets(ns, batchTargets) {
  const prepFile = "/data/prepTargets.txt";
  const drained = [];

  for (const target of batchTargets) {
    if (!ns.serverExists(target)) continue;
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    if (maxMoney > 0 && money <= maxMoney * 0.02) drained.push(target);
  }

  if (drained.length === 0) return;

  const currentPrep = await readList(ns, prepFile);
  const updatedPrep = [...new Set([...currentPrep, ...drained])];
  const updatedBatch = batchTargets.filter(t => !drained.includes(t));

  await ns.write(prepFile, updatedPrep.join("\n") + "\n", "w");
  await ns.write("/data/batchTargets.txt", updatedBatch.join("\n") + "\n", "w");

  ns.print(`🔻 Demoted targets: ${drained.join(", ")}`);
}

async function promotePreppedTargets(ns, batchTargets, prepTargets) {
  const batchFile = "/data/batchTargets.txt";
  const prepFile = "/data/prepTargets.txt";
  const promoted = [];

  for (const target of prepTargets) {
    if (!ns.serverExists(target)) continue;
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    const isReady = sec <= minSec + 0.5 && money >= maxMoney * 0.95;
    if (isReady && !batchTargets.includes(target)) promoted.push(target);
  }

  if (promoted.length === 0) return;

  const updatedBatch = [...new Set([...batchTargets, ...promoted])];
  const updatedPrep = prepTargets.filter(t => !promoted.includes(t));

  await ns.write(batchFile, updatedBatch.join("\n") + "\n", "w");
  await ns.write(prepFile, updatedPrep.join("\n") + "\n", "w");
  ns.print(`🔼 Promoted targets: ${promoted.join(", ")}`);
}
