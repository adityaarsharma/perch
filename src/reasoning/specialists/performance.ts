/**
 * performance.ts — Performance specialist
 *
 * Domain: "make the site fast"
 * Modules it can schedule (from src/modules/stack/wordpress/performance/):
 *   wp.images_optimize / wp.images_compress_bulk_start
 *   wp.thumbnails_audit / wp.thumbnails_clean
 *   wp.plugins_perf_profile
 *   wp.caching_audit
 *   wp.lighthouse_audit
 *
 * Cross-module heuristic seeds (will get richer as we run on real sites):
 *   • Low Redis hit rate + high TTFB → install/repair page cache
 *   • Lighthouse mobile score < 50 + uploads > 5 GB → bulk image compress
 *   • Many "low_score" plugins active → recommend deactivation
 *
 * STATUS: scaffold (v2.3). Returns a deterministic plan based on simple
 * rules. v2.4 swaps the planner for an LLM call with this file's
 * SYSTEM_PROMPT + filtered brain history.
 */

import {
  registerSpecialist,
  type SpecialistContract,
  type SpecialistPlanArgs,
  type Plan,
} from '../orchestrator.js';

const ALLOWED_TOOLS = [
  'wp.images_optimize',
  'wp.images_compress_bulk_start',
  'wp.images_compress_bulk_status',
  'wp.thumbnails_audit',
  'wp.thumbnails_clean',
  'wp.plugins_perf_profile',
  'wp.caching_audit',
  'wp.lighthouse_audit',
];

export const SYSTEM_PROMPT = `You are the Performance specialist inside Perch. \
Your only domain is making WordPress sites faster. \
You have these tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Always start with a read-only audit unless the user explicitly says \
they have already audited. (2) Never propose mutating actions on a host with \
no recent backup. (3) Prefer wp.images_compress_bulk_start over wp.images_optimize \
when uploads exceed 1 GB. (4) Cite the specific module output that justifies \
each step.`;

export const performanceSpecialist: SpecialistContract = {
  domain: 'performance',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    // v2.3 deterministic plan: lighthouse → caching audit → conditional bulk
    // image compress. v2.4 replaces this with an LLM call using SYSTEM_PROMPT.
    return {
      intent: args.intent,
      domain: 'performance',
      producedBy: 'performance@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.lighthouse_audit',
          args: { url: `https://${args.wpPath.split('/').pop()}` },
          reason: 'establish baseline scores + Core Web Vitals',
          mutating: false,
        },
        {
          tool: 'wp.caching_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'detect missing object cache or page cache',
          mutating: false,
        },
        {
          tool: 'wp.images_compress_bulk_start',
          args: { wpPath: args.wpPath, wpUser: args.wpUser, confirm: true },
          reason: 'highest-leverage win for typical sites',
          mutating: true,
        },
      ],
    };
  },
};

registerSpecialist(performanceSpecialist);
