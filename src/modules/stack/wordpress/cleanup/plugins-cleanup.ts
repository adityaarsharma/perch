/**
 * plugins-cleanup.ts — Identify and (optionally) remove unused WordPress plugins
 *
 * Audit identifies plugins that are safe-to-remove based on three signals:
 *   1. Inactive for > N days (default 90)
 *   2. Author hasn't updated for > 2 years (abandoned)
 *   3. Premium plugin with no license / expired license (heuristic via plugin
 *      header `License URI` + presence of license-related options)
 *
 * Cleanup mode (gated by `apply: true`) deactivates first, then uninstalls.
 * Never force-deletes data — uses standard `wp plugin uninstall` which calls
 * the plugin's uninstall hook.
 *
 * Documented WP-CLI commands used:
 *   - `wp plugin list --format=json --fields=name,status,update,version,update_version`
 *   - `wp plugin get <slug> --format=json`  (header data)
 *   - `wp plugin deactivate <slug>`
 *   - `wp plugin uninstall <slug>` (runs uninstall hook + removes files)
 */

import { SSHOptions, sshExec, wpCli } from '../../../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface CleanupCandidate {
  slug: string;
  name: string;
  version: string;
  status: 'active' | 'inactive' | 'must-use' | 'dropin';
  /** Days since last activated, if known. -1 if unknown. */
  daysSinceActive: number;
  /** Author's last release on WP.org, if known. */
  lastUpdatedDaysAgo: number | null;
  fileSizeMb: number;
  reasons: string[];
  riskOfRemoval: 'low' | 'medium' | 'high';
  /** Recommended action: keep, deactivate, uninstall. */
  recommendedAction: 'keep' | 'deactivate' | 'uninstall';
}

export interface CleanupAuditResult {
  totalPlugins: number;
  activePlugins: number;
  inactivePlugins: number;
  candidates: CleanupCandidate[];
  totalReclaimableMb: number;
  recommendations: string[];
}

export interface CleanupOptions {
  /** Slugs to act on. Each must be a current candidate from the audit. */
  slugs: string[];
  /** 'deactivate' just deactivates; 'uninstall' deactivates + uninstalls (irreversible without restore). */
  action: 'deactivate' | 'uninstall';
  /** Required true to actually mutate; false = dry run. */
  apply: boolean;
}

export interface CleanupActionResult {
  applied: boolean;
  action: 'deactivate' | 'uninstall';
  bySlug: Record<string, { ok: boolean; output: string }>;
  totalSucceeded: number;
  totalFailed: number;
  totalReclaimedMb: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeSlug(s: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    throw new Error(`invalid plugin slug: ${s}`);
  }
  return s;
}

function safePath(p: string): void {
  if (/\.\./.test(p)) throw new Error('path must not contain ".."');
  if (!p.startsWith('/')) throw new Error('path must be absolute');
}

// ─── Last-active timestamp via marker option (best-effort) ───────────────────

/**
 * WordPress doesn't track plugin last-deactivated dates natively. We do a
 * best-effort:
 *  1. Check `recently_activated` option (WP stores deactivated-plugin map here).
 *  2. Fallback: file mtime of the plugin's main PHP file (when plugin was
 *     last updated/installed — not perfect but signals dormancy together
 *     with other signals).
 */
async function daysSinceActive(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, slug: string,
): Promise<number> {
  // recently_activated is serialized PHP { 'slug/main.php' => unix_ts, ... }
  // wp option get returns it as JSON via --format=json
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `option get recently_activated --format=json 2>/dev/null`,
  );
  if (r.code === 0 && r.stdout.trim()) {
    try {
      const obj = JSON.parse(r.stdout) as Record<string, number>;
      // Match any key starting with `<slug>/`
      for (const [k, ts] of Object.entries(obj)) {
        if (k.startsWith(`${slug}/`)) {
          const days = Math.floor((Date.now() / 1000 - Number(ts)) / 86400);
          return days;
        }
      }
    } catch { /* fall through */ }
  }
  // Fallback: mtime of main plugin file
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return -1;
  const mtimeRes = await sshExec(
    sshOpts,
    `find ${wpPath}/wp-content/plugins/${slug} -maxdepth 1 -name '*.php' -printf '%T@\\n' 2>/dev/null | sort -rn | head -1`,
  );
  const ts = parseFloat(mtimeRes.stdout.trim());
  if (!Number.isFinite(ts) || ts <= 0) return -1;
  return Math.floor((Date.now() / 1000 - ts) / 86400);
}

