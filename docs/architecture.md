# Perch — Architecture

Canonical reference. When in doubt, follow this doc.

Last revised: 2026-04-27 (Perch v2.4 — Connectors redesign). Predecessor block-model doc preserved at [`architecture-blocks-legacy.md`](./architecture-blocks-legacy.md) for reference.

---

## TL;DR

Perch is a **4-layer system** with a per-host SQLite **brain** and modules organised in two dimensions: **Stack vs Platform** (where they operate) and **Performance / Security / Cleanup / Operations / Diagnostics / Plugin-specific** (what domain they cover).

The **Connectors** layer is itself two surfaces with one sharp boundary:
- **Surface A (Monitor + Notifier)** — push, read + Smart-Fix-only writes
- **Surface B (AI Conversational)** — pull, strictly read-only

> **The line: Conversation never mutates. Smart Fix is the only write path. The LLM is the connector — that's Perch's moat.**

Each Reasoning domain gets its own LLM **specialist**; the Orchestrator routes user intent to the right specialist. See [`connectors.md`](./connectors.md) and [`monitor.md`](./monitor.md) for the connector design in depth.

> **What changed in v2.4:** Old "Notifier layer 4" collapsed into Connectors → Surface A. Total layers: 5 → 4. Monitor is now its own first-class sub-layer of Connectors. New brain room: `conversations` (every chat persisted).

---

## The 4 layers

```
╔═══════════════════════════════════════════════════════════════════════╗
║  CONNECTORS                                                           ║
║                                                                       ║
║   ┌─ Surface A (server → user, push) ───────────────────────────────┐ ║
║   │   ┌─ MONITOR  (own sub-layer, grows fastest) ───────────────┐   │ ║
║   │   │  Probes · rules-as-data · scheduler · dedup · severity  │   │ ║
║   │   │  Inbound webhooks: RunCloud · CF · GitHub · custom      │   │ ║
║   │   │  Output: Event { host, type, severity, signal, ctx }    │   │ ║
║   │   └─────────────────────────────┬───────────────────────────┘   │ ║
║   │                                 ↓                               │ ║
║   │   ┌─ NOTIFIER  (LLM compose · dispatch · Smart Fix) ───────┐    │ ║
║   │   │  Out:    Telegram · Slack · Email · Webhook            │    │ ║
║   │   │  Buttons:[Smart Fix]  [Snooze 1h]  [Ignore]            │    │ ║
║   │   │  Writes: ONLY via Smart Fix (LLM-judged from registry) │    │ ║
║   │   └────────────────────────────────────────────────────────┘    │ ║
║   └─────────────────────────────────────────────────────────────────┘ ║
║                                                                       ║
║   ┌─ Surface B (user ↔ server, pull) — STRICTLY READ-ONLY ──────────┐ ║
║   │  Telegram DM · Slack · Claude Code MCP · ChatGPT/Gemini plugin · │ ║
║   │  CLI · HTTP API                                                  │ ║
║   │  Engine: user msg → BYOK LLM → static brain → live RO modules    │ ║
║   │  Scope: server topics only · soft tone · refuses off-topic       │ ║
║   │  Writes: NEVER. Refuses + redirects to Smart Fix.                │ ║
║   └──────────────────────────────────────────────────────────────────┘║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║  REASONING                                                            ║
║  ┌─ ORCHESTRATOR (intent → specialist routing) ─────────┐             ║
║  │   PERFORMANCE · SECURITY · CLEANUP · OPERATIONS ·    │             ║
║  │   DIAGNOSTICS · PLUGIN-SPECIFIC ← sub-agents         │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  + Recommend engine · Guardrails enforcer · Cost meter                ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║  EXECUTOR                                                             ║
║  ┌── STACK modules (operate INSIDE the server) ─────────┐             ║
║  │ src/modules/stack/wordpress/{performance,security,   │             ║
║  │   cleanup,operations,diagnostics,plugins}/           │             ║
║  │ src/modules/stack/{nodejs,laravel,static}/  (future) │             ║
║  │ via SSH + CLI (wp-cli, find, openssl, …)             │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  ┌── PLATFORM modules (operate ABOVE the server) ───────┐             ║
║  │ src/modules/platform/{runcloud,hetzner,cloudflare,   │             ║
║  │   github}/                                           │             ║
║  │ via REST APIs                                        │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  Every module: read-only audit + (gated) mutating actions             ║
║  Always: log to BRAIN.actions; check BRAIN.guardrails first           ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║ BRAIN  (~/.perch/brain.db)                                            ║
║ Logical ROOMS:                                                        ║
║   secrets · guardrails · problems · actions · knowledge · webapps ·   ║
║   incidents · timeseries · audit_log · conversations  ← v2.4          ║
╚═══════════════════════════════════════════════════════════════════════╝
```

