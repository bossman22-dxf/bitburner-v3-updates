/** @param {NS} ns **/
export async function main(ns) {
    const BATCH_FILE = "/data/batchTargets.txt";
    const PREP_FILE = "/data/prepTargets.txt";
    const MIN_VALUE = 2_000_000;
    const PREP_COUNT = 8;
    const REFRESH_MS = 5000;

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.print("🎯 Target Manager active — refreshing every 5s");

    while (true) {
        const allServers = scanAll(ns);
        const rooted = allServers.filter(s => ns.hasRootAccess(s));

        // Batch candidates: high-value and not drained
        const batchCandidates = rooted.filter(s =>
            ns.getServerMaxMoney(s) >= MIN_VALUE &&
            ns.getServerMoneyAvailable(s) >= ns.getServerMaxMoney(s) * 0.05
        );

        const batchTargets = batchCandidates
            .sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a));

        // Prep candidates: either not batch-worthy or demoted due to low funds
        const prepCandidates = rooted.filter(s =>
            !batchTargets.includes(s) &&
            ns.getServerMaxMoney(s) >= MIN_VALUE
        );

        const sortedPrepCandidates = prepCandidates
            .sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a));

        const prepTargets = sortedPrepCandidates.slice(0, PREP_COUNT);

        await ns.write(BATCH_FILE, batchTargets.join("\n"), "w");
        await ns.write(PREP_FILE, sortedPrepCandidates.join("\n"), "w");

        ns.clearLog();
        ns.print(`✅ Wrote ${batchTargets.length} batch targets to ${BATCH_FILE}`);
        ns.print(`✅ Wrote ${prepTargets.length} prep targets to ${PREP_FILE}`);

        ns.print("\n💰 Batch Targets:");
        for (const t of batchTargets) {
            const ready = isReady(ns, t);
            const icon = ready ? "✅" : "⏳";
            ns.print(
                `  - ${t} ${icon} | ` +
                `💵 Max: ${ns.format.number(ns.getServerMaxMoney(t), "$0.000a")} | ` +
                `💰 Now: ${ns.format.number(ns.getServerMoneyAvailable(t), "$0.000a")} | ` +
                `🔐 Sec: ${ns.getServerSecurityLevel(t).toFixed(2)} / ${ns.getServerMinSecurityLevel(t)}`
            );
        }

        ns.print("\n🛠️ Prep Targets:");
        for (const t of prepTargets) {
            const ready = isReady(ns, t);
            const icon = ready ? "✅" : "⏳";
            ns.print(
                `  - ${t} ${icon} | ` +
                `💵 Max: ${ns.format.number(ns.getServerMaxMoney(t), "$0.000a")} | ` +
                `💰 Now: ${ns.format.number(ns.getServerMoneyAvailable(t), "$0.000a")} | ` +
                `🔐 Sec: ${ns.getServerSecurityLevel(t).toFixed(2)} / ${ns.getServerMinSecurityLevel(t)}`
            );
        }

        await ns.sleep(REFRESH_MS);
    }
}

function scanAll(ns, start = "home", visited = new Set()) {
    const stack = [start];
    const discovered = new Set();

    while (stack.length > 0) {
        const node = stack.pop();
        if (discovered.has(node)) continue;
        discovered.add(node);
        const neighbors = ns.scan(node);
        for (const neighbor of neighbors) {
            if (!discovered.has(neighbor)) stack.push(neighbor);
        }
    }

    return Array.from(discovered);
}

function isReady(ns, target) {
    const sec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const money = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    return sec <= minSec + 0.5 && money >= maxMoney * 0.95;
}