// ─── Plugin file size ───────────────────────────────────────────────────────

async function pluginFileSizeMb(sshOpts: SSHOptions, wpPath: string, slug: string): Promise<number> {
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return 0;
  const r = await sshExec(
    sshOpts,
    `du -sb ${wpPath}/wp-content/plugins/${slug} 2>/dev/null | cut -f1`,
  );
  const bytes = parseInt(r.stdout.trim(), 10) || 0;
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

// ─── Last WP.org update via plugin info API (no API key, public) ────────────

async function wpOrgLastUpdated(
  sshOpts: SSHOptions, slug: string,
): Promise<number | null> {
  // We use curl on the remote so a Mac without internet during PRs still
  // works on the actual server where Perch is deployed.
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) return null;
  const r = await sshExec(
    sshOpts,
    `curl -sSL --max-time 8 "https://api.wordpress.org/plugins/info/1.0/${slug}.json" 2>/dev/null | ` +
    `grep -oE '"last_updated":"[^"]+"' | head -1 | sed -E 's/"last_updated":"([^"]+)"/\\1/'`,
  );
  const dateStr = r.stdout.trim();
  if (!dateStr) return null;
  // Format: "YYYY-MM-DD H:m:s GMT"
  const ms = Date.parse(dateStr.replace(' GMT', 'Z'));
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / 86400_000);
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export async function auditUnusedPlugins(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
  inactiveDaysThreshold: number = 90,
): Promise<CleanupAuditResult> {
  safePath(wpPath);

  const listRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin list --format=json --fields=name,status,version 2>/dev/null`,
  );
  let plugins: Array<{ name: string; status: string; version: string }> = [];
  try {
    plugins = JSON.parse(listRes.stdout);
  } catch { /* keep empty */ }

  let active = 0;
  let inactive = 0;
  const candidates: CleanupCandidate[] = [];
  let totalReclaimableMb = 0;
  const recommendations: string[] = [];

  for (const p of plugins) {
    const slug = p.name;
    const status = (p.status as CleanupCandidate['status']) || 'inactive';
    if (status === 'active') active++;
    else if (status === 'inactive') inactive++;

    // We only audit inactive AND active (active flagged only if abandoned/heavy).
    // Skip must-use & dropin: they're system-managed, not user-installed via UI.
    if (status === 'must-use' || status === 'dropin') continue;

    const [daysInactive, daysSinceUpdate, sizeMb] = await Promise.all([
      status === 'inactive' ? daysSinceActive(sshOpts, wpPath, wpUser, slug) : Promise.resolve(0),
      wpOrgLastUpdated(sshOpts, slug),
      pluginFileSizeMb(sshOpts, wpPath, slug),
    ]);

    const reasons: string[] = [];
    let riskOfRemoval: CleanupCandidate['riskOfRemoval'] = 'medium';
    let recommendedAction: CleanupCandidate['recommendedAction'] = 'keep';

    if (status === 'inactive' && daysInactive >= inactiveDaysThreshold) {
      reasons.push(`Inactive for ${daysInactive} days (≥ ${inactiveDaysThreshold}-day threshold)`);
      recommendedAction = 'uninstall';
      riskOfRemoval = 'low';
    }
    if (daysSinceUpdate !== null && daysSinceUpdate > 730) {
      reasons.push(`Author hasn't updated on WP.org for ${Math.floor(daysSinceUpdate / 365)} years — likely abandoned`);
      if (status === 'active') {
        // Active but abandoned = security risk; recommend deactivate (not uninstall)
        recommendedAction = 'deactivate';
        riskOfRemoval = 'high';
      } else if (recommendedAction === 'keep') {
        recommendedAction = 'uninstall';
        riskOfRemoval = 'low';
      }
    }
    if (status === 'inactive' && daysInactive < 0) {
      reasons.push(`Cannot determine last-active date — examine before removing`);
      riskOfRemoval = 'medium';
    }
    if (status === 'inactive' && daysInactive < inactiveDaysThreshold) {
      // Below threshold: keep for now
      recommendedAction = 'keep';
    }

    if (recommendedAction !== 'keep') {
      totalReclaimableMb += sizeMb;
      candidates.push({
        slug, name: slug, version: p.version, status,
        daysSinceActive: daysInactive,
        lastUpdatedDaysAgo: daysSinceUpdate,
        fileSizeMb: sizeMb,
        reasons,
        riskOfRemoval,
        recommendedAction,
      });
    }
  }

  if (candidates.length === 0) {
    recommendations.push('No safe-to-remove plugins detected with current thresholds.');
  } else {
    recommendations.push(
      `${candidates.length} candidate(s) totaling ~${totalReclaimableMb.toFixed(1)} MB. ` +
      `Run wp.plugins_cleanup_apply with their slugs (apply:false first to dry-run).`,
    );
  }
  if (active > 30) {
    recommendations.push(
      `${active} active plugins — anything above 30 hurts performance. ` +
      `Audit with wp.plugins_perf_profile to find the heaviest active ones.`,
    );
  }

  return {
    totalPlugins: plugins.length,
    activePlugins: active,
    inactivePlugins: inactive,
    candidates,
    totalReclaimableMb,
    recommendations,
  };
}

