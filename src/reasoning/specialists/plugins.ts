/**
 * plugins.ts — Plugin-specific specialist
 *
 * Domain: deep audits for major individual plugins (WooCommerce, Yoast,
 *         eventually Elementor, Divi, ACF). Each plugin gets its own
 *         module under src/modules/stack/wordpress/plugins/.
 *
 * STATUS: scaffold (v2.3). Deterministic plan; v2.4 swaps for LLM.
 *
 * Note: this is the "plugins" *specialist*, not the generic plugin CVE
 * checker (which lives under security/plugins.ts) or plugin perf profiler
 * (under performance/plugins-perf.ts) or unused-plugin cleaner (under
 * cleanup/plugins-cleanup.ts). This specialist routes intents like
 * "WooCommerce health" / "Yoast issues" / "Elementor bloat" to the right
 * per-plugin auditor.
 */

import {
  registerSpecialist,
  type SpecialistContract,
  type SpecialistPlanArgs,
  type Plan,
} from '../orchestrator.js';

const ALLOWED_TOOLS = [
  'wp.woocommerce_audit',
  'wp.yoast_audit',
  // future: wp.elementor_audit, wp.divi_audit, wp.acf_audit
];

export const SYSTEM_PROMPT = `You are the Plugin-specific specialist inside \
Perch. You handle deep audits for major individual plugins (WooCommerce, \
Yoast, eventually Elementor, Divi, ACF). \
Tools: ${ALLOWED_TOOLS.join(', ')}. \
Rules: (1) Each plugin auditor is stand-alone — never cross-call between \
plugin auditors in one plan unless the user explicitly asks for "everything." \
(2) Use the auditor's recommendations verbatim — don't second-guess plugin- \
specific best practices.`;

export const pluginsSpecialist: SpecialistContract = {
  domain: 'plugins',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    // v2.3 deterministic: try both top auditors. v2.4 will use LLM to pick
    // the right plugin based on intent text.
    return {
      intent: args.intent,
      domain: 'plugins',
      producedBy: 'plugins@v2.3-deterministic',
      steps: [
        {
          tool: 'wp.woocommerce_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'WooCommerce-specific health (HPOS, sessions, low-stock)',
          mutating: false,
        },
        {
          tool: 'wp.yoast_audit',
          args: { wpPath: args.wpPath, wpUser: args.wpUser },
          reason: 'Yoast SEO health (sitemap, indexables, schema)',
          mutating: false,
        },
      ],
    };
  },
};

registerSpecialist(pluginsSpecialist);
