# Perch Webapp Modules — Spec

Status: design draft (no TS yet)
Audience: implementer of the next four Perch modules — Laravel, Node.js/PM2, n8n, Docker
Calibrated against: `src/modules/wordpress/{db,plugins,security,perf,errors}.ts`

This document is the single source of truth for the four new webapp modules. Every disk path, system user, log location, and command was either verified in RunCloud's official docs (cited at the bottom) or marked as **assumed** and gated behind a runtime detection step.

---

## 0. Shared RunCloud Conventions

These apply to **every** webapp on a RunCloud-managed server. The new modules must reuse them rather than re-derive them.

| Concern | Truth |
|---|---|
| Webapp root | `/home/{system_user}/webapps/{app_name}/` |
| System user | One Linux user per webapp (configured as the "Web Application Owner" in the RunCloud panel). NOT `www-data`. Default examples: `runcloud`, but real installs typically have `myapp`, `clientx`, etc. Always resolve at runtime via the RunCloud API or by `stat -c '%U' /home/.../webapps/{app}`. |
| Webapp logs (web-server) | `/home/{system_user}/logs/` — contains nginx access/error logs and PHP-FPM access/slow/error logs for that specific app. RunCloud names them like `nginx_{app}.access.log`, `nginx_{app}.error.log`, `fpm_{app}.error.log`, `fpm_{app}.slow.log`. |
| Nginx (`nginx-rc` — NOT vanilla nginx) | Service name: `nginx-rc`. Binary: `/RunCloud/Packages/nginx-rc/sbin/nginx-rc`. Main config: `/etc/nginx-rc/nginx.conf`. Per-app config: `/etc/nginx-rc/conf.d/{app}.conf` and `/etc/nginx-rc/conf.d/{app}.d/main.conf`. **Custom user-supplied configs go in `/etc/nginx-rc/extra.d/*.conf` only.** Reload: `systemctl reload nginx-rc`. Validate: `nginx-rc -t`. |
| PHP-FPM pool | `/etc/php{ver}rc/fpm.d/{app}.conf` (e.g. `/etc/php82rc/fpm.d/myapp.conf`). Extra pool snippets: `/etc/php-extra/{app}.conf`. Service: `php{ver}rc-fpm.service`. PHP CLI binary: `/RunCloud/Packages/php{ver}rc/bin/php`. |
| Supervisor jobs | Created via RunCloud panel/API (`POST /servers/{id}/supervisor`). Fields: `label`, `command`, `username`, `numprocs`, `autoStart`, `autoRestart`, `binary`, `directory`. RunCloud writes the underlying supervisord conf — Perch should treat the API as the source of truth, not the on-disk file. Status check: `supervisorctl status` (run as root or `sudo`). |
| Cron | RunCloud-managed cron entries live in the system user's crontab (`crontab -l -u {system_user}`) plus optionally `/etc/cron.d/`. |
| Service-level metrics | Per-app CPU/RAM via `ps -u {system_user}` is reliable because of one-user-per-app isolation. |

**Module rule of thumb:** when a check could be done at the RunCloud API level OR at SSH level, prefer SSH for read-only audits (faster, no rate limit, works offline from panel) and prefer the API for any state-changing action (so the panel stays consistent).

---

## 1. Laravel Module

### 1.1 Disk layout & process model

| Concern | Path / Detail |
|---|---|
| App root | `/home/{user}/webapps/{app}/` |
| Public webroot | `/home/{user}/webapps/{app}/public/` (Laravel default; RunCloud installer sets webroot to `/public`) |
| `.env` | `/home/{user}/webapps/{app}/.env` — owner `{user}:{user}`, MUST be `600` or `640`, never world-readable |
| Storage | `/home/{user}/webapps/{app}/storage/` — must be writable by `{user}` |
| Bootstrap cache | `/home/{user}/webapps/{app}/bootstrap/cache/` — same |
| PHP CLI | `/RunCloud/Packages/php{ver}rc/bin/php` (use the version pinned for the app, not just `php`) |
| PHP-FPM pool | `/etc/php{ver}rc/fpm.d/{app}.conf` runs as `{user}` |
| Nginx config | `/etc/nginx-rc/conf.d/{app}.conf` — points public root at `…/public` |
| Queue worker | RunCloud Supervisor job (one per queue connection). Command pattern: `/RunCloud/Packages/php{ver}rc/bin/php /home/{user}/webapps/{app}/artisan queue:work --sleep=3 --tries=3 --max-time=3600` running as `{user}`. |
| Schedule runner | Cron: `* * * * * cd /home/{user}/webapps/{app} && {php_bin} artisan schedule:run >> /dev/null 2>&1` in `{user}`'s crontab |
| Laravel logs | `/home/{user}/webapps/{app}/storage/logs/laravel.log` (and daily-rotated `laravel-YYYY-MM-DD.log`) |
| Web-server logs | `/home/{user}/logs/nginx_{app}.error.log`, `fpm_{app}.error.log`, `fpm_{app}.slow.log` |
| Opcache | Configured in `/etc/php{ver}rc/conf.d/10-opcache.ini`; per-app overrides in `/etc/php-extra/{app}.conf`. Inspect via `{php_bin} -r 'print_r(opcache_get_status(false));'` |

### 1.2 Gotchas

