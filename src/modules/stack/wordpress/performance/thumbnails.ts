/**
 * thumbnails.ts — WordPress thumbnail (image-size) audit
 *
 * Lists every registered image size, measures disk usage per size,
 * cross-references active theme & plugins for `add_image_size()` /
 * `set_post_thumbnail_size()` calls, and flags sizes that appear unused.
 *
 * Cleanup mode (gated by confirm) deletes only the variant files for
 * removal-candidate sizes; originals and `-scaled.*` are never touched.
 *
 * Field signal: a real WordPress install on 2026-04-27 had 70,846 thumbnail
 * variants vs 47,613 originals — a 1.49× ratio. Many WP themes register
 * 6–10 image sizes that the live site never uses.
 *
 * Documented WP-CLI commands used:
 *   - `wp media image-size list --format=json`
 *   - `wp media regenerate --image_size=<slug>` (after cleanup)
 */

import { SSHOptions, sshExec, wpCli } from '../../../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface RegisteredImageSize {
  slug: string;
  width: number;
  height: number;
  crop: boolean;
  diskMb: number;
  fileCount: number;
  registeredBy: string[];     // theme/plugin slugs detected via grep
  inUseInPosts: boolean;      // detected in sampled rendered HTML
  removalCandidate: boolean;
  rationale: string;
}

export interface ThumbnailAuditResult {
  totalRegisteredSizes: number;
  totalVariantFiles: number;
  totalVariantMb: number;
  sizes: RegisteredImageSize[];
  unusedDiskMb: number;
  recommendations: string[];
}

export interface ThumbnailCleanupOptions {
  /** Slugs to remove. Each must correspond to a `removalCandidate: true` size from auditThumbnails. */
  sizeSlugs: string[];
  /** Default false; set true to actually delete. Required at the API layer. */
  apply: boolean;
}

export interface ThumbnailCleanupResult {
  applied: boolean;
  bySlug: Record<string, { deleted: number; freedMb: number }>;
  totalDeleted: number;
  totalFreedMb: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePath(p: string): void {
  if (/\.\./.test(p)) throw new Error('path must not contain ".."');
  if (!p.startsWith('/')) throw new Error('path must be absolute');
}

function shellSlug(s: string): string {
  // Restrict to chars valid in image-size slugs as WP defines them
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`invalid size slug: ${s} (allowed: a-z, A-Z, 0-9, _, -)`);
  }
  return s;
}

function bytesToMb(b: number): number {
  return Math.round((b / (1024 * 1024)) * 100) / 100;
}

interface RawSize { name: string; width: number; height: number; crop: boolean; }

// ─── List registered sizes (via WP-CLI) ─────────────────────────────────────

async function listRegisteredSizes(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<RawSize[]> {
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `media image-size list --format=json`,
  );
  if (!r.stdout.trim()) return [];
  try {
    const arr = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    return arr.map(o => ({
      name: String(o.name ?? ''),
      width: Number(o.width ?? 0),
      height: Number(o.height ?? 0),
      crop: o.crop === 'hard' || o.crop === true,
    })).filter(s => s.name);
  } catch {
    return [];
  }
}

// ─── Disk usage for a size ──────────────────────────────────────────────────

async function diskForSize(
  sshOpts: SSHOptions, uploadsPath: string, width: number, height: number,
): Promise<{ count: number; bytes: number }> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { count: 0, bytes: 0 };
  }
  const r = await sshExec(
    sshOpts,
    `find ${uploadsPath} -type f -regextype posix-extended -iregex ` +
    `'.*-${width}x${height}\\.(jpg|jpeg|png|webp|gif)$' ` +
    `-printf '%s\\n' 2>/dev/null | awk '{c++; s+=$1} END{printf "%d %d", c+0, s+0}'`,
  );
  const [c, s] = r.stdout.trim().split(' ');
  return { count: parseInt(c, 10) || 0, bytes: parseInt(s, 10) || 0 };
}

// ─── Detect who registered a size (theme/plugin grep) ───────────────────────

