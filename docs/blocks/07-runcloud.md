# Block 7 — RunCloud Module

## Purpose

Make Perch genuinely RunCloud-aware. Two layers:

1. **Filesystem awareness** — every script and rule uses RunCloud's
   conventions (nginx-rc, phpXXrc-fpm, mariadb, /etc/nginx-rc/conf.d/
   layout, /home/{user}/logs/nginx/, /home/{user}/webapps/{App}/)
2. **API integration** — talk to RunCloud's REST API to list servers,
   webapps, deploy, manage backups, switch PHP version per app

## Files (current + target)

- `scripts/import-runcloud-servers.ts` — CLI to seed brain.db from a
  RunCloud account ✅
- `scripts/access-top-ips.sh`, `access-summary.sh`, `wp-errors.sh` — all
  use RunCloud nginx-conf layout ✅
- `src/modules/runcloud/` — **target** for API tools (not yet built)

## Current state

### Filesystem awareness ✅
- `nginx-rc.service` (NOT nginx) — rule_nginx, fix-nginx
- `phpXXrc-fpm.service` (NOT php-fpm) — rule_php_fpm, fix-php-fpm
- `mariadb.service` — rule_database, fix-mysql
- `/etc/nginx-rc/conf.d/<Webapp>.d/main.conf` — has the real `access_log`
- `/etc/nginx-rc/conf.d/<Webapp>.domains.d/<domain>.conf` — usually
  `access_log off`, used to map domain → webapp
- `/home/<user>/logs/nginx/<Webapp>_access.log` — per-webapp access logs
- `/home/<user>/webapps/<App>/` — webapp roots (WordPress and others)

These are now **explicitly** referenced in scripts — no auto-detect that
falls through to wrong defaults.

### API integration — historical baseline preserved ✅, modern wiring ❌
- **`src/modules/runcloud-v1/index.ts`** — the original 135-tool MCP that
  existed pre-v2-rebrand (commit `825d3c3`). Saved byte-for-byte. Builds
  as a separate MCP server today. See `src/modules/runcloud-v1/README.md`
  for install instructions.
- `scripts/import-runcloud-servers.ts` — bootstrap importer (existing)
- ❌ Not yet ported into the v2 HANDLERS pattern in `src/api/server.ts` —
  that's the long-term goal so all tools live behind one HTTP API +
  Bearer auth.

### Tool catalog (135 from runcloud-v1, available today as separate MCP)
- 🖥️ Servers — 17 · 🌐 Web Applications — 12 · 🔧 PHP Installer — 3
- 🌿 Git — 6 · 🌍 Domains — 3 · 🔒 SSL — 10 · 🗄️ Databases — 12
- 👤 System Users — 6 · 🔑 SSH Keys — 4 · ⏰ Cron — 5 · 📋 Supervisor — 8
- 🛡️ Firewall — 9 · ⚙️ Services — 2 · 🔗 External APIs — 5
- 🔍 Cross-Server Search — 4 · 📈 Health & Perf — 7 · 🚀 Deployments — 2
- 🟦 WordPress (SSH) — 5 · 🖥️ SSH Direct — 4 · 🔧 Self-Healing — 7

## Gaps (toward vision)

- [ ] Build `src/modules/runcloud/api.ts` — typed RunCloud REST client
  (auth, pagination, error handling)
- [ ] Wire 8 MCP/HTTP API tools:
  - `runcloud.list_servers`
  - `runcloud.list_apps`
  - `runcloud.app_detail` (PHP version, domains, SSL, deploy info)
  - `runcloud.deploy` (trigger git deploy)
  - `runcloud.create_backup`
  - `runcloud.list_backups`
  - `runcloud.switch_php` (per-app, with confirm)
  - `runcloud.ssl_install` (Let's Encrypt toggle)
- [ ] Multi-RunCloud-account support (vault stores N tokens, brain.db has
  account_id column)
- [ ] Webhook receiver (`/api/runcloud/webhook`) for deploy events
  triggered outside Perch

## Next ship task

**Bridge the 135 v1 tools into the v2 HANDLERS pattern in
`src/api/server.ts`.** Two-step:

1. Add `src/modules/runcloud-v1/bridge.ts` — imports the v1 module's tool
   list + dispatcher, exposes a single `runcloud_v1_call(toolName, args)`
   function that returns the same JSON the v1 MCP would.
2. In `src/api/server.ts`, register a single dynamic handler:
   `Object.fromEntries(v1ToolNames.map(t => [\`runcloud.\${t}\`, async (a) => runcloud_v1_call(t, a)]))`

Result: every public Perch deployment exposes all 135 tools at
`POST /api/runcloud.<tool_name>` with Bearer auth — no separate MCP needed.

~2h. Single biggest leverage move for completing block 7.

## Boundaries

- RunCloud API token lives in Vault (block 2), never in plain `.env`
- Server/webapp data syncs into Brain (block 1) — RunCloud is not the
  source of truth at runtime, the local Brain is (synced periodically)
- Write operations (deploy, switch_php) MUST go through HTTP API confirm
  flow (block 3 next-ship-task)
