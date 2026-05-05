/** @param {NS} ns **/
/**
 * controlCenter.js
 *
 * Lightweight supervisor for early-run automation.
 *
 * Usage:
 *   run controlCenter.js [--dry] [--monitorInterval=10000] [--autoBootstrap=true]
 *
 * Notes:
 * - Worker scripts expected under home/scripts.
 * - Does not use Singularity APIs.
 */
export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  const flags = parseFlags(ns.args);
  const dry = flags.dry === true || flags.dry === "true";
  const monitorInterval = Number(flags.monitorInterval) || 10000;
  const autoBootstrap = flags.autoBootstrap === "false" ? false : true;

  ns.tprint(`controlCenter: starting (dry=${dry}) interval=${monitorInterval} autoBootstrap=${autoBootstrap}`);

  // Scripts this supervisor may start (if present)
  const bootstrapScript = "bootstrap.js";
  const prepScript = "prepEngine.js";

  // Simple uptime guard: only auto-bootstrap during first hour after run start
  const startTs = Date.now();
  const autoBootstrapWindowMs = 60 * 60 * 1000; // 1 hour

  while (true) {
    try {
      // Basic status snapshot
      const homeMax = ns.getServerMaxRam("home");
      const homeUsed = ns.getServerUsedRam("home");
      const purchased = ns.getPurchasedServers();
      const purchasedCount = purchased ? purchased.length : 0;
      const money = ns.getServerMoneyAvailable("home");

      ns.print(`controlCenter: home RAM ${homeUsed}/${homeMax} | purchased ${purchasedCount} | money ${formatMoney(money)}`);

      // Check for key scripts and optionally start them if missing
      if (autoBootstrap && (Date.now() - startTs) < autoBootstrapWindowMs) {
        // If bootstrap.js exists on home and is not running, start it (unless dry)
        if (ns.fileExists(bootstrapScript, "home")) {
          const running = ns.ps("home").some(p => p.filename === bootstrapScript);
          if (!running) {
            ns.print("controlCenter: bootstrap.js not running");
            if (!dry) {
              const pid = ns.exec(bootstrapScript, "home", 1);
              if (pid) ns.tprint(`controlCenter: started ${bootstrapScript} pid=${pid}`);
              else ns.tprint(`controlCenter: failed to start ${bootstrapScript}`);
            } else {
              ns.tprint("controlCenter: dry mode - would start bootstrap.js");
            }
          }
        }

        // Similarly ensure prepEngine is running if present
        if (ns.fileExists(prepScript, "home")) {
          const runningPrep = ns.ps("home").some(p => p.filename === prepScript);
          if (!runningPrep) {
            ns.print("controlCenter: prepEngine.js not running");
            if (!dry) {
              const pid = ns.exec(prepScript, "home", 1);
              if (pid) ns.tprint(`controlCenter: started ${prepScript} pid=${pid}`);
              else ns.tprint(`controlCenter: failed to start ${prepScript}`);
            } else {
              ns.tprint("controlCenter: dry mode - would start prepEngine.js");
            }
          }
        }
      }

      // Print a short summary of purchased servers and their usable RAM
      if (purchased && purchased.length) {
        for (const h of purchased) {
          try {
            const max = ns.getServerMaxRam(h);
            const used = ns.getServerUsedRam(h);
            ns.print(`  pserv ${h}: ${used}/${max} RAM used`);
          } catch (e) {
            ns.print(`  pserv ${h}: error querying RAM: ${e}`);
          }
        }
      }

    } catch (e) {
      ns.print(`controlCenter: unexpected error: ${e}`);
    }

    await ns.sleep(monitorInterval);
  }

  // helpers (never reached)
  function parseFlags(args) {
    const out = {};
    for (const a of args) {
      if (typeof a !== "string") continue;
      if (!a.startsWith("--")) continue;
      const eq = a.indexOf("=");
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    }
    return out;
  }

  function formatMoney(n) {
    if (n === undefined || n === null) return String(n);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
    return `${n}`;
  }
}