async function detectRegistrants(
  sshOpts: SSHOptions, wpPath: string, sizeSlug: string,
): Promise<string[]> {
  // Look for: add_image_size( 'slug', ... )  or  add_image_size( "slug", ... )
  // Search active theme + all plugins; ignore .min.js / vendor
  const slugLit = sizeSlug.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!slugLit) return [];
  const r = await sshExec(
    sshOpts,
    `grep -rl --include='*.php' --exclude-dir=node_modules --exclude-dir=vendor ` +
    `-E "add_image_size\\(\\s*['\\\"]${slugLit}['\\\"]" ` +
    `${wpPath}/wp-content/themes ${wpPath}/wp-content/plugins 2>/dev/null | head -10`,
  );
  const paths = r.stdout.split('\n').filter(Boolean);
  // Convert to plugin/theme slugs
  const slugs = new Set<string>();
  for (const p of paths) {
    const themeMatch = p.match(/wp-content\/themes\/([^/]+)/);
    const pluginMatch = p.match(/wp-content\/plugins\/([^/]+)/);
    if (themeMatch) slugs.add(`theme:${themeMatch[1]}`);
    if (pluginMatch) slugs.add(`plugin:${pluginMatch[1]}`);
  }
  return Array.from(slugs);
}

// ─── Check whether a size is referenced in actual rendered HTML ─────────────

async function sampleHtmlForSize(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
  width: number, height: number,
): Promise<boolean> {
  // Pull 5 random recent post permalinks and curl them; check if any contains
  // the `<width>x<height>.` size suffix in src/srcset attributes.
  const permRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `post list --post_type=post --post_status=publish --posts_per_page=5 ` +
    `--orderby=rand --field=url 2>/dev/null`,
  );
  const urls = permRes.stdout.split('\n').filter(u => u.startsWith('http'));
  if (urls.length === 0) return false;
  for (const url of urls) {
    const r = await sshExec(
      sshOpts,
      `curl -sSL --max-time 8 ${shellQuote(url)} 2>/dev/null | grep -c '${width}x${height}\\.\\(jpg\\|jpeg\\|png\\|webp\\)' || true`,
    );
    if ((parseInt(r.stdout.trim(), 10) || 0) > 0) return true;
  }
  return false;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── Main audit ─────────────────────────────────────────────────────────────

