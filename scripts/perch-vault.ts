#!/usr/bin/env node
/**
 * perch-vault — CLI for managing the encrypted credential vault.
 *
 * Usage:
 *   npm run vault list
 *   npm run vault add ssh:production-1 -- --file=/home/user/.ssh/id_ed25519
 *   npm run vault add runcloud:apikey -- --value="rc_xxxxx"
 *   npm run vault get ssh:production-1
 *   npm run vault delete ssh:production-1
 *   npm run vault rotate -- --old-key="OLD_MASTER_KEY"
 *
 * Reads PERCH_MASTER_KEY from process.env. Source ~/.perch/.env first if needed:
 *   set -a && . ~/.perch/.env && set +a
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import {
  vaultPut, vaultGet, vaultList, vaultDelete, vaultExists, vaultRotate,
} from "../src/core/vault.js";

// ── Trusted-host management (mirrors src/core/ssh-enhanced.ts) ─────────────

const HOST_KEYS_PATH = join(process.env.PERCH_VAULT_DIR ?? join(homedir(), ".perch"), "known_hosts.json");

function loadKnownHosts(): Record<string, string> {
  if (!existsSync(HOST_KEYS_PATH)) return {};
  try { return JSON.parse(readFileSync(HOST_KEYS_PATH, "utf8")) as Record<string, string>; }
  catch { return {}; }
}

function saveKnownHosts(map: Record<string, string>): void {
  writeFileSync(HOST_KEYS_PATH, JSON.stringify(map, null, 2), { mode: 0o600 });
}

// ── Argument parsing (no external deps) ─────────────────────────────────────

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of rest) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

// ── Help ────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`Perch vault CLI

Commands:
  list                            Show all stored credential IDs
  add <id> [--file=PATH | --value=VAL]
                                  Store a credential (prompts if neither flag given)
  get <id>                        Print decrypted value to stdout
  delete <id>                     Remove a credential
  rotate --old-key=OLD            Re-encrypt all entries (after rotating PERCH_MASTER_KEY)
  status                          Show vault state

Trusted SSH host fingerprints (TOFU):
  trust list                      Show all pinned host fingerprints
  trust untrust <host>            Remove a host's pinned fingerprint (next connect re-pins)
  trust untrust-all               Wipe all pinned fingerprints (rare, e.g. fleet rebuild)

Examples:
  npm run vault list
  npm run vault add ssh:production-1 -- --file=/home/serverbrain/.ssh/id_ed25519
  npm run vault add runcloud:apikey -- --value="rc_xxxxx"
  npm run vault get ssh:production-1
  npm run vault delete ssh:production-1
  npm run vault trust list
  npm run vault trust untrust 95.216.156.89

Environment:
  PERCH_MASTER_KEY              required — derives the AES-256-GCM key
  PERCH_VAULT_DIR               optional — defaults to ~/.perch
  PERCH_SSH_TRUST_NEW_HOSTS=0   strict mode — require pre-pinned fingerprints (no TOFU)
`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readKeyFromFile(path: string): string {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return readFileSync(path, "utf8").trimEnd();
}

function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Basic hidden input — overwrite prompt char-by-char
      process.stdout.write(question);
      let buf = "";
      const onData = (ch: Buffer): void => {
        const s = ch.toString("utf8");
        if (s === "\r" || s === "\n") {
          process.stdout.write("\n");
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          rl.close();
          resolve(buf);
          return;
        }
        if (s === "\u0003") { process.exit(1); }
        if (s === "\u007f") { buf = buf.slice(0, -1); return; }
        buf += s;
      };
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

function ensureMasterKey(): void {
  if (!process.env.PERCH_MASTER_KEY) {
    console.error("✗ PERCH_MASTER_KEY env var not set.");
    console.error("  Source your env file first:");
    console.error("    set -a && . ~/.perch/.env && set +a");
    process.exit(1);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  ensureMasterKey();
  if (!vaultExists()) {
    console.log("(vault is empty — no entries yet)");
    return;
  }
  const ids = vaultList();
  if (ids.length === 0) {
    console.log("(vault is empty)");
    return;
  }
  console.log(`Vault entries (${ids.length}):`);
  for (const id of ids) console.log(`  ${id}`);
}

async function cmdAdd(args: ParsedArgs): Promise<void> {
  ensureMasterKey();
  const id = args.positional[0];
  if (!id) { console.error("✗ Usage: vault add <id> [--file=PATH | --value=VAL]"); process.exit(1); }

  let value: string;
  if (typeof args.flags.file === "string") {
    value = readKeyFromFile(args.flags.file);
    console.log(`→ Reading from ${args.flags.file} (${value.length} bytes)`);
  } else if (typeof args.flags.value === "string") {
    value = args.flags.value;
  } else {
    console.log(`Storing credential under: ${id}`);
    console.log("Paste value (single line). Press Enter when done:");
    value = await prompt("> ", true);
    if (!value) { console.error("✗ Empty value, aborting"); process.exit(1); }
  }

  vaultPut(id, value);
  console.log(`✓ Stored: ${id} (encrypted at rest with AES-256-GCM)`);
}

async function cmdGet(args: ParsedArgs): Promise<void> {
  ensureMasterKey();
  const id = args.positional[0];
  if (!id) { console.error("✗ Usage: vault get <id>"); process.exit(1); }
  const v = vaultGet(id);
  if (v === null) { console.error(`✗ Not found: ${id}`); process.exit(1); }
  process.stdout.write(v);
  if (!v.endsWith("\n")) process.stdout.write("\n");
}

async function cmdDelete(args: ParsedArgs): Promise<void> {
  ensureMasterKey();
  const id = args.positional[0];
  if (!id) { console.error("✗ Usage: vault delete <id>"); process.exit(1); }
  const deleted = vaultDelete(id);
  if (deleted) console.log(`✓ Deleted: ${id}`);
  else { console.error(`✗ Not found: ${id}`); process.exit(1); }
}

async function cmdRotate(args: ParsedArgs): Promise<void> {
  ensureMasterKey();
  const oldKey = args.flags["old-key"];
  if (typeof oldKey !== "string") {
    console.error("✗ Usage: vault rotate --old-key=OLD_MASTER_KEY");
    console.error("  (set PERCH_MASTER_KEY to the NEW key first, then pass the OLD key here)");
    process.exit(1);
  }
  const { rotated, upgraded_v1_to_v2 } = vaultRotate(oldKey);
  console.log(`✓ Re-encrypted ${rotated} entries with new master key`);
  if (upgraded_v1_to_v2 > 0) {
    console.log(`✓ Upgraded ${upgraded_v1_to_v2} entries from v1 (SHA-256) to v2 (scrypt)`);
  }
}

async function cmdTrust(args: ParsedArgs): Promise<void> {
  // Subcommand router: trust list | trust untrust <host> | trust untrust-all
  const sub = args.positional[0];
  if (!sub || sub === "list") {
    const known = loadKnownHosts();
    const entries = Object.entries(known);
    if (entries.length === 0) {
      console.log("(no hosts pinned yet — first SSH connection will auto-pin)");
      return;
    }
    console.log(`Pinned host fingerprints (${entries.length}):`);
    for (const [host, fp] of entries.sort()) {
      // Show only first 16 hex chars so a screenshot doesn't expose full fingerprint
      console.log(`  ${host.padEnd(28)} sha256:${fp.slice(0, 16)}…`);
    }
    console.log(`\nFile: ${HOST_KEYS_PATH}`);
    return;
  }

  if (sub === "untrust") {
    const host = args.positional[1];
    if (!host) { console.error("✗ Usage: vault trust untrust <host>"); process.exit(1); }
    const known = loadKnownHosts();
    if (!(host in known)) { console.log(`(${host} was not pinned — nothing to do)`); return; }
    delete known[host];
    saveKnownHosts(known);
    console.log(`✓ Removed pinned fingerprint for ${host}`);
    console.log("  Next SSH connection to this host will pin a fresh fingerprint (TOFU).");
    return;
  }

  if (sub === "untrust-all") {
    const known = loadKnownHosts();
    const count = Object.keys(known).length;
    if (count === 0) { console.log("(no hosts pinned)"); return; }
    saveKnownHosts({});
    console.log(`✓ Wiped ${count} pinned fingerprint(s).`);
    console.log("  Use sparingly — only after a fleet rebuild or known infrastructure rotation.");
    return;
  }

  console.error(`✗ Unknown trust subcommand: ${sub}`);
  console.error("  Use: trust list | trust untrust <host> | trust untrust-all");
  process.exit(1);
}

async function cmdStatus(): Promise<void> {
  console.log("Perch vault status:");
  console.log(`  Master key set:   ${process.env.PERCH_MASTER_KEY ? "yes" : "NO (set PERCH_MASTER_KEY)"}`);
  console.log(`  Vault file exists: ${vaultExists() ? "yes" : "no (created on first add)"}`);
  if (process.env.PERCH_MASTER_KEY && vaultExists()) {
    const ids = vaultList();
    console.log(`  Entries:          ${ids.length}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  try {
    switch (args.command) {
      case "list":   await cmdList(); break;
      case "add":    await cmdAdd(args); break;
      case "get":    await cmdGet(args); break;
      case "delete": await cmdDelete(args); break;
      case "rotate": await cmdRotate(args); break;
      case "status": await cmdStatus(); break;
      case "trust":  await cmdTrust(args); break;
      case "help":
      case "--help":
      case "-h":
      default:       printHelp(); break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

main();
