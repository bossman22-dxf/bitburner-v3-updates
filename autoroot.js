/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const target = ns.args[0] ?? "n00dles";
  const maxDepth = 20;
  const visited = new Set();

  ns.tprint(`autoroot: starting scan from home to find route to ${target}`);

  // Defensive: ensure target exists
  try {
    const servers = ns.scan("home");
  } catch (e) {
    ns.tprint(`autoroot: error scanning network: ${e}`);
  }

  // BFS to find path from home to target
  const queue = [["home"]];
  visited.add("home");

  while (queue.length > 0) {
    const path = queue.shift();
    const node = path[path.length - 1];

    if (node === target) {
      // Found path; execute connect sequence and attempt root/backdoor if needed
      ns.tprint(`autoroot: path found: ${path.join(" -> ")}`);
      await followPathAndRoot(ns, path);
      return;
    }

    if (path.length > maxDepth) continue;

    let neighbors;
    try {
      neighbors = ns.scan(node);
    } catch (e) {
      ns.print(`autoroot: scan failed for ${node}: ${e}`);
      continue;
    }

    for (const n of neighbors) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push([...path, n]);
      }
    }
  }

  ns.tprint(`autoroot: target ${target} not found from home`);
}

/**
 * Follow the path from home to the target and attempt to gain root/backdoor.
 * This function assumes the path includes "home" as first element and target as last.
 */
async function followPathAndRoot(ns, path) {
  // Connect step-by-step
  for (let i = 1; i < path.length; ++i) {
    const server = path[i];
    try {
      ns.connect(server);
      ns.print(`autoroot: connected to ${server}`);
    } catch (e) {
      ns.tprint(`autoroot: failed to connect to ${server}: ${e}`);
      return;
    }
    await ns.sleep(100); // small pause to avoid tight loops
  }

  const target = path[path.length - 1];

  // Defensive: check if we already have root
  if (ns.hasRootAccess(target)) {
    ns.tprint(`autoroot: already have root on ${target}`);
    // Optionally backdoor if not present
    if (!ns.getServer(target).backdoorInstalled) {
      await tryBackdoor(ns, target);
    }
    // Return to home
    ns.connect("home");
    return;
  }

  // Try to run available port openers in a safe order
  const portOpeners = [
    { name: "BruteSSH.exe", fn: ns.brutessh },
    { name: "FTPCrack.exe", fn: ns.ftpcrack },
    { name: "relaySMTP.exe", fn: ns.relaysmtp },
    { name: "HTTPWorm.exe", fn: ns.httpworm },
    { name: "SQLInject.exe", fn: ns.sqlinject },
  ];

  let opened = 0;
  for (const opener of portOpeners) {
    if (ns.fileExists(opener.name, "home")) {
      try {
        // Call the corresponding ns function if it exists
        if (typeof opener.fn === "function") {
          opener.fn(target);
          opened++;
          ns.print(`autoroot: ran ${opener.name} on ${target}`);
        }
      } catch (e) {
        ns.print(`autoroot: ${opener.name} failed on ${target}: ${e}`);
      }
    }
  }

  // Attempt nuke if we have enough ports opened
  try {
    const required = ns.getServerNumPortsRequired(target);
    if (opened >= required) {
      ns.nuke(target);
      ns.tprint(`autoroot: nuked ${target}`);
      // Optionally install backdoor
      await tryBackdoor(ns, target);
    } else {
      ns.tprint(`autoroot: not enough ports opened for ${target} (opened ${opened}, required ${required})`);
    }
  } catch (e) {
    ns.tprint(`autoroot: error during nuke attempt on ${target}: ${e}`);
  }

  // Return to home
  ns.connect("home");
}

/** Attempt to backdoor the server if possible */
async function tryBackdoor(ns, target) {
  try {
    // Only backdoor if we have root and the server allows it
    if (!ns.hasRootAccess(target)) {
      ns.print(`autoroot: cannot backdoor ${target} without root`);
      return;
    }
    // Move to the server
    ns.connect(target);
    // Wait a moment for stability
    await ns.sleep(200);
    // Install backdoor if not already installed
    const serverObj = ns.getServer(target);
    if (serverObj.backdoorInstalled) {
      ns.print(`autoroot: backdoor already installed on ${target}`);
    } else {
      await ns.installBackdoor();
      ns.tprint(`autoroot: backdoor installed on ${target}`);
    }
  } catch (e) {
    ns.print(`autoroot: backdoor attempt failed on ${target}: ${e}`);
  } finally {
    // Return to home
    try { ns.connect("home"); } catch (e) { /* ignore */ }
  }
}