export async function auditThumbnails(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<ThumbnailAuditResult> {
  safePath(wpPath);
  const uploads = `${wpPath}/wp-content/uploads`;
  const recommendations: string[] = [];

  const raw = await listRegisteredSizes(sshOpts, wpPath, wpUser);

  // Always-present WP core sizes (never propose to remove these without warning)
  const CORE_SIZES = new Set(['thumbnail', 'medium', 'medium_large', 'large', 'full']);

  // Total variant count (any size) for top-line stats
  const totalVariantsRes = await sshExec(
    sshOpts,
    `find ${uploads} -type f -regextype posix-extended ` +
    `-iregex '.*-[0-9]+x[0-9]+\\.(jpg|jpeg|png|webp|gif)$' ` +
    `-printf '%s\\n' 2>/dev/null | awk '{c++; s+=$1} END{printf "%d %d", c+0, s+0}'`,
  );
  const [tvCountStr, tvBytesStr] = totalVariantsRes.stdout.trim().split(' ');
  const totalVariantFiles = parseInt(tvCountStr, 10) || 0;
  const totalVariantMb = bytesToMb(parseInt(tvBytesStr, 10) || 0);

  const sizes: RegisteredImageSize[] = [];
  let unusedDiskMb = 0;

  for (const s of raw) {
    const [{ count, bytes }, registrants] = await Promise.all([
      diskForSize(sshOpts, uploads, s.width, s.height),
      CORE_SIZES.has(s.name) ? Promise.resolve(['core:wordpress']) : detectRegistrants(sshOpts, wpPath, s.name),
    ]);
    const diskMb = bytesToMb(bytes);

    let inUseInPosts = false;
    if (count > 0 && diskMb > 5 && !CORE_SIZES.has(s.name)) {
      inUseInPosts = await sampleHtmlForSize(sshOpts, wpPath, wpUser, s.width, s.height);
    }

    let removalCandidate = false;
    let rationale: string;
    if (CORE_SIZES.has(s.name)) {
      rationale = 'WordPress core size — removing breaks admin UI; not a candidate.';
    } else if (count === 0) {
      rationale = 'Registered but no files exist on disk — already clean.';
    } else if (registrants.length === 0 && !inUseInPosts) {
      removalCandidate = true;
      rationale = 'No add_image_size() found in active theme/plugins AND not detected in sampled rendered HTML.';
      unusedDiskMb += diskMb;
    } else if (!inUseInPosts) {
      rationale = `Registered by ${registrants.join(', ')} but not detected in sampled posts — review before removing.`;
    } else {
      rationale = `Registered by ${registrants.join(', ')} and present in rendered HTML — keep.`;
    }

    sizes.push({
      slug: s.name,
      width: s.width, height: s.height, crop: s.crop,
      diskMb, fileCount: count,
      registeredBy: registrants,
      inUseInPosts,
      removalCandidate,
      rationale,
    });
  }

  if (unusedDiskMb > 50) {
    recommendations.push(
      `~${unusedDiskMb.toFixed(0)} MB lives in unused thumbnail variants. After backup, run wp.thumbnails_clean with the proposed slugs.`,
    );
  }
  if (totalVariantFiles > 0 && totalVariantMb > 1024) {
    recommendations.push(
      `Total thumbnail variants weigh ${totalVariantMb.toFixed(0)} MB — combine cleanup with pngquant via wp.images_compress_bulk_start for max impact.`,
    );
  }
  if (sizes.length === 0) {
    recommendations.push('Could not enumerate registered image sizes — verify wp-cli is installed and the wpUser can run it.');
  }

  return {
    totalRegisteredSizes: sizes.length,
    totalVariantFiles,
    totalVariantMb,
    sizes,
    unusedDiskMb,
    recommendations,
  };
}

// ─── Cleanup (mutation) ─────────────────────────────────────────────────────

export async function cleanThumbnails(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  opts: ThumbnailCleanupOptions,
): Promise<ThumbnailCleanupResult> {
  safePath(wpPath);
  const uploads = `${wpPath}/wp-content/uploads`;
  if (!Array.isArray(opts.sizeSlugs) || opts.sizeSlugs.length === 0) {
    throw new Error('cleanThumbnails: sizeSlugs is required and must be non-empty');
  }
  for (const slug of opts.sizeSlugs) shellSlug(slug);

  // Re-audit so we don't accept stale slug proposals
  const audit = await auditThumbnails(sshOpts, wpPath, wpUser);
  const candidateMap = new Map(
    audit.sizes
      .filter(s => s.removalCandidate)
      .map(s => [s.slug, s]),
  );
  for (const slug of opts.sizeSlugs) {
    if (!candidateMap.has(slug)) {
      throw new Error(
        `slug "${slug}" is not a current removal candidate — re-run wp.thumbnails_audit and resubmit only proposed slugs`,
      );
    }
  }

  const bySlug: Record<string, { deleted: number; freedMb: number }> = {};
  let totalDeleted = 0;
  let totalFreedMb = 0;

  for (const slug of opts.sizeSlugs) {
    const s = candidateMap.get(slug)!;
    if (!opts.apply) {
      // Dry run: just report what would happen
      bySlug[slug] = { deleted: s.fileCount, freedMb: s.diskMb };
      totalDeleted += s.fileCount;
      totalFreedMb += s.diskMb;
      continue;
    }
    // Apply: find -delete on the exact size suffix
    const r = await sshExec(
      { ...sshOpts, timeoutMs: 600_000 },
      `find ${uploads} -type f -regextype posix-extended -iregex ` +
      `'.*-${s.width}x${s.height}\\.(jpg|jpeg|png|webp|gif)$' -delete -print 2>/dev/null | wc -l`,
    );
    const deleted = parseInt(r.stdout.trim(), 10) || 0;
    bySlug[slug] = { deleted, freedMb: s.diskMb };
    totalDeleted += deleted;
    totalFreedMb += s.diskMb;
  }

  return { applied: opts.apply, bySlug, totalDeleted, totalFreedMb };
}
