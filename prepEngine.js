/** @param {NS} ns **/
export async function main(ns) {
    const weakenScript = "weaken.js";
    const growScript = "grow.js";
    const weakenRam = ns.getScriptRam(weakenScript);
    const growRam = ns.getScriptRam(growScript);
    const usageFile = "/data/batchUsage.txt";
    const prepTargetFile = "/data/prepTargets.txt";
    const batchTargetFile = "/data/batchTargets.txt";
    const hostTagsFile = "/data/hostTags.txt";
    const throttleFile = "/data/prepThrottle.txt";
    const prepUseAllFile = "/data/prepUseAll.txt";
    const reservedHomeRam = 80;
    const MAX_PREP_TARGETS = 5;
    const VERBOSE = false;
    const RESPECT_RESERVATIONS_STRICT = false;

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.print("🛠️ Prep Engine active");

    while (true) {
        ns.clearLog();
        ns.print(`🛠️ prep cycle @ ${new Date().toLocaleTimeString()}`);

        // 1) Auto-move fully prepped servers from prep -> batch
        const movedCount = await updatePrepAndBatchLists(ns, prepTargetFile, batchTargetFile);
        if (movedCount > 0) ns.print(`📦 Moved ${movedCount} server(s) to batch list`);

        // 2) Throttle
        let restrictedToPrepOnly = false;
        if (ns.fileExists(throttleFile)) {
            const flag = ns.read(throttleFile).trim();
            if (flag === "true") {
                restrictedToPrepOnly = true;
                ns.print("⚠️ Prep throttled — restricted to prep-only hosts");
            }
        }

        // 3) allowAll
        let allowAllPrep = false;
        if (ns.fileExists(prepUseAllFile)) {
            allowAllPrep = ns.read(prepUseAllFile).trim() === "true";
            if (allowAllPrep) ns.print("🚀 Full grid granted to prep — using all available hosts and targets");
        }

        // 4) Load targets
        let targets = readList(ns, prepTargetFile);
        if (allowAllPrep) {
            const batchTargets = readList(ns, batchTargetFile);
            const merged = new Set([...targets, ...batchTargets]);
            targets = [...merged];
        }

        // Filter out non-existent or non-root targets early
        targets = targets.filter(t => ns.serverExists(t) && ns.hasRootAccess(t));

        // Sort and cap
        targets = targets
            .sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a))
            .slice(0, MAX_PREP_TARGETS);

        if (targets.length === 0) {
            ns.print("ℹ️ No prep targets available");
            await ns.sleep(2000);
            continue;
        }

        const hostTags = await readHostTags(ns, hostTagsFile);
        const usage = readUsage(ns, usageFile);
        const allHosts = Object.keys(hostTags);
        const hostState = [];

        for (const host of allHosts) {
            if (!ns.serverExists(host) || !ns.hasRootAccess(host)) continue;
            const tag = hostTags[host] || "flex";
            const isHome = host === "home";
            const maxRam = ns.getServerMaxRam(host);
            const usedRam = ns.getServerUsedRam(host);
            const freeRam = Math.max(0, isHome ? maxRam - usedRam - reservedHomeRam : maxRam - usedRam);
            if (freeRam < Math.min(weakenRam, growRam)) continue;

            if (!allowAllPrep) {
                if (restrictedToPrepOnly && tag !== "prep") continue;
                if (!restrictedToPrepOnly && tag === "batch") continue;
            } else {
                if (restrictedToPrepOnly && tag !== "prep") continue;
            }

            const entry = usage[host] || {};
            const reserved = entry.reserved === true;
            if (!allowAllPrep && reserved) continue;
            if (allowAllPrep && RESPECT_RESERVATIONS_STRICT && reserved) continue;

            hostState.push({ host, freeRam, isHome, tag, maxRam });
        }

        ns.print(`📋 Prep targets this cycle: ${targets.length} | Eligible hosts: ${hostState.length}\n📦 Modes: allowAll=${allowAllPrep}, restricted=${restrictedToPrepOnly}`);

        // Diagnostics: show targets and readiness
        ns.print("\n🎯 Prep Targets:");
        for (const t of targets) {
            const ready = isPrepped(ns, t);
            const icon = ready ? "✅" : "⏳";
            const money = ns.serverExists(t) && ns.hasRootAccess(t) ? ns.getServerMoneyAvailable(t) : 0;
            const maxMoney = ns.serverExists(t) && ns.hasRootAccess(t) ? ns.getServerMaxMoney(t) : 0;
            const sec = ns.serverExists(t) && ns.hasRootAccess(t) ? ns.getServerSecurityLevel(t) : 0;
            const minSec = ns.serverExists(t) && ns.hasRootAccess(t) ? ns.getServerMinSecurityLevel(t) : 0;
            ns.print(` ${icon} ${t.padEnd(16)} | 💰 ${ns.format.number(money, "$0.000a")} / ${ns.format.number(maxMoney, "$0.000a")} | 🔐 ${sec.toFixed(2)} / ${minSec}`);
        }

        ns.print("\n🖥️ Eligible Hosts:");
        for (const h of hostState) {
            const icon = h.tag === "prep" ? "🟦" : h.tag === "batch" ? "🟥" : "🟩";
            ns.print(` ${icon} ${h.host.padEnd(16)} | Tag: ${h.tag.padEnd(6)} | Free: ${h.freeRam.toFixed(1)} GB`);
        }

        if (hostState.length === 0) {
            ns.print("⛔ No eligible hosts available for prep this cycle");
            await ns.sleep(2000);
            continue;
        }

        // Build jobs only for not-ready targets
        const notReadyTargets = targets.filter(t => !isPrepped(ns, t));
        if (notReadyTargets.length === 0) {
            ns.print("ℹ️ All listed targets appear ready — nothing to prep this cycle");
            await ns.sleep(2000);
            continue;
        }

        const jobs = [];
        for (const target of notReadyTargets) {
            if (!ns.serverExists(target) || !ns.hasRootAccess(target)) continue;

            const sec = ns.getServerSecurityLevel(target);
            const minSec = ns.getServerMinSecurityLevel(target);
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);

            // First weaken phase to take security down to min
            const perWeaken = ns.weakenAnalyze(1);
            const secDef = Math.max(0, sec - minSec);
            const weakenThreadsA = perWeaken > 0 ? Math.ceil(secDef / perWeaken) : 0;

            // Grow to near max money
            let growThreads = 0;
            if (money < maxMoney * 0.95) {
                const factor = Math.max(1, maxMoney / Math.max(1, money));
                const cappedFactor = Math.min(factor, 100);
                try {
                    growThreads = Math.ceil(ns.growthAnalyze(target, cappedFactor));
                } catch (e) {
                    // growthAnalyze may throw for non-hackable targets; skip grow in that case
                    growThreads = 0;
                }
            }

            // Weaken to counteract growth security
            let growHeat = 0;
            try {
                growHeat = growThreads > 0 ? ns.growthAnalyzeSecurity(growThreads, target) : 0;
            } catch (e) {
                growHeat = 0;
            }
            const weakenThreadsB = growHeat > 0 && perWeaken > 0 ? Math.ceil(growHeat / perWeaken) : 0;

            if (weakenThreadsA > 0) jobs.push(jobWeaken(target, weakenThreadsA, weakenScript, weakenRam));
            if (growThreads > 0) jobs.push(jobGrow(target, growThreads, growScript, growRam));
            if (weakenThreadsB > 0) jobs.push(jobWeaken(target, weakenThreadsB, weakenScript, weakenRam));
        }

        if (jobs.length === 0) {
            ns.print("ℹ️ Computed zero jobs. Not-ready targets exist but require no action (rare).");
            for (const t of notReadyTargets) {
                if (!ns.serverExists(t) || !ns.hasRootAccess(t)) continue;
                ns.print(` • ${t}: sec=${ns.getServerSecurityLevel(t).toFixed(2)} vs min=${ns.getServerMinSecurityLevel(t)}, money=${ns.format.number(ns.getServerMoneyAvailable(t), "$0.000a")} / ${ns.format.number(ns.getServerMaxMoney(t), "$0.000a")}`);
            }
            await ns.sleep(2000);
            continue;
        }

        let totalThreadsLaunched = 0;

        // Dispatch jobs across eligible hosts
        for (const job of jobs) {
            for (const h of hostState) {
                if (job.remaining <= 0) break;
                if (h.freeRam < job.ram) continue;

                if (!ns.fileExists(job.script, h.host)) {
                    // Optional: auto-copy from home if desired
                    // await ns.scp(job.script, h.host);
                    continue;
                }

                const possible = Math.floor(h.freeRam / job.ram);
                if (possible <= 0) continue;
                const threads = Math.min(possible, job.remaining);
                const pid = ns.exec(job.script, h.host, threads, job.target);
                if (pid > 0) {
                    h.freeRam -= threads * job.ram;
                    job.remaining -= threads;
                    totalThreadsLaunched += threads;
                    if (VERBOSE) ns.print(`▶️ ${job.kind.toUpperCase()} x${threads} on ${h.host} -> ${job.target}`);
                }
            }
        }

        ns.print(`✅ Launched ${totalThreadsLaunched} threads across ${hostState.length} hosts`);
        await ns.sleep(2000);
    }

    // Helpers
    function jobWeaken(target, threads, weakenScript, weakenRam) {
        return { kind: "weaken", script: weakenScript, ram: weakenRam, target, remaining: threads };
    }
    function jobGrow(target, threads, growScript, growRam) {
        return { kind: "grow", script: growScript, ram: growRam, target, remaining: threads };
    }
}

