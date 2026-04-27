# Specialists — Sub-agents in the Reasoning layer

Six domain specialists live in `src/reasoning/specialists/`. Each is a small TypeScript file (~100 lines) with a focused system prompt and a defined tool allowlist. The Orchestrator routes user intent to one specialist; the specialist plans the steps; the Executor runs them.

| Specialist | Domain | Modules folder | Tool allowlist size |
|---|---|---|---|
| `performance.ts` | "make the site fast" | `stack/wordpress/performance/` | 8 |
| `security.ts` | "find and fix security gaps" | `stack/wordpress/security/` | 7 |
| `cleanup.ts` | "free disk + DB bloat" | `stack/wordpress/cleanup/` | 10 |
| `operations.ts` | "daily admin work" | `stack/wordpress/operations/` | 9 |
| `diagnostics.ts` | "what's wrong right now" | `stack/wordpress/diagnostics/` | 4 |
| `plugins.ts` | "deep audit of one plugin" | `stack/wordpress/plugins/` | 2 (will grow) |

## Specialist contract

```ts
interface SpecialistContract {
  domain: Domain;             // 'performance' | 'security' | ...
  allowedTools: string[];     // tools this specialist may schedule
  plan(args: SpecialistPlanArgs): Promise<Plan>;
}
```

A specialist:
- **Knows its modules deeply**, not all modules shallowly.
- **Owns cross-module heuristics** that other specialists wouldn't recognise (e.g. Performance knows that "low Redis hit rate + high TTFB" probably means missing page cache).
- **Filters brain history** to only its domain — past performance incidents don't leak into security planning.
- **Cannot schedule out-of-domain tools** — orchestrator enforces this.

## v2.3 status — deterministic plans

Each specialist currently returns a deterministic plan based on simple rules. This unlocks the architecture without requiring LLM calls. Specialists are testable: same intent → same plan.

## v2.4 plan — LLM-driven plans

In v2.4 each specialist swaps its `plan()` for an LLM call:

```ts
async plan(args: SpecialistPlanArgs): Promise<Plan> {
  return await this.llm.plan({
    systemPrompt: SYSTEM_PROMPT,
    userIntent: args.intent.text,
    brainHistory: await this.brainFiltered(args),
    allowedTools: this.allowedTools,
  });
}
```

The system prompt for each specialist is already in this PR (look for `SYSTEM_PROMPT` exported constant in each file). It encodes the cross-module heuristics in plain English so we can iterate them as text without code changes.

## Adding a new specialist

To add e.g. `Networking` for future Cloudflare ops:

1. Create `src/reasoning/specialists/networking.ts` mirroring an existing one.
2. Add the domain to `Domain` union in `orchestrator.ts`.
3. Define `ALLOWED_TOOLS` and `SYSTEM_PROMPT` constants.
4. Implement `plan()`.
5. Export `registerSpecialist(networkingSpecialist)` at module level.
6. Re-export from `specialists/index.ts`.

The orchestrator picks it up automatically once the file is imported.
