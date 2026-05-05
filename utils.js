/** @param {NS} ns **/
/**
 * utils.js
 *
 * Small, dependency-free helpers for early-run automation.
 * - Low RAM footprint; safe to keep on home.
 * - No Singularity usage.
 *
 * Usage:
 *   import { parseFlags, formatMoney, discoverServers, safeScp, safeExec, writeLock, removeLock, isLocked } from "utils.js";
 *
 * Note: Bitburner module imports require the file to be present on home.
 */

export function parseFlags(args) {
  const out = {};
  for (const a of args || []) {
    if (typeof a !== "string") continue;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

export function formatMoney(n) {
  if (n === undefined || n === null) return String(n);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return `${Math.round(n)}`;
}

/**
 * discoverServers(ns, options)
 * - Breadth-first scan from home, returns array of server hostnames.
 * - options.maxTargets (number) limits results.
 * - options.filter(fn) optional predicate(serverObject, hostname) -> boolean
 */
export function discoverServers(ns, options = {}) {
  const maxTargets = options.maxTargets || 50;
  const filter = typeof options.filter === "function" ? options.filter : () => true;
  const visited = new Set(["home"]);
  const queue = ["home"];
  const results = [];
  const purchased = ns.getPurchasedServers ? ns.getPurchasedServers() : [];

  while (queue.length && results.length < maxTargets) {
    const node = queue.shift();
    for (const n of ns.scan(node)) {
      if (visited.has(n)) continue;
      visited.add(n);
      queue.push(n);
      try {
        if (n === "home" || purchased.includes(n)) continue;
        const srv = ns.getServer(n);
        if (!srv) continue;
        if (!filter(srv, n)) continue;
        results.push(n);
        if (results.length >= maxTargets) break;
      } catch (e) {
        // ignore unreachable nodes
      }
    }
  }
  return results;
}

/** Safe wrappers for scp and exec that log failures and return boolean/pid */
export function safeScp(ns, src, destHost) {
  try {
    const ok = ns.scp(src, destHost, "home");
    if (!ok) ns.print(`safeScp: scp failed ${src} -> ${destHost}`);
    return ok;
  } catch (e) {
    ns.print(`safeScp: exception scp ${src} -> ${destHost}: ${e}`);
    return false;
  }
}

export function safeExec(ns, script, host, threads, ...args) {
  try {
    if (threads <= 0) {
      ns.print(`safeExec: zero threads for ${script} on ${host}`);
      return 0;
    }
    const pid = ns.exec(script, host, threads, ...args);
    if (!pid) ns.print(`safeExec: exec failed ${script} on ${host} threads=${threads}`);
    return pid;
  } catch (e) {
    ns.print(`safeExec: exception exec ${script} on ${host}: ${e}`);
    return 0;
  }
}

/* Lock helpers: write a small lock file on home and check TTL */
export function writeLock(ns, lockFile) {
  try {
    ns.write(lockFile, JSON.stringify({ ts: Date.now() }), "w");
    return true;
  } catch (e) {
    ns.print(`writeLock: failed to write ${lockFile}: ${e}`);
    return false;
  }
}

export function removeLock(ns, lockFile) {
  try {
    ns.write(lockFile, "", "w");
    return true;
  } catch (e) {
    ns.print(`removeLock: failed to remove ${lockFile}: ${e}`);
    return false;
  }
}

export function isLocked(ns, lockFile, ttlMs = 5 * 60 * 1000) {
  try {
    if (!ns.fileExists(lockFile, "home")) return false;
    const content = ns.read(lockFile);
    if (!content) return false;
    const obj = JSON.parse(content);
    if (!obj.ts) return false;
    const age = Date.now() - obj.ts;
    if (age > ttlMs) return false;
    return true;
  } catch (e) {
    ns.print(`isLocked: error reading ${lockFile}: ${e}`);
    return false;
  }
}
