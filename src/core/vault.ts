/**
 * vault.ts — Encrypted credential storage at rest
 *
 * AES-256-GCM encryption for SSH passwords, API keys, and any other secret
 * Perch needs to store. Master key sourced from PERCH_MASTER_KEY env var.
 *
 * Threat model:
 * - Disk theft / image leak → vault.json + master key both needed; key file is mode 0600
 *   in a separate location from vault.json (.env vs vault.json), and the KDF (scrypt)
 *   adds a work factor so even a leaked vault file can't be brute-forced quickly offline
 * - Compromised SQLite brain.db → no credentials live in brain.db, only metadata
 * - Memory dump while running → out of scope (any in-memory secret tool has this)
 *
 * KDF: scrypt with per-vault salt (N=2^14, r=8, p=1, derive 32 bytes)
 * Backward compat: blob.v=1 (SHA-256 derivation) is still readable. New writes use v=2.
 * Migration: any vault op that touches a v=1 blob auto-upgrades it to v=2 on next write.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, openSync, fsyncSync, closeSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;        // GCM standard
const TAG_LEN = 16;       // GCM auth tag
const KEY_LEN = 32;       // 256 bits

// scrypt parameters — chosen so derivation takes ~50-100ms on a typical VPS.
// N must be power of 2. Doubling N doubles work; we're at 16384.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64MB cap

export interface VaultEntry {
  id: string;
  value: string;
  label?: string;
  created_at: number;
  updated_at: number;
}

// v1: SHA-256(master_key) → key  (legacy, still decryptable)
// v2: scrypt(master_key, vault_salt) → key  (current)
type EncryptedBlob =
  | { v: 1; iv: string; tag: string; ct: string }
  | { v: 2; iv: string; tag: string; ct: string };

interface VaultFile {
  schema: 1;
  salt?: string;          // base64, set on first v2 write; missing on legacy files (assume v1)
  entries: Record<string, EncryptedBlob>;
}

// ─── Key derivation (v1 legacy + v2 scrypt) ─────────────────────────────────

function getMasterKey(): string {
  const masterKey = process.env.PERCH_MASTER_KEY;
  if (!masterKey) {
    throw new Error(
      "PERCH_MASTER_KEY environment variable is required for credential vault. " +
      "Set it to a strong random string (e.g., openssl rand -base64 32) and store it safely."
    );
  }
  if (masterKey.length < 16) {
    throw new Error("PERCH_MASTER_KEY must be at least 16 characters.");
  }
  return masterKey;
}

// v1 — legacy, no salt, fast. Kept only for backward compatibility on read.
function deriveKeyV1(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey).digest();
}

// v2 — scrypt with per-vault salt. The salt lives in vault.json (`salt` field).
// Cached because scrypt is intentionally slow (~50-100ms) and we may decrypt
// many entries per process lifetime.
let cachedScryptKey: { masterKey: string; salt: string; key: Buffer } | null = null;
function deriveKeyV2(masterKey: string, saltB64: string): Buffer {
  if (cachedScryptKey && cachedScryptKey.masterKey === masterKey && cachedScryptKey.salt === saltB64) {
    return cachedScryptKey.key;
  }
  const salt = Buffer.from(saltB64, "base64");
  const key = scryptSync(masterKey, salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  cachedScryptKey = { masterKey, salt: saltB64, key };
  return key;
}

// ─── Encrypt / Decrypt primitives ────────────────────────────────────────────

function encrypt(plaintext: string, saltB64: string): EncryptedBlob {
  const key = deriveKeyV2(getMasterKey(), saltB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 2,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decrypt(blob: EncryptedBlob, saltB64: string | undefined): string {
  const masterKey = getMasterKey();
  let key: Buffer;
  if (blob.v === 1) {
    key = deriveKeyV1(masterKey);
  } else if (blob.v === 2) {
    if (!saltB64) throw new Error("vault has v=2 entries but no salt — file is corrupt");
    key = deriveKeyV2(masterKey, saltB64);
  } else {
    throw new Error(`Unsupported vault entry version: ${(blob as { v: number }).v}`);
  }
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// ─── Vault file management ───────────────────────────────────────────────────

function vaultPath(): string {
  const dir = process.env.PERCH_VAULT_DIR ?? join(homedir(), ".perch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "vault.json");
}

function loadVault(): VaultFile {
  const path = vaultPath();
  if (!existsSync(path)) {
    return { schema: 1, entries: {} };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as VaultFile;
  if (parsed.schema !== 1) throw new Error(`Unsupported vault schema: ${parsed.schema}`);
  return parsed;
}

/**
 * Get or generate the per-vault salt for v2 (scrypt) KDF.
 * Returns the existing salt if vault has v=2 entries; generates and persists
 * a new one if this is a fresh vault or only had v=1 entries.
 */