1. **`.env` permissions** are the #1 cause of 500s after a deploy when someone `scp`s as the wrong user. Always check owner and mode.
2. **`storage/` and `bootstrap/cache/` permissions** — Laravel will white-screen if these are not writable by `{user}`. Especially after `git pull` from a different user.
3. **`composer install`** must run as `{user}`, not root. If it ran as root, `vendor/` permissions break PHP-FPM. Detect via `stat vendor/autoload.php`.
4. **`APP_DEBUG=true` in production** leaks stack traces with DB credentials. Always check.
5. **Telescope / Debugbar in production** — both ship with `composer require --dev` patterns but get accidentally promoted. Detect installed-and-enabled.
6. **Schedule cron** silently dies if the PHP CLI version was bumped and the cron line still references the old binary.
7. **Supervisor queue workers** need a restart after every deploy (`php artisan queue:restart`) — workers cache code in memory. Long uptime + recent deploy = stale code running.
8. **`config:cache` corruption** — if a deploy ran `config:cache` and a closure crept into a config file, the bootstrap cache will throw at every request until cleared.

### 1.3 `auditLaravel()` — 7 health checks

Returns score 0–100, grade A–F, structured findings. All read-only.

| # | Check | Severity | Method |
|---|---|---|---|
| 1 | `.env` exists, mode ≤640, owned by `{user}` | critical | `stat -c '%a %U %G' .env` |
| 2 | `APP_DEBUG=false` and `APP_ENV=production` | critical | `grep -E '^APP_(DEBUG\|ENV)=' .env` |
| 3 | `storage/` and `bootstrap/cache/` writable by `{user}` | critical | `sudo -u {user} test -w storage && test -w bootstrap/cache; echo $?` |
| 4 | Composer dependencies installed and lockfile in sync | warning | `{php_bin} {app}/artisan --version` (fails if `vendor/` missing); `composer validate --no-check-publish --working-dir=…` |
| 5 | Migration state clean (no pending) | warning | `{php_bin} artisan migrate:status` — count rows where `Ran?` = `No` |
| 6 | Queue workers healthy via supervisor | critical (if any defined) | `sudo supervisorctl status \| grep {app}` — flag any not in `RUNNING` for >60s |
| 7 | Schedule cron present and current PHP version | warning | `crontab -u {user} -l \| grep -E 'artisan schedule:run'` and verify the binary path matches an existing file |
| 8 (bonus) | Opcache enabled, hit_rate ≥95%, no recent reset | info | `{php_bin} -r '$s=opcache_get_status(false); echo json_encode($s["opcache_statistics"]);'` |
| 9 (bonus) | `laravel.log` size <100MB and rotated | info | `stat -c '%s' storage/logs/laravel.log`; check for date-suffixed siblings (daily channel) |
| 10 (bonus) | No `telescope` / `debugbar` enabled in prod | warning | `grep -E 'TELESCOPE_ENABLED\|DEBUGBAR_ENABLED' .env` and check `config/app.php` providers |

Pick **7** for the v1 scoring set: 1, 2, 3, 4, 5, 6, 7. Treat 8/9/10 as info-only add-ons surfaced in the report but not weighted.

**Scoring:** start 100. Critical fail = −20. Warning fail = −10. Info fail = −2.

### 1.4 `diagnoseLaravel()` — root-cause patterns

Triggered when `auditLaravel()` says critical OR HTTP probe shows 500/blank. Reads `storage/logs/laravel.log` (last 300 lines) AND `fpm_{app}.error.log` AND nginx error log, runs pattern match:

| Pattern in logs | Root cause | Fixable by Perch? |
|---|---|---|
| `Class "App\…" not found` after deploy | Missing `composer install` or stale autoload | Yes — run `composer dump-autoload` |
| `file_put_contents(/…/storage/logs/laravel.log): Failed to open` | storage perms | Yes — `chown -R {user}:{user} storage bootstrap/cache && chmod -R 775` |
| `The stream or file "…/laravel.log" could not be opened` | same as above | Yes |
| `No application encryption key has been specified` | `.env` missing `APP_KEY` | Half — can run `artisan key:generate` but only if `.env` exists |
| `SQLSTATE[HY000] [2002]` | DB unreachable | No (server-level) — alert only |
| `Symfony\…\AccessDeniedHttpException` immediately on every request | bad middleware/policy after deploy | No — alert |
| `Whoops` in production response body | `APP_DEBUG=true` | Yes — flip via `.env` edit + `artisan config:clear` |
| `cached the configuration` + closure error | corrupt config cache | Yes — `artisan config:clear && artisan cache:clear` |
| Queue worker `restarted_too_many` (supervisor `FATAL`) | bad job code or missing dep | No — alert with last 50 lines of worker stderr |
| Nothing in laravel.log but 500s | PHP fatal before framework boot — check FPM error log | escalate to FPM log analysis (reuse pattern from `wordpress/errors.ts`) |

### 1.5 `healLaravel()` — auto-fix whitelist

Only these are safe enough to run unattended (with `dryRun` flag and Telegram confirmation per `safety.md`):

1. `chown -R {user}:{user} storage bootstrap/cache` + `chmod -R 775` on those two dirs only.
2. `sudo -u {user} {php_bin} artisan config:clear && artisan cache:clear && artisan view:clear && artisan route:clear`.
3. `sudo -u {user} {php_bin} artisan queue:restart` (graceful — workers pick up new code on next job).
4. `sudo -u {user} composer dump-autoload --optimize` (only if `vendor/` exists).
5. Truncate `laravel.log` if >500MB (back up to `laravel.log.{date}.bak` first, capped).
6. Restart a specific supervisor queue worker via RunCloud API: `PATCH /servers/{id}/supervisor/{job_id}/restart`.

