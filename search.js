/** @param {NS} ns **/
export async function main(ns) {
    const target = ns.args[0];
    if (!target) {
        ns.tprint("❌ Please provide a target server name as an argument.");
        return;
    }

    if (!ns.serverExists(target)) {
        ns.tprint(`❌ Server "${target}" does not exist.`);
        return;
    }

    const path = findPath(ns, "home", target);
    if (!path) {
        ns.tprint(`🔍 No path found to ${target}`);
        return;
    }

    const command = path.map(s => `connect ${s}`).join(";\n");
    ns.tprint(`🧭 Path to ${target}:\n\n${command}`);
}

// BFS pathfinder from start to target
function findPath(ns, start, target) {
    const queue = [[start]];
    const visited = new Set();

    while (queue.length > 0) {
        const path = queue.shift();
        const node = path[path.length - 1];
        if (node === target) return path.slice(1); // exclude "home"
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
