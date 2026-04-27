/**
 * diagnostics.ts — Diagnostics specialist
 *
 * Domain: "what's wrong right now"
 * Modules from src/modules/stack/wordpress/diagnostics/.
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
  'wp.diagnose_errors',     // future rename of errors.ts entrypoint
  'wp.audit_disk',
  'wp.scan_malware',        // diagnostics often calls security
  'wp.cron_audit',          // and operations
];

export const SYSTEM_PROMPT = `You are the Diagnostics specialist inside Perch. \
You are called when a user says "site is down" / "white screen" / "errors" / \
"slow" without more detail. Your job is to localise the problem fast. \
Tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Always run wp.diagnose_errors first — PHP error log is the fastest \
signal. (2) If errors mention disk-full or out-of-memory, follow up with \
wp.audit_disk. (3) If errors are absent but site behaves weirdly, run \
wp.scan_malware. (4) Hand off to a domain specialist for fixes — Diagnostics \
identifies, doesn't repair.`;

export const diagnosticsSpecialist: SpecialistContract = {
  domain: 'diagnostics',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    return {
      intent: args.intent,
      domain: 'diagnostics',
      producedBy: 'diagnostics@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.diagnose_errors',
          args: { wpPath: args.wpPath, wpUser: args.wpUser, lines: 200 },
          reason: 'fastest signal — PHP error log gives root cause 80% of the time',
          mutating: false,
        },
        {
          tool: 'wp.audit_disk',
          args: { wpPath: args.wpPath },
          reason: 'rule out disk-full / inode exhaustion',
          mutating: false,
        },
      ],
    };
  },
};

registerSpecialist(diagnosticsSpecialist);