**Never auto:** `composer install`, `artisan migrate`, `artisan key:generate`, anything that touches `.env`, anything as root.

### 1.6 Telegram alert templates

Friendly tone, action buttons via inline keyboard (per existing `telegram.md`).

```
[CRITICAL] {app} is throwing 500s
Likely cause: storage/ folder is not writable by {user}.
Last error (1m ago):
  file_put_contents(…/laravel.log): Permission denied

I can fix this by re-applying ownership to storage and bootstrap/cache.
[ Fix it ] [ Show full log ] [ Snooze 1h ]
```

```
[WARNING] {app} queue worker keeps crashing
Worker `{app}-default-worker` has restarted 14 times in the last hour.
Last stderr line:
  Symfony\Component\…\TransportException: Connection refused

This usually means Redis/SQS is down — not a Laravel bug.
[ Show stderr (50 lines) ] [ Stop worker ] [ Snooze ]
```

```
[INFO] {app} schedule:run hasn't fired in 6 hours
Cron entry exists but the binary path /RunCloud/Packages/php80rc/bin/php
no longer exists (PHP was upgraded to 8.2).

[ Repoint cron to php82rc ] [ Show crontab ] [ Ignore ]
```

```
[CRITICAL] {app} has APP_DEBUG=true in production
This leaks stack traces with database credentials to every visitor on errors.

[ Set APP_DEBUG=false + clear cache ] [ Show .env (masked) ] [ Acknowledge risk ]
```

---

## 2. Node.js / PM2 Module

### 2.1 Disk layout & process model

| Concern | Path / Detail |
|---|---|
| App root | `/home/{user}/webapps/{app}/` (RunCloud "Custom Web Application", typically Native NGINX + Custom config) |
| Entry file | Convention: `server.js`, `app.js`, `index.js`, or `dist/index.js` — not enforced. Discover via `ecosystem.config.js` first. |
| `ecosystem.config.js` | `/home/{user}/webapps/{app}/ecosystem.config.js` (PM2 convention) |
| Listening port | App-chosen, typically 3000–3999. Discovered via `ss -tlnp` filtered to `{user}`. |
| Reverse proxy | `/etc/nginx-rc/conf.d/{app}.d/main.conf` — `proxy_pass http://127.0.0.1:{port}` (RunCloud sets this when stack = Native NGINX + Custom Config) |
| PM2 home | `/home/{user}/.pm2/` (per-user PM2 — there is one PM2 daemon per system user) |
| PM2 logs | `/home/{user}/.pm2/logs/{app_name}-out.log` and `{app_name}-error.log` |
| PM2 dump | `/home/{user}/.pm2/dump.pm2` (resurrect file) |
| Startup | `pm2 startup systemd -u {user} --hp /home/{user}` produces a systemd unit `pm2-{user}.service`. RunCloud does NOT auto-create this — it's manual. |
| Node binary | `/usr/bin/node` (system) OR per-user via `nvm` at `/home/{user}/.nvm/versions/node/v{ver}/bin/node`. Always resolve via `which node` AS `{user}` — the system node may differ from the one PM2 launched. |

### 2.2 Gotchas

1. **PM2 is per-user.** Running `pm2 list` as root shows root's empty list, not `{user}`'s apps. Always `sudo -u {user} pm2 ...` or `sudo -iu {user} pm2 list`.
2. **`pm2 startup` is not run by default on RunCloud.** Many installs lose all apps on reboot. Detect via `systemctl status pm2-{user}`.
3. **Node version mismatch via nvm**: cron, supervisor and PM2 might each see a different `node` because nvm is shell-scoped. PM2 captures the node path at the time `pm2 start` was run — if the user later `nvm install`s a new version, PM2 keeps using the old binary until restart.
4. **Port collision**: two apps both wanting 3000 — second one silently exits with `EADDRINUSE` and PM2 keeps restarting it.
5. **Memory leaks**: PM2 `max_memory_restart` is the safety net. Without it, a leaky app eats the box.
6. **Unhandled promise rejections** kill the process in modern Node — and PM2 keeps restarting. The error is in `{app}-error.log`, not visible in `pm2 logs` after the buffer rolls.
7. **`ecosystem.config.js` drift**: file says one thing, `pm2 list` shows another (e.g. someone ran `pm2 start app.js --name foo` and never updated the file). On reboot via dump, the live state wins.
8. **NODE_ENV**: missing or set to `development` is the silent perf killer (no Express/React caching). Always check.
9. **Logrotate**: PM2 doesn't rotate by default — `.log` files grow until disk fills. Solution is `pm2 install pm2-logrotate`.

### 2.3 `auditNode()` — 7 health checks