---

## Layer responsibilities

| Layer | Sub-layer | Owns | Doesn't own |
|---|---|---|---|
| **Connectors** | **Monitor** (Surface A) | Probes · rules-as-data · scheduler · dedup · severity · inbound webhooks. Emits typed `Event`. | LLM calls · message composition · writes |
| **Connectors** | **Notifier** (Surface A) | LLM compose · channel dispatch · Smart Fix runner · button callbacks | What to watch · when to fire |
| **Connectors** | **AI Conversational** (Surface B) | User msg routing · BYOK LLM · read-only module orchestration · scope-locking · chat persistence | Mutations of any kind |
| **Reasoning** | — | Intent → plan, ranking, guardrail enforcement, LLM calls for specialists | Direct shell/SSH · brain writes |
| **Executor** | — | Modules + their audit/mutate functions · SSH/API execution | Deciding when to run · alerting |
| **Brain** | — | All persistent state in named "rooms" · encrypted secrets | Logic. Just storage + query API |

Hard boundaries:
- **Conversation never mutates.** Surface B refuses every write and redirects to Smart Fix.
- **Smart Fix is the only write path** from Connectors. LLM-judged, registry-bounded, guardrails-checked.
- **Monitor never calls LLMs.** It emits structured Events; Notifier prose-ifies.
- **Executor never alerts directly.** Notifier owns dispatch.

---

## Stack vs Platform — two kinds of modules

The Executor layer has two kinds of modules with different vantage points:

| Type | What it operates on | How it talks | Examples |
|---|---|---|---|
| **STACK** | What's running INSIDE the server | SSH + CLI (wp-cli, find, openssl, etc.) | `wordpress/`, `nodejs/`, `laravel/` |
| **PLATFORM** | The control plane ABOVE the server | REST API | `runcloud/`, `hetzner/`, `cloudflare/`, `github/` |

**Decision rule:** If the operation is *about the platform* (server, webapp, service, cert, backup destination), use a Platform module. If it's *about the application code/data inside a webapp*, use a Stack module.

### Why RunCloud isn't "just another module"

RunCloud is one Platform module but plays five distinct roles:

1. **Discovery** — at onboarding, `GET /servers` seeds `BRAIN.webapps` automatically (zero → 50 webapps in one API key paste)
2. **Cross-server ops** — "disk free across all my servers?" = one API call vs 50 SSH connections
3. **Lifecycle management** — create webapp, issue Let's Encrypt, trigger backup (only RunCloud API can; SSH cannot create panel-tracked entities)
4. **Telemetry** — Notifier polls `GET /servers/<id>/stats` and writes to `BRAIN.timeseries`
5. **Source of truth for inventory** — nightly reconcile: if BRAIN drifts from RunCloud, RunCloud wins

Future Platform modules (Cloudflare, Hetzner, GitHub) follow the same 5-role pattern.

---

## Sub-sub-modules — the WordPress submodule, broken open

22 capabilities cluster into 6 domains. Each domain is a folder. Each domain has its own specialist (LLM persona) in the Reasoning layer.

