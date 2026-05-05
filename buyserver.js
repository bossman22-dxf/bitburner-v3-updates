/** @param {NS} ns **/
export async function main(ns) {
    const ram = Number(ns.args[0] ?? 512);
    const limit = ns.cloud.getServerLimit();
    const existingNames = ns.cloud.getServerNames();
    const existing = existingNames.length;
    const slots = Math.max(0, limit - existing);

    const perCost = ns.cloud.getServerCost(ram);

    // Helpers to format costs cleanly
    const fmt = (n) => ns.format.number(n, "$0.000a");
    const fmtK = (n) => `$${ns.format.number(n / 1e3, 0)}k`;
    const fmtM = (n) => `$${ns.format.number(n / 1e6, 2)}M`;

    ns.tprint(`🖥️ Target RAM: ${ram}GB`);
    ns.tprint(`💸 Per-server cost: ${fmt(perCost)} (${fmtK(perCost)} / ${fmtM(perCost)})`);
    ns.tprint(`📦 Slots available: ${slots} (limit ${limit}, existing ${existing})`);
    if (slots === 0) {
        ns.tprint("✅ You’re at the purchased server limit. Nothing to buy.");
        return;
    }

    let bought = 0;
    let spent = 0;

    // Recompute money each iteration from home to reflect current funds
    for (let i = 0; i < slots; i++) {
        const name = `worker${i}`.trim();

        // Avoid name collisions with any existing server names
        if (existingNames.includes(name) || ns.serverExists(name)) continue;

        const money = ns.getServerMoneyAvailable("home");
        if (money < perCost) {
            ns.tprint(`❌ Not enough money to buy ${name}. Needed: ${fmt(perCost)} (have ${fmt(money)})`);
            break;
        }

        // Purchase and handle failure
        const hostname = ns.cloud.purchaseServer(name, ram);
        if (!hostname) {
            ns.tprint(`⚠️ Failed to purchase ${name}.`);
            // If purchase failed but we still have money, continue to next slot
            continue;
        }

        bought++;
        spent += perCost;
        existingNames.push(hostname); // keep local list up to date
        ns.tprint(`✅ Purchased ${hostname} for ${fmt(perCost)}`);
    }

    if (bought === 0) {
        ns.tprint("ℹ️ No servers purchased this run.");
        return;
    }

    ns.tprint("────────────────────────────────────────────");
    ns.tprint(`📊 Summary: Bought ${bought} server(s) @ ${ram}GB`);
    ns.tprint(`💰 Total spent: ${fmt(spent)} (${fmtK(spent)} / ${fmtM(spent)})`);
}