| # | Check | Severity | Method |
|---|---|---|---|
| 1 | PM2 daemon online for `{user}` | critical | `sudo -iu {user} pm2 ping` (returns `pong`) |
| 2 | All apps in `online` state, none `errored`/`stopped` | critical | `sudo -iu {user} pm2 jlist` → parse JSON, check `pm2_env.status` |
| 3 | No app with `restart_time` > 10 in last hour | warning | Same JSON; compare `pm2_env.restart_time` against value cached from previous Perch run |
| 4 | `pm2-{user}.service` enabled (survives reboot) | warning | `systemctl is-enabled pm2-{user}` |
| 5 | Each app's listening port matches nginx upstream | critical | `ss -tlnp \| grep {user}` ∩ grep `proxy_pass` in `/etc/nginx-rc/conf.d/{app}.d/*.conf` |
| 6 | No memory leak trend (RSS not monotonically increasing over 30min) | warning | Sample `pm2 jlist` `monit.memory` 3x at 10-min intervals; flag if last > first × 1.5 AND > 500MB |
| 7 | `NODE_ENV=production` in `pm2_env` | warning | `pm2 jlist` → check each app's `pm2_env.NODE_ENV` |
| 8 (bonus) | `ecosystem.config.js` matches live `pm2 list` (no drift) | info | Diff `apps[].name` from file vs `pm2 jlist` names |
| 9 (bonus) | `pm2-logrotate` installed | info | `pm2 jlist` for module entry, or check `~/.pm2/modules/` |
| 10 (bonus) | Log files <500MB each | info | `du -sh ~/.pm2/logs/*.log` |

Pick 7 for v1: 1, 2, 3, 4, 5, 6, 7.

### 2.4 `diagnoseNode()` — root-cause patterns

Reads PM2 error logs (last 300 lines) and `pm2 describe {id}`. Patterns:

| Pattern in `*-error.log` | Root cause | Fixable? |
|---|---|---|
| `Error: listen EADDRINUSE: address already in use :::{port}` | port collision (another process or a stale instance) | Half — `pm2 delete {app} && pm2 start ecosystem.config.js` only if config is healthy |
| `UnhandledPromiseRejectionWarning` followed by `Process exited with code 1` | unhandled async error in app code | No — alert with stack |
| `JavaScript heap out of memory` / `FATAL ERROR: Reached heap limit` | OOM — app exceeded Node's heap | Half — bump `--max-old-space-size` in ecosystem if config-driven |
| `Cannot find module '{x}'` | missing `npm install` after deploy | Yes — `cd {app} && sudo -u {user} npm ci` |
| `Error: ENOSPC: no space left on device` | disk full | No — server-level alert |
| Repeated `ECONNREFUSED 127.0.0.1:{db_port}` | DB/Redis backend down | No — alert |
| `restarted_too_many` (PM2 status FATAL after 15 restarts) | crash loop, exponential backoff exhausted | Half — `pm2 reset {app} && pm2 restart {app}` once, then escalate |
| Empty error log but app is `errored` | likely killed by OOM-killer | Check `dmesg \| grep -i 'out of memory'` and `journalctl --since '1h ago' \| grep oom_reaper` |

Also surface: `pm2 prettylist` env mismatch (NODE_ENV ≠ production), Node version (`process.versions.node` from `pm2 describe`), uptime (frequent <60s = crash loop).

### 2.5 `healNode()` — auto-fix whitelist

1. `pm2 reload {app}` — zero-downtime restart in cluster mode.
2. `pm2 restart {app}` — for fork mode.
3. `pm2 reset {app}` — clear restart counter (after a real fix).
4. `pm2 flush {app}` — empty its log files.
5. `npm ci` (only if `package-lock.json` exists and `node_modules/` is missing or out of sync) — run as `{user}` in app dir.
6. Install `pm2-logrotate` and set `max_size 50M`, `retain 7`.
7. Run `pm2 startup systemd -u {user} --hp /home/{user}` and `pm2 save` to persist.

**Never auto:** edit `ecosystem.config.js`, change ports, run `npm install` (use `npm ci`), kill processes by PID.

### 2.6 Telegram alert templates

```
[CRITICAL] {app} keeps crashing — port already in use
PM2 has restarted {app} 23 times in the last 5 minutes.
Error: listen EADDRINUSE: address already in use :::3000

Another process on this server is holding port 3000. Probably a stale
instance from a previous deploy.

[ Find & kill stale process ] [ Show ss -tlnp ] [ Snooze 30m ]
```

```
[WARNING] {app} memory growing — possible leak
RSS over 30 minutes:
  10:00 → 180 MB
  10:15 → 290 MB
  10:30 → 470 MB

[ Restart {app} (graceful) ] [ Show heap dump steps ] [ Set max_memory_restart ]
```

```
[CRITICAL] PM2 won't survive reboot for {user}
pm2-{user}.service is not enabled. If this server reboots tonight,
{count} apps will not auto-start.

[ Enable pm2-{user}.service ] [ Show what would run ] [ Acknowledge ]
```

```
[WARNING] {app} is running with NODE_ENV=development
This disables Express/React production optimizations and can leak debug info.

[ Restart with NODE_ENV=production ] [ Show ecosystem.config.js ] [ Ignore ]
```

---

## 3. n8n Module

