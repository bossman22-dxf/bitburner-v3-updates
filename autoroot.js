/** @param {NS} ns **/
export async function main(ns) {
    const RESCAN_MS = 300_000; // 5 minutes
    const TAG_FILE = "/data/hostTags.txt";
    const scriptsToCopy = ["hack.js", "weaken.js", "grow.js"];
    const portPrograms = [
        { name: "BruteSSH.exe", fn: ns.brutessh },
        { name: "FTPCrack.exe", fn: ns.ftpcrack },
        { name: "relaySMTP.exe", fn: ns.relaysmtp },
        { name: "HTTPWorm.exe", fn: ns.httpworm },
        { name: "SQLInject.exe", fn: ns.sqlinject },
    ];

    // Track hosts we've successfully copied to during this session
    const announcedRooted = new Set();
    const copiedHosts = new Set();

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.print("🔓 AutoRooter online: rescans every 5 minutes");

    // Precompute minimum script RAM for strict copy checks (only consider scripts that exist on home)
    const availableScripts = scriptsToCopy.filter(s => ns.fileExists(s, "home"));
    const scriptRams = availableScripts.length ? availableScripts.map(s => ns.getScriptRam(s)) : [];
    const minScriptRam = scriptRams.length ? Math.min(...scriptRams) : 0;

    while (true) {
        const cycleStart = Date.now();
        const visited = new Set();
        const stack = ["home"];

        let scannedCount = 0;
        const newlyRooted = [];
        const copiedThisRun = [];

        // Depth-first scan
        while (stack.length) {
            const host = stack.pop();
            if (visited.has(host)) continue;
            visited.add(host);
            scannedCount++;

            // push neighbors
            for (const n of ns.scan(host)) {
                if (!visited.has(n)) stack.push(n);
            }

            if (host === "home") continue;
            if (ns.hasRootAccess(host)) continue;
            if (!ns.serverExists(host)) continue;

            const reqLevel = ns.getServerRequiredHackingLevel(host);
            if (ns.getHackingLevel() < reqLevel) continue;

            // Open ports using available programs; these functions return booleans
            let opened = 0;
            const needed = ns.getServerNumPortsRequired(host);
            for (const tool of portPrograms) {
                if (!ns.fileExists(tool.name, "home")) continue;
                try {
                    if (tool.fn(host)) opened++;
                } catch (e) {
                    ns.print(`⚠️ Port tool error on ${host} with ${tool.name}: ${String(e)}`);
                }
            }

            if (opened >= needed) {
                try {
                    if (ns.nuke(host) && ns.hasRootAccess(host)) {
                        newlyRooted.push(host);

                        const hostKey = String(host).trim();

                        // Skip non-executable hosts (no RAM)
                        if (!ns.serverExists(hostKey)) {
                            ns.print(`⏭️ Skipping ${hostKey} — server no longer exists`);
                            continue;
                        }
                        const maxRam = ns.getServerMaxRam(hostKey);
                        if (maxRam === 0) {
                            ns.print(`⏭️ Skipping ${hostKey} — no RAM (non-executable host)`);
                            // mark as copied to avoid repeated attempts if desired
                            copiedHosts.add(hostKey);
                            continue;
                        }

                        // Skip if we've already successfully copied this session or the host already has the scripts
                        const alreadyCopied = copiedHosts.has(hostKey) || availableScripts.every(s => ns.fileExists(s, hostKey));
                        if (alreadyCopied) {
                            // ensure it's tracked for reporting
                            copiedHosts.add(hostKey);
                            continue;
                        }

                        // Strict check: ensure host has enough free RAM for at least one script
                        if (minScriptRam > 0) {
                            const usedRam = ns.getServerUsedRam(hostKey);
                            const freeRam = Math.max(0, maxRam - usedRam);
                            if (freeRam < minScriptRam) {
                                ns.print(`⏭️ Skipping ${hostKey} — insufficient free RAM (${freeRam} GB) for scripts (need ${minScriptRam} GB)`);
                                // do not mark as copied; will attempt again later when resources change
                                continue;
                            }
                        }

                        // Attempt scp once per host per session
                        try {
                            await ns.scp(availableScripts, hostKey);
                            copiedThisRun.push(hostKey);
                            copiedHosts.add(hostKey);
                            ns.print(`📦 Scripts copied to ${hostKey}`);
                        } catch (e) {
                            ns.print(`❌ Failed to scp scripts to ${hostKey}: ${String(e)}`);
                        }
                    }
                } catch (e) {
                    ns.print(`❌ Error nuking ${host}: ${String(e)}`);
                }
            }
        }

        // Load existing tags
        const existingTags = {};
        if (ns.fileExists(TAG_FILE)) {
            const lines = ns.read(TAG_FILE).split("\n").map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const [rawHost, rawTag] = line.split(",");
                if (!rawHost) continue;
                const host = rawHost.trim();
                const tag = (rawTag || "").trim();
                if (host && tag) existingTags[host] = tag;
            }
        }

        // Tag newly rooted servers only
        const purchased = ns.cloud.getServerNames();
        const rooted = Array.from(visited).filter(h => ns.hasRootAccess(h));
        for (const rawHost of rooted) {
            const host = String(rawHost).trim();
            if (!host) continue;
            if (existingTags[host]) continue;
            if (!ns.serverExists(host)) continue;

            const ram = ns.getServerMaxRam(host);
            if (ram === 0) continue;

            let tag = "flex";
            if (host === "home" || host === "worker0" || host === "worker1") {
                tag = "prep";
            } else if (host.startsWith("worker")) {
                const index = Number(host.replace("worker", ""));
                tag = index >= 2 && index <= 24 ? "batch" : "flex";
            } else if (purchased.includes(host)) {
                tag = "batch";
            } else if (ram < 32) {
                tag = "prep";
            }

            existingTags[host] = tag;
        }

        // Write updated tag list (trimmed hostnames)
        const tagLines = Object.entries(existingTags).map(([h, t]) => `${String(h).trim()},${String(t).trim()}`);
        await ns.write(TAG_FILE, tagLines.join("\n") + (tagLines.length ? "\n" : ""), "w");

        // Logging (do not clear the tail; keep tail history)
        const duration = ((Date.now() - cycleStart) / 1000).toFixed(2);
        ns.print("🧭 AutoRooter scan complete");
        ns.print(`🔍 Servers scanned: ${scannedCount}`);
        ns.print(`🔓 Newly rooted: ${newlyRooted.length}`);
        ns.print(`📦 Scripts copied this run: ${copiedThisRun.length}`);
        ns.print(`⏱️ Duration: ${duration}s`);
        if (newlyRooted.length > 0) {
            ns.print(`🌐 New access: ${newlyRooted.join(", ")}`);
        }

        for (const h of newlyRooted) {
            if (!announcedRooted.has(h)) {
                ns.tprint(`✅ Rooted ${h} (scripts copied: ${copiedThisRun.includes(h) ? "yes" : "no"})`);
                announcedRooted.add(h);
            }
        }

        ns.tprint(`🧾 AutoRoot summary: scanned=${scannedCount}, newlyRooted=${newlyRooted.length}, copied=${copiedThisRun.length}, duration=${duration}s`);
        ns.tprint("🏷️ hostTags.txt updated (only new roots tagged)");

        await ns.sleep(RESCAN_MS);
    }
}
