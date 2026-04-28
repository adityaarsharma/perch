# Perch — Smart Fix

The group-breaking automation inside Surface A. One button on every alert.
One callback shape. One registry. One router. One learning loop.

This doc is for someone who wants to understand Smart Fix end-to-end —
why it exists, what it is exactly, how it stays safe, and how to extend it.

Last revised: 2026-04-28 (Perch v2.5).
Sister docs: [`architecture.md`](./architecture.md) · [`connectors.md`](./connectors.md) · [`monitor.md`](./monitor.md) · [`brain.md`](./brain.md) · [`guardrails.md`](./guardrails.md)

---

## TL;DR (2 sentences)

Every Telegram alert ends with the same three buttons; the first is always **🔧 Smart Fix**. That single button is wired to one HTTP endpoint, which consults one registry that maps alert types to safe scripts — so adding a new alert type is one line, and the user never sees the names of internal scripts in any callback or button.

---

## Why this exists

A naïve alerting bot would attach different buttons per alert: a "Restart nginx" button on nginx alerts, a "Clear logs" button on disk alerts, a "Renew SSL" button on cert alerts. That works at five alerts and falls apart at fifty:

- Buttons leak internal script names into the public surface — renaming `clear-logs.sh` later breaks every pinned alert.
- Each new alert type means a new callback name, new dispatcher branch in every bot client, new docs.
- Different alerts get different button layouts → users have to learn which buttons exist for which alert.
- No single place knows which fixes are safe vs which need humans.

Smart Fix collapses all of that. **Same button, every alert. Same callback shape, every alert. One algorithm decides.** The user learns the surface in five seconds and never has to relearn it.

---

## The contract

### What the user sees

Every alert from `monitor.sh` looks like this:

```
🔴 aditya-personal-s — Disk getting full (86%)
95.216.156.89

Root filesystem at 86%. Top consumer: /var/log/nginx-rc/access.log (4.2 GB).

Server: aditya-personal-s · 22:35 IST

[🔧 Smart Fix]   [💤 Snooze 1h]   [✅ Ack]
```

That's it. Same three buttons, every time. **There is no other UI surface.**

### What the button carries

Each `🔧 Smart Fix` button has a `callback_data` of the exact shape:

```
perch:smart-fix:<alert_id>
```

Where `<alert_id>` is one of the canonical alert keys:

```
nginx_down · php_fpm_down · mysql_down · disk_warn · disk_high · disk_critical
ram_warn · ram_critical · cpu_warn · cpu_critical · orphans · failed_svc
ssl_expiring · ssl_critical · site_down · site_5xx · ports_down · backup_age
fail2ban_spike · backup_stale · ⟨any future alert⟩
```

### What the dispatcher does

Whatever bot is polling Telegram (Perch's own `bot.py` for standalone deploys, Niyati for Aditya's case) recognises the prefix and POSTs to Perch's fix-server:

```http
POST /smart-fix
Authorization: Bearer <FIX_SERVER_TOKEN>
Content-Type: application/json

{ "alert_id": "<alert_id>" }
```

### What the router does

`fix-server.py` runs the registry lookup:

```python
SMART_FIX_REGISTRY = {
    'nginx_down':      'fix-nginx.sh',
    'site_down':       'fix-nginx.sh',
    'php_fpm_down':    'fix-php-fpm.sh',
    'mysql_down':      'fix-mysql.sh',
    'mysql_oom':       'fix-mysql.sh',
    'service_down':    'fix-services.sh',
    'ports_down':      'fix-services.sh',
    'disk_warn':       'clear-logs.sh',
    'disk_high':       'clear-logs.sh',
    'disk_critical':   'clear-logs.sh',
    'ram_high':        'smart-fix.sh',
    'ram_critical':    'smart-fix.sh',
    'load_high':       'smart-fix.sh',
    'ssl_expiring':    'renew-ssl.sh',
    'ssl_critical':    'renew-ssl.sh',
    'orphans':         'smart-fix.sh',
    'site_5xx':        'smart-fix.sh',
    'fail2ban_spike':  None,    # no safe auto-fix
    'backup_age':      None,    # no safe auto-fix
    'disk_growth':     None,    # informational
}
```

Three outcomes from a lookup:

1. **Found, has a script** → run it, report stdout/stderr to the user.
2. **Found, value is `None`** → reply with a friendly *"no safe auto-fix exists for this alert; investigate via Claude Code MCP / `perch` CLI / direct HTTP API"*. Better silence than guessing.
3. **Not in the registry** → fall through to `smart-fix.sh` (the catch-all). `smart-fix.sh` itself is narrow — it only does proven-safe things (zombie reap, log trim) — so falling through never breaks anything.

### What the user sees back

