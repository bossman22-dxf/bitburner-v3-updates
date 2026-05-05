/** @param {NS} ns **/
export async function main(ns) {
    const script = "share.js";
    const targets = getAllServers(ns).filter(s => ns.hasRootAccess(s));
    const ramPerThread = ns.getScriptRam(script);

    if (!ns.fileExists(script, "home")) {
        ns.tprint(`❌ Missing ${script} on home.`);
        return;
    }

    let launched = 0;

    for (const server of targets) {
        const maxRam = ns.getServerMaxRam(server);
        const usedRam = ns.getServerUsedRam(server);
        const freeRam = maxRam - usedRam;
        const threads = Math.floor(freeRam / ramPerThread);

        if (threads <= 0) continue;

        await ns.scp(script, "home", server);

        const running = ns.ps(server).some(p => p.filename === script);
        if (running) continue;

        const pid = ns.exec(script, server, threads);
        if (pid > 0) {
            ns.tprint(`🧠 Launched ${script} x${threads} on ${server}`);
            launched++;
        }
    }

    ns.tprint(`✅ Sharing script deployed to ${launched} servers.`);
}

// 🔍 Recursively scan all servers
function getAllServers(ns) {
    const discovered = new Set();
    const scanQueue = ["home"];

    while (scanQueue.length > 0) {
        const host = scanQueue.pop();
        if (discovered.has(host)) continue;
        discovered.add(host);
        for (const neighbor of ns.scan(host)) {
            if (!discovered.has(neighbor)) scanQueue.push(neighbor);
        }
    }

    return Array.from(discovered);
}
