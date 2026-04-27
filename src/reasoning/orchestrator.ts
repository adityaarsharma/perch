/**
 * orchestrator.ts — Routes user intent to the right specialist
 *
 * Lives at the top of the Reasoning layer. Owns intent classification
 * and dispatch. Doesn't run modules itself — delegates to a specialist.
 *
 * STATUS: scaffold (v2.3). Full LLM-driven classification ships in v2.4
 * once we have the cost meter + brain-rooms typed API in place. For now,
 * this exposes the contract so specialists can be built against it.
 */

import type { SSHOptions } from '../core/ssh-enhanced.js';

export type Domain =
  | 'performance'
  | 'security'
  | 'cleanup'
  | 'operations'
  | 'diagnostics'
  | 'plugins';

export interface Intent {
  /** Free-text from the user (Telegram message, Slack command, etc.) */
  text: string;
  /** Resolved domain. v2.3 expects callers to set this; v2.4 will infer via LLM. */
  domain: Domain;
  /** Optional urgency hint (low | medium | high | critical) */
  urgency?: 'low' | 'medium' | 'high' | 'critical';
}

export interface PlanStep {
  tool: string;                 // e.g. "wp.images_compress_bulk_start"
  args: Record<string, unknown>;
  reason: string;
  /** True if this step requires confirm:true at the API layer */
  mutating: boolean;
}

export interface Plan {
  intent: Intent;
  domain: Domain;
  steps: PlanStep[];
  /** Specialist that produced the plan */
  producedBy: string;
}

export interface SpecialistContract {
  domain: Domain;
  /** Tools this specialist is allowed to schedule */
  allowedTools: string[];
  plan(args: SpecialistPlanArgs): Promise<Plan>;
}

export interface SpecialistPlanArgs {
  sshOpts: SSHOptions;
  wpPath: string;
  wpUser: string;
  intent: Intent;
}

const REGISTRY = new Map<Domain, SpecialistContract>();

export function registerSpecialist(s: SpecialistContract): void {
  if (REGISTRY.has(s.domain)) {
    throw new Error(`specialist for domain "${s.domain}" already registered`);
  }
  REGISTRY.set(s.domain, s);
}

export function listSpecialists(): Domain[] {
  return Array.from(REGISTRY.keys());
}

export async function dispatch(args: SpecialistPlanArgs): Promise<Plan> {
  const s = REGISTRY.get(args.intent.domain);
  if (!s) {
    throw new Error(
      `no specialist registered for domain "${args.intent.domain}". ` +
      `Available: ${listSpecialists().join(', ') || '(none yet)'}`,
    );
  }
  const plan = await s.plan(args);
  if (plan.domain !== args.intent.domain) {
    throw new Error(`specialist returned plan for wrong domain: ${plan.domain}`);
  }
  // Defense-in-depth: make sure specialist only schedules its allowed tools
  for (const step of plan.steps) {
    if (!s.allowedTools.includes(step.tool)) {
      throw new Error(
        `specialist "${s.domain}" tried to schedule tool "${step.tool}" not in its allowedTools`,
      );
    }
  }
  return plan;
}
