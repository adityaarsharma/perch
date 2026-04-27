/**
 * security.ts — Security specialist
 *
 * Domain: "find and fix security gaps"
 * Modules from src/modules/stack/wordpress/security/.
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
  'wp.scan_malware',
  'wp.images_scan',           // (read-only image dir scan touches security too)
  'wp.audit_security',        // (renamed from raw security.ts callable; future)
  'wp.htaccess_audit',
  'wp.ssl_audit',
  'wp.wp_config_audit',
  'wp.plugins_perf_profile',  // CVE check uses this in current plugins.ts
];

export const SYSTEM_PROMPT = `You are the Security specialist inside Perch. \
Your only domain is hardening WordPress sites and detecting compromise. \
Tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Never delete or quarantine files without human confirmation. \
(2) For high-risk findings (riskLevel: 'critical'), recommend a backup \
before any remediation. (3) Distinguish MalCare quarantine artifacts from \
real webshells before recommending action. (4) Cite the specific check \
that flagged each issue.`;

export const securitySpecialist: SpecialistContract = {
  domain: 'security',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    return {
      intent: args.intent,
      domain: 'security',
      producedBy: 'security@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.scan_malware',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'top-of-funnel — detect webshells + tampered core',
          mutating: false,
        },
        {
          tool: 'wp.wp_config_audit',
          args: { wpPath: args.wpPath },
          reason: 'verify production-safe wp-config (DEBUG, salts, perms)',
          mutating: false,
        },
        {
          tool: 'wp.htaccess_audit',
          args: { wpPath: args.wpPath },
          reason: 'flag dangerous directives + stale plugin blocks',
          mutating: false,
        },
        {
          tool: 'wp.ssl_audit',
          args: { url: `https://${args.wpPath.split('/').pop()}` },
          reason: 'cert expiry, HSTS, mixed-content',
          mutating: false,
        },
      ],
    };
  },
};

registerSpecialist(securitySpecialist);