function getOrCreateSalt(v: VaultFile): string {
  if (v.salt) return v.salt;
  const salt = randomBytes(16).toString("base64");
  v.salt = salt;
  return salt;
}

function saveVault(v: VaultFile): void {
  const path = vaultPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // SECURITY [C3]: atomic write — write to .tmp, fsync, then rename.
  // Prevents corruption if process crashes mid-write.
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  // fsync so contents hit the disk before rename
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function vaultPut(id: string, value: string, label?: string): void {
  if (!id || !value) throw new Error("vaultPut: id and value are required");
  const v = loadVault();
  const salt = getOrCreateSalt(v);
  v.entries[id] = encrypt(value, salt);
  saveVault(v);
  void label; // future metadata file
}

export function vaultGet(id: string): string | null {
  const v = loadVault();
  const blob = v.entries[id];
  if (!blob) return null;
  const plaintext = decrypt(blob, v.salt);
  // Auto-upgrade v=1 (legacy SHA-256) to v=2 (scrypt) on read
  if (blob.v === 1) {
    const salt = getOrCreateSalt(v);
    v.entries[id] = encrypt(plaintext, salt);
    saveVault(v);
  }
  return plaintext;
}

export function vaultDelete(id: string): boolean {
  const v = loadVault();
  if (!(id in v.entries)) return false;
  delete v.entries[id];
  saveVault(v);
  return true;
}

export function vaultList(): string[] {
  return Object.keys(loadVault().entries).sort();
}

export function vaultExists(): boolean {
  return existsSync(vaultPath());
}

/**
 * Re-encrypt all entries with a new master key.
 * Call after rotating PERCH_MASTER_KEY.
 *
 * Pass the OLD key as oldMasterKey, then set process.env.PERCH_MASTER_KEY to the new value
 * before calling this function.
 */
export function vaultRotate(oldMasterKey: string): { rotated: number; upgraded_v1_to_v2: number } {
  // SECURITY [C3]: atomic rotation with backup + plaintext zeroing.
  // Also auto-upgrades any remaining v=1 (legacy SHA-256) entries to v=2 (scrypt).
  const path = vaultPath();
  if (existsSync(path)) {
    copyFileSync(path, path + ".bak");
  }
  const v = loadVault();
  const oldSalt = v.salt; // may be undefined if file was pure-v1

  // Generate a NEW salt for the rotated file (forces all entries to re-derive)
  const newSalt = randomBytes(16).toString("base64");

  const newEntries: Record<string, EncryptedBlob> = {};
  let rotated = 0;
  let upgraded = 0;

  for (const [id, blob] of Object.entries(v.entries)) {
    // Decrypt with the OLD master key (and old salt if v=2)
    let key: Buffer;
    if (blob.v === 1) {
      key = deriveKeyV1(oldMasterKey);
    } else {
      if (!oldSalt) throw new Error("vault has v=2 entries but no salt — corrupt");
      key = deriveKeyV2(oldMasterKey, oldSalt);
    }
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    const ct = Buffer.from(blob.ct, "base64");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const ptBuf = Buffer.concat([decipher.update(ct), decipher.final()]);
    const pt = ptBuf.toString("utf8");

    // Re-encrypt with the NEW master key (cached deriveKeyV2 picks up new env)
    // Force v=2 output regardless of input version.
    cachedScryptKey = null;       // bust cache so deriveKeyV2 re-runs with new master key
    newEntries[id] = encrypt(pt, newSalt);
    if (blob.v === 1) upgraded++;
    rotated++;
    // Zero plaintext buffer
    ptBuf.fill(0);
  }

  saveVault({ schema: 1, salt: newSalt, entries: newEntries });
  return { rotated, upgraded_v1_to_v2: upgraded };
}