function isPrepped(ns, target) {
    if (!ns.serverExists(target) || !ns.hasRootAccess(target)) return false;
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    return sec <= minSec + 0.5 && money >= maxMoney * 0.95;
}

function isFullyPrepped(ns, server) {
    if (!ns.serverExists(server) || !ns.hasRootAccess(server)) return false;
    const sec = ns.getServerSecurityLevel(server);
    const minSec = ns.getServerMinSecurityLevel(server);
    const money = ns.getServerMoneyAvailable(server);
    const maxMoney = ns.getServerMaxMoney(server);
    return sec <= minSec && money >= maxMoney * 0.99;
}

function readList(ns, file) {
    if (!ns.fileExists(file)) return [];
    const raw = ns.read(file);
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

function readUsage(ns, file) {
    const usage = {};
    if (!ns.fileExists(file)) return usage;
    const lines = ns.read(file).split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const [host, timestamp, flag] = line.split(",");
        if (!host) continue;
        usage[host] = { ts: Number(timestamp) || 0, reserved: flag === "reserved" };
    }
    return usage;
}

async function updatePrepAndBatchLists(ns, prepFile, batchFile) {
    const prepTargets = readList(ns, prepFile);
    const batchTargets = readList(ns, batchFile);
    const stillNeedsPrep = [];
    const newlyReady = [];

    for (const server of prepTargets) {
        if (!ns.serverExists(server) || !ns.hasRootAccess(server)) continue;
        if (isFullyPrepped(ns, server)) {
            if (!batchTargets.includes(server)) {
                newlyReady.push(server);
                ns.print(`✅ ${server} is fully prepped — moved to batch list`);
            }
        } else {
            stillNeedsPrep.push(server);
        }
    }

    const updatedBatch = [...new Set([...batchTargets, ...newlyReady])];
    await ns.write(prepFile, stillNeedsPrep.join("\n") + (stillNeedsPrep.length ? "\n" : ""), "w");
    await ns.write(batchFile, updatedBatch.join("\n") + (updatedBatch.length ? "\n" : ""), "w");
    return newlyReady.length;
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