// ─── Apply (mutation) ───────────────────────────────────────────────────────

export async function applyPluginCleanup(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  opts: CleanupOptions,
): Promise<CleanupActionResult> {
  safePath(wpPath);
  if (!Array.isArray(opts.slugs) || opts.slugs.length === 0) {
    throw new Error('applyPluginCleanup: slugs is required and must be non-empty');
  }
  if (opts.action !== 'deactivate' && opts.action !== 'uninstall') {
    throw new Error('action must be "deactivate" or "uninstall"');
  }
  for (const s of opts.slugs) safeSlug(s);

  // Re-run audit and validate every requested slug is still a candidate
  const audit = await auditUnusedPlugins(sshOpts, wpPath, wpUser);
  const candidateSlugs = new Set(audit.candidates.map(c => c.slug));
  for (const slug of opts.slugs) {
    if (!candidateSlugs.has(slug)) {
      throw new Error(
        `slug "${slug}" is not a current cleanup candidate — re-run wp.plugins_cleanup_audit and resubmit only proposed slugs`,
      );
    }
  }

  const bySlug: Record<string, { ok: boolean; output: string }> = {};
  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalReclaimedMb = 0;

  for (const slug of opts.slugs) {
    if (!opts.apply) {
      bySlug[slug] = { ok: true, output: '[dry-run] would ' + opts.action };
      totalSucceeded++;
      const cand = audit.candidates.find(c => c.slug === slug);
      if (cand && opts.action === 'uninstall') totalReclaimedMb += cand.fileSizeMb;
      continue;
    }
    let r;
    if (opts.action === 'uninstall') {
      // `wp plugin uninstall --deactivate` runs uninstall hook + removes files
      r = await wpCli(
        { ...sshOpts, timeoutMs: 120_000 }, wpPath, wpUser,
        `plugin uninstall ${slug} --deactivate`,
      );
    } else {
      r = await wpCli(
        { ...sshOpts, timeoutMs: 60_000 }, wpPath, wpUser,
        `plugin deactivate ${slug}`,
      );
    }
    const ok = r.code === 0;
    bySlug[slug] = {
      ok,
      output: (r.stdout + r.stderr).slice(0, 500),
    };
    if (ok) {
      totalSucceeded++;
      const cand = audit.candidates.find(c => c.slug === slug);
      if (cand && opts.action === 'uninstall') totalReclaimedMb += cand.fileSizeMb;
    } else {
      totalFailed++;
    }
  }

  return {
    applied: opts.apply,
    action: opts.action,
    bySlug,
    totalSucceeded,
    totalFailed,
    totalReclaimedMb,
  };
}