The bot edits the original alert message:

```
✅ Smart Fix done

=== Clearing Large Logs ===
Disk before: 86%
Cleared 3 log file(s):
  ✓ 4.2G: /var/log/nginx-rc/access.log
  ✓ 280M: /var/log/syslog
  ✓ 95M: /var/log/auth.log

Disk: 86% → 41%
```

That's the whole loop. Twelve seconds typical, including the script run.

---

## End-to-end flow (worked example)

`monitor.sh` cron fires `rule_disk` at minute :05.

```
1. monitor.sh detects disk at 86% → calls send_alert "disk_high" "warning" \
     "Disk getting full (86%)" "$body" "$(BTN_3 disk_high)"

2. BTN_3 produces the inline keyboard:
     callback_data on the first button = "perch:smart-fix:disk_high"

3. send_alert posts to Telegram sendMessage with the keyboard attached.
   User sees the alert + 3 buttons in their chat.

4. User taps 🔧 Smart Fix.

5. Telegram delivers a callback_query update to the bot polling getUpdates
   (Perch bot.py for standalone deploys, niyati-bot for Aditya).

6. Bot recognises the "perch:smart-fix:" prefix:
     payload = "smart-fix:disk_high"
     alert_id = "disk_high"

7. Bot POSTs:
     POST http://127.0.0.1:3014/smart-fix
     Authorization: Bearer <FIX_SERVER_TOKEN>
     { "alert_id": "disk_high" }

8. fix-server.py SMART_FIX_REGISTRY['disk_high'] → 'clear-logs.sh'
   Spawns: bash /home/serverbrain/perch-src/telegram-bot/scripts/clear-logs.sh
   Captures stdout/stderr, returncode.

9. fix-server.py logs an audit row to BRAIN.actions_log:
     action_type = "smart_fix.disk_high"
     target = "localhost"
     args = {"alert_id": "disk_high", "mapped_script": "clear-logs.sh"}
     ok = (returncode == 0)
     output (truncated to 500 chars)

10. fix-server.py replies with JSON: {"output": "...", "ok": true}.

11. Bot edits the original Telegram message:
     "✅ Smart Fix done\n\n```\n<output>\n```"

12. Done. Total round-trip ~12s for this one.
```

---

## How to extend it

Adding a new alert with auto-fix is **one line in the registry plus one BTN_3 callsite**.

Say you add a new probe `rule_redis` that detects when Redis is down. You write the bash that calls `send_alert "redis_down" "critical" "Redis is down" "$body" "$(BTN_3 redis_down)"`. Then:

```python
# fix-server.py
SMART_FIX_REGISTRY = {
    ...
    'redis_down': 'fix-redis.sh',
}
```

Drop a `scripts/fix-redis.sh` next to the others. **That's it.** No bot changes. No callback name changes. No dispatcher changes. No new endpoint. No client (Niyati / standalone bot.py / future ChatGPT plugin) needs to know.

If the fix isn't safe to automate (e.g. "redis_oom" — needs human judgment), put `None`:

```python
'redis_oom': None,
```

The router will reply with the friendly refusal. User taps Smart Fix → "no safe auto-fix exists, investigate via Claude Code MCP". Never silent. Never wrong action.

---

## The learning loop

`src/scripts/smart-fix-learn.ts` runs nightly via cron at 03:00. It reads `BRAIN.actions_log` for the last 7 days and finds patterns:

- Same `(host, action_type)` pair
- Ran ≥3 times
- Every run succeeded (`ok = 1`)

For each pattern found, it inserts a row into `BRAIN.smart_fix_registry` with `promoted_by = 'auto-proposed'`. Sends one Telegram nudge summarising the new candidates.

Today the registry is hand-curated. Tomorrow it grows from observed reality — *"this fix has worked 3+ times for this host without issues; promote it"*. The user gets a one-time ack flow before any auto-promotion lands. After ack, future occurrences of that alert auto-fire.

```
Cron fires nightly                                              ┐
   │                                                            │
   ▼                                                            │
Scan BRAIN.actions_log (last 7 days)                            │
   │                                                            │
   ▼                                                            │
For each (host, action_type) where successes ≥ 3 AND total = successes:
   │                                                            │
   ▼                                                            │
Skip if already in BRAIN.smart_fix_registry                     │
   │                                                            │
   ▼                                                            │
Insert into BRAIN.smart_fix_registry as 'auto-proposed'         │
   │                                                            │
   ▼                                                            │
Send Telegram summary if any new candidates                     │
   │                                                            │
   ▼                                                            │
User reviews + edits BRAIN.smart_fix_registry if wanted         │
   │                                                            │
   ▼                                                            │
Next time the same alert fires: pattern is now registered → auto-fix
```

