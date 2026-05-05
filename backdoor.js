/** @param {NS} ns **/
export async function main(ns) {
    const specialServers = [
        // Faction servers
        "CSEC",
        "avmnite-02h",
        "I.I.I.I",
        "run4theh111z",
        "The-Cave",
        // BitNode-related servers
        "w0r1d_d43m0n",
        "fulcrumassets",
        "ecorp",
        "megacorp",
        "nwo",
        "clarkinc",
        "blade",
        "omnitek",
        "kuai-gong",
        "4sigma",
        "b-and-a"
    ];

    for (const server of specialServers) {
        if (!ns.serverExists(server)) continue;
        if (!ns.hasRootAccess(server)) {
            ns.tprint(`❌ No root access to ${server}`);
            continue;
        }

        const path = findPath(ns, "home", server);
        if (!path) {
            ns.tprint(`🔍 No path found to ${server}`);
            continue;
        }

        for (const hop of path) {
            await ns.connect(hop);
        }

        try {
            await ns.installBackdoor();
            ns.tprint(`✅ Backdoor installed on ${server}`);
        } catch {
            ns.tprint(`⚠️ Failed to backdoor ${server}`);
        }

        await ns.connect("home");
    }
}

// BFS pathfinder from home to target
function findPath(ns, start, target) {
    const queue = [[start]];
    const visited = new Set();

    while (queue.length > 0) {
        const path = queue.shift();
        const node = path[path.length - 1];
        if (node === target) return path;
        if (visited.has(node)) continue;
        visited.add(node);

        for (const neighbor of ns.scan(node)) {
            if (!visited.has(neighbor)) {
                queue.push([...path, neighbor]);
            }
        }
    }
    return null;
}
