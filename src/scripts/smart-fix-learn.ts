#!/usr/bin/env node
/**
 * scripts/smart-fix-learn.ts
 *
 * Nightly job. Scans BRAIN.actions_log for the last 7 days. Finds patterns
 * — same (host, action_type) ran ≥3 times, all succeeded — and proposes
 * them as auto-Smart-Fix candidates by inserting (status='proposed') rows
 * into BRAIN.smart_fix_registry.
 *
 * Sends ONE Telegram nudge summarising new candidates. The user promotes
 * via the existing `perch:fix:*` callback flow — when they tap the
 * proposed action and it works, the next run sees use_count growing and
 * leaves the registry row alone. Demotion (if a registered fix later
 * fails) is left for v2.6.
 *
 * Cron: `0 3 * * * /usr/bin/node /home/serverbrain/perch-src/dist/scripts/smart-fix-learn.js`
 *
 * Constraints:
 *   - Pure pattern-matching, no LLM call. Free, deterministic, auditable.
 *   - Read-mostly: only writes to smart_fix_registry. Never modifies actions_log.
 *   - Idempotent: re-runs in a single night don't duplicate proposals.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

const DB_PATH = process.env.PERCH_BRAIN_PATH ?? join(homedir(), ".perch", "brain.db");
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const MIN_OCCURRENCES = Number(process.env.SMART_FIX_LEARN_MIN_OCCURRENCES ?? "3");
const LOOKBACK_DAYS = Number(process.env.SMART_FIX_LEARN_LOOKBACK_DAYS ?? "7");

interface PatternRow {
  target: string;
  action_type: string;
  successes: number;
  total: number;
  last_seen: string;
}

function findPatterns(db: Database.Database): PatternRow[] {
  const sql = `
    SELECT target, action_type,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS successes,
           COUNT(*) AS total,
           MAX(ts) AS last_seen
      FROM actions_log
     WHERE ts >= datetime('now', ?)
       AND target IS NOT NULL
       AND action_type IS NOT NULL
     GROUP BY target, action_type
    HAVING successes >= ?
       AND successes = total
  `;
  return db.prepare(sql).all(`-${LOOKBACK_DAYS} days`, MIN_OCCURRENCES) as PatternRow[];
}

function alreadyRegistered(db: Database.Database, host: string, eventType: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM smart_fix_registry WHERE host = ? AND event_type = ?`)
    .get(host, eventType);
  return row !== undefined;
}

function propose(
  db: Database.Database,
  host: string,
  eventType: string,
  action: string
): boolean {
  if (alreadyRegistered(db, host, eventType)) return false;
  db.prepare(
    `INSERT INTO smart_fix_registry (host, event_type, action, promoted_by, use_count, success_count)
     VALUES (?, ?, ?, 'auto-proposed', 0, 0)`
  ).run(host, eventType, action);
  return true;
}

async function notifyTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (e) {
    console.error("[smart-fix-learn] telegram failed:", e);
  }
}

function deriveEventType(actionType: string): string {
  // Heuristic: "fix-nginx" → "nginx.down"; "clear-logs" → "disk.high";
  // fall back to the action name if no clean mapping.
  const map: Record<string, string> = {
    "fix-nginx": "nginx.down",
    "fix-php-fpm": "php_fpm.down",
    "fix-mysql": "mysql.down",
    "fix-services": "services.down",
    "clear-logs": "disk.high",
    "renew-ssl": "ssl.expiring",
    "fix": "auto.health",
  };
  return map[actionType] ?? `manual.${actionType}`;
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH);
  const patterns = findPatterns(db);
  if (patterns.length === 0) {
    console.log("[smart-fix-learn] no patterns met the threshold this run");
    return;
  }

  const proposals: string[] = [];
  for (const p of patterns) {
    const eventType = deriveEventType(p.action_type);
    const action = `/${p.action_type}`;
    if (propose(db, p.target, eventType, action)) {
      proposals.push(
        `• \`${p.target}\` → ${eventType}: \`${action}\` (${p.successes}/${p.total} ✓ in ${LOOKBACK_DAYS}d)`
      );
    }
  }

  if (proposals.length === 0) {
    console.log("[smart-fix-learn] all patterns already registered, nothing new");
    return;
  }

  const text = [
    "*🪶 Smart Fix learning — new candidates*",
    "",
    "Patterns I noticed: same fix worked 3+ times for the same host/issue.",
    "Listed as auto-proposed. Next time the issue fires, the Smart Fix",
    "card will offer this action automatically.",
    "",
    ...proposals,
    "",
    "_To reject any: edit BRAIN.smart_fix_registry._",
  ].join("\n");

  await notifyTelegram(text);
  console.log(`[smart-fix-learn] ${proposals.length} new candidates proposed`);
}

main().catch((e) => {
  console.error("[smart-fix-learn] fatal:", e);
  process.exit(1);
});
