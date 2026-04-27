/**
 * plugins-perf.ts — Slow-plugin detection via the official `wp profile` add-on
 *
 * Uses the documented `wp-cli/profile-command` package (see
 * https://make.wordpress.org/cli/2017/04/04/profile-command/) to attribute
 * load time + query time to each plugin's hooks during a sampled request.
 *
 * Read-only. Does not toggle plugin state. Falls back to a static heuristic
 * (plugin file size, hook count, autoload bytes) when `wp profile` is not
 * installed; the heuristic is clearly labeled and never claims authority.
 *
 * Documented WP-CLI commands used:
 *   - `wp package install wp-cli/profile-command` (one-time install hint only;
 *     this module never runs it)
 *   - `wp profile hook --hook=init --orderby=time --format=json`
 *   - `wp plugin list --format=json`
 *   - `wp option get autoload_count`
 */

import { SSHOptions, sshExec, wpCli } from '../../../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PluginPerfRow {
  slug: string;
  status: 'active' | 'inactive';
  /** ms attributed to this plugin during the sampled request. -1 if unmeasured. */
  hookTimeMs: number;
  /** SQL queries attributed to this plugin during the sampled request. */
  hookQueries: number;
  /** Bytes occupied by the plugin's autoloaded options. */
  autoloadBytes: number;
  /** Total file size of the plugin directory. */
  fileSizeMb: number;
  /** Number of `add_action` / `add_filter` hooks the plugin registers (heuristic). */
  registeredHooks: number;
  /** Composite score 0-100; higher = more likely to be a culprit. */
  score: number;
  reasons: string[];
}

