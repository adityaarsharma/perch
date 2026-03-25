# RunCloud Server Management MCP

**The most complete RunCloud integration for Claude.** Manage servers, web applications, databases, SSL, deployments, firewall rules, self-healing fixes, and live SSH commands — all from a single AI conversation. No switching tabs. No API docs. Just ask.

[![RunCloud](https://img.shields.io/badge/RunCloud-API%20v3-0066CC?style=flat-square)](https://runcloud.io)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/Tools-135-orange?style=flat-square)](#tool-catalog)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

---

## What Is This?

[RunCloud](https://runcloud.io) is a server management panel that lets you deploy and manage web applications on any cloud server — DigitalOcean, Hetzner, AWS, Vultr, Linode, or a bare metal box. It has a full REST API covering every feature the panel has.

This MCP server plugs that API — plus raw SSH execution — directly into Claude. Instead of opening the RunCloud dashboard, writing curl commands, or reading API docs, you just describe what you want:

> *"Set up a WordPress site on my production server, use PHP 8.2, create the database and system user, and install an SSL cert."*

Claude handles the 6 API calls, in the right order, with the right parameters.

---

## Two Modes — One Tool

### Mode 1: Full RunCloud API (requires API key)

Everything the RunCloud panel can do, Claude can do — programmatically, in bulk, across all servers at once. 128 RunCloud API tools.

### Mode 2: SSH-Only (no API key needed)

No RunCloud account? Just have a Linux server with SSH access? 7 dedicated monitoring and self-healing tools work with any server — RunCloud-managed or not. These are especially useful for:

- Checking server health without logging into anything
- Auto-fixing issues Claude detects
- Monitoring from a Telegram bot

Both modes work together. Connect the API key → get everything. Skip it → SSH tools still fully work.

---

## What Makes This Different

### Not Just an API Wrapper

Most RunCloud integrations wrap the API 1:1. This goes further:

**Compound tools** chain multiple API calls in parallel into single operations:

| Tool | What Happens Behind The Scenes |
|------|-------------------------------|
| `wordpress_quickstart` | Creates system user → database → DB user → grants access → creates web app → installs WordPress. **Six API calls. One prompt.** |
| `server_overview` | Server info + health + hardware + services + web apps — fetched simultaneously |
| `all_servers_health` | Health check across **every server** in your account at once |
| `multi_server_dashboard` | Every server: name, IP, health score, webapp count, memory %, disk % — one view |
| `webapp_inventory` | Every webapp across every server — domain, PHP, stack mode — one table |
| `ssl_expiry_check` | Scans all web apps on a server, flags expired and expiring-soon certs |
| `find_webapp_by_domain` | Searches **all servers** for a domain — returns which server it's on |
| `failed_services_scan` | Scans all servers, returns only stopped/failed services — instant incident detection |
| `deploy_and_verify` | Force deploy + check webapp status + tail logs — full deploy cycle in one step |
| `server_health_score` | Calculates a 0–100 score with letter grade (A–F) based on memory, disk, load, services |

**SSH execution built in.** Claude can open a real terminal session to any of your servers and run commands directly:

```
"Run wp cache flush on /home/myuser/myblog"
"Show me the last 500 lines of the nginx error log on server 12345"
"SSH into my server and find every file larger than 1GB"
```

**Self-healing.** The new SSH monitoring tools let Claude detect and fix real server problems — without you being the middleman.

---

## Full Tool Catalog (135 Tools)

### 🖥️ Servers — 17 tools

| Tool | Description |
|------|-------------|
| `list_servers` | List all servers. Supports `all: true` for auto-pagination. |
| `list_shared_servers` | Servers shared with your account |
| `get_server` | Full server details by ID |
| `create_server` | Add a new server (works with any provider) |
| `delete_server` | Remove a server from RunCloud |
| `get_server_stats` | Web app count, database count, cron count, geo location |
| `get_server_hardware_info` | CPU, RAM, disk, load average, kernel version, uptime |
| `get_server_health` | Latest health data snapshot from RunCloud agent |
| `clean_server_disk` | Trigger disk cleanup via RunCloud |
| `get_installation_script` | Get the RunCloud agent install script for a server |
| `get_server_logs` | Action and change logs for a server |
| `get_ssh_settings` | SSH config: passwordless login, DNS, root login settings |
| `update_ssh_settings` | Modify SSH configuration |
| `update_server_meta` | Rename server or change provider label |
| `update_server_autoupdate` | Configure automatic OS and security updates |
| `list_php_versions` | Available PHP versions installed on a server |
| `change_php_cli` | Set the default PHP CLI version |

### 🌐 Web Applications — 12 tools

| Tool | Description |
|------|-------------|
| `list_webapps` | All web apps on a server. Supports `all: true`. |
| `get_webapp` | Full details for a specific web app |
| `create_webapp` | Create a web app (Native, Custom, or WordPress stack) |
| `delete_webapp` | Delete a web app |
| `rebuild_webapp` | Rebuild nginx + PHP config for a web app |
| `get_webapp_settings` | PHP-FPM settings, memory, upload size |
| `update_webapp_fpm_settings` | Update PHP-FPM pool settings |
| `get_webapp_logs` | Recent logs for a web app |
| `set_webapp_default` | Set a web app as the server's default |
| `remove_webapp_default` | Remove the default flag |
| `create_webapp_alias` | Add an alias/subdomain to a web app |
| `change_webapp_php_version` | Switch PHP version for a web app |

### 🔧 PHP Script Installer — 3 tools

| Tool | Description |
|------|-------------|
| `list_script_installers` | Available one-click installers (WordPress, Joomla, Drupal, phpMyAdmin, etc.) |
| `install_php_script` | Run a one-click installer on a web app |
| `remove_php_installer` | Remove a script installer from a web app |

### 🌿 Git — 6 tools

| Tool | Description |
|------|-------------|
| `get_git_info` | Current git connection details for a web app |
| `clone_git_repo` | Connect a git repository to a web app |
| `remove_git_repo` | Disconnect git from a web app |
| `change_git_branch` | Switch the active branch |
| `force_git_deploy` | Force a git pull and deploy |
| `update_git_deploy_script` | Modify the post-deploy script |
| `generate_deployment_key` | Generate an SSH deploy key for private repos |

### 🌍 Domains — 3 tools

| Tool | Description |
|------|-------------|
| `list_domains` | All domain names attached to a web app |
| `add_domain` | Add a domain or subdomain to a web app |
| `delete_domain` | Remove a domain from a web app |

### 🔒 SSL Certificates — 10 tools

| Tool | Description |
|------|-------------|
| `get_ssl` | Current SSL cert info for a web app |
| `install_ssl` | Install Let's Encrypt or custom SSL |
| `delete_ssl` | Remove SSL from a web app |
| `redeploy_ssl` | Force SSL redeployment |
| `get_domain_ssl` | Per-domain SSL info |
| `install_domain_ssl` | Install SSL for a specific domain |
| `delete_domain_ssl` | Remove domain-level SSL |
| `redeploy_domain_ssl` | Force redeploy domain SSL |
| `get_advanced_ssl` | Advanced SSL config details |
| `switch_advanced_ssl` | Toggle advanced SSL settings |

### 🗄️ Databases — 12 tools

| Tool | Description |
|------|-------------|
| `list_databases` | All databases on a server |
| `get_database` | Details for a specific database |
| `create_database` | Create a new database |
| `delete_database` | Delete a database |
| `list_database_users` | All database users on a server |
| `get_database_user` | Details for a specific DB user |
| `create_database_user` | Create a database user |
| `delete_database_user` | Delete a database user |
| `update_database_user_password` | Change a DB user's password |
| `list_granted_database_users` | Users with access to a specific database |
| `grant_database_user` | Grant a user access to a database |
| `revoke_database_user` | Revoke user access from a database |
| `list_database_collations` | Available character sets and collations |

### 👤 System Users — 6 tools

| Tool | Description |
|------|-------------|
| `list_system_users` | All system users on a server |
| `get_system_user` | Details for a specific system user |
| `create_system_user` | Create a system user (for web apps) |
| `delete_system_user` | Delete a system user |
| `change_system_user_password` | Set or change password (also needed for SSH login) |
| `generate_deployment_key` | Generate SSH deploy key for a system user |

### 🔑 SSH Keys — 4 tools

| Tool | Description |
|------|-------------|
| `list_ssh_keys` | All public SSH keys on a server |
| `get_ssh_key` | Details for a specific SSH key |
| `add_ssh_key` | Add a public SSH key to a server |
| `delete_ssh_key` | Remove an SSH key |

### ⏰ Cron Jobs — 5 tools

| Tool | Description |
|------|-------------|
| `list_cronjobs` | All cron jobs on a server |
| `get_cronjob` | Details for a specific cron job |
| `create_cronjob` | Create a new cron job |
| `delete_cronjob` | Delete a cron job |
| `rebuild_cronjobs` | Rebuild the crontab file |

### 📋 Supervisor — 8 tools

| Tool | Description |
|------|-------------|
| `list_supervisor_jobs` | All Supervisor background workers |
| `get_supervisor_job` | Details for a specific worker |
| `create_supervisor_job` | Create a new background worker |
| `delete_supervisor_job` | Delete a worker |
| `reload_supervisor_job` | Reload a specific worker |
| `rebuild_supervisor_jobs` | Rebuild all Supervisor configs |
| `get_supervisor_status` | Current status of all workers |
| `list_supervisor_binaries` | Available binary paths for Supervisor |

### 🛡️ Firewall & Security — 9 tools

| Tool | Description |
|------|-------------|
| `list_firewall_rules` | All firewall rules on a server |
| `create_firewall_rule` | Add a firewall rule (IP whitelist, port block, etc.) |
| `delete_firewall_rule` | Remove a firewall rule |
| `deploy_firewall_rules` | Apply pending firewall changes |
| `list_fail2ban_blocked_ips` | IPs currently blocked by Fail2Ban |
| `unblock_fail2ban_ip` | Unblock a specific IP from Fail2Ban |
| `security_audit` | Full snapshot: firewall + SSH keys + Fail2Ban + external APIs |
| `open_ports_report` | Ports open to 0.0.0.0 — review before going live |
| `list_ssl_protocols` | Available SSL/TLS protocol versions |

### ⚙️ Services — 2 tools

| Tool | Description |
|------|-------------|
| `list_services` | All services (nginx, mysql, redis, etc.) with CPU, memory, version |
| `control_service` | Start, stop, restart, or reload any service via RunCloud API |

### 🔗 External APIs — 5 tools

| Tool | Description |
|------|-------------|
| `list_external_apis` | All connected third-party API keys |
| `get_external_api` | Details for a specific external API |
| `create_external_api` | Add a new external API (Cloudflare, DigitalOcean, etc.) |
| `update_external_api` | Update an external API connection |
| `delete_external_api` | Remove an external API |

### 🔍 Cross-Server Search & Inventory — 4 tools

| Tool | Description |
|------|-------------|
| `find_webapp_by_domain` | Search all servers for a domain name — returns server + webapp |
| `webapp_inventory` | Full inventory: every webapp across all servers in one table |
| `multi_server_dashboard` | All servers: health score, webapp count, memory%, disk% |
| `failed_services_scan` | All servers: only stopped/failed services — instant incident detection |

### 📈 Health, Monitoring & Performance — 7 tools

| Tool | Description |
|------|-------------|
| `server_overview` | Full server snapshot: info + health + hardware + services + webapps |
| `server_health_score` | 0–100 score + letter grade (A–F) based on RAM, disk, load, services |
| `all_servers_health` | Health status across every server in your account |
| `server_load_report` | CPU, memory, disk, and load trends via SSH |
| `nginx_top_ips` | Top IPs hitting nginx — detect scrapers and attackers |
| `php_error_summary` | PHP error counts by type + last 20 lines from error log |
| `ssl_expiry_check` | Scans all web apps, flags EXPIRED and EXPIRING_SOON certs |

### 🚀 Deployments — 2 tools

| Tool | Description |
|------|-------------|
| `deploy_and_verify` | Force deploy + check webapp status + tail logs — one step |
| `wordpress_quickstart` | Full WordPress setup: user + DB + web app + install — one prompt |

### 🟦 WordPress Management (SSH) — 5 tools

| Tool | Description |
|------|-------------|
| `ssh_wp_cli` | Run any WP-CLI command on any web app |
| `wp_health_check` | WP core checksums + active plugins + cron status |
| `wp_outdated_plugins` | List plugins with available updates |
| `wp_admin_audit` | All admin users — detect unexpected accounts |
| `wp_clear_all_caches` | Flush WordPress + Redis + OPcache |

### 🖥️ SSH Direct Execution — 4 tools

| Tool | Description |
|------|-------------|
| `ssh_run_command` | Run any shell command on any server via SSH |
| `ssh_artisan` | Run Laravel Artisan commands |
| `ssh_tail_log` | Live tail a log file (returns last N lines) |
| `ping` | Test API authentication |

---

### 🔧 Server Monitoring & Self-Healing (SSH-direct, no RunCloud API key needed) — 7 tools

These work on **any Linux server** — RunCloud-managed or not. Just need SSH access.

| Tool | Description |
|------|-------------|
| `ssh_server_status` | Full health report: RAM, disk, CPU load, nginx/nginx-rc status, orphan process count, top 5 processes by memory |
| `ssh_smart_fix` | Detects and fixes: nginx down → restart, orphan procs → kill, high memory → PM2 restart, disk full → clear large logs. Reports exactly what was fixed. |
| `ssh_restart_service` | Restart any service via SSH. Smart nginx handling: auto-detects `nginx-rc` (RunCloud) vs `nginx`. Also handles `n8n`, `pm2`, any systemd service. |
| `ssh_kill_orphans` | Finds processes with PPID=1 (parent died = true orphan). Dry-run by default. Optional filter by process name (e.g. `supergateway`). Safe — skips init, systemd, dbus. |
| `ssh_disk_cleanup` | Lists large log files (configurable min size). Dry-run by default. Pass `dryRun: false` to actually clear. |
| `ssh_check_ports` | All listening ports with PID and process name. Optionally filter to specific ports. |
| `telegram_send_alert` | Send a Markdown message to any Telegram chat from Claude. Optionally include action buttons (Status, Smart Fix, Nginx, Disk, Ignore). |

#### What `ssh_smart_fix` Actually Checks and Fixes

```
Problem detected               →  Action taken
─────────────────────────────────────────────────
nginx-rc / nginx is not active →  sudo systemctl restart nginx-rc (or nginx)
Orphan procs (PPID=1) > 10    →  Kill all orphan PIDs
Memory usage > 88%             →  pm2 restart all (finds pm2 automatically)
Disk usage > 88%               →  truncate -s 0 on log files > 50MB
All clear                      →  Reports "healthy — nothing needed fixing"
```

#### RunCloud-Specific: nginx-rc vs nginx

RunCloud installs its own nginx binary (`nginx-rc`) instead of the standard `nginx`. Standard monitoring tools and scripts check `systemctl is-active nginx` which returns `inactive` even when the web server is running fine.

All SSH monitoring tools auto-detect which one is running:

```
systemctl is-active nginx-rc   →  active  →  use nginx-rc
systemctl is-active nginx-rc   →  inactive →  fall back to nginx
```

You can also pass `nginxService: "nginx-rc"` explicitly to skip detection.

---

### 📱 Optional: Telegram Bot Stack (no n8n needed)

The `telegram-bot/` directory contains a complete standalone monitoring and control stack. No extra services required beyond Python.

#### Architecture

```
Your Server
├── monitor.sh        ← Cron every 10 min → Telegram alerts with action buttons
├── fix-server.py     ← Local HTTP API on 127.0.0.1:3011 → runs fix scripts
├── bot.py            ← Telegram bot (polling) → handles commands + button callbacks
└── .env              ← All config in one file
```

#### Telegram Commands

| Command | Action |
|---------|--------|
| `/status` | Full RAM, Disk, CPU, nginx, services status |
| `/brief` | One-liner quick status |
| `/fix` | Smart fix — auto-detect and repair all issues |
| `/nginx` | Restart nginx / nginx-rc |
| `/n8n` | Restart n8n |
| `/services` | Restart all custom services |
| `/disk` | Disk usage breakdown |
| `/logs` | Clear large log files |
| `/ports` | Check which service ports are responding |
| `/mute 2h` | Silence alerts for 2 hours |
| `/mute 30m` | Silence for 30 minutes |
| `/unmute` | Re-enable alerts |
| `/test` | Send a test alert |
| `/reboot` | Reboot server (inline confirmation required) |
| `/menu` | Show action button keyboard |
| `/help` | All commands |

#### Alert Buttons

When `monitor.sh` sends an alert, it includes inline buttons:

```
🔧 Smart Fix    📊 Status
🌐 Nginx        💾 Disk    ✅ Ignore
```

Tapping a button calls the local fix API and shows the result directly in chat. Works even without the Telegram bot running — but if the bot is running it handles the callbacks and shows output inline.

#### Install

```bash
cd telegram-bot
cp config.example.env .env
# Edit .env with your Telegram token and chat ID
bash setup.sh
```

`setup.sh` does everything:
1. Writes `.env` with all config
2. Generates a random fix server token
3. Installs Python `requests` dependency
4. Sets up the cron for `monitor.sh`
5. Creates and starts systemd services for `bot.py` and `fix-server.py`
6. Sends a test Telegram message to confirm it works

---

## Dependencies

### MCP Server (RunCloud API + SSH tools)

| Dependency | Version | Why |
|------------|---------|-----|
| **Node.js** | 18+ | Runtime. Needed for `fetch()` (built-in from Node 18). |
| **npm** | 8+ | Package manager |
| `@modelcontextprotocol/sdk` | latest | MCP protocol implementation — how Claude talks to this server |
| `ssh2` | ^1.x | SSH client library — enables direct SSH connections from Claude |
| **TypeScript** | 5.x | Source language (compiles to `dist/`) |
| **Claude Desktop or Claude Code** | latest | The AI that uses these tools |

**That's it.** No database, no background services, no port forwarding. The MCP server is a process Claude Desktop spawns when you open it.

### Telegram Bot (optional, `telegram-bot/`)

| Dependency | Version | Why |
|------------|---------|-----|
| **Python** | 3.8+ | Runtime for bot.py, fix-server.py, monitor.sh helper |
| `requests` | any | HTTP library for Telegram API calls (`pip install requests`) |
| **bash** | 4+ | For monitor.sh and all fix scripts |
| `jq` | any | JSON formatting in monitor.sh (`apt install jq`) |
| `curl` | any | HTTP in monitor.sh (`apt install curl`) |
| `nc` (netcat) | any | Port checking in check-ports.sh |
| **systemd** | any | To run bot.py and fix-server.py as services |
| **cron** | any | To run monitor.sh every 10 minutes |

No Telegram bot library needed — uses raw Telegram Bot API via `requests` and `curl`.

---

## Installation

### MCP Server

**1. Clone and build**

```bash
git clone https://github.com/adityaarsharma/runcloud-server-management-mcp.git
cd runcloud-server-management-mcp
npm install
npm run build
```

**2. Configure Claude Desktop**

Open the config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "runcloud": {
      "command": "node",
      "args": ["/absolute/path/to/runcloud-server-management-mcp/dist/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your_runcloud_api_key_here"
      }
    }
  }
}
```

> **No RunCloud API key?** Remove the `RUNCLOUD_API_KEY` line entirely. The 7 SSH monitoring/self-healing tools still work. You'll get an error only if you try to use a RunCloud API tool.

**3. Restart Claude Desktop**

The MCP server starts automatically. You'll see a hammer icon (🔨) in Claude Desktop confirming tools are loaded.

**4. Claude Code (terminal)**

```bash
claude mcp add runcloud node /absolute/path/to/dist/index.js \
  -e RUNCLOUD_API_KEY=your_runcloud_api_key_here
```

Or without API key (SSH tools only):

```bash
claude mcp add runcloud node /absolute/path/to/dist/index.js
```

**5. Via supergateway (for remote/shared access)**

```bash
npm install -g supergateway
supergateway --stdio "node /path/to/dist/index.js" \
  --port 3020 \
  --outputTransport streamableHttp \
  --path /mcp \
  --oauth2Bearer your_secret_token \
  --logLevel none
```

Then in Claude Desktop config:

```json
{
  "mcpServers": {
    "runcloud": {
      "type": "streamable-http",
      "url": "https://your-server.com:3020/mcp",
      "headers": {
        "Authorization": "Bearer your_secret_token"
      }
    }
  }
}
```

---

### Getting Your RunCloud API Key

1. Log into [RunCloud](https://runcloud.io)
2. Go to **Settings → API Management**
3. Create a new API key
4. Copy the key — you won't see it again

The API key gives full read/write access to everything in your RunCloud account. Keep it private. Store it only in your local Claude config file — never commit it to Git.

---

### Telegram Bot (optional)

```bash
cd telegram-bot
cp config.example.env .env
nano .env   # Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
bash setup.sh
```

To get your Telegram credentials:
- **Bot token:** Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
- **Chat ID:** Message [@userinfobot](https://t.me/userinfobot) → it replies with your chat ID

---

## Example Prompts

### Server Health

```
"Give me a full dashboard of all my servers"
"Which servers have memory above 80%?"
"Are there any stopped services across any of my servers?"
"Give server 12345 a health score"
"Check if any SSL certificates are expiring in the next 30 days on server 12345"
```

### Self-Healing (SSH monitoring tools — no RunCloud API needed)

```
"Check the status of my server at 95.216.156.89 (SSH: runcloud / mypassword)"
"Run a smart fix on my server — detect and repair any issues"
"Kill orphan processes on my server (dry run first)"
"Restart nginx on my server — it uses RunCloud so try nginx-rc first"
"Show me all listening ports on my server"
"Find log files over 100MB and clear them"
```

### WordPress

```
"Set up a full WordPress site on server 12345:
 - Domain: myblog.com
 - PHP 8.2
 - System user: bloguser (password: Secure123!)
 - Database: myblog_db / DB user: blog_user (password: DbPass456)
 - Timezone: Asia/Kolkata"

"What WordPress plugins need updates on /home/myuser/myblog?"
"List all admin accounts on my WordPress site — check for anything suspicious"
"Flush the WordPress cache on /home/myuser/myblog including Redis"
"Run a full WordPress health check on my site"
```

### Git & Deployments

```
"Deploy the latest changes from main branch to webapp 789 and verify it worked"
"Connect my GitHub repo to webapp 789"
"Switch my app from staging to production branch and deploy"
"Set up auto-deploy for my repo"
```

### Database

```
"List all databases on server 12345"
"Create a database called shop_db with utf8mb4_unicode_ci"
"Create a database user shopuser and give them full access to shop_db"
"Revoke shopuser's access from shop_db"
```

### SSL

```
"Which SSL certs are expired or expiring soon on server 12345?"
"Install a Let's Encrypt certificate for myblog.com on webapp 456"
"Renew the SSL for all web apps on server 12345"
```

### Security & Firewall

```
"Show me the full security audit for server 12345"
"Which ports are open to everyone? I want to review before going live"
"Block all traffic to port 8080 except from IP 203.0.113.5"
"List IPs blocked by Fail2Ban on server 12345"
"Unblock IP 198.51.100.0 from Fail2Ban"
```

### SSH Commands

```
"Run df -h on server 12345 as user myapp with password mypassword"
"Tail the last 200 lines of /home/myapp/logs/app.log"
"Show me the top 10 IPs hitting nginx on server 12345"
"Summarize PHP errors from the error log"
"Run php artisan migrate on my Laravel app"
"Find all files over 1GB on /home/myapp"
```

### Telegram Alerts

```
"Send a Telegram alert to my monitoring chat that the deployment succeeded"
"Send a server status update to chat 887964145 with action buttons"
```

### Cross-Server

```
"Which server is example.com on?"
"Give me a full inventory of every web app across all my servers"
"Show me a dashboard of all servers with health scores"
"Find all servers with disk usage above 85%"
```

---

## SSH Tools — How Server IP Works

For tools that use `serverId`, the server IP is fetched automatically from RunCloud. You never need to look it up.

For the SSH monitoring tools (`ssh_server_status`, `ssh_smart_fix`, etc.), you pass `host` directly — no RunCloud API needed.

**Typical workflow with RunCloud API:**

```
1. List servers to find the server ID
   → "List my servers"

2. Get system user info (or create one)
   → "Create a system user called deploy on server 12345"

3. Set a password for SSH access
   → "Set the password for system user 99 on server 12345 to DeployPass123"

4. SSH in and run commands
   → "SSH into server 12345 as deploy / DeployPass123 and run: ls -la /home/deploy"
```

**Without RunCloud API:**

```
→ "Check server status at 95.216.156.89 — SSH as runcloud / mypassword"
→ "Run smart fix on 95.216.156.89 (SSH: runcloud / mypassword)"
```

---

## RunCloud-Specific Notes

### nginx-rc vs nginx

RunCloud installs its own nginx binary called `nginx-rc` (located at `/usr/local/sbin/nginx-rc`). The systemd service is `nginx-rc.service` — not `nginx.service`.

This means:
- `systemctl is-active nginx` → **inactive** (wrong service name)
- `systemctl is-active nginx-rc` → **active** (correct)

All SSH monitoring tools in this MCP auto-detect which one is running. If your server is RunCloud-managed, they will automatically use `nginx-rc`. You can also pass `nginxService: "nginx-rc"` to force it.

### System Users Are Required for SSH

RunCloud uses isolated system users per web app. SSH tools need a system user and password. The quickest way:

```
"Set the password for system user 99 on server 12345 to MyPass123"
```

Then use that username and password in all SSH tool calls.

### RunCloud Agent Metrics vs SSH Metrics

`get_server_health` uses RunCloud's built-in agent data (polled every minute by RunCloud). `ssh_server_status` runs commands directly — real-time, no delay, works even if the RunCloud agent is slow.

---

## Project Structure

```
runcloud-server-management-mcp/
│
├── src/
│   └── index.ts              ← Full MCP server — all 135 tools
│
├── dist/                     ← Compiled JavaScript (auto-generated by npm run build)
│   └── index.js
│
├── telegram-bot/             ← Optional: standalone Telegram monitoring stack
│   ├── bot.py                ← Telegram bot (polling, no library needed)
│   ├── fix-server.py         ← Local HTTP fix API (127.0.0.1:3011)
│   ├── monitor.sh            ← Cron monitor script (alerts + dedup + mute)
│   ├── setup.sh              ← One-command interactive setup wizard
│   └── config.example.env    ← All config documented
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Security Model

- **RunCloud API key** — stored only in your local Claude Desktop config. Never leaves your machine.
- **SSH credentials** — passed per-call. Never stored anywhere by this MCP.
- **All API traffic** — goes directly from your machine to `manage.runcloud.io` over HTTPS.
- **All SSH traffic** — goes directly from your machine to your server. No relay, no third party.
- **Telegram bot** — runs on your server, only responds to your chat ID.
- **Fix server API** — binds to `127.0.0.1` only. Not accessible from outside the server.
- **Read + write access** — the RunCloud API key has full control. Be careful about who has access to the machine where Claude Desktop is configured.

---

## Built With

| Library | Purpose |
|---------|---------|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MCP protocol — how Claude talks to this server |
| [`ssh2`](https://github.com/mscdex/ssh2) | SSH client for Node.js |
| [RunCloud API v3](https://runcloud.io/docs/api/v3) | Full REST API documentation |
| TypeScript 5 + Node.js 18 | Language and runtime |
| Python 3 + requests | Telegram bot and fix server |

---

## Contributing

PRs welcome. Ideas for additions:

- More compound tools (e.g. `migrate_webapp` — clone webapp to another server)
- Discord notification support in monitor.sh
- RunCloud webhook receiver
- Multi-account support (multiple API keys)
- Health history tracking

---

## Related Projects

- **[YouTube Channel Data MCP](https://github.com/adityaarsharma/youtube-channel-data-mcp)** — Connect Claude to your YouTube Analytics data

---

## License

MIT — use it, modify it, ship it.

---

## About

Built by **[Aditya Sharma](https://adityaarsharma.com)** — marketing and growth at [POSIMYTH](https://posimyth.com), makers of WordPress tools.

- 🌐 [adityaarsharma.com](https://adityaarsharma.com)
- 🐦 [@adityaarsharma](https://twitter.com/adityaarsharma)
- 💻 [github.com/adityaarsharma](https://github.com/adityaarsharma)

If this saved you an hour → **star the repo ⭐**

---

*Not an official RunCloud product. Built independently using the [RunCloud public API v3](https://runcloud.io/docs/api/v3).*