Pure pattern matching. Zero LLM cost. Deterministic and auditable.

---

## Hard rules (the things that don't change)

| Rule | Why |
|---|---|
| Smart Fix never runs an action outside `SMART_FIX_REGISTRY`. | The registry IS the safety boundary. Even hand-crafted callbacks can only invoke registry actions or fall to the narrow `smart-fix.sh` catch-all. |
| Catch-all = `smart-fix.sh`, NOT a default unsafe script. | `smart-fix.sh` only reaps actual zombies (state=Z) + known stuck-loop signatures (sudo cat / sendmail / postdrop). It never `kill -9`s arbitrary PID-1 children — that would crash a RunCloud box. |
| Alerts with no safe auto-fix have `None` in the registry. | Better an explicit "I won't guess" message than a silent no-op or wrong action. |
| Smart Fix is the **only** write path from any Surface A channel. | Telegram, Slack, Email — none of them can mutate anything except via Smart Fix. Conversational ops with full writes happen on Surface B (Claude Code MCP / ChatGPT / Gemini / CLI / HTTP API). |
| Every Smart Fix run logs to `BRAIN.actions_log`. | The learning loop needs this; `/perch undo` (future) needs this; auditing your own infra needs this. |
| One button label, always. The label says "🔧 Smart Fix" — never "Restart nginx" or "Clear logs". | Keeps the surface stable as the registry grows. Renaming an internal script never changes anything user-visible. |

---

## Code locations

| Piece | File |
|---|---|
| Registry + `POST /smart-fix` handler | [`telegram-bot/fix-server.py`](../telegram-bot/fix-server.py) |
| `BTN_3 <alert_id>` helper + `send_alert` callsites | [`telegram-bot/monitor.sh`](../telegram-bot/monitor.sh) |
| Standalone bot dispatcher (recognises `smart-fix:` prefix) | [`telegram-bot/bot.py`](../telegram-bot/bot.py) |
| The catch-all script (also called for `orphans`, `ram_*`, `site_5xx`) | [`telegram-bot/scripts/smart-fix.sh`](../telegram-bot/scripts/smart-fix.sh) |
| Per-alert action scripts | [`telegram-bot/scripts/`](../telegram-bot/scripts/) |
| Learning loop (nightly cron) | [`src/scripts/smart-fix-learn.ts`](../src/scripts/smart-fix-learn.ts) |
| Brain table for registry + audit | `BRAIN.smart_fix_registry`, `BRAIN.actions_log` (see [`brain.md`](./brain.md)) |

In Aditya's specific deploy where Niyati polls Telegram instead of Perch's `bot.py`, Niyati's `niyati.py` has a parallel dispatcher that recognises the same `smart-fix:` prefix and POSTs to the same `/smart-fix` endpoint at `http://127.0.0.1:3014`. Single source of truth: Perch.

---

## What this is NOT

- **Not a slash-command system.** There is no `/fix-nginx`, `/clear-logs`, `/restart-php` for users to type. Smart Fix is reactive — it appears on alerts, period. Want to invoke a fix without an alert? Use Surface B (Claude Code MCP, CLI, HTTP API) where you have full read+write access to all 55 tools.
- **Not an LLM agent.** Smart Fix today is deterministic — registry lookup, fixed mapping, fixed action. The router doesn't ask Gemini what to do. (The *learning loop* is also deterministic — pure pattern matching.) Future v2.6 may add LLM-judged action selection within the registry, but the registry stays the safety boundary.
- **Not a kitchen sink.** Smart Fix's job is "the action that's safe to do automatically when you tap a button on a phone". It is *not* the place to do plugin updates, search-replace, core upgrades, schema migrations, or any heavy ops. Those live on Surface B with `confirm: true` ack flows.
- **Not the alert composer.** The alert *text* is composed by `monitor.sh` rules today (templated bash). v2.6 may swap to LLM-composed alerts. Either way, Smart Fix is decoupled from how the alert text gets generated — it only cares about the `alert_id`.

---

## When to revise this doc

- Adding a new alert type that needs auto-fix → update the registry table in this doc.
- Changing the callback shape from `perch:smart-fix:<alert_id>` → update everywhere (the contract is the contract).
- Promoting a new pattern from the learning loop into the registry → registry stays the source of truth; this doc gets the table refresh.
- Adding a new Surface A channel (e.g. Discord) → no Smart Fix changes needed; the new channel just speaks the same callback shape.
- Adding a new bot client (e.g. someone forks Niyati for their own AI assistant) → they wire their dispatcher to recognise `perch:smart-fix:*` and POST to `/smart-fix`. No coordination with Perch needed.

The registry + the callback shape + the endpoint shape — those three things together are Smart Fix. Everything else can change.