```
src/modules/stack/wordpress/
├── performance/          ← "make the site fast"
│   ├── images.ts
│   ├── images-bulk.ts
│   ├── perf.ts
│   ├── thumbnails.ts
│   ├── plugins-perf.ts
│   ├── caching.ts
│   └── lighthouse.ts
├── security/             ← "find and fix security gaps"
│   ├── security.ts
│   ├── malware.ts
│   ├── htaccess.ts
│   ├── ssl.ts
│   ├── wp-config.ts
│   └── plugins.ts        (CVE checks)
├── cleanup/              ← "free disk + DB bloat"
│   ├── media-orphans.ts
│   ├── revisions.ts
│   ├── translations.ts
│   ├── plugins-cleanup.ts
│   └── db.ts             (transients, autoload, fragmentation)
├── operations/           ← "daily admin work"
│   ├── backup.ts
│   ├── core.ts           (WP core update)
│   ├── search-replace.ts
│   ├── cron.ts           (WP-Cron + rewrite flush)
│   ├── multisite.ts
│   └── email-test.ts
├── diagnostics/          ← "what's wrong right now"
│   ├── errors.ts
│   └── disk.ts
├── plugins/              ← "specialised per major plugin"
│   ├── woocommerce.ts
│   ├── yoast.ts
│   ├── elementor.ts      (future)
│   ├── divi.ts           (future)
│   └── acf.ts            (future)
└── recommend.ts          ← top-level aggregator (calls all specialists)
```

Future Stack modules (`stack/nodejs/`, `stack/laravel/`) follow the same 6-domain shape so users learn one mental model.

---

## Specialists — the multi-agent layer

Each domain has a specialist in `src/reasoning/specialists/`. A specialist is a small TS file (~100-150 lines) with:

- A focused **system prompt** for its domain
- The **list of modules** it can call
- **Cross-module heuristics** nobody else knows ("low Redis hit rate + high TTFB → install page cache")
- A **brain history filter** (only sees Performance-related past events, not unrelated noise)

```ts
// Example: src/reasoning/specialists/performance.ts (sketch)
export class PerformanceSpecialist {
  domain = 'performance';
  modules = [
    'wp.images_compress_bulk_start',
    'wp.caching_audit',
    'wp.lighthouse_audit',
    'wp.thumbnails_audit',
    'wp.plugins_perf_profile',
  ];

  async plan({ webapp, intent, brain }) {
    const past = await brain.knowledge.search({ domain: 'performance', host: webapp.host });
    // LLM call with focused system prompt + filtered history
    return this.llm.plan({ intent, past, modules: this.modules });
  }
}
```

The Orchestrator (in `src/reasoning/orchestrator.ts`) classifies the user's intent into a domain, then delegates to that specialist.

---

## Brain rooms

The brain is one SQLite file (`~/.perch/brain.db`) organised as logical "rooms." One file per host = trivial backup (`cp brain.db brain.db.bak`).

