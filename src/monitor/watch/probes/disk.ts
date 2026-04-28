/**
 * disk.ts — first probe ported to v2.5 src/monitor/.
 *
 * Watches root filesystem usage. Reads only `df -h`. Emits a ProbeResult
 * with the highest mount % as `signal`. Decide tier maps to severity
 * (warn ≥ RULE_DISK_WARN, critical ≥ RULE_DISK_CRIT — defaults 80/95).
 *
 * Migration: monitor.sh's rule_disk does the same job today via cron.
 * This TS version is the v2.5 successor; the bash rule stays live until
 * scheduler.ts + decide/runner.ts land. Both can run in parallel
 * (dedup is host+type keyed, so duplicate alerts won't double-fire).
 */

import type { ProbeContext, ProbeMeta, ProbeResult } from "../../event.js";

export const meta: ProbeMeta = {
  name: "disk",
  interval: "5m",
  reads: ["ssh.df"],
};

interface DfRow { pct: number; mount: string; }

function parseDf(output: string): DfRow[] {
  const lines = output.trim().split("\n").filter(Boolean);
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      // expected order from `df --output=pcent,target`: <pct%> <mount>
      const pctStr = parts[0]?.replace("%", "") ?? "";
      const pct = Number.parseInt(pctStr, 10);
      const mount = parts.slice(1).join(" ") || "?";
      return Number.isFinite(pct) ? { pct, mount } : null;
    })
    .filter((r): r is DfRow => r !== null);
}

export async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  // Tail of the df listing (skip header). Uses --output to avoid Filesystem
  // column variability across distros + RunCloud's nginx-rc layout.
  const out = await ctx.read("ssh.df", {
    args: "-h --output=pcent,target",
    skipHeader: true,
  });
  const rows = parseDf(out);
  const max = rows.length ? Math.max(...rows.map((r) => r.pct)) : 0;
  const top = rows.slice().sort((a, b) => b.pct - a.pct).slice(0, 5);

  // Also push to timeseries for trend detection by Notifier compose ("disk
  // climbing 1%/hour for 6 hours" needs this).
  ctx.brain.timeseries.append(`disk.${ctx.host}.max_pct`, max);

  return {
    type: max >= 95 ? "disk.critical" : max >= 80 ? "disk.high" : "disk.ok",
    signal: max,
    raw: { rows: top, total_mounts: rows.length },
    triggered: max >= 80,
  };
}
