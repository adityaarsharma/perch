/**
 * disk.ts — WordPress disk usage audit
 *
 * Walks `wp-content/` and reports where space is going: top-level breakdown,
 * uploads by year/month, largest files, plugin/theme sizes, image-format
 * totals, dormant backup-plugin output, MySQL data size, and a thumbnail
 * bloat heuristic.
 *
 * Read-only. Safe to run repeatedly.
 *
 * Field-tested 2026-04-27 on a 51 GB / 47K-PNG WordPress install — surfaced
 * uploads/2021 (19 GB) and uploads/2026/04 (3 GB of 12 MB PNGs) as the
 * top offenders; 70,846 thumbnail variants from 47K originals (1.5× ratio).
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DiskTotals {
  wpContentMb: number;
  uploadsMb: number;
  pluginsMb: number;
  themesMb: number;
  cacheMb: number;
  backupsMb: number;
  fontsMb: number;
  muPluginsMb: number;
}

export interface UploadsBucket {
  label: string;        // "2026" or "2026/04"
  sizeMb: number;
}

export interface FileEntry {
  path: string;
  sizeMb: number;
}

export interface FormatCount {
  ext: string;
  count: number;
  sizeMb: number;
}

export interface DirSize {
  path: string;
  sizeMb: number;
}

export interface BackupArtifact {
  pluginSlug: string;       // e.g. "updraftplus", "duplicator", "ai1wm-backups"
  path: string;
  sizeMb: number;
}

export interface ThumbnailHeuristic {
  originalCount: number;
  variantCount: number;
  ratio: number;            // variants / originals
  status: 'healthy' | 'warning' | 'critical';
  comment: string;
}

export interface DiskAuditResult {
  totals: DiskTotals;
  uploadsByYear: UploadsBucket[];
  uploadsByYearMonth: UploadsBucket[];
  largestFiles: FileEntry[];
  imageFormats: FormatCount[];
  topPlugins: DirSize[];
  topThemes: DirSize[];
  backups: BackupArtifact[];
  mysqlDataMb: number | null;
  thumbnails: ThumbnailHeuristic;
  diskFreeMb: number;
  diskUsedPercent: number;
  recommendations: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safePath(p: string): void {
  if (/\.\./.test(p)) throw new Error('path must not contain ".."');
  if (!p.startsWith('/')) throw new Error('path must be absolute');
}

function parseFloat0(s: string): number {
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : 0;
}

function bytesToMb(b: number): number {
  return Math.round((b / (1024 * 1024)) * 100) / 100;
}

async function dirSizeMb(sshOpts: SSHOptions, path: string): Promise<number> {
  const r = await sshExec(sshOpts, `du -sb ${path} 2>/dev/null | cut -f1`);
  const bytes = parseInt(r.stdout.trim(), 10) || 0;
  return bytesToMb(bytes);
}

// ─── Main audit ──────────────────────────────────────────────────────────────

export async function auditDisk(
  sshOpts: SSHOptions,
  wpPath: string,
): Promise<DiskAuditResult> {
  safePath(wpPath);
  const wpc = `${wpPath}/wp-content`;
  const uploads = `${wpc}/uploads`;
  const recommendations: string[] = [];

  // Top-level totals
  const [
    wpContentMb, uploadsMb, pluginsMb, themesMb,
    cacheMb, fontsMb, muPluginsMb,
  ] = await Promise.all([
    dirSizeMb(sshOpts, wpc),
    dirSizeMb(sshOpts, uploads),
    dirSizeMb(sshOpts, `${wpc}/plugins`),
    dirSizeMb(sshOpts, `${wpc}/themes`),
    dirSizeMb(sshOpts, `${wpc}/cache`),
    dirSizeMb(sshOpts, `${wpc}/fonts`),
    dirSizeMb(sshOpts, `${wpc}/mu-plugins`),
  ]);

  // Backups: detect known backup-plugin output dirs and large archive files
  const BACKUP_DIRS = [
    'ai1wm-backups', 'updraft', 'backup-db', 'backups',
    'duplicator', 'wpvividbackups', 'backupbuddy_backups', 'backups-dup-lite',
  ];
  const backups: BackupArtifact[] = [];
  let backupsTotalMb = 0;
  for (const slug of BACKUP_DIRS) {
    const r = await sshExec(sshOpts, `du -sb ${wpc}/${slug} 2>/dev/null | cut -f1`);
    const bytes = parseInt(r.stdout.trim(), 10);
    if (bytes && bytes > 0) {
      const mb = bytesToMb(bytes);
      backups.push({ pluginSlug: slug, path: `${wpc}/${slug}`, sizeMb: mb });
      backupsTotalMb += mb;
    }
  }
  // Also catch loose archive files >50 MB anywhere in wp-content
  const looseArchives = await sshExec(
    sshOpts,
    `find ${wpc} -maxdepth 4 -type f \\( -iname "*.zip" -o -iname "*.tar.gz" -o -iname "*.sql" -o -iname "*.wpress" -o -iname "*.bak" \\) -size +50M -printf '%s %p\\n' 2>/dev/null | sort -rn | head -10`,
  );
  for (const line of looseArchives.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    const path = line.slice(idx + 1);
    backups.push({ pluginSlug: 'loose-archive', path, sizeMb: bytesToMb(bytes) });
    backupsTotalMb += bytesToMb(bytes);
  }
  if (backupsTotalMb > 1024) {
    recommendations.push(
      `Backup-plugin artifacts consume ${backupsTotalMb.toFixed(0)} MB — confirm these are exported offsite, then delete on-server copies.`,
    );
  }

  // Uploads by year (uploads/<YYYY>/)
  const yearRes = await sshExec(
    sshOpts,
    `for d in ${uploads}/2*; do [ -d "$d" ] && printf '%s %s\\n' "$(du -sb "$d" 2>/dev/null | cut -f1)" "$(basename "$d")"; done | sort -rn`,
  );
  const uploadsByYear: UploadsBucket[] = [];
  for (const line of yearRes.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    uploadsByYear.push({ label: line.slice(idx + 1), sizeMb: bytesToMb(bytes) });
  }

  // Uploads by year/month — top 20 largest only (avoid massive output)
  const monthRes = await sshExec(
    sshOpts,
    `for d in ${uploads}/2*/[0-1]*; do [ -d "$d" ] && printf '%s %s\\n' "$(du -sb "$d" 2>/dev/null | cut -f1)" "$(echo "$d" | sed 's|.*/uploads/||')"; done | sort -rn | head -20`,
  );
  const uploadsByYearMonth: UploadsBucket[] = [];
  for (const line of monthRes.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    uploadsByYearMonth.push({ label: line.slice(idx + 1), sizeMb: bytesToMb(bytes) });
  }

  // Top 30 largest files in uploads (any type)
  const largestRes = await sshExec(
    sshOpts,
    `find ${uploads} -type f -printf '%s %p\\n' 2>/dev/null | sort -rn | head -30`,
  );
  const largestFiles: FileEntry[] = [];
  for (const line of largestRes.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    largestFiles.push({ path: line.slice(idx + 1), sizeMb: bytesToMb(bytes) });
  }

  // Image format counts + size by extension
  const FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'heic', 'pdf', 'mp4', 'mov'];
  const imageFormats: FormatCount[] = [];
  for (const ext of FORMATS) {
    const r = await sshExec(
      sshOpts,
      `find ${uploads} -type f -iname "*.${ext}" -printf '%s\\n' 2>/dev/null | awk '{c++; s+=$1} END{printf "%d %d", c+0, s+0}'`,
    );
    const [countStr, sizeStr] = r.stdout.trim().split(' ');
    const count = parseInt(countStr, 10) || 0;
    const size = parseInt(sizeStr, 10) || 0;
    if (count > 0) {
      imageFormats.push({ ext, count, sizeMb: bytesToMb(size) });
    }
  }
  imageFormats.sort((a, b) => b.sizeMb - a.sizeMb);

  // Top plugins by disk
  const pluginsRes = await sshExec(
    sshOpts,
    `for d in ${wpc}/plugins/*/; do [ -d "$d" ] && printf '%s %s\\n' "$(du -sb "$d" 2>/dev/null | cut -f1)" "$(basename "$d")"; done | sort -rn | head -15`,
  );
  const topPlugins: DirSize[] = [];
  for (const line of pluginsRes.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    topPlugins.push({ path: line.slice(idx + 1), sizeMb: bytesToMb(bytes) });
  }

  const themesRes = await sshExec(
    sshOpts,
    `for d in ${wpc}/themes/*/; do [ -d "$d" ] && printf '%s %s\\n' "$(du -sb "$d" 2>/dev/null | cut -f1)" "$(basename "$d")"; done | sort -rn | head -10`,
  );
  const topThemes: DirSize[] = [];
  for (const line of themesRes.stdout.split('\n').filter(Boolean)) {
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const bytes = parseInt(line.slice(0, idx), 10) || 0;
    topThemes.push({ path: line.slice(idx + 1), sizeMb: bytesToMb(bytes) });
  }

  // MySQL data size — best-effort, runs only if mysql client + the wp DB user
  // are reachable from this shell. We don't make this fatal.
  let mysqlDataMb: number | null = null;
  const mysqlRes = await sshExec(
    sshOpts,
    `du -sb /var/lib/mysql 2>/dev/null | cut -f1`,
  );
  const mysqlBytes = parseInt(mysqlRes.stdout.trim(), 10);
  if (Number.isFinite(mysqlBytes) && mysqlBytes > 0) {
    mysqlDataMb = bytesToMb(mysqlBytes);
  }

  // Thumbnail bloat heuristic
  const origRes = await sshExec(
    sshOpts,
    `find ${uploads} -type f -regextype posix-extended -iregex '.*/[^/]+\\.(jpg|jpeg|png|webp)$' ! -iregex '.*-[0-9]+x[0-9]+\\.(jpg|jpeg|png|webp)$' ! -iregex '.*-scaled\\.(jpg|jpeg|png|webp)$' 2>/dev/null | wc -l`,
  );
  const variantRes = await sshExec(
    sshOpts,
    `find ${uploads} -type f -regextype posix-extended -iregex '.*-[0-9]+x[0-9]+\\.(jpg|jpeg|png|webp)$' 2>/dev/null | wc -l`,
  );
  const originalCount = parseInt(origRes.stdout.trim(), 10) || 0;
  const variantCount = parseInt(variantRes.stdout.trim(), 10) || 0;
  const ratio = originalCount > 0 ? variantCount / originalCount : 0;
  let thumbStatus: ThumbnailHeuristic['status'] = 'healthy';
  let thumbComment = `${variantCount} thumbnail variants from ${originalCount} originals (ratio ${ratio.toFixed(2)}).`;
  if (ratio > 12) {
    thumbStatus = 'critical';
    thumbComment += ' Likely many registered image sizes are unused — run wp.clean_thumbnails.';
    recommendations.push('Thumbnail bloat detected — audit registered image sizes via wp.clean_thumbnails.');
  } else if (ratio > 8) {
    thumbStatus = 'warning';
    thumbComment += ' Higher than typical — review registered image sizes.';
  }

  // Disk-level free space
  const dfRes = await sshExec(
    sshOpts,
    `df / | tail -1 | awk '{print $4 " " $5}'`,
  );
  const dfParts = dfRes.stdout.trim().split(' ');
  const diskFreeKb = parseInt(dfParts[0], 10) || 0;
  const diskFreeMb = Math.round(diskFreeKb / 1024);
  const diskUsedPercent = parseInt((dfParts[1] || '0').replace('%', ''), 10) || 0;
  if (diskUsedPercent >= 85) {
    recommendations.push(
      `Disk is ${diskUsedPercent}% full — free space below comfort threshold. Consider running wp.images_compress_bulk_start.`,
    );
  }

  // High-level recs
  if (uploadsMb > 0 && uploadsMb / Math.max(1, wpContentMb) > 0.7) {
    recommendations.push(
      `Uploads is ${Math.round((uploadsMb / wpContentMb) * 100)}% of wp-content — image compression is the highest-leverage win.`,
    );
  }
  const png = imageFormats.find(f => f.ext === 'png');
  if (png && png.sizeMb > 1024 && png.sizeMb / Math.max(1, uploadsMb) > 0.5) {
    recommendations.push(
      `PNGs are ${Math.round((png.sizeMb / uploadsMb) * 100)}% of uploads (${png.sizeMb.toFixed(0)} MB) — pngquant via wp.images_compress_bulk_start typically saves 60–80%.`,
    );
  }

  return {
    totals: { wpContentMb, uploadsMb, pluginsMb, themesMb, cacheMb, backupsMb: backupsTotalMb, fontsMb, muPluginsMb },
    uploadsByYear,
    uploadsByYearMonth,
    largestFiles,
    imageFormats,
    topPlugins,
    topThemes,
    backups,
    mysqlDataMb,
    thumbnails: { originalCount, variantCount, ratio: Math.round(ratio * 100) / 100, status: thumbStatus, comment: thumbComment },
    diskFreeMb,
    diskUsedPercent,
    recommendations,
  };
}