export interface PluginsPerfResult {
  /** True if `wp profile` add-on was available and used. */
  profileCommandAvailable: boolean;
  /** Hook used for sampling when wp profile ran. Default 'init'. */
  sampledHook: string | null;
  /** Total request time (ms) from `wp profile` run, when available. */
  totalRequestMs: number | null;
  rows: PluginPerfRow[];
  recommendations: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePath(p: string): void {
  if (/\.\./.test(p)) throw new Error('path must not contain ".."');
  if (!p.startsWith('/')) throw new Error('path must be absolute');
}

interface WpProfileEntry {
  hook?: string;
  callback?: string;
  location?: string;
  time?: string;          // e.g. "0.0142s"
  query_time?: string;
  query_count?: string;
}

function parseSeconds(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// Extract plugin slug from a profile callback's "location" file path.
// Example location: "wp-content/plugins/<slug>/some-file.php:123"
function pluginSlugFromLocation(loc: string | undefined): string | null {
  if (!loc) return null;
  const m = loc.match(/wp-content\/plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

// ─── Profile via wp profile ─────────────────────────────────────────────────

async function runWpProfile(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<{ ok: boolean; entries: WpProfileEntry[]; totalSeconds: number }> {
  // First check: is wp profile installed?
  const probe = await wpCli(
    sshOpts, wpPath, wpUser,
    `cli alias list 2>/dev/null; wp help profile 2>&1 | head -1 || true`,
  );
  const hasProfile = /usage:\s*wp profile/i.test(probe.stdout) || /usage:\s*wp profile/i.test(probe.stderr);
  if (!hasProfile) {
    return { ok: false, entries: [], totalSeconds: 0 };
  }

  // Profile the 'init' hook chain — captures the bulk of plugin work.
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `profile hook init --orderby=time --format=json 2>/dev/null`,
  );
  let entries: WpProfileEntry[] = [];
  try {
    entries = JSON.parse(r.stdout) as WpProfileEntry[];
  } catch {
    return { ok: false, entries: [], totalSeconds: 0 };
  }

  // Total seconds = sum of entry times
  const total = entries.reduce((acc, e) => acc + parseSeconds(e.time), 0);
  return { ok: true, entries, totalSeconds: total };
}

// ─── Static heuristic (fallback only) ───────────────────────────────────────

interface StaticInfo {
  fileSizeBytes: number;
  hookCount: number;
}

async function staticPluginInfo(
  sshOpts: SSHOptions, wpPath: string, slug: string,
): Promise<StaticInfo> {
  // Validate slug strictly so we can interpolate safely
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return { fileSizeBytes: 0, hookCount: 0 };
  const dir = `${wpPath}/wp-content/plugins/${slug}`;
  const sizeRes = await sshExec(sshOpts, `du -sb ${dir} 2>/dev/null | cut -f1`);
  const fileSizeBytes = parseInt(sizeRes.stdout.trim(), 10) || 0;
  const hookRes = await sshExec(
    sshOpts,
    `grep -rE --include='*.php' "add_action|add_filter" ${dir} 2>/dev/null | wc -l`,
  );
  const hookCount = parseInt(hookRes.stdout.trim(), 10) || 0;
  return { fileSizeBytes, hookCount };
}

// ─── Autoload bytes per plugin (heuristic via option_name prefix) ───────────

async function autoloadBytesByPrefix(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<Map<string, number>> {
  // Sum autoload bytes grouped by option_name prefix (everything up to first _).
  // Plugins commonly prefix their options with a slug-derived token.
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `db query "SELECT SUBSTRING_INDEX(option_name,'_',1) AS pref, SUM(LENGTH(option_value)) AS bytes ` +
    `FROM \\\`$(wp db prefix --skip-plugins --skip-themes 2>/dev/null)options\\\` ` +
    `WHERE autoload='yes' GROUP BY pref ORDER BY bytes DESC LIMIT 50;" --skip-column-names 2>/dev/null`,
  );
  const map = new Map<string, number>();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pref = parts[0].toLowerCase();
    const bytes = parseInt(parts[1], 10) || 0;
    if (pref) map.set(pref, bytes);
  }
  return map;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function profilePlugins(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<PluginsPerfResult> {
  safePath(wpPath);

  // 1. List plugins
  const listRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin list --format=json --fields=name,status 2>/dev/null`,
  );
  let pluginList: Array<{ name: string; status: string }> = [];
  try {
    pluginList = JSON.parse(listRes.stdout);
  } catch { /* leave empty */ }

  // 2. Try wp profile
  const profile = await runWpProfile(sshOpts, wpPath, wpUser);

  // 3. Aggregate hook time + query count by plugin slug
  const timeBySlug = new Map<string, { ms: number; queries: number }>();
  if (profile.ok) {
    for (const e of profile.entries) {
      const slug = pluginSlugFromLocation(e.location);
      if (!slug) continue;
      const cur = timeBySlug.get(slug) ?? { ms: 0, queries: 0 };
      cur.ms += parseSeconds(e.time) * 1000;
      cur.queries += parseInt(e.query_count ?? '0', 10) || 0;
      timeBySlug.set(slug, cur);
    }
  }

  // 4. Autoload bytes by prefix
  const autoload = await autoloadBytesByPrefix(sshOpts, wpPath, wpUser);

  // 5. Build rows
  const rows: PluginPerfRow[] = [];
  for (const p of pluginList) {
    const slug = p.name;
    const status = p.status === 'active' ? 'active' : 'inactive';
    const hookSample = timeBySlug.get(slug);
    const hookTimeMs = hookSample ? Math.round(hookSample.ms * 100) / 100 : -1;
    const hookQueries = hookSample ? hookSample.queries : 0;

    const stat = await staticPluginInfo(sshOpts, wpPath, slug);

    // Best-effort autoload match: prefix that starts with the plugin slug
    const slugPrefix = slug.toLowerCase().split(/[-_]/)[0];
    const autoloadBytes = autoload.get(slugPrefix) ?? 0;

    // Composite score (0-100) — additive, favors actually-measured signals
    let score = 0;
    const reasons: string[] = [];
    if (status === 'active') {
      if (hookTimeMs > 100) {
        score += Math.min(50, Math.round(hookTimeMs / 4));
        reasons.push(`adds ~${hookTimeMs.toFixed(0)} ms during init hook`);
      }
      if (hookQueries > 5) {
        score += Math.min(20, hookQueries);
        reasons.push(`runs ${hookQueries} SQL queries during init`);
      }
      if (autoloadBytes > 100_000) {
        score += Math.min(20, Math.round(autoloadBytes / 50_000));
        reasons.push(`~${(autoloadBytes / 1024).toFixed(0)} KB autoloaded options`);
      }
      // Static fallbacks (capped) — only if no profile data
      if (hookTimeMs < 0) {
        if (stat.hookCount > 200) {
          score += Math.min(15, Math.round(stat.hookCount / 50));
          reasons.push(`registers ${stat.hookCount} hooks (file scan; install wp profile for accurate timing)`);
        }
        if (stat.fileSizeBytes > 30 * 1024 * 1024) {
          score += 10;
          reasons.push(`${(stat.fileSizeBytes / (1024 * 1024)).toFixed(0)} MB on disk`);
        }
      }
    }

    rows.push({
      slug,
      status,
      hookTimeMs,
      hookQueries,
      autoloadBytes,
      fileSizeMb: Math.round((stat.fileSizeBytes / (1024 * 1024)) * 100) / 100,
      registeredHooks: stat.hookCount,
      score: Math.min(100, score),
      reasons,
    });
  }

  rows.sort((a, b) => b.score - a.score);

  const recommendations: string[] = [];
  if (!profile.ok) {
    recommendations.push(
      `For accurate per-plugin load timing, install the wp profile add-on: ` +
      `\`wp package install wp-cli/profile-command\` (https://make.wordpress.org/cli/2017/04/04/profile-command/). ` +
      `Without it, scores fall back to a static heuristic (file size + hook count) and are clearly less authoritative.`,
    );
  }
  const heavyActive = rows.filter(r => r.status === 'active' && r.score >= 40);
  if (heavyActive.length > 0) {
    recommendations.push(
      `${heavyActive.length} active plugin(s) score ≥40 (likely culprits): ` +
      heavyActive.slice(0, 5).map(r => `${r.slug} (${r.score})`).join(', ') +
      `. Investigate hook timing or replace.`,
    );
  }
  const inactive = rows.filter(r => r.status === 'inactive');
  if (inactive.length > 0) {
    recommendations.push(
      `${inactive.length} inactive plugin(s) installed — see wp.plugins_cleanup_audit for safe-removal candidates.`,
    );
  }

  return {
    profileCommandAvailable: profile.ok,
    sampledHook: profile.ok ? 'init' : null,
    totalRequestMs: profile.ok ? Math.round(profile.totalSeconds * 1000) : null,
    rows,
    recommendations,
  };
}
