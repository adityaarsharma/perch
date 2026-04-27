/**
 * guardrails.ts — Rules-as-data layer
 *
 * Today, mutating endpoints in server.ts each check `if (a.confirm !== true)`.
 * That's three problems:
 *   1. Scattered logic — hard to audit
 *   2. Not editable at runtime — every rule change ships a new release
 *   3. Coarse — same gate for "delete a transient" and "uninstall a plugin"
 *
 * Guardrails fixes this by storing rules in BRAIN.guardrails and giving the
 * Reasoning layer a single check() function it MUST call before any mutating
 * executor invocation.
 *
 * STATUS: scaffold (v2.3) — rule engine + types + a tiny built-in rule set.
 * v2.4 will: (a) persist rules in BRAIN.guardrails table, (b) expose admin
 * API to add/remove rules, (c) wire orchestrator to call check() before
 * dispatch.
 */

export type Decision = 'allow' | 'deny' | 'require_human_confirmation';

export interface GuardrailContext {
  /** Tool being invoked, e.g. "wp.core_update" */
  tool: string;
  /** Args being passed to the tool */
  args: Record<string, unknown>;
  /** Identity of the actor (user id, "system", "cron", etc.) */
  actor: string;
  /** Optional host tags (e.g. ["prod", "wordpress"]) */
  hostTags?: string[];
}

export interface GuardrailRule {
  id: string;
  /** Higher first */
  priority: number;
  /** Returns null if rule doesn't apply, else a Decision */
  evaluate(ctx: GuardrailContext): Promise<Decision | null> | Decision | null;
  reason: string;
}

export interface GuardrailCheckResult {
  decision: Decision;
  matchedRules: Array<{ id: string; reason: string; decision: Decision }>;
  /** Why the final decision was reached */
  rationale: string;
}

// ─── Built-in rules (v2.3 hard-coded; v2.4 makes them DB-driven) ────────────

const BUILT_IN_RULES: GuardrailRule[] = [
  {
    id: 'mutating-needs-confirm',
    priority: 100,
    reason: 'All mutating tools require explicit confirm:true',
    evaluate(ctx) {
      // Tools that ARE mutating per current server.ts allowlist
      const mutating = new Set([
        'wp.images_optimize',
        'wp.images_compress_bulk_start',
        'wp.images_compress_bulk_cancel',
        'wp.images_compress_bulk_cleanup',
        'wp.thumbnails_clean',
        'wp.plugins_cleanup_apply',
        'wp.revisions_clean',
        'wp.translations_clean',
        'wp.core_update',
        'wp.search_replace',
        'wp.cron_run',
        'wp.rewrite_flush',
        'wp.email_test',
        'wp.db_clean',
      ]);
      if (!mutating.has(ctx.tool)) return null;
      if (ctx.args.confirm === true) return 'allow';
      return 'deny';
    },
  },
  {
    id: 'prod-double-confirm',
    priority: 200,
    reason: 'Production hosts require human confirmation for destructive tools',
    evaluate(ctx) {
      if (!ctx.hostTags?.includes('prod')) return null;
      const destructive = new Set([
        'wp.core_update',
        'wp.search_replace',
        'wp.plugins_cleanup_apply',
        'wp.thumbnails_clean',
      ]);
      if (!destructive.has(ctx.tool)) return null;
      // Even with confirm:true, prod requires a separate human-ack channel
      if (ctx.args.humanAck === true) return 'allow';
      return 'require_human_confirmation';
    },
  },
  {
    id: 'system-actor-cannot-mutate-prod',
    priority: 300,
    reason: 'Cron-triggered actors cannot run destructive tools on prod',
    evaluate(ctx) {
      if (ctx.actor !== 'cron' && ctx.actor !== 'system') return null;
      if (!ctx.hostTags?.includes('prod')) return null;
      const destructive = new Set([
        'wp.core_update',
        'wp.search_replace',
        'wp.plugins_cleanup_apply',
        'wp.images_compress_bulk_start',
      ]);
      if (destructive.has(ctx.tool)) return 'deny';
      return null;
    },
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

const customRules: GuardrailRule[] = [];

export function registerRule(rule: GuardrailRule): void {
  customRules.push(rule);
}

export function listRules(): GuardrailRule[] {
  return [...BUILT_IN_RULES, ...customRules].sort((a, b) => b.priority - a.priority);
}

export async function check(ctx: GuardrailContext): Promise<GuardrailCheckResult> {
  const matched: Array<{ id: string; reason: string; decision: Decision }> = [];
  let final: Decision = 'allow';

  for (const rule of listRules()) {
    const decision = await rule.evaluate(ctx);
    if (decision === null) continue;
    matched.push({ id: rule.id, reason: rule.reason, decision });
    // Most-restrictive wins: deny > require_human_confirmation > allow
    if (decision === 'deny') { final = 'deny'; break; }
    if (decision === 'require_human_confirmation' && final === 'allow') {
      final = 'require_human_confirmation';
    }
  }

  const rationale = matched.length === 0
    ? 'no rules matched; default allow'
    : matched.map(m => `${m.id}: ${m.reason} → ${m.decision}`).join('; ');

  return { decision: final, matchedRules: matched, rationale };
}

/**
 * Convenience helper for executor entry points.
 * Throws with a useful error message if not allowed.
 */
export async function enforce(ctx: GuardrailContext): Promise<void> {
  const result = await check(ctx);
  if (result.decision === 'allow') return;
  throw new Error(
    `guardrail ${result.decision}: ${result.rationale}`,
  );
}
