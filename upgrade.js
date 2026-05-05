/** @param {NS} ns **/
export async function main(ns) {
  // Config
  const requiredScripts = ["hack.js", "grow.js", "weaken.js"];
  const MAX_RAM = 2 ** 20; // 1,048,576 GB (max practical cap)
  ns.disableLog("ALL");

  // Ensure required scripts exist on home
  const missing = requiredScripts.filter(s => !ns.fileExists(s, "home"));
  if (missing.length > 0) {
    ns.tprint(`❌ Missing scripts on home: ${missing.join(", ")}`);
    return;
  }

  // Usage hint
  if (ns.args.length === 0) {
    ns.tprint("ℹ️ Usage: run upgrade.js [ram] — e.g. 64gb, 2tb, or 'max'");
  }

  // Parse input
  const input = String(ns.args[0] ?? "max").toLowerCase().trim();
  let targetRam;
  try {
    targetRam = input === "max" ? null : parseRamInput(input);
  } catch (err) {
    ns.tprint(`❌ Invalid RAM input: "${input}" — ${err.message}`);
    return;
  }

  // Get purchased servers and limits
  const purchased = ns.cloud.getServerNames();
  const limit = ns.cloud.getServerLimit();
  const count = purchased.length;

  if (count === 0) {
    ns.tprint("⚠️ No purchased servers found to upgrade.");
    return;
  }

  // If targetRam is null (max), compute the max affordable power-of-two tier for all servers
  if (targetRam === null) {
    const money = ns.getServerMoneyAvailable("home");
    targetRam = getMaxAffordableRam(ns, money, count);
    ns.tprint(`🔎 Computed max affordable RAM tier for all ${count} servers: ${formatRam(targetRam)}`);
  }

  // Validate targetRam
  if (!isPowerOfTwo(targetRam) || targetRam <= 0 || targetRam > MAX_RAM) {
    ns.tprint(`❌ Target RAM must be a power of two between 1 and ${formatRam(MAX_RAM)}. Got: ${targetRam}`);
    return;
  }

  // Current max among purchased servers
  const currentMax = Math.max(...purchased.map(s => ns.getServerMaxRam(s)));
  if (targetRam <= currentMax) {
    ns.tprint(`⚠️ All servers already have ${formatRam(currentMax)} or more. No upgrade needed.`);
    // Suggest next tier (double)
    const nextRam = Math.min(currentMax * 2, MAX_RAM);
    if (nextRam > currentMax) {
      const nextCost = ns.cloud.getServerCost(nextRam) * count;
      const money = ns.getServerMoneyAvailable("home");
      ns.tprint(`📈 Next upgrade: ${formatRam(nextRam)} will cost ${ns.format.number(nextCost, "$0.000a")}`);
      if (money < nextCost) {
        ns.tprint(`💸 You need ${ns.format.number(nextCost - money, "$0.000a")} more to afford it.`);
      } else {
        ns.tprint(`✅ You can afford to upgrade all servers to ${formatRam(nextRam)}.`);
      }
    } else {
      ns.tprint(`🚫 You've already reached the maximum server RAM (${formatRam(MAX_RAM)}).`);
    }
    return;
  }

  // Compute costs and confirm
  const costPerServer = ns.cloud.getServerCost(targetRam);
  const totalCost = costPerServer * count;
  ns.tprint(`🛠️ Upgrading ${count} servers to ${formatRam(targetRam)} will cost ${ns.format.number(totalCost, "$0.000a")}.`);
  const confirm = await ns.prompt(`Confirm upgrade of ${count} servers to ${formatRam(targetRam)}? (y/n)`, { type: "text" });
  if (String(confirm).toLowerCase() !== "y") {
    ns.tprint("❌ Upgrade cancelled.");
    return;
  }

  // Perform upgrades (only on servers that are below target)
  let upgraded = 0;
  for (const server of purchased) {
    const name = String(server).trim();
    const curRam = ns.getServerMaxRam(name);
    if (curRam >= targetRam) continue;

    // Re-check affordability per server
    const money = ns.getServerMoneyAvailable("home");
    if (money < costPerServer) {
      ns.tprint(`❌ Insufficient funds to upgrade ${name}. Needed ${ns.format.number(costPerServer, "$0.000a")}, have ${ns.format.number(money, "$0.000a")}`);
      continue;
    }

    // Kill, delete, purchase, and copy scripts
    try {
      ns.killall(name);
    } catch (e) { /* ignore */ }

    const deleted = ns.cloud.deleteServer(name);
    if (!deleted) {
      ns.tprint(`⚠️ Failed to delete ${name}. Skipping.`);
      continue;
    }

    const purchasedName = ns.cloud.purchaseServer(name, targetRam);
    if (!purchasedName) {
      ns.tprint(`⚠️ Failed to purchase ${name} @ ${formatRam(targetRam)}. Skipping.`);
      continue;
    }

    // Copy required scripts from home to the new server
    try {
      await ns.scp(requiredScripts, purchasedName);
    } catch (e) {
      ns.tprint(`⚠️ Failed to scp scripts to ${purchasedName}.`);
    }

    upgraded++;
    ns.tprint(`✅ Upgraded ${purchasedName} -> ${formatRam(targetRam)}`);
  }

  ns.tprint(`✅ Completed: ${upgraded} server(s) upgraded to ${formatRam(targetRam)}.`);
}

/* ---------- Helpers ---------- */

function parseRamInput(input) {
  const normalized = String(input).trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(tb|gb|t|g)?$/);
  if (!match) throw new Error("Invalid RAM input");
  const value = parseFloat(match[1]);
  const unit = match[2] || "gb";
  let gb = unit.startsWith("t") ? value * 1024 : value;
  gb = Math.round(gb); // integer GB
  // Round up to nearest power of two
  return nextPowerOfTwo(gb);
}

function formatRam(ram) {
  return ram >= 1024 ? `${(ram / 1024).toFixed(0)}TB` : `${ram}GB`;
}

function isPowerOfTwo(x) {
  return x > 0 && (x & (x - 1)) === 0;
}

function nextPowerOfTwo(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function getMaxAffordableRam(ns, money, count) {
  // Find highest power-of-two RAM such that cost * count <= money
  for (let exp = 1; exp <= 20; exp++) {
    const ram = 2 ** exp;
    const cost = ns.cloud.getServerCost(ram) * count;
    if (cost > money) return Math.max(1, 2 ** (exp - 1));
  }
  return 2 ** 20;
}