n8n on RunCloud is most commonly **Docker-deployed** behind a Native NGINX + Custom Config reverse proxy (per RunCloud's official blog), but PM2-based installs also exist. The module must detect which mode is in use and branch.

### 3.1 Disk layout & process model

| Concern | Docker mode | PM2 mode |
|---|---|---|
| App root | `/home/{user}/webapps/{app}/` | `/home/{user}/webapps/{app}/` |
| Data dir | `/home/{user}/webapps/{app}/n8n_data/` (mounted into container at `/home/node/.n8n`) | `/home/{user}/.n8n/` |
| `docker-compose.yml` | `/home/{user}/webapps/{app}/docker-compose.yml` | n/a |
| Container port | host `5678` → container `5678` | n8n binds `127.0.0.1:5678` |
| Env file | `/home/{user}/webapps/{app}/.env` (mounted) — contains `N8N_ENCRYPTION_KEY`, `N8N_HOST`, DB creds | `~/.n8n/config` (JSON) — `encryptionKey` lives here |
| Credentials store | inside `n8n_data/database.sqlite` OR Postgres if configured | same — `~/.n8n/database.sqlite` |
| Reverse proxy | `/etc/nginx-rc/extra.d/{app}-n8n.conf` OR per-app config — `proxy_pass http://127.0.0.1:5678` with WebSocket upgrade headers | same |
| Logs | `docker logs {container}` (driver-dependent on disk location) | PM2 logs at `~/.pm2/logs/n8n-*.log` |
| Process | `docker compose ps` in app dir | `pm2 jlist` |
| n8n CLI | `docker compose exec n8n n8n …` | `sudo -iu {user} n8n …` |

### 3.2 Gotchas

1. **Encryption key rotation = data loss.** If `N8N_ENCRYPTION_KEY` changes, every credential in the DB becomes unreadable. Perch must NEVER touch this. Audit must verify the key is set AND backed up somewhere.
2. **`n8n_data/` permissions** — the container runs as UID 1000 by default. If `{user}` UID ≠ 1000, the container can't write. RunCloud system users often have UID 1001+.
3. **WebSocket failures** without `proxy_set_header Upgrade $http_upgrade` and `Connection "upgrade"` in the nginx config — the editor UI loads but executions hang.
4. **Webhook URL mismatch**: `N8N_HOST`, `N8N_PROTOCOL`, `WEBHOOK_URL` env vars must match the public domain or webhook URLs registered with external services (Stripe, GitHub) silently break on every fire.
5. **Postgres backend not configured**: SQLite locks under load (>10 concurrent executions) — symptom is `SQLITE_BUSY` in logs.
6. **Queue mode (Bull)** requires Redis env vars — easy to half-configure (Redis exists, but `EXECUTIONS_MODE=queue` not set, so it doesn't actually queue).
7. **Upgrade pitfall**: `n8nio/n8n:latest` tag changes daily. Pinning to a version is safer; pulling without backing up `n8n_data/` first has burned many users.
8. **Container restart loop on volume permission errors** is silent — `docker compose ps` shows `restarting` not `unhealthy`.

### 3.3 `auditN8n()` — 7 health checks

| # | Check | Severity | Method |
|---|---|---|---|
| 1 | n8n process is running and healthy | critical | Docker: `docker compose -f {app}/docker-compose.yml ps --format json` (state = `running`, health ≠ `unhealthy`) · PM2: `pm2 describe n8n` |
| 2 | n8n responds on `127.0.0.1:5678/healthz` | critical | `curl -fsS http://127.0.0.1:5678/healthz` (returns `{"status":"ok"}`) |
| 3 | `N8N_ENCRYPTION_KEY` is set and ≥32 chars | critical | Docker: read from `.env` on host; PM2: read from `~/.n8n/config` |
| 4 | Recent execution failure rate <10% (last 24h) | warning | n8n CLI: `n8n executions:list --output=json --limit=200` → count `status=error` / total |
| 5 | Webhook reachability matches `N8N_HOST` | warning | HTTP HEAD `https://{N8N_HOST}/healthz` from outside-perch — must return 200 |
| 6 | `n8n_data/` (or `~/.n8n/`) writable by container/PM2 user | critical | `sudo -u {user} test -w {data_dir}` and check `database.sqlite` is not `-r--` |
| 7 | If Postgres backend: connection healthy + recent successful write | warning | `n8n executions:list --limit=1` is a valid implicit check; if env says Postgres but execs fail with `connection refused`, flag |
| 8 (bonus) | Image pinned (not `:latest`) | info | grep `image:` in `docker-compose.yml` |
| 9 (bonus) | `credentials.json` (if exported) has perms ≤600 | warning | `find {data_dir} -name 'credentials*' -perm /044` |
| 10 (bonus) | Queue size if in queue mode (Redis) | info | If `EXECUTIONS_MODE=queue`, `redis-cli LLEN bull:jobs:wait` |

Pick 7 for v1: 1, 2, 3, 4, 5, 6, 7.

### 3.4 `diagnoseN8n()` — root-cause patterns

| Pattern | Root cause | Fixable? |
|---|---|---|
| Container in `restarting` loop, last log shows `EACCES: permission denied, open '/home/node/.n8n/config'` | volume UID mismatch | Half — `chown -R 1000:1000 n8n_data/` (only with explicit user OK) |
| `error: column "…" does not exist` in logs after upgrade | DB migration didn't run | Half — `docker compose run --rm n8n n8n db:migrate` |
| `Error: Mismatching encryption keys` | someone rotated the key without re-encrypting | NO — alert and stop; this is data-loss territory |
| `WebSocket connection failed` in browser console, but n8n is up | nginx missing Upgrade headers | Yes — patch `/etc/nginx-rc/extra.d/{app}-n8n.conf` (only after diff preview) |
| Webhook fires but n8n receives no request | `N8N_HOST` / `WEBHOOK_URL` mismatch with reverse proxy | Half — suggest exact env values, don't auto-edit |
| `SQLITE_BUSY: database is locked` repeatedly | needs Postgres backend | No — recommendation only |
| Container OOMKilled (`docker inspect` `State.OOMKilled = true`) | needs memory limit raise | No — alert |
| `429 Too Many Requests` from external API in execution logs | not n8n's fault — workflow design | No |

### 3.5 `healN8n()` — auto-fix whitelist

1. `docker compose -f {compose} restart n8n` (only after confirmation; never on credential errors).
2. `docker compose -f {compose} pull && docker compose up -d` — ONLY if image is pinned to a version (refuse on `:latest` without explicit override).
3. Patch nginx WebSocket headers in `/etc/nginx-rc/extra.d/{app}-n8n.conf` — diff-then-confirm flow.
4. `chown -R 1000:1000 {data_dir}` if and only if container logs show `EACCES` and current owner is wrong.
5. Run pending DB migration: `docker compose run --rm n8n n8n db:migrate` (only after a SQLite/Postgres backup is verified <24h old).
6. Truncate Docker container log if >1GB: `truncate -s 0 $(docker inspect --format='{{.LogPath}}' {container})` — needs root.

**Never auto:** edit `.env`, change `N8N_ENCRYPTION_KEY`, delete `n8n_data/`, force-pull `:latest`, run anything that writes to `database.sqlite` directly.

### 3.6 Telegram alert templates

```
[CRITICAL] n8n is down — restart loop
Container has restarted 8 times in the last 10 minutes.
Last 3 log lines:
  EACCES: permission denied, open '/home/node/.n8n/config'

The data folder isn't writable by the n8n container user.
This is fixable, but I want you to confirm — your data won't be touched.

[ Show fix plan ] [ Open n8n_data permissions ] [ Snooze ]
```

```
[CRITICAL] n8n encryption key issue
Logs show: "Mismatching encryption keys"

This means the N8N_ENCRYPTION_KEY in .env doesn't match the one
that encrypted your stored credentials. I will NOT auto-fix this —
the wrong move here makes every credential unrecoverable.

[ Show recovery checklist ] [ Acknowledge ]
```

```
[WARNING] {workflow_count} workflows failed in the last 24h ({pct}%)
Top failing workflows:
  1. "Stripe → Slack" — 14 fails (HTTP 401)
  2. "Daily Report"  — 6 fails (timeout)

Failure rate is {pct}% (threshold 10%).

[ Show executions ] [ Pause failing workflows ] [ Snooze ]
```

```
[WARNING] n8n webhooks may be silently broken
N8N_HOST is set to "n8n.example.com" but the public URL responds on
"automation.example.com". External services calling the old URL get 404.

[ Show env values ] [ Suggest correct N8N_HOST ] [ Ignore ]
```

---

## 4. Docker Module

This is the generic "any Docker webapp" module — n8n is a special case of it. Used when a RunCloud webapp's stack is Native NGINX + Custom Config and the upstream is one or more containers.

### 4.1 Disk layout & process model

| Concern | Path / Detail |
|---|---|
| Webapp dir | `/home/{user}/webapps/{app}/` (often holds `docker-compose.yml`) |
| Compose file | `/home/{user}/webapps/{app}/docker-compose.yml` (and optional `.override.yml`) |
| Env file | `/home/{user}/webapps/{app}/.env` |
| Bind mounts | typically subfolders of the webapp dir |
| Docker daemon | `/var/run/docker.sock` — by default only `root` and `docker` group can talk to it. RunCloud's system user is typically NOT in `docker` group unless explicitly added. |
| Container logs | JSON-file driver default: `/var/lib/docker/containers/{cid}/{cid}-json.log`. Discoverable via `docker inspect --format='{{.LogPath}}'`. |
| Reverse proxy | `/etc/nginx-rc/conf.d/{app}.d/main.conf` or `/etc/nginx-rc/extra.d/*.conf` → `proxy_pass http://127.0.0.1:{host_port}` |
| Image storage | `/var/lib/docker/` (overlay2) — disk hog if `docker system prune` never runs |

### 4.2 Gotchas

1. **System user can't run `docker` without sudo or group membership.** A lot of RunCloud Docker installs end up with everything run as root, which is a security issue — but Perch must accommodate both modes.
2. **`docker-compose` vs `docker compose`** — older boxes have v1 (`docker-compose`), newer have v2 plugin (`docker compose`). Detect via `docker compose version` first.
3. **Restart policy missing**: containers without `restart: unless-stopped` don't come back after reboot. Common oversight.
4. **No resource limits**: a leaky container can eat the host. Always check for `mem_limit` / `cpus`.
5. **`:latest` tag drift** — same as n8n.
6. **Compose file drift**: `docker compose ps` shows containers that aren't in the file (someone `docker run`'d directly), or vice versa.
7. **Log driver default `json-file` with no `max-size`** — disk fills with logs. Compose-level `logging: { driver: "json-file", options: { max-size: "50m", max-file: "3" } }` is the fix.
8. **Stale images**: `<none>` images and old tags accumulating. `docker system df` reveals it.
9. **Exposed ports leaking**: `ports: - "5678:5678"` binds on `0.0.0.0` — everyone on the internet can hit it. Should be `127.0.0.1:5678:5678` when behind nginx-rc.

### 4.3 `auditDocker()` — 7 health checks

| # | Check | Severity | Method |
|---|---|---|---|
| 1 | Docker daemon healthy | critical | `systemctl is-active docker` AND `docker info --format '{{.ServerErrors}}'` empty |
| 2 | All containers in compose file are `running` and healthy | critical | `docker compose -f {compose} ps --format json` — state=running, health≠unhealthy |
| 3 | No container restarting >5 times in last hour | warning | `docker inspect {cid} --format='{{.RestartCount}}'` — compare against last Perch sample |
| 4 | No container has hit memory limit (oom_killed events) | critical | `docker inspect {cid} --format='{{.State.OOMKilled}}'` — true means killed |
| 5 | No port bound on `0.0.0.0` for app expected to be behind nginx-rc | warning | `docker port {cid}` — check for `0.0.0.0` prefix; cross-check with whether nginx proxies it |
| 6 | Image age <90 days for security-sensitive containers | info | `docker inspect {cid} --format='{{.Created}}'` |
| 7 | Compose file in sync with live state | warning | Diff `docker compose config --services` against `docker compose ps --services` |
| 8 (bonus) | Log driver has `max-size` set | info | `docker inspect {cid} --format='{{json .HostConfig.LogConfig}}'` |
| 9 (bonus) | `restart: unless-stopped` (or always) on every service | warning | parse compose YAML |
| 10 (bonus) | `docker system df` reclaimable <5GB | info | `docker system df --format json` |

Pick 7 for v1: 1, 2, 3, 4, 5, 6, 7.

### 4.4 `diagnoseDocker()` — root-cause patterns

Tail `docker logs --tail=300 --timestamps {cid}` for each unhealthy container, plus `dmesg | grep -i docker` for OOM/iptables/storage hints.

| Pattern | Root cause | Fixable? |
|---|---|---|
| Container repeatedly `Exited (137)` | OOMKilled — needs memory bump or leak fix | No — alert with `docker stats` snapshot |
| `Exited (1)` with stack in logs | application crash | depends — surface stack |
| `Cannot start service {svc}: driver failed programming external connectivity` + `address already in use` | port collision on host | Yes — list owners via `ss -tlnp`, suggest port change |
| `no space left on device` in dockerd logs | `/var/lib/docker` full | Half — `docker system prune -af --volumes` (with confirmation; this is destructive for unused volumes) |
| Image pull `manifest unknown` | tag deleted/typo'd | No |
| Container `Exited (143)` after deploy | SIGTERM during graceful shutdown — usually fine | Info only |
| Healthcheck failing but app responds on different port | misconfigured healthcheck in compose | Half — suggest fix, don't auto-edit |
| `iptables: No chain/target/match by that name` | Docker networking broken after kernel/iptables update | No — needs `systemctl restart docker` (server-level decision) |

### 4.5 `healDocker()` — auto-fix whitelist

1. `docker compose -f {compose} restart {service}` — single service.
2. `docker compose -f {compose} up -d --remove-orphans` — reconcile to compose file (only after diff confirmation).
3. `docker compose -f {compose} pull && up -d` — ONLY when image is pinned to a version tag (refuse on `:latest`).
4. `docker system prune -f` (no `-a`, no `--volumes`) — reclaim dangling images only. Safe.
5. Truncate a single container's log file when >1GB (verify it's a json-file path under `/var/lib/docker/containers/`).
6. Add a `127.0.0.1:` prefix to a port binding via compose patch — only on user confirmation, with diff preview.

