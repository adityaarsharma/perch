# Guardrails — rules-as-data

Centralised rule layer that gates every mutating executor call.

## Why

Today's `confirm: true` checks are scattered across `server.ts`. Three problems:
1. Hard to audit — no single place lists what's gated and why
2. Not editable at runtime — every rule change ships a new release
3. Coarse — same gate for "delete a transient" and "uninstall a plugin"

Guardrails fixes all three by storing rules as data and giving the Reasoning layer one `check()` function it MUST call before dispatch.

## Rule shape

```ts
interface GuardrailRule {
  id: string;
  priority: number;       // higher first
  evaluate(ctx): Decision | null;   // null = doesn't apply
  reason: string;
}

type Decision = 'allow' | 'deny' | 'require_human_confirmation';
```

Most-restrictive wins: `deny > require_human_confirmation > allow`.

## Built-in rules (v2.3)

| ID | Priority | What it does |
|---|---|---|
| `mutating-needs-confirm` | 100 | All mutating tools require explicit `confirm: true` |
| `prod-double-confirm` | 200 | Production hosts require `humanAck: true` for destructive tools (core update, search-replace, plugin uninstall, thumbnail delete) |
| `system-actor-cannot-mutate-prod` | 300 | Cron-triggered actors cannot run destructive tools on prod |

In v2.4 these become rows in `BRAIN.guardrails`, editable via API.

## Adding a custom rule (today, v2.3)

```ts
import { registerRule } from './core/guardrails.js';

registerRule({
  id: 'never-touch-malcare-quarantine',
  priority: 500,
  reason: 'MalCare quarantine — let MalCare manage them',
  evaluate(ctx) {
    if (ctx.tool !== 'wp.scan_malware') return null;
    const paths = JSON.stringify(ctx.args);
    if (paths.includes('/wp-malcare/')) return 'deny';
    return null;
  },
});
```

## Future syntax (v2.4 — DB rules)

```yaml
- id: backup-before-core-update
  priority: 400
  match: { tool: wp.core_update }
  precondition: { wp.backup_health: { ageHours: { lt: 24 } } }
  rule: deny_if_precondition_fails
  reason: "Refuse core update if last backup is older than 24h."
```

## Where check() is called

Today: not yet wired into server.ts (handlers still do `if (a.confirm !== true)`).

v2.4 wiring plan:
1. `server.ts` handler delegates to `orchestrator.dispatch(...)`
2. Orchestrator calls `guardrails.enforce({ tool, args, actor, hostTags })` BEFORE specialist plan
3. If decision is `require_human_confirmation`, orchestrator returns to Connector with a confirm prompt
4. After human ack via Connector (Telegram button, Slack action, etc.), the request comes back with `humanAck: true` and re-enters the flow

The point: **no executor call ever bypasses the guardrails layer.**
