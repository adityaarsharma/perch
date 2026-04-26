#!/usr/bin/env node
/**
 * seed-from-server — registers the local server + all its webapps in Perch's brain.db.
 *
 * Run this ON the Perch server (the one running perch-api). It introspects the local
 * filesystem to find all RunCloud webapps under /home/*\/webapps/*\/, detects each
 * webapp's type (wordpress / laravel / node / n8n / docker / static / unknown), and
 * upserts everything into ~/.perch/brain.db.
 *
 * Use cases:
 *   - First-time seed so Niyati / brain queries actually return something
 *   - Re-run anytime to pick up newly-added webapps (idempotent — UPSERT)
 *
 * No SSH, no API key needed — runs locally as the Perch user (with sudo for read).
 *
 * Usage:
 *   set -a && . ~/.perch/.env && set +a
 *   sudo -u serverbrain npm run seed-from-server
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { hostname } from "os";
import { join } from "path";
import { initBrain, upsertServer, upsertWebapp } from "../src/core/brain.js";

interface WebappOnDisk {
  user: string;
  name: string;
  path: string;
  type: "wordpress" | "laravel" | "node" | "n8n" | "docker" | "static" | "unknown";
  domain: string | null;
}

// ─── Webapp discovery (local filesystem) ─────────────────────────────────────

function discoverWebapps(): WebappOnDisk[] {
  // Use sudo because /home/*/webapps requires elevated read on RunCloud boxes
  const out = execSync(
    `sudo bash -c 'ls -d /home/*/webapps/*/ 2>/dev/null'`,
    { encoding: "utf8" },
  );
  const dirs = out.split("\n").map(s => s.trim()).filter(Boolean);

  const webapps: WebappOnDisk[] = [];
  for (const dir of dirs) {
    const parts = dir.split("/").filter(Boolean);
    // /home/{user}/webapps/{name}/ → ['home', user, 'webapps', name]
    const user = parts[1];
    const name = parts[3];
    if (!user || !name) continue;

    const type = detectType(dir);
    const domain = guessDomain(name);
    webapps.push({ user, name, path: dir.replace(/\/$/, ""), type, domain });
  }
  return webapps;
}

function detectType(dir: string): WebappOnDisk["type"] {
  // Use sudo for each test because individual webapp dirs may be 0750
  const has = (rel: string): boolean => {
    try {
      execSync(`sudo test -e "${dir}${rel}"`, { stdio: "ignore" });
      return true;
    } catch { return false; }
  };

  // ─── Strong markers (single file = clear answer) ───
  if (has("wp-config.php"))         return "wordpress";
  if (has("artisan"))               return "laravel";
  if (has("docker-compose.yml") || has("Dockerfile")) return "docker";

  // ─── package.json: look at deps to disambiguate node / n8n ───
  if (has("package.json")) {
    try {
      const pkg = execSync(`sudo cat "${dir}package.json"`, { encoding: "utf8" });
      const j = JSON.parse(pkg);
      const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
      if (deps["n8n"] || j.name?.includes("n8n")) return "n8n";
      return "node";
    } catch { return "node"; }
  }

  // ─── Python markers ───
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")
      || has(".venv") || has("venv") || has("manage.py")) {
    return "node"; // closest tag in current schema (will rename to 'python' once schema accepts it)
  }

  // ─── PM2-managed MCP host folder (multiple Node tools under one dir) ───
  // Many MCP setups live in a folder with no root package.json — instead each
  // tool has its own subfolder. If we see lots of *.py / *.js / mcp-* dirs at
  // top level, treat as a "node" host.
  try {
    const listing = execSync(`sudo ls -1 "${dir}"`, { encoding: "utf8" });
    const entries = listing.split("\n").filter(Boolean);
    const looksLikeMcpHost = entries.some(e => /^mcp[-_]/.test(e) || e === "niyati.py" || /\.py$/.test(e));
    if (looksLikeMcpHost) return "node"; // best fit until we add 'python' / 'mcp-host' types
  } catch { /* ignore */ }

  // ─── Plain HTML last resort ───
  if (has("index.html"))            return "static";
  return "unknown";
}

function guessDomain(name: string): string | null {
  // Names like "Perch-Server-Brain" → no obvious domain
  // Names like "perch.adityaarsharma.com" → that's the domain
  if (/[.][a-z]{2,}/i.test(name)) return name.toLowerCase();
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  if (!process.env.PERCH_MASTER_KEY) {
    console.error("✗ PERCH_MASTER_KEY env var required.");
    console.error("  Run: set -a && . ~/.perch/.env && set +a");
    process.exit(1);
  }

  const brain = initBrain();
  const localHostname = hostname();
  const localIp = (() => {
    try { return execSync("hostname -I", { encoding: "utf8" }).trim().split(/\s+/)[0]; }
    catch { return ""; }
  })();
  const osInfo = (() => {
    try {
      const r = execSync("cat /etc/os-release", { encoding: "utf8" });
      const m = /PRETTY_NAME="([^"]+)"/.exec(r);
      return m ? m[1] : "";
    } catch { return ""; }
  })();

  console.log(`→ Registering server: ${localHostname} (${localIp || "no ip"})`);
  const serverId = upsertServer(brain, {
    hostname: localHostname,
    ip: localIp || "127.0.0.1",
    os: osInfo,
  });
  console.log(`✓ server registered, id=${serverId}`);

  console.log("\n→ Discovering webapps…");
  const webapps = discoverWebapps();
  console.log(`✓ found ${webapps.length} webapp(s) on disk\n`);

  let registered = 0;
  for (const w of webapps) {
    const webappId = upsertWebapp(brain, {
      server_id: serverId,
      domain: w.domain || w.name,
      type: w.type,
      webroot: w.path,
      system_user: w.user,
    });
    console.log(`  ✓ ${w.name.padEnd(26)} ${w.type.padEnd(10)} ${w.user} (id=${webappId})`);
    registered++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Server registered:   1 (${localHostname})`);
  console.log(`  Webapps registered:  ${registered}`);
  console.log(`  By type:`);
  const byType = webapps.reduce<Record<string, number>>((acc, w) => {
    acc[w.type] = (acc[w.type] || 0) + 1;
    return acc;
  }, {});
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(12)} ${n}`);
  }
  console.log(`\n  Niyati / Perch /api/brain will now reflect this. Try 'what do you know about my servers'.`);
}

main();
