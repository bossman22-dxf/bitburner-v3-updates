/** @param {NS} ns **/
export async function main(ns) {
    const MAX_TARGETS = Number(ns.args[0]) || 8;
    const REQUIRED_READY = Math.ceil(MAX_TARGETS * 1.25);
    const LOW_READY = 2;

    const usageFile = "/data/batchUsage.txt";
    const batchTargetFile = "/data/batchTargets.txt";
    const prepThrottleFile = "/data/prepThrottle.txt";
    const prepUseAllFile = "/data/prepUseAll.txt";
    const hostTagsFile = "/data/hostTags.txt";

    const USAGE_TIMEOUT = 30_000;
    const RESERVED_EXPIRY = 600_000;
    const REFRESH_MS = 2000;

    let lastPrepUseAll = null;

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.print("🔁 Rebalancer active");

    while (true) {
        const now = Date.now();
        const usage = await readUsage(ns, usageFile);
        const batchTargets = await readList(ns, batchTargetFile);
        const hostTags = await readHostTags(ns, hostTagsFile);
        const allHosts = Object.keys(hostTags);

        const sortedBatchTargets = batchTargets
            .map(t => ({ target: t, maxMoney: ns.getServerMaxMoney(t) }))
            .sort((a, b) => b.maxMoney - a.maxMoney)
            .map(obj => obj.target);

        const readyBatchTargets = sortedBatchTargets.filter(t => isReady(ns, t));
        const prepThrottle = readyBatchTargets.length >= REQUIRED_READY;

        // Float prepUseAll between LOW_READY and REQUIRED_READY
        let prepUseAll;
        if (readyBatchTargets.length < LOW_READY) {
            prepUseAll = true;
        } else if (readyBatchTargets.length >= REQUIRED_READY) {
            prepUseAll = false;
        } else {
            prepUseAll = lastPrepUseAll ?? false;
        }


        // Write flags
        await ns.write(prepThrottleFile, prepThrottle ? "true" : "false", "w");

        if (prepUseAll !== lastPrepUseAll) {
            await ns.write(prepUseAllFile, prepUseAll ? "true" : "false", "w");
            lastPrepUseAll = prepUseAll;
            ns.print(`🔄 prepUseAll updated → ${prepUseAll}`);
        }
        const heatmap = [];
        for (const host of allHosts) {
            const tag = hostTags[host] || "flex";
            const maxRam = ns.getServerMaxRam(host);
            const usedRam = ns.getServerUsedRam(host);
            const freeRam = maxRam - usedRam;

            const entry = usage[host] || {};
            const lastUsed = entry.ts || 0;
            const reserved = entry.reserved || false;
            const idle = now - lastUsed > USAGE_TIMEOUT;
            const expired = reserved && now - lastUsed > RESERVED_EXPIRY;

            if (expired && tag !== "batch") {
                usage[host].reserved = false;
                ns.print(`🔄 Releasing ${host} from batch reservation`);
            }

            let icon = "🟩";
            if (tag === "prep") icon = "🟦";
            else if (reserved) icon = "🟥";
            else if (idle) icon = "🟨";

            heatmap.push(`${icon} ${host.padEnd(16)} | Tag: ${tag.padEnd(6)} | RAM: ${maxRam.toFixed(1)} GB`);
        }

        ns.print("\n📊 Host Heatmap:");
        for (const line of heatmap) ns.print("  " + line);

        await ns.sleep(REFRESH_MS);
    }
}

function isReady(ns, target) {
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    return sec <= minSec + 0.5 && money >= maxMoney * 0.95;
}

async function readList(ns, file) {
    if (!ns.fileExists(file)) return [];
    const raw = ns.read(file);
    return raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

async function readUsage(ns, file) {
    const usage = {};
    if (!ns.fileExists(file)) return usage;

    const raw = ns.read(file);
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const [host, ts, flag] = line.split(",");
        usage[host] = {
            ts: Number(ts) || 0,
            reserved: flag === "reserved",
        };
    }
    return usage;
}

async function readHostTags(ns, file) {
    const tags = {};
    if (!ns.fileExists(file)) return tags;

    const lines = await ns.read(file).split("\n").map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const [host, tag] = line.split(",");
        if (host && tag) tags[host] = tag;
    }
    return tags;
}