| Room | Stores | Used by |
|---|---|---|
| 🔐 `secrets` | SSH passwords, API keys, salts (encrypted with `PERCH_MASTER_KEY`) | Connectors (creds resolution), Executor (SSH auth) |
| 📋 `guardrails` | Rules: "never delete X", "always backup before update", per-host overrides | Reasoning (enforces before any mutating call) |
| ⚠️ `problems` | Every issue found (type, root_cause, snippet, severity, host) | Reasoning (recommend), Notifier (alert if recurring) |
| 🔧 `actions` | Every action attempted (tool, args, outcome, undo data) | Reasoning (avoid retry-loops), Connectors (`/perch undo`) |
| 📚 `knowledge` | Patterns repeated across runs, LLM-extracted facts (bi-temporal) | Reasoning (boost confidence) |
| 🌐 `webapps` | Per-host inventory: WP path, user, type, last-audited | All layers |
| 🚨 `incidents` | Open/ack/resolved with timeline + linked problems | Notifier (don't re-alert), Reasoning (postmortem) |
| 📊 `timeseries` | Disk %, response time, plugin count over time | Notifier (trend alerts), Reasoning (capacity planning) |
| 📜 `audit_log` | Immutable trail of every Perch decision (who, what, why, outcome) | Compliance, debugging |
| 💬 `conversations` | Every chat turn (msg, reply, tool calls, tokens) scoped per host. **Added v2.4.** | Surface B (load context next turn); Notifier (knows past chats when composing) |

See [`brain.md`](./brain.md) for room API + schema. See [`guardrails.md`](./guardrails.md) for rule syntax.

### How the brain stays smart (self-updating + reasoning)

Three LLM-driven background jobs (model from `PERCH_LLM_MODEL` env, default `claude-haiku-4-5`):

1. **Fact extractor (post-event hook)** — when a problem is logged, Claude extracts structured facts into `knowledge` with bi-temporal fields (`learned_at`, `valid_at`).
2. **Pattern finder (nightly cron)** — Claude reads last-7-days events, surfaces patterns into `knowledge`.
3. **Conflict resolver (per-write)** — when new fact contradicts old, Claude judges; old marked `superseded_by` with timestamp + reason. No facts ever deleted; history preserved.

Optional sidecar (v2.4+): **sqlite-vec** for embeddings + similarity search ("have we seen this error before?").

We deliberately do NOT adopt Mem0 or Graphiti wholesale — they're chat-shaped memory; Perch's data is ops-shaped. We borrow their best ideas (auto fact-merge, bi-temporal facts, contradiction handling) but run them on our SQLite to keep the "self-hosted, free forever, no extra services" promise.

---

## Guardrails — first-class rules-as-data

Today's `confirm: true` checks are scattered across `server.ts`. Guardrails consolidates them into editable rules in `BRAIN.guardrails`.

A guardrail is a rule: `(host, action, args) → allow | deny | require_human_confirmation`.

```yaml
- id: prod-hosts-need-confirm
  match: { host_tag: prod }
  on: [wp.core_update, wp.search_replace, wp.plugins_cleanup_apply]
  rule: require_human_confirmation
  reason: "Production hosts always need a human ack before mutating."

- id: backup-before-core-update
  match: { tool: wp.core_update }
  precondition: { wp.backup_health: { ageHours: { lt: 24 } } }
  rule: deny_if_precondition_fails
  reason: "Refuse core update if last backup is older than 24h."
```

See [`guardrails.md`](./guardrails.md) for full syntax + built-in rules.

---

## End-to-end flows (two worked examples — one per surface)

### Flow A — Surface A (Monitor → Notifier → Smart Fix)

`startupcooking.net` disk crosses 95%.

1. **Monitor → `disk` probe** runs (5m interval), measures 96%, matches rule `disk-critical` → emits `Event { host: startupcooking.net, type: disk.critical, severity: critical, signal: 96, raw: {...}, context: { related_incidents: [...] } }`.
2. **Monitor** writes to `BRAIN.incidents` (status=open) and `BRAIN.timeseries`.
3. **Notifier → composer** reads Event + brain (incidents/knowledge/webapps/conversations) → BYOK LLM drafts: *"Disk 96% on startupcooking.net. ~5 GB orphan media in `/uploads/2024/` — past Smart Fix freed 24 GB safely. Want me to do the same?"*
4. **Notifier → dispatcher** sends Telegram card with `[Smart Fix] [Snooze 1h] [Ignore]`.
5. User taps `Smart Fix`.
6. **Smart Fix runner** → LLM picks `wp.cleanup_media_orphans_apply` from registry → **Guardrails enforcer** checks (host=prod, action allowed, has rollback) → "Perching..." status posted.
7. **Executor** runs the action via SSH, logs to `BRAIN.actions`.
8. **Notifier** reports outcome: *"Done. Freed 5.2 GB. Disk now 78%."*
9. **Brain LLM hooks** extract facts into `knowledge` ("orphan-media pattern works on startupcooking.net, run-2").

### Flow B — Surface B (AI Conversational, READ-ONLY)

User in same Telegram chat: *"why was my site slow yesterday?"*

1. **Surface B router** loads recent context from `BRAIN.conversations` (host-scoped).
2. **BYOK LLM** reads static brain first (incidents from yesterday + recent timeseries) → judges "I have enough" → answers conversationally: *"At 14:30 IST, php-fpm pool saturated for 4 minutes. Notifier auto-restarted it. Want me to pull the access logs from that window?"*
3. User: *"yes pull logs"*
4. LLM judges this needs live read → calls `wp.diagnostics_errors` (read-only) → summarises.
5. User: *"delete those error logs"*
6. **`refuse-write.ts`** intercepts: *"I can't write from chat. Smart Fix can rotate logs — want me to surface a card, or run it via CLI?"*
7. Every turn persisted to `BRAIN.conversations`.

User never sees layers. Sees a competent ops assistant getting smarter — and one that refuses to fuck up their server from chat.

---

## What's IN scope vs OUT

| In scope | Out of scope |
|---|---|
| Single-user per host | Multi-tenant SaaS (community fork option) |
| Self-hosted SQLite brain | Cross-host fleet brain (v3.x) |
| LLM-driven smart writes | LLM that mutates without human-in-loop |
| Telegram, Slack, Email, Webhook channels | iOS/Android apps |
| RunCloud + Hetzner + Cloudflare + GitHub | AWS, GCP, Azure (community-contributed) |
| WordPress, NodeJS, Laravel, static | Every framework |
| Closed-loop postmortem after incidents | Auto-fix critical without human ack |

---

## What's MATURE today (v2.3 shipped)

- Layer separation (now 4-layer post-v2.4 design lock)
- Module pattern (audit + gated mutating, log to brain)
- SSH + Vault + Brain core foundations
- HTTP API with Bearer + rate limit + allowlist
- 22 WordPress capabilities organised into 6 sub-sub-module domains
- RunCloud API wrapper
- LLM-judged static-vs-dynamic intent (in `bot.py` — to be ported into Surface B)
- `monitor.sh` cron with Telegram + Slack mirroring (to be ported into `src/connectors/monitor/`)

## What's DESIGNED but NOT yet implemented (v2.4 design lock)

- 🟡 Connectors split into Monitor + Notifier + AI (docs landed, code follows)
- 🟡 Monitor as own sub-layer with rules-as-data + scheduler + dedup
- 🟡 Smart Fix as the only write path (LLM-judged, registry, learning loop)
- 🟡 Surface B strict-read-only with `refuse-write.ts`
- 🟡 BYOK LLM (Gemini reference) wired through `src/connectors/ai/llm/`
- 🟡 `BRAIN.conversations` room + per-host chat persistence
- 🟡 Bot personality (server-scope-locked, soft tone) via `system-prompt.ts`

## What's MISSING (v2.4 → v2.6)

- ❌ Inbound webhooks (RunCloud/Cloudflare/GitHub) — designed for Monitor, not built
- ❌ Smart Fix promotion gate (nightly LLM proposes new candidates)
- ❌ Cost meter (LLM API call tracking per session/host)
- ❌ Brain backup/restore (export/import of `brain.db`)
- ❌ Guardrails-as-data (today scattered in code; Monitor rules will share this store)
- ❌ Cross-host fleet view
- ❌ Specialist LLM personas (scaffolds shipped in v2.3; full implementation pending)

---

## Files for new contributors / agents (read in order)

1. [`architecture.md`](./architecture.md) — this file
2. [`connectors.md`](./connectors.md) — Connectors layer (Surface A + B)
3. [`monitor.md`](./monitor.md) — Monitor sub-layer (probes, rules, growth plan)
4. [`specialists.md`](./specialists.md) — sub-agent design
5. [`brain.md`](./brain.md) — room schemas (incl. `conversations`)
6. [`guardrails.md`](./guardrails.md) — rule syntax (also used by Monitor rules-as-data)
7. [`blocks/wordpress-images.md`](./blocks/wordpress-images.md) — case study of a complete module pair
8. `src/core/` — read first: `ssh-enhanced.ts`, `brain.ts`, `vault.ts`
9. `src/api/server.ts` — every endpoint (will become `src/connectors/ai/channels/http-api.ts` in v2.4 implementation)
10. `src/modules/stack/wordpress/<domain>/<feature>.ts` — copy this pattern when adding modules

---

## When to revise this document

- Adding or removing a layer (rare; 4 should stay stable)
- Adding a brain room
- Changing the guardrails contract or Monitor rules contract
- Reorganising Connectors sub-layers (Monitor / Notifier / AI) or Executor sub-layers
- Changing the Surface A ↔ Surface B boundary (currently: conversation never writes, Smart Fix is the only write path)

The diagram + layer responsibilities are canonical. Every other doc should be consistent with this one.