**Never auto:** `docker system prune -a --volumes`, `docker rm` of any container, `docker rmi`, edits to running containers, anything that touches volumes.

### 4.6 Telegram alert templates

```
[CRITICAL] {app} container OOMKilled
{service} was killed by the kernel — out of memory.
  Memory limit: 512 MB
  Peak usage:   538 MB

[ Show last 100 log lines ] [ Bump mem_limit to 1GB ] [ Snooze ]
```

```
[WARNING] {service} is exposed on 0.0.0.0:{port}
This container's port is reachable from the public internet, bypassing
nginx-rc and your SSL/rate limits.

[ Bind to 127.0.0.1 only ] [ Show docker port ] [ Acknowledge — intentional ]
```

```
[CRITICAL] Docker daemon is degraded
systemctl status docker shows: "device or resource busy"
3 containers stuck in "removing" state.

This is usually fixable by restarting the daemon, but it WILL bounce
every container on this server. Confirm before I proceed.

[ Show containers affected ] [ Restart docker ] [ Snooze ]
```

```
[WARNING] /var/lib/docker is at 89%
Reclaimable: 4.2 GB (dangling images, build cache)

I can safely free this without touching any volume or running container.

[ Run docker system prune ] [ Show what will be freed ] [ Ignore ]
```

```
[INFO] Compose file drift detected for {app}
docker-compose.yml says these services should be running:
  api, worker, redis
But these are actually running:
  api, worker, redis, debug-shell  ← not in file

[ Show diff ] [ Stop debug-shell ] [ Add to compose ] [ Ignore ]
```

