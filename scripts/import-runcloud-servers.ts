#!/usr/bin/env node
/**
 * import-runcloud-servers — Pulls all servers from your RunCloud account,
 * helps you load each server's SSH key into the encrypted Perch vault,
 * and registers each server in the brain DB.
 *
 * Usage:
 *   npm run import-runcloud
 *   npm run import-runcloud -- --keys-dir=/home/serverbrain/.ssh/runcloud
 *
 * Flags:
 *   --keys-dir=PATH    Look for SSH keys at PATH/<server-slug>.pem (or .key)
 *                      If not given, you'll be prompted per server.
 *   --user=USER        SSH username for all servers (default: runcloud)
 *   --skip-existing    Don't prompt for servers that already have ssh:<slug> in vault
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { vaultPut, vaultList } from "../src/core/vault.js";
import { initBrain, upsertServer } from "../src/core/brain.js";

interface RunCloudServer {
  id: number;
  name: string;
  ipAddress: string;
  online?: boolean;
  os?: string;
  webServerType?: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

async function fetchServers(apiKey: string): Promise<RunCloudServer[]> {
  const all: RunCloudServer[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`https://manage.runcloud.io/api/v3/servers?page=${page}&perPage=40`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`RunCloud API ${res.status}: ${await res.text()}`);
    const json = await res.json() as { data: RunCloudServer[]; meta?: { pagination?: { total_pages: number } } };
    all.push(...json.data);
    const totalPages = json.meta?.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

function findKeyInDir(dir: string, slug: string): string | null {
  const candidates = [
    `${slug}.pem`, `${slug}.key`, `${slug}_ed25519`, `${slug}_rsa`,
    `id_ed25519_${slug}`, `id_rsa_${slug}`,
  ];
  for (const name of candidates) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

async function main(): Promise<void> {
  // Parse flags
  const flags: Record<string, string | true> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    }
  }

  const apiKey = process.env.RUNCLOUD_API_KEY;
  if (!apiKey) {
    console.error("✗ RUNCLOUD_API_KEY env var not set.");
    console.error("  Source your env file first: set -a && . ~/.perch/.env && set +a");
    process.exit(1);
  }
  if (!process.env.PERCH_MASTER_KEY) {
    console.error("✗ PERCH_MASTER_KEY env var not set.");
    process.exit(1);
  }

  const sshUser = (flags.user as string) ?? "runcloud";
  const keysDir = flags["keys-dir"] as string | undefined;
  const skipExisting = flags["skip-existing"] === true;

  console.log("→ Fetching servers from RunCloud API...");
  const servers = await fetchServers(apiKey);
  console.log(`✓ Found ${servers.length} server(s)`);

  if (keysDir) {
    if (!existsSync(keysDir)) {
      console.error(`✗ Keys directory not found: ${keysDir}`);
      process.exit(1);
    }
    console.log(`→ Looking for SSH keys in ${keysDir}/`);
    console.log(`  Available files: ${readdirSync(keysDir).join(", ")}\n`);
  }

  const brain = initBrain();
  const existing = new Set(vaultList());
  const summary: Array<{ name: string; status: string; ip: string }> = [];

  for (const server of servers) {
    const slug = slugify(server.name);
    const vaultId = `ssh:${slug}`;
    const meta = `${server.name} (${server.ipAddress})`;

    // Register in brain DB
    upsertServer(brain, {
      hostname: server.name,
      ip: server.ipAddress,
      os: server.os,
      runcloud_server_id: server.id,
    });

    if (existing.has(vaultId) && skipExisting) {
      console.log(`⊘ Skip ${meta} — vault already has ${vaultId}`);
      summary.push({ name: server.name, status: "exists (skipped)", ip: server.ipAddress });
      continue;
    }

    let keyPath: string | null = null;

    // Try keys-dir auto-discovery
    if (keysDir) {
      keyPath = findKeyInDir(keysDir, slug);
      if (keyPath) console.log(`✓ Found key for ${meta}: ${keyPath}`);
    }

    // Fall back to interactive prompt
    if (!keyPath) {
      console.log(`\n--- ${meta} (${slug}) ---`);
      const answer = await prompt(`SSH key path (or 'skip', or 'pwd:<password>'): `);
      if (!answer || answer === "skip") {
        summary.push({ name: server.name, status: "skipped", ip: server.ipAddress });
        continue;
      }
      if (answer.startsWith("pwd:")) {
        const password = answer.slice(4);
        vaultPut(`pwd:${slug}`, password);
        console.log(`✓ Stored password as pwd:${slug}`);
        summary.push({ name: server.name, status: "password stored", ip: server.ipAddress });
        continue;
      }
      keyPath = answer;
    }

    if (!existsSync(keyPath)) {
      console.error(`✗ File not found: ${keyPath}`);
      summary.push({ name: server.name, status: "key not found", ip: server.ipAddress });
      continue;
    }

    const keyContents = readFileSync(keyPath, "utf8").trimEnd();
    if (!keyContents.includes("PRIVATE KEY")) {
      console.error(`⚠ ${keyPath} does not look like a PEM private key — storing anyway`);
    }
    vaultPut(vaultId, keyContents);
    // Also store SSH metadata as a non-secret companion
    vaultPut(`meta:${slug}`, JSON.stringify({
      host: server.ipAddress,
      user: sshUser,
      runcloud_id: server.id,
      name: server.name,
    }));
    console.log(`✓ Encrypted and stored ${vaultId} (${keyContents.length} bytes)`);
    summary.push({ name: server.name, status: "key imported", ip: server.ipAddress });
  }

  console.log("\n=== Summary ===");
  for (const row of summary) {
    console.log(`  ${row.name.padEnd(30)} ${row.ip.padEnd(18)} ${row.status}`);
  }
  console.log(`\n✓ ${servers.length} server(s) registered in brain.db`);
  console.log(`✓ Vault now has ${vaultList().length} entries`);
  console.log("\nNext: run 'npm run vault list' to see all entries.");
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
