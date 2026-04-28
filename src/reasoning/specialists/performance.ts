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

/**
 * v2.5 LLM-driven planner.
 *
 * Calls the user's BYOK Gemini/Gemma model with SYSTEM_PROMPT + intent +
 * the filtered Performance-domain brain history (TODO: brain query when the
 * orchestrator passes it in). Asks for a JSON plan in the shape the
 * orchestrator already accepts. Falls back to the deterministic plan on
 * any LLM failure (network, quota, bad parse) so the specialist never
 * blocks Perch — it only gets smarter when the LLM is reachable.
 */

interface LlmStep { tool: string; args: Record<string, unknown>; reason: string; mutating: boolean; }

async function callLlmForPlan(intent: string, wpPath: string, wpUser: string): Promise<LlmStep[] | null> {
  const apiKey = process.env.PERCH_LLM_API_KEY;
  const model = process.env.PERCH_LLM_MODEL ?? 'gemma-3-27b-it';
  if (!apiKey) return null;

  const userPrompt = `INTENT: ${intent}
WPPATH: ${wpPath}
WPUSER: ${wpUser}
DOMAIN: ${wpPath.split('/').pop() || 'unknown'}

Output ONLY a JSON array of steps. Each step:
{ "tool": "<one of allowed>", "args": {...}, "reason": "<one sentence>", "mutating": true|false }

Rules:
- Read-only audits first unless intent explicitly says skip baseline.
- Never include mutating actions if you wouldn't run them blindly on prod.
- 2-5 steps typical. No prose, no markdown, no explanation outside the JSON.`;

  // Gemma rejects systemInstruction → fold into first user turn.
  const isGemma = model.startsWith('gemma');
  const body: Record<string, unknown> = {
    contents: [{
      role: 'user',
      parts: [{ text: isGemma ? `${SYSTEM_PROMPT}\n\n${userPrompt}` : userPrompt }],
    }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
  };
  if (!isGemma) body.systemInstruction = { parts: [{ text: SYSTEM_PROMPT }] };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) return null;
    // Extract JSON array — Gemma sometimes wraps in ```json fences
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as LlmStep[];
    return parsed.filter((s) =>
      typeof s === 'object' && s.tool && ALLOWED_TOOLS.includes(s.tool)
    );
  } catch {
    return null;
  }
}

function deterministicSteps(args: SpecialistPlanArgs): LlmStep[] {
  return [
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
  ];
}

export const performanceSpecialist: SpecialistContract = {
  domain: 'performance',
  allowedTools: ALLOWED_TOOLS,
  async plan(args: SpecialistPlanArgs): Promise<Plan> {
    const llmSteps = await callLlmForPlan(args.intent.text, args.wpPath, args.wpUser);
    const usedLlm = !!(llmSteps && llmSteps.length > 0);
    const steps = usedLlm ? llmSteps! : deterministicSteps(args);
    return {
      intent: args.intent,
      domain: 'performance',
      producedBy: usedLlm ? `performance@v2.5-llm:${process.env.PERCH_LLM_MODEL ?? 'gemma-3-27b-it'}` : 'performance@v2.5-deterministic-fallback',
      steps,
    };
  },
};

registerSpecialist(performanceSpecialist);