---

## 5. Cross-Module Patterns

These are not module-specific but every module must implement them consistently with WordPress modules:

1. **Result shape**: `{ score, grade, summary, findings[], recommendations[] }` mirroring `SecurityAuditResult` and `DBHealthResult` from `wordpress/`.
2. **Severity weighting**: critical = -20, warning = -10, info = -2 (calibrated to match `wordpress/security.ts`).
3. **All SSH execution** routes through `core/ssh-enhanced.ts` — never shell out directly.
4. **All RunCloud-API state changes** route through `core/runcloud-api.ts` (to be created — supervisor restart, system user lookup).
5. **Heal functions take a `dryRun: boolean`** — when true, return planned commands without executing. Match the convention in `wordpress/db.ts` action functions.
6. **Telegram alerts** use the helpers in `telegram.md` — `sendAlert(severity, title, body, actions[])`. Action button payloads encode `{module, app, action, args}`.
7. **All log-tailing** caps at 300 lines and 5MB, never unbounded.
8. **All file-ownership detection** uses `stat -c '%U:%G %a'` — single round trip per file.

---

## 6. Detection / Bootstrapping per Module

Each module must first answer "is this app actually a {Laravel|Node|n8n|Docker} app?" before running its checks. Detection logic:

| Module | Detection signal (any one is sufficient) |
|---|---|
| Laravel | `{root}/artisan` exists AND `{root}/composer.json` contains `"laravel/framework"` |
| Node | `{root}/package.json` exists AND `{root}/ecosystem.config.js` exists OR `pm2 jlist` shows an app whose `pm2_env.pm_cwd` starts with `{root}` |
| n8n | `{root}/docker-compose.yml` mentions `n8nio/n8n` image, OR `~/.n8n/` exists for `{user}`, OR `pm2 jlist` shows an app named `n8n` |
| Docker | `{root}/docker-compose.yml` exists OR `{root}/Dockerfile` exists AND at least one container is running with a label/mount referencing `{root}` |

