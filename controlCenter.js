/** @param {NS} ns **/
/*
  controlCenter.js
  - Starts and monitors a set of manager/engine scripts.
  - Auto-restarts any that stop.
  - Opens tails for selected scripts.
  - Updated for Bitburner 3.0.0 API behavior and defensive checks.
  - NOTE: This script assumes it runs on a machine with enough RAM to run the control center itself.
*/

export async function main(ns) {
  ns.disableLog("ALL");
  ns.clearLog();
  ns.ui.openTail();

  const MAX_BATCH_TARGETS = 4;
  const CHECK_INTERVAL = 10_000; // ms

  // Script list: name, args, human tag, whether to tail, startup delay in seconds
  const scripts = [
    { name: "rebalancer.js", args: [MAX_BATCH_TARGETS], tag: "🧠 Rebalancer", tail: true,  delay: 0 },
    { name: "targetManager.js", args: [],           tag: "🎯 Target Manager", tail: true,  delay: 0 },
    { name: "prepEngine.js",    args: [],           tag: "🛠️ PrepEngine",     tail: false, delay: 60 },
    { name: "batchEngine.js",   args: [],           tag: "💰 BatchEngine",    tail: false, delay: 30 },
    { name: "profitTracker.js", args: [],           tag: "💰 ProfitTracker",  tail: true,  delay: 0 },
    { name: "autoroot.js",      args: [],           tag: "🕷️ Autoroot",       tail: false, delay: 0 }
  ];

  ns.print("🚀 Control Center initialized.\n");

  // Map script name -> pid
  const pids = {};
  // Track which scripts we've opened a tail for
  const tailed = new Set();

  // Helper: scan all reachable servers
  function scanAllHosts() {
    const seen = new Set();
    const stack = ["home"];
    while (stack.length) {
      const cur = String(stack.pop()).trim();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      try {
        const neighbors = ns.scan(cur);
        for (const n of neighbors) {
          if (!seen.has(n)) stack.push(n);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(seen);
  }

  // Helper: find a running process by filename across all hosts
  function findProcessByName(filename) {
    try {
      const hosts = scanAllHosts();
      for (const host of hosts) {
        try {
          const procs = ns.ps(host) || [];
          for (const p of procs) {
            if (p.filename === filename) return { pid: p.pid, host };
          }
        } catch {
          // ignore ps errors for this host
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  // Initial launch with per-script delay support
  for (const { name, args, tag, tail, delay = 0 } of scripts) {
    try {
      if (delay && delay > 0) await ns.sleep(delay * 1000);

      // Try to find an existing running instance anywhere
      const running = findProcessByName(name);
      if (running) {
        pids[name] = running.pid;
        ns.print(`${tag} already running (PID: ${running.pid} on ${running.host})`);
        if (tail && !tailed.has(name)) {
          try {
            ns.ui.openTail(running.pid);
            tailed.add(name);
          } catch {
            // ignore tail errors
          }
        }
        continue;
      }

      // Not running: attempt to start on home
      const pid = ns.run(name, 1, ...args);
      if (pid && pid > 0) {
        pids[name] = pid;
        ns.print(`${tag} started (PID: ${pid})`);
        if (tail && !tailed.has(name)) {
          try {
            ns.ui.openTail(pid);
            tailed.add(name);
          } catch {
            // ignore tail errors
          }
        }
      } else {
        ns.print(`❌ Failed to start ${tag} (insufficient RAM or missing file)`);
      }
    } catch (e) {
      ns.print(`❌ Error while launching ${name}: ${String(e)}`);
    }
  }

  // Auto-restart / monitor loop
  while (true) {
    try {
      for (const { name, args, tag, tail } of scripts) {
        try {
          // First, check if there's any running instance anywhere
          const running = findProcessByName(name);

          if (running) {
            // If we didn't know about it or PID changed, update and tail if requested
            if (!pids[name] || pids[name] !== running.pid) {
              pids[name] = running.pid;
              ns.print(`${tag} detected running (PID: ${running.pid} on ${running.host})`);
              if (tail && !tailed.has(name)) {
                try {
                  ns.ui.openTail(running.pid);
                  tailed.add(name);
                } catch {
                  // ignore
                }
              }
            }
            // If it's running, nothing to do
            continue;
          }

          // No running instance found: attempt restart
          ns.print(`🔄 ${tag} not running — attempting restart...`);
          const newPid = ns.run(name, 1, ...args);
          if (newPid && newPid > 0) {
            pids[name] = newPid;
            ns.print(`${tag} restarted (PID: ${newPid})`);
            if (tail && !tailed.has(name)) {
              try {
                ns.ui.openTail(newPid);
                tailed.add(name);
              } catch {
                // ignore
              }
            }
          } else {
            ns.print(`❌ Failed to restart ${tag} (insufficient RAM or missing file)`);
          }
        } catch (innerErr) {
          ns.print(`⚠️ Error monitoring ${name}: ${String(innerErr)}`);
        }
      }
    } catch (e) {
      ns.print(`⚠️ Control loop error: ${String(e)}`);
    }

    await ns.sleep(CHECK_INTERVAL);
  }
}
