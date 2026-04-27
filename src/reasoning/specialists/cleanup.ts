/**
 * cleanup.ts — Cleanup specialist
 *
 * Domain: "free disk + DB bloat"
 * Modules from src/modules/stack/wordpress/cleanup/.
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
  'wp.media_orphans_audit',
  'wp.revisions_audit',
  'wp.revisions_clean',
  'wp.translations_audit',
  'wp.translations_clean',
  'wp.plugins_cleanup_audit',
  'wp.plugins_cleanup_apply',
  'wp.db_clean',
  'wp.thumbnails_audit',
  'wp.thumbnails_clean',
];

export const SYSTEM_PROMPT = `You are the Cleanup specialist inside Perch. \
Your only domain is freeing disk and DB bloat without breaking sites. \
Tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Always audit before clean — never propose mutations from a stale \
audit. (2) Order operations by risk: revisions/transients (low) → translations \
(low) → unused plugins (medium) → orphan media (medium-high; page builders \
often confuse orphan detection). (3) Never delete originals; only variants \
and -scaled copies are safe to remove. (4) Recommend a backup before any \
mutation that touches >100 MB.`;

export const cleanupSpecialist: SpecialistContract = {
  domain: 'cleanup',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    return {
      intent: args.intent,
      domain: 'cleanup',
      producedBy: 'cleanup@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.revisions_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'cheap and almost-always-safe quick win',
          mutating: false,
        },
        {
          tool: 'wp.translations_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'often 50-200 MB of unused .po/.mo files',
          mutating: false,
        },
        {
          tool: 'wp.plugins_cleanup_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'inactive >90d + abandoned (>2y no WP.org update) candidates',
          mutating: false,
        },
        {
          tool: 'wp.media_orphans_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'highest reward but highest false-positive risk — surface for human review',
          mutating: false,
        },
      ],
    };
  },
};

registerSpecialist(cleanupSpecialist);