Auto-classification is done by a top-level `detectWebappType({user, app})` helper that returns one or more types (a webapp can be both Docker and n8n, etc.).

---

## 7. Sources Cited

RunCloud official docs:

- Installing Laravel on RunCloud — https://runcloud.io/docs/installing-laravel-on-runcloud
- Set Up Laravel with Git Deployment — https://runcloud.io/docs/laravel-git
- Create Supervisor Job on RunCloud — https://runcloud.io/docs/guide/server-management/supervisord
- Supervisor API — https://runcloud.io/docs/api/supervisor
- NGINX Cheat Sheet — https://runcloud.io/docs/cheat-sheet-nginx
- PHP Cheat Sheet — https://runcloud.io/docs/cheat-sheet-php
- NGINX Reverse Proxy — https://runcloud.io/docs/nginx-reverse-proxy
- Custom NGINX Config blog — https://runcloud.io/blog/nginx-config
- How to Create a Custom NGINX Configuration File — https://runcloud.io/docs/how-to-create-a-custom-nginx-configuration-file
- Effortless n8n Hosting with RunCloud, Docker, and NGINX — https://runcloud.io/blog/n8n-hosting-docker-nginx
- How to Deploy Laravel with Docker on VPS — https://runcloud.io/blog/deploy-laravel-with-docker-on-vps
- Change Web Application Ownership — https://runcloud.io/docs/how-do-i-change-the-ownership-of-a-web-application
- File Permission Issues on RunCloud — https://runcloud.io/knowledgebase/articles/web-application/file-permission-issues-on-runcloud
- System User API — https://runcloud.io/docs/api/system-user
- Accessing Logs in RunCloud — https://runcloud.io/docs/accessing-logs-in-runcloud
- Update PHP-FPM, NGINX settings (API) — https://runcloud.io/docs/api/v3/api-8617100
- Enabling PHP Slow Log on Nginx — https://www.linuxtutorialz.co.uk/2023/08/php-slowlog-nginx.html (third-party but referenced for `/home/runcloud/logs/fpm/slow.log` pattern)

Process-manager & ecosystem references:

- PM2 production setup with Nginx — https://pm2.keymetrics.io/docs/tutorials/pm2-nginx-production-setup
- n8n Hosting Docs — https://docs.n8n.io/hosting/
- n8n via PM2 — https://blog.n8n.io/how-to-set-up-n8n-via-pm2/
- Supervisor configuration reference — https://supervisord.org/configuration.html
- Laravel Queues — https://laravel.com/docs/9.x/queues

---

## 8. Open Questions / Assumptions to Verify Before Coding

1. **System user UID for Docker containers** — Perch should fetch the actual UID at runtime (`id -u {user}`) rather than assume 1000. Verify on a real RunCloud box.
2. **Supervisor on-disk path** — RunCloud docs don't expose where the API writes the conf files. Likely `/etc/supervisor/conf.d/{job}.conf`; confirm by inspecting a live server before relying on it.
3. **PHP-FPM error log path** — `/home/{user}/logs/fpm_{app}.error.log` is consistent with the slow-log pattern in the third-party reference, but RunCloud's official docs only describe the dashboard's "Web Server Log" viewer, not the raw path. Detect via `php -i | grep error_log` per pool to be safe.
4. **`pm2-{user}.service` naming** — confirm RunCloud doesn't auto-generate a different unit name in their server provisioning.
5. **`docker compose` v1 vs v2** — must detect at runtime; some older RunCloud servers may still have only v1.
6. **Docker group membership** — whether the system user is in the `docker` group varies per install. Test via `id {user} | grep docker`.

These six items are tracked as `// TODO(spec)` markers — each new module's detection step should validate them on first run and cache the answers in `~/.perch/server-{id}.json`.
