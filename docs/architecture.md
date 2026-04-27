# Perch — Architecture

Canonical reference. When in doubt, follow this doc.

Last revised: 2026-04-27 (Perch v2.3). Predecessor block-model doc preserved at [`architecture-blocks-legacy.md`](./architecture-blocks-legacy.md) for reference.

---

## TL;DR

Perch is a **5-layer system** with a per-host SQLite **brain** and modules organised in two dimensions: **Stack vs Platform** (where they operate) and **Performance / Security / Cleanup / Operations / Diagnostics / Plugin-specific** (what domain they cover).

Each domain gets its own LLM **specialist** in the Reasoning layer; the Orchestrator routes user intent to the right specialist.

---

## The 5 layers

```
╔═══════════════════════════════════════════════════════════════╗
║  CONNECTORS                                                   ║
║  Telegram · Slack · Claude Code MCP · CLI · HTTP API          ║
║  Inbound webhooks: RunCloud · Cloudflare · GitHub · custom    ║
╚════════════════════════════╤══════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════╗
║  REASONING                                                    ║
║  ┌─ ORCHESTRATOR (intent → specialist routing) ─────────┐     ║
║  │   PERFORMANCE · SECURITY · CLEANUP · OPERATIONS ·    │     ║
║  │   DIAGNOSTICS · PLUGIN-SPECIFIC ← sub-agents         │     ║
║  └──────────────────────────────────────────────────────┘     ║
║  + Recommend engine · Guardrails enforcer · Cost meter        ║
╚════════════════════════════╤══════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════╗
║  EXECUTOR                                                     ║
║  ┌── STACK modules (operate INSIDE the server) ─────────┐     ║
║  │ src/modules/stack/wordpress/{performance,security,   │     ║
║  │   cleanup,operations,diagnostics,plugins}/           │     ║
║  │ src/modules/stack/{nodejs,laravel,static}/  (future) │     ║
║  │ via SSH + CLI (wp-cli, find, openssl, …)             │     ║
║  └──────────────────────────────────────────────────────┘     ║
║  ┌── PLATFORM modules (operate ABOVE the server) ───────┐     ║
║  │ src/modules/platform/{runcloud,hetzner,cloudflare,   │     ║
║  │   github}/                                           │     ║
║  │ via REST APIs                                        │     ║
║  └──────────────────────────────────────────────────────┘     ║
║  Every module: read-only audit + (gated) mutating actions     ║
║  Always: log to BRAIN.actions; check BRAIN.guardrails first   ║
╚═══════════╤════════════════════════════════════╤══════════════╝
            ↓                                    ↑
╔═══════════════════════════════╗  ╔═══════════════════════════════╗
║ NOTIFIER  (passive, push)     ║  ║ BRAIN  (~/.perch/brain.db)    ║
║ Cron probes · Health monitors ║◄─║ Logical ROOMS:                ║
║ Alert dispatcher · Dedup      ║  ║   secrets · guardrails ·      ║
║ Out: Telegram · Slack ·       ║  ║   problems · actions ·        ║
║      Email · Webhook          ║──►║   knowledge · webapps ·       ║
║ Never mutates. Only watches.  ║  ║   incidents · timeseries ·    ║
╚═══════════════════════════════╝  ║   audit_log                   ║
                                   ╚═══════════════════════════════╝
```

---

## Layer responsibilities

| Layer | Owns | Doesn't own |
|---|---|---|
| **Connectors** | Inbound auth, payload shape, channel-specific UX | What to do with the request |
| **Reasoning** | Intent → plan, ranking, guardrail enforcement, LLM calls | Direct shell/SSH; brain writes |
| **Executor** | Modules + their audit/mutate functions, SSH/API execution | Deciding when to run; alerting |
| **Notifier** | Cron probes, alert routing, dedup. **Read-only**, **push-only** | Mutations; planning; user input |
| **Brain** | All persistent state in named "rooms". Encrypted secrets | Logic. Just storage + query API |

Hard boundary: **Notifier never mutates. Executor never alerts directly.**

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

## End-to-end request flow (worked example)

User in Telegram: *"clean up images on startupcooking.net"*

1. **Connector** (Telegram) parses, posts to `POST /api/recommend-or-do`.
2. **Reasoning → Orchestrator** classifies intent → routes to **Performance specialist**.
3. **Specialist** queries `BRAIN.webapps` for "startupcooking.net" → resolves host, user, wp-path.
4. **Specialist** queries `BRAIN.knowledge` for prior performance work on this host (e.g. "pngquant @75-90 saved 49.4% last time").
5. **Specialist** plans: "skip baseline audit (recent), jump to `wp.images_compress_bulk_start`."
6. **Reasoning → Guardrails** enforces: tool is mutating + host is `prod` → emit "This will modify ~50K files on prod. Reply CONFIRM."
7. User replies CONFIRM.
8. **Executor** invokes `startBulkCompression`, opens SSH, launches tmux job, returns `jobId`.
9. **Executor** writes to `BRAIN.actions`.
10. **Reasoning** answers: "Job started. I'll ping you when done."
11. **Notifier** sees new action → schedules a status probe.
12. 3h later — Notifier dispatches "24.6 GB freed" to Telegram, writes outcome to `BRAIN.actions`.
13. **Brain LLM hooks** extract facts into `knowledge` ("startupcooking.net's PNG savings ratio: 49.4%, run-3").
14. Next time same user says "clean again" — Specialist sees prior knowledge, jumps straight to action.

User never sees layers. Sees a competent ops assistant getting smarter.

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

## What's MATURE today

- 5-layer separation
- Module pattern (audit + gated mutating, log to brain)
- SSH + Vault + Brain core foundations
- HTTP API with Bearer + rate limit + allowlist
- 22 WordPress capabilities organised into 6 sub-sub-module domains
- RunCloud API wrapper
- LLM-judged static-vs-dynamic intent (in bot.py)
- Monitor cron with Telegram + Slack mirroring

## What's MISSING (v2.3 → v2.5)

- ❌ Inbound webhooks (RunCloud/Cloudflare/GitHub events into Perch)
- ❌ Approval workflow (2nd-human ack via Telegram for high-stakes)
- ❌ Cost meter (LLM API call tracking per session/host)
- ❌ Brain backup/restore (export/import of `brain.db`)
- ❌ Audit log room (immutable trail)
- ❌ Guardrails-as-data (today scattered in code)
- ❌ Cross-host fleet view
- ❌ Specialist LLM personas (scaffolds in this PR; full implementation v2.4)

---

## Files for new contributors / agents (read in order)

1. [`architecture.md`](./architecture.md) — this file
2. [`specialists.md`](./specialists.md) — sub-agent design
3. [`brain.md`](./brain.md) — room schemas
4. [`guardrails.md`](./guardrails.md) — rule syntax
5. [`blocks/wordpress-images.md`](./blocks/wordpress-images.md) — case study of a complete module pair
6. `src/core/` — read first: `ssh-enhanced.ts`, `brain.ts`, `vault.ts`
7. `src/api/server.ts` — every endpoint
8. `src/modules/stack/wordpress/<domain>/<feature>.ts` — copy this pattern when adding modules

---

## When to revise this document

- Adding a layer (rare; 5 should stay stable)
- Adding a brain room
- Changing the guardrails contract
- Reorganising connectors or executor sublayers

The diagram + layer responsibilities are canonical. Every other doc should be consistent with this one.
