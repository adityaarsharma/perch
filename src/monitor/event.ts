/**
 * Monitor → Notifier contract (v2.5).
 *
 * Watch tier produces ProbeResult; Decide tier promotes it to Event.
 * Notifier consumes Events, nothing else does.
 */

export interface ProbeMeta {
  /** kebab-case probe name, also the file basename. */
  name: string;
  /** cron-style or "Nm" / "Ns" schedule string. */
  interval: string;
  /** Read-only allowlist — for verification at registration time. */
  reads: string[];
}

export interface ProbeContext {
  host: string;
  /** Read-only command runner over SSH. Stack/Platform reads only. */
  read: (script: string, opts?: Record<string, unknown>) => Promise<string>;
  /** Brain rooms (typed, read-only here). */
  brain: {
    timeseries: { append: (metric: string, value: number) => void };
    knowledge: { search: (q: { domain: string; host?: string }) => unknown };
  };
}

export interface ProbeResult {
  /** Stable type slug, e.g. "disk.high". Decide tier rule keys off this. */
  type: string;
  /** Numeric or structured measurement that tripped the rule. */
  signal: number | string | Record<string, unknown>;
  /** Unfiltered probe output for Notifier's compose step (LLM input). */
  raw: Record<string, unknown>;
  /** Soft self-trip — Decide tier still applies thresholds + dedup. */
  triggered: boolean;
}

export type Severity = "info" | "warn" | "critical";

export interface Event {
  id: string;                      // ULID, dedup key root
  host: string;
  type: string;                    // "disk.high", "ssl.expiring", …
  severity: Severity;
  signal: ProbeResult["signal"];
  raw: ProbeResult["raw"];
  context: {
    last_seen?: string;
    streak?: number;
    related_incidents?: string[];
    historical_fix?: string;
  };
  created_at: string;              // ISO8601
}
