/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const target = ns.args[0] ?? "n00dles";
  ns.tprint(`backdoor: starting for ${target}`);

  // Defensive: ensure target exists
  try {
    const server = ns.getServer(target);
    if (!server) {
      ns.tprint(`backdoor: server ${target} not found`);
      return;
    }
  } catch (e) {
    ns.tprint(`backdoor: error checking server ${target}: ${e}`);
    return;
  }

  // If we already have root and backdoor installed, nothing to do
  try {
    if (ns.hasRootAccess(target) && ns.getServer(target).backdoorInstalled) {
      ns.tprint(`backdoor: already have root and backdoor on ${target}`);
      return;
    }
  } catch (e) {
    ns.print(`backdoor: check failed: ${e}`);
  }

  // If we don't have root, try to open ports and nuke
  if (!ns.hasRootAccess(target)) {
    let opened = 0;
    const portOpeners = [
      { exe: "BruteSSH.exe", fn: ns.brutessh },
      { exe: "FTPCrack.exe", fn: ns.ftpcrack },
      { exe: "relaySMTP.exe", fn: ns.relaysmtp },
      { exe: "HTTPWorm.exe", fn: ns.httpworm },
      { exe: "SQLInject.exe", fn: ns.sqlinject },
    ];

    for (const opener of portOpeners) {
      try {
        if (ns.fileExists(opener.exe, "home")) {
          // Some environments may not expose the function; guard it
          if (typeof opener.fn === "function") {
            try {
              opener.fn(target);
              opened++;
              ns.print(`backdoor: ran ${opener.exe} on ${target}`);
            } catch (e) {
              ns.print(`backdoor: ${opener.exe} failed on ${target}: ${e}`);
            }
          }
        }
      } catch (e) {
        ns.print(`backdoor: error checking ${opener.exe}: ${e}`);
      }
      await ns.sleep(50);
    }

    try {
      const required = ns.getServerNumPortsRequired(target);
      if (opened >= required) {
        ns.nuke(target);
        ns.tprint(`backdoor: nuked ${target}`);
      } else {
        ns.tprint(`backdoor: not enough ports opened for ${target} (opened ${opened}, required ${required})`);
      }
    } catch (e) {
      ns.tprint(`backdoor: nuke attempt error for ${target}: ${e}`);
    }
  }

  // If we have root now, connect and install backdoor if not present
  try {
    if (ns.hasRootAccess(target)) {
      // Connect to the target before installing backdoor
      try {
        // Build path from home to target and connect stepwise if needed
        await connectPathToTarget(ns, target);
      } catch (e) {
        ns.print(`backdoor: connectPathToTarget failed: ${e}`);
      }

      // Re-check server object
      const serverObj = ns.getServer(target);
      if (serverObj && serverObj.backdoorInstalled) {
        ns.tprint(`backdoor: backdoor already installed on ${target}`);
      } else {
        try {
          await ns.installBackdoor();
          ns.tprint(`backdoor: backdoor installed on ${target}`);
        } catch (e) {
          ns.tprint(`backdoor: installBackdoor failed on ${target}: ${e}`);
        }
      }
    } else {
      ns.tprint(`backdoor: still do not have root on ${target}; cannot install backdoor`);
    }
  } catch (e) {
    ns.tprint(`backdoor: unexpected error for ${target}: ${e}`);
  } finally {
    // Ensure we return to home
    try {
      ns.connect("home");
    } catch (e) {
      // ignore
    }
  }
}

/** Connect stepwise from home to target using BFS path discovery */
async function connectPathToTarget(ns, target) {
  if (target === "home") return;
  const visited = new Set(["home"]);
  const queue = [["home"]];

  while (queue.length > 0) {
    const path = queue.shift();
    const node = path[path.length - 1];
    if (node === target) {
      // follow path
      for (let i = 1; i < path.length; ++i) {
        ns.connect(path[i]);
        await ns.sleep(50);
      }
      return;
    }
    const neighbors = ns.scan(node);
    for (const n of neighbors) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push([...path, n]);
      }
    }
  }
  throw new Error(`connectPathToTarget: path to ${target} not found`);
}
