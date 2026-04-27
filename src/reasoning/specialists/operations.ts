/**
 * operations.ts — Operations specialist
 *
 * Domain: "daily admin work"
 * Modules from src/modules/stack/wordpress/operations/.
 *
 * STATUS: scaffold (v2.3). Deterministic plan; v2.4 swaps for LLM.
 */

import {
  registerSpecialist,
  type SpecialistContract,
  type SpecialistPlanArgs,
  type Plan,
} from '../orchestrator.js';

const ALLOWED_TOOLS = [
  'wp.core_status',
  'wp.core_update',
  'wp.search_replace',
  'wp.cron_audit',
  'wp.cron_run',
  'wp.rewrite_flush',
  'wp.multisite_audit',
  'wp.email_test',
  'wp.backup_health',          // currently lives under modules/.../backup.ts
];

export const SYSTEM_PROMPT = `You are the Operations specialist inside Perch. \
Your domain is routine admin: WP core updates, URL migrations, cron repair, \
permalink flush, email deliverability, multisite admin. \
Tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Refuse wp.core_update if last backup is older than 24h. (2) For \
wp.search_replace, ALWAYS dry-run first; only apply with explicit confirm. \
(3) wp.cron_run only after wp.cron_audit shows overdue events. (4) Recommend \
real-cron over WP-Cron when traffic is low.`;

export const operationsSpecialist: SpecialistContract = {
  domain: 'operations',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    return {
      intent: args.intent,
      domain: 'operations',
      producedBy: 'operations@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.core_status',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'check WP version + checksum integrity',
          mutating: false,
        },
        {
          tool: 'wp.cron_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'overdue events, missing standard hooks, stuck doing_cron',
          mutating: false,
        },
        {
          tool: 'wp.backup_health',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'verify backups are recent before any mutating op',
          mutating: false,
        },
      ],
    };
  },
};

registerSpecialist(operationsSpecialist);
