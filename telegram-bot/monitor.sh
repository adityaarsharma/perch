#!/usr/bin/env bash
# Perch — Comprehensive Automation Rule Engine
# Runs every 5 min via cron, evaluates 14 rules, sends friendly Telegram alerts.
# No external dependencies (no n8n, no Zapier). Fully self-contained.
#
# Add to cron with: crontab -e
#   */5 * * * * /home/user/Perch/telegram-bot/monitor.sh
#
# Reads config from .env in same directory.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && set -a && . "$SCRIPT_DIR/.env" && set +a

# ── Required tooling ──────────────────────────────────────────────────────────

for cmd in free df awk nproc curl jq md5sum ps systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing: $cmd" >&2; exit 1; }
done

# ── Required config ───────────────────────────────────────────────────────────

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
[ -z "$BOT_TOKEN" ] && { echo "TELEGRAM_BOT_TOKEN not set" >&2; exit 1; }
[ -z "$CHAT_ID" ]   && { echo "TELEGRAM_CHAT_ID not set" >&2;   exit 1; }

# ── Optional config + thresholds (sensible defaults) ──────────────────────────

FIX_URL="${FIX_SERVER_URL:-http://127.0.0.1:3011}"
NGINX_SVC="${NGINX_SVC:-auto}"  # honour .env override
STATE_DIR="${MONITOR_STATE_DIR:-/tmp/perch-monitor}"
MUTE_FILE="${MONITOR_MUTE_FILE:-/tmp/perch-monitor-muted}"
SERVER_NAME="${MONITOR_SERVER_NAME:-$(hostname -s)}"
TZ_NAME="${MONITOR_TIMEZONE:-UTC}"

# Per-rule thresholds (override in .env)
RULE_RAM_WARN="${RULE_RAM_WARN:-85}"        # %
RULE_RAM_CRIT="${RULE_RAM_CRIT:-93}"        # %
RULE_DISK_WARN="${RULE_DISK_WARN:-80}"      # %
RULE_DISK_HIGH="${RULE_DISK_HIGH:-90}"      # %
RULE_DISK_CRIT="${RULE_DISK_CRIT:-95}"      # %
RULE_LOAD_PCT_WARN="${RULE_LOAD_PCT_WARN:-100}"  # % of nproc cores
RULE_LOAD_PCT_CRIT="${RULE_LOAD_PCT_CRIT:-200}"
RULE_ORPHAN_WARN="${RULE_ORPHAN_WARN:-10}"
RULE_SSL_DAYS_WARN="${RULE_SSL_DAYS_WARN:-30}"
RULE_SSL_DAYS_CRIT="${RULE_SSL_DAYS_CRIT:-7}"
RULE_FAIL2BAN_BAN_RATE="${RULE_FAIL2BAN_BAN_RATE:-50}"   # bans/hour
RULE_5XX_RATE="${RULE_5XX_RATE:-1}"          # % of requests
RULE_COOLDOWN="${RULE_COOLDOWN:-1800}"        # 30 min between repeat alerts

# Sites to HTTP-check (CSV of domains): MONITOR_SITES="example.com,api.example.com"
MONITOR_SITES="${MONITOR_SITES:-}"

# Custom ports to check (CSV): MONITOR_PORTS="3000,5678"
MONITOR_PORTS="${MONITOR_PORTS:-}"

# ── State directory ───────────────────────────────────────────────────────────

mkdir -p "$STATE_DIR" 2>/dev/null
chmod 700 "$STATE_DIR" 2>/dev/null || true

# ── Mute check ────────────────────────────────────────────────────────────────

if [ -f "$MUTE_FILE" ]; then
  MUTE_UNTIL=$(cat "$MUTE_FILE" 2>/dev/null)
  if [ -n "$MUTE_UNTIL" ] && [ "$(date +%s)" -lt "$MUTE_UNTIL" ]; then
    exit 0
  fi
fi

# ── Auto-detect nginx service (RunCloud uses nginx-rc) ────────────────────────

if [ "$NGINX_SVC" = "auto" ]; then
  if systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc'; then
    NGINX_SVC="nginx-rc"
  else
    NGINX_SVC="nginx"
  fi
fi

# ── Telegram send helper ──────────────────────────────────────────────────────

send_alert() {
  # send_alert <rule_id> <severity> <title> <body> <button_json>
  local rule_id="$1" severity="$2" title="$3" body="$4" buttons="${5:-[]}"
  body="$(printf '%b' "$body")"  # expand \n escape sequences

  # NOTE (v2.5): alerts are nudges, NOT session triggers.
  # We deliberately do NOT touch /tmp/perch_session.json here —
  # session must be opened explicitly by /perch_start. Aditya's rule:
  # "Perch start nhi karu toh na ho, even if nudge se aaye."

  local state_file="$STATE_DIR/$rule_id"
  local now hash last_hash last_time elapsed
  now="$(date +%s)"
  hash="$(printf '%s%s' "$title" "$body" | md5sum | awk '{print $1}')"

  # Cooldown — don't repeat the same alert
  if [ -f "$state_file" ]; then
    last_hash="$(cut -d: -f1 "$state_file" 2>/dev/null)"
    last_time="$(cut -d: -f2 "$state_file" 2>/dev/null || echo 0)"
    elapsed=$((now - last_time))
    if [ "$last_hash" = "$hash" ] && [ "$elapsed" -lt "$RULE_COOLDOWN" ]; then
      return 0
    fi
  fi
  printf '%s:%s\n' "$hash" "$now" > "$state_file"

  local emoji
  case "$severity" in
    info)     emoji="ℹ️" ;;
    warning)  emoji="⚠️" ;;
    critical) emoji="🔴" ;;
    *)        emoji="•"  ;;
  esac

  local timestamp; timestamp="$(TZ="$TZ_NAME" date '+%H:%M %Z')"
  local server_ip; server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"

  local text
  text=$(printf '%s *%s — %s*\n%s\n\n%s\n\n_Server: %s · %s_' \
    "$emoji" "$SERVER_NAME" "$title" "$server_ip" "$body" "$SERVER_NAME" "$timestamp")

  # SECURITY [H5]: keep BOT_TOKEN out of curl's argv (visible in `ps`).
  # Build the full URL into a curl --config block fed via stdin.
  local url_config
  url_config="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$BOT_TOKEN")"

  jq -n \
    --arg c "$CHAT_ID" \
    --arg t "$text" \
    --argjson k "{\"inline_keyboard\":$buttons}" \
    '{"chat_id":$c,"text":$t,"parse_mode":"Markdown","reply_markup":$k}' \
  | curl -sf -X POST -K <(printf '%s\n' "$url_config") \
      -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true

  # ── Slack mirror — fires when SLACK_WEBHOOK_URL is set ────────────────────
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    local sev_color
    case "$severity" in
      critical) sev_color="#dc2626" ;;
      warning)  sev_color="#f59e0b" ;;
      *)        sev_color="#3b82f6" ;;
    esac
    local slack_text
    slack_text=$(printf "%s %s — %s\n%s\n\n_Server: %s · %s_" \
      "$emoji" "$SERVER_NAME" "$title" "$body" "$SERVER_NAME" "$timestamp")
    jq -n \
      --arg c "$sev_color" \
      --arg t "$slack_text" \
      --arg fb "$emoji $SERVER_NAME — $title" \
      '{ "attachments": [{ "color": $c, "fallback": $fb, "blocks": [
          { "type": "section", "text": { "type": "mrkdwn", "text": $t } }
        ]}]}' \
    | curl -sf -X POST -H 'Content-Type: application/json' \
        -d @- "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 || true
  fi
}

# Perch v2.5 — every alert ships with the same 3-button shape:
#   [🔧 Smart Fix]  [💤 Snooze 1h]  [✅ Ack]
# Smart Fix's callback_data carries the action name; bot/Niyati dispatches it.
# For alerts where no safe Smart Fix exists, BTN_ACK_ONLY drops the fix button.

BTN_3() {
  # Unified Smart Fix shape (v2.5). Caller passes the alert_id (rule_id);
  # the smart router on fix-server picks the action from SMART_FIX_REGISTRY.
  # User always sees "🔧 Smart Fix" — internal routing is invisible.
  local alert="${1:-unknown}"
  printf '[[{"text":"🔧 Smart Fix","callback_data":"perch:smart-fix:%s"},{"text":"💤 Snooze 1h","callback_data":"perch:mute_1h"},{"text":"✅ Ack","callback_data":"perch:ack"}]]' "$alert"
}

BTN_ACK_ONLY='[[{"text":"💤 Snooze 1h","callback_data":"perch:mute_1h"},{"text":"✅ Ack","callback_data":"perch:ack"}]]'

# ────────────────────────────────────────────────────────────────────────────────
# RULE 1 — nginx / nginx-rc service down
# ────────────────────────────────────────────────────────────────────────────────

rule_nginx() {
  local status; status="$(systemctl is-active "$NGINX_SVC" 2>/dev/null)"; status="${status:-unknown}"
  if [ "$status" != "active" ]; then
    local error_summary=""
    if [ -f /var/log/nginx-rc/error.log ]; then
      error_summary="$(tail -3 /var/log/nginx-rc/error.log 2>/dev/null | head -200)"
    elif [ -f /var/log/nginx/error.log ]; then
      error_summary="$(tail -3 /var/log/nginx/error.log 2>/dev/null | head -200)"
    fi

    local body="${NGINX_SVC} is currently *${status}*.
Websites on this server may be unreachable."
    [ -n "$error_summary" ] && body="${body}

Last errors:
\`\`\`
${error_summary}
\`\`\`"

    send_alert "nginx_down" "critical" "Web server is down" "$body" "$(BTN_3 nginx_down)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 2 — PHP-FPM service(s) down
# ────────────────────────────────────────────────────────────────────────────────

rule_php_fpm() {
  local down_services=()
  while IFS= read -r unit; do
    [ -z "$unit" ] && continue
    local status; status="$(systemctl is-active "$unit" 2>/dev/null)"
    [ "$status" != "active" ] && [ "$status" != "" ] && down_services+=("$unit:$status")
  done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
            | awk '/php[0-9]+rc-fpm\.service/{print $1}')

  if [ ${#down_services[@]} -gt 0 ]; then
    local listing
    listing="$(printf -- '- %s\n' "${down_services[@]}")"
    send_alert "php_fpm_down" "critical" "PHP-FPM is down" \
      "PHP-FPM service(s) are not running:\n${listing}\n\nWordPress and PHP sites cannot serve requests." \
      "$(BTN_3 php_fpm_down)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 3 — MySQL / MariaDB down
# ────────────────────────────────────────────────────────────────────────────────

rule_database() {
  local svc=""
  for s in mysql mariadb; do
    if systemctl list-units --all 2>/dev/null | grep -q " ${s}\."; then
      svc="$s"; break
    fi
  done
  [ -z "$svc" ] && return 0

  local status; status="$(systemctl is-active "$svc" 2>/dev/null)"
  if [ "$status" != "active" ]; then
    send_alert "mysql_down" "critical" "Database is down" \
      "${svc} is *${status}*. WordPress, Laravel, and any DB-backed site cannot run.\n\nThis often happens after an out-of-memory event. I can restart it for you." \
      "$(BTN_3 mysql_down)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 4 — Disk usage tiered (warn → high → critical)
# ────────────────────────────────────────────────────────────────────────────────

rule_disk() {
  local pct used total
  pct="$(df / | awk 'NR==2{gsub(/%/,""); print $5}')"
  used="$(df -h / | awk 'NR==2{print $3}')"
  total="$(df -h / | awk 'NR==2{print $2}')"

  if [ "$pct" -ge "$RULE_DISK_CRIT" ]; then
    local top
    top="$(du -sh /home/* /var/log /tmp 2>/dev/null | sort -rh | head -5 | awk '{printf "  %s  %s\n",$1,$2}')"
    send_alert "disk_critical" "critical" "Disk almost full ($pct%)" \
      "$used / $total used. Sites will start failing soon — log writes fail, MySQL can't write, uploads break.\n\nTop offenders:\n\`\`\`\n${top}\n\`\`\`" \
      "$(BTN_3 disk_critical)"
  elif [ "$pct" -ge "$RULE_DISK_HIGH" ]; then
    send_alert "disk_high" "warning" "Disk getting full ($pct%)" \
      "$used / $total used. Time to clean up old logs and rotate backups." \
      "$(BTN_3 disk_high)"
  elif [ "$pct" -ge "$RULE_DISK_WARN" ]; then
    send_alert "disk_warn" "info" "Disk usage rising ($pct%)" \
      "$used / $total used. Just keeping an eye on this — no action needed yet." \
      "$BTN_ACK_ONLY"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 5 — RAM usage tiered
# ────────────────────────────────────────────────────────────────────────────────

rule_ram() {
  local total used pct
  total="$(free -m | awk 'NR==2{print $2}')"
  used="$(free -m | awk 'NR==2{print $3}')"
  [ "$total" -le 0 ] && return 0
  pct=$((used * 100 / total))

  if [ "$pct" -ge "$RULE_RAM_CRIT" ]; then
    local top
    top="$(ps -eo rss,comm --sort=-rss 2>/dev/null | head -6 | tail -5 \
            | awk '{printf "  %dMB  %s\n",$1/1024,$2}')"
    send_alert "ram_critical" "critical" "Memory critical ($pct%)" \
      "${used}MB / ${total}MB used. The kernel is about to start killing processes (OOM).\n\nTop consumers:\n\`\`\`\n${top}\n\`\`\`" \
      "$(BTN_3 ram_critical)"
  elif [ "$pct" -ge "$RULE_RAM_WARN" ]; then
    send_alert "ram_warn" "warning" "Memory pressure ($pct%)" \
      "${used}MB / ${total}MB used. Consider restarting heavy processes (PHP-FPM, PM2)." \
      "$(BTN_3 ram_warn)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 6 — CPU sustained high load
# ────────────────────────────────────────────────────────────────────────────────

rule_cpu_load() {
  local load1 cores pct
  load1="$(awk '{print $1}' /proc/loadavg)"
  cores="$(nproc)"
  [ "$cores" -le 0 ] && cores=1
  pct="$(awk "BEGIN{printf \"%d\", ($load1 / $cores) * 100}")"

  if [ "$pct" -ge "$RULE_LOAD_PCT_CRIT" ]; then
    local top_cpu
    top_cpu="$(ps -eo pcpu,comm --sort=-pcpu 2>/dev/null | head -6 | tail -5 \
                | awk '{printf "  %s%%  %s\n",$1,$2}')"
    send_alert "cpu_critical" "critical" "CPU overloaded ($pct%)" \
      "Load average $load1 with only $cores core(s).\n\nTop processes:\n\`\`\`\n${top_cpu}\n\`\`\`" \
      "$(BTN_3 cpu_critical)"
  elif [ "$pct" -ge "$RULE_LOAD_PCT_WARN" ]; then
    send_alert "cpu_warn" "warning" "CPU under load ($pct%)" \
      "Load average $load1 across $cores core(s). Could be a traffic spike or runaway process." \
      "$(BTN_3 cpu_warn)"
  else
    # Load is OK but check for a single process spinning (catches early busy-loops
    # before they drag up the 1-minute average, e.g. one thread at 100% on 2 cores = 50% load)
    local busy_procs
    busy_procs="$(ps -eo pid,user,comm,pcpu --sort=-pcpu --no-headers 2>/dev/null | \
      awk '$4+0 > 85.0 && $3 !~ /^(kworker|migration|rcu_|ksoftirqd|irq|cpuhp|scsi_|mmcqd|jbd2|ext4)/' | head -3)"
    if [ -n "${busy_procs:-}" ]; then
      local top_info
      top_info="$(printf '%s' "$busy_procs" | awk '{printf "  PID %s (%s): %s%%\n",$1,$3,$4}')"
      send_alert "cpu_busyloop" "warning" "CPU busy-loop detected" \
        "A process is holding >85% CPU while overall load is still low — caught early:\n\`\`\`\n${top_info}\n\`\`\`\nLikely a stuck request, infinite loop, or runaway script." \
        "$(BTN_3 cpu_busyloop)"
    fi
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 7 — Orphan processes (PPID=1)
# ────────────────────────────────────────────────────────────────────────────────

rule_orphans() {
  # 1. Zombie + stuck mail/sudo loop processes
  local zombies
  zombies="$(ps -eo state --no-headers 2>/dev/null | awk '$1=="Z"' | wc -l | tr -d ' ')"
  zombies="${zombies:-0}"

  local stuck
  stuck="$(pgrep -f 'sudo cat |sendmail -t|postdrop -r' 2>/dev/null | wc -l | tr -d ' ')"
  stuck="${stuck:-0}"

  local total=$((zombies + stuck))
  if [ "$total" -gt "$RULE_ORPHAN_WARN" ]; then
    send_alert "orphans" "warning" "Stuck/zombie processes: $total" \
      "Detected ${zombies} zombie(s) (state=Z) + ${stuck} stuck mail/sudo loop(s). Smart Fix reaps them safely (does NOT touch nginx-rc, php-fpm, mariadb, redis, or any legit RunCloud service)." \
      "$(BTN_3 orphans)"
  fi

  # 2. WP-Cron pile-up (>2 running = stuck loops that didn't exit)
  local wpcron_n
  wpcron_n="$(pgrep -c -f 'wp-cron\.php' 2>/dev/null || echo 0)"
  if [ "${wpcron_n:-0}" -gt 2 ]; then
    send_alert "wpcron_pileup" "warning" "WP-Cron pile-up: ${wpcron_n} processes" \
      "${wpcron_n} wp-cron.php processes stuck running (normal is ≤1). WordPress scheduled tasks are looping and not exiting — likely a slow plugin HTTP callback or cron flood.\n\nThis eats PHP workers and causes 503s under load. Smart Fix restarts the PHP-FPM pool to clear them." \
      "$(BTN_3 webapp_php)"
  fi

  # 3. PM2 crash-loops across all apps (≥10 restarts)
  local pm2_loops
  pm2_loops="$(pm2 list --no-color 2>/dev/null | awk '
    /^[│|]/ {
      gsub(/[│|]/, " ")
      name=""; restarts=0; found_name=0
      for(i=1;i<=NF;i++) {
        if(!found_name && $i~/^[a-zA-Z]/ && length($i)>1) { name=$i; found_name=1 }
        else if($i~/^[0-9]+$/ && $i+0 >= 10 && name!="" && name!="id") restarts=$i+0
      }
      if(restarts >= 10) print name " (" restarts " restarts)"
    }' | head -5)"
  if [ -n "${pm2_loops:-}" ]; then
    local list; list="$(printf -- '• %s\n' $pm2_loops)"
    send_alert "pm2_crashloop" "warning" "PM2 crash-loop detected" \
      "App(s) restarting repeatedly:\n${list}\n\nLikely cause: OOM kill, missing env var, or unhandled exception. Check PM2 logs for the error message." \
      "$(BTN_3 webapp_pm2crash)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 8 — Failed systemd services
# ────────────────────────────────────────────────────────────────────────────────

rule_failed_services() {
  local failed
  # Filter user@N.service — systemd user-session managers; SIGKILL'd on every SSH
  # disconnect on RunCloud/Ubuntu. Not actionable, not a real failure.
  failed="$(systemctl --failed --no-legend --plain 2>/dev/null \
            | awk '{print $1}' \
            | grep -Ev '^user@[0-9]+\.service$' \
            | head -10)"
  if [ -n "$failed" ]; then
    local list; list="$(printf -- '- %s\n' $failed)"
    send_alert "failed_svc" "warning" "Failed services" \
      "These systemd units are in a failed state:\n\`\`\`\n${list}\n\`\`\`" \
      "$(BTN_3 failed_svc)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 9 — SSL certificate expiry per site
# ────────────────────────────────────────────────────────────────────────────────

rule_ssl_expiry() {
  [ -z "$MONITOR_SITES" ] && return 0
  command -v openssl >/dev/null 2>&1 || return 0
  IFS=',' read -ra SITES <<< "$MONITOR_SITES"

  local now_epoch; now_epoch="$(date +%s)"
  for raw in "${SITES[@]}"; do
    local site; site="$(echo "$raw" | tr -d ' ')"
    [ -z "$site" ] && continue
    local end_date
    end_date="$(echo | timeout 10 openssl s_client -servername "$site" -connect "$site:443" 2>/dev/null \
                  | openssl x509 -noout -enddate 2>/dev/null \
                  | sed 's/notAfter=//')"
    [ -z "$end_date" ] && continue
    local end_epoch; end_epoch="$(date -d "$end_date" +%s 2>/dev/null || echo 0)"
    [ "$end_epoch" = 0 ] && continue
    local days_left=$(( (end_epoch - now_epoch) / 86400 ))

    if [ "$days_left" -le "$RULE_SSL_DAYS_CRIT" ]; then
      send_alert "ssl_${site}" "critical" "SSL expiring soon: $site" \
        "Certificate for *${site}* expires in *${days_left} day(s)*. Browser warnings will start showing." \
        "$(BTN_3 ssl_critical)"
    elif [ "$days_left" -le "$RULE_SSL_DAYS_WARN" ]; then
      send_alert "ssl_${site}_warn" "warning" "SSL renewal due: $site" \
        "Certificate for ${site} expires in ${days_left} days. Time to renew." \
        "$(BTN_3 ssl_expiring)"
    fi
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 10 — Site HTTP availability (5xx / unreachable)
# ────────────────────────────────────────────────────────────────────────────────

rule_http_availability() {
  [ -z "$MONITOR_SITES" ] && return 0
  IFS=',' read -ra SITES <<< "$MONITOR_SITES"

  for raw in "${SITES[@]}"; do
    local site; site="$(echo "$raw" | tr -d ' ')"
    [ -z "$site" ] && continue
    local code
    code="$(curl -sk -o /dev/null --max-time 15 -w '%{http_code}' "https://${site}/" 2>/dev/null \
            || curl -s -o /dev/null --max-time 15 -w '%{http_code}' "http://${site}/" 2>/dev/null \
            || echo 0)"

    if [ "$code" = "0" ]; then
      send_alert "http_${site}" "critical" "Site unreachable: $site" \
        "Could not connect to https://${site}/ or http://${site}/. DNS, firewall, or web server may be down." \
        "$(BTN_3 site_down)"
    elif [ "$code" -ge 500 ] && [ "$code" -lt 600 ]; then
      send_alert "http_${site}_${code}" "critical" "Site returning $code: $site" \
        "https://${site}/ returns HTTP $code.\n\nLikely cause: PHP fatal error, plugin conflict, or stack overflow. I can pull the error log for you." \
        "$(BTN_3 site_5xx)"
    fi
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 11 — Custom port checks (CSV of TCP ports)
# ────────────────────────────────────────────────────────────────────────────────

rule_custom_ports() {
  [ -z "$MONITOR_PORTS" ] && return 0
  command -v nc >/dev/null 2>&1 || return 0
  IFS=',' read -ra PORTS <<< "$MONITOR_PORTS"
  local down=()

  for raw in "${PORTS[@]}"; do
    local port; port="$(echo "$raw" | tr -d ' ')"
    [ -z "$port" ] && continue
    nc -z 127.0.0.1 "$port" 2>/dev/null || down+=("$port")
  done

  if [ ${#down[@]} -gt 0 ]; then
    local list; list="$(printf -- '- 127.0.0.1:%s\n' "${down[@]}")"
    send_alert "ports_down" "warning" "Custom ports unreachable" \
      "These ports are not listening on localhost:\n\`\`\`\n${list}\n\`\`\`\nApps bound to these ports may have crashed." \
      "$(BTN_3 ports_down)"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 12 — fail2ban ban-rate spike
# ────────────────────────────────────────────────────────────────────────────────

rule_fail2ban_spike() {
  command -v fail2ban-client >/dev/null 2>&1 || return 0
  systemctl is-active fail2ban &>/dev/null || return 0

  local since="1 hour ago"
  local bans
  bans=$(journalctl -u fail2ban --since "$since" --no-pager 2>/dev/null | grep -c ' Ban ' 2>/dev/null || true)
  # Defensive: command-substitution quirks under cron can leave multi-line / whitespace residue here.
  bans="${bans//[^0-9]/}"
  bans="${bans:-0}"
  local rate; rate="${RULE_FAIL2BAN_BAN_RATE//[^0-9]/}"; rate="${rate:-50}"
  if [ "$bans" -gt "$rate" ]; then
    send_alert "fail2ban_spike" "warning" "Brute force surge" \
      "fail2ban banned *${bans}* IP(s) in the last hour. You may be under a brute-force or scanner sweep.\n\nIf this is sustained, consider tightening rate limits or enabling additional jails." \
      "$BTN_ACK_ONLY"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 13 — Backup age (RunCloud backup logs)
# ────────────────────────────────────────────────────────────────────────────────

rule_backup_age() {
  local newest=0
  shopt -s nullglob
  for log in /var/log/runcloud/backup* /home/*/logs/backup*; do
    [ ! -f "$log" ] && continue
    local mtime; mtime="$(stat -c %Y "$log" 2>/dev/null || echo 0)"
    [ "$mtime" -gt "$newest" ] && newest="$mtime"
  done
  shopt -u nullglob

  [ "$newest" -eq 0 ] && return 0  # no backup logs found at all → silent
  local now hours
  now="$(date +%s)"
  hours=$(( (now - newest) / 3600 ))
  if [ "$hours" -gt 36 ]; then
    send_alert "backup_stale" "warning" "Backup may be stalled" \
      "No fresh backup activity detected in the last *${hours}h*. Last RunCloud backup log was $hours hours ago. Check the backup destination is reachable." \
      "$BTN_ACK_ONLY"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 14 — Heartbeat (daily proof-of-life summary, 09:00 local)
# ────────────────────────────────────────────────────────────────────────────────

rule_heartbeat() {
  [ "${RULE_HEARTBEAT:-on}" != "on" ] && return 0
  local hour minute
  hour="$(TZ="$TZ_NAME" date +%H)"
  minute="$(TZ="$TZ_NAME" date +%M)"
  # Only fire between 09:00 and 09:09 local
  [ "$hour" != "09" ] && return 0
  [ "$minute" -gt 9 ] && return 0

  local stamp
  stamp="$STATE_DIR/heartbeat_$(TZ="$TZ_NAME" date +%Y%m%d)"
  [ -f "$stamp" ] && return 0
  touch "$stamp"

  local total used pct disk_pct load1 cores ngx
  total="$(free -m | awk 'NR==2{print $2}')"
  used="$(free -m  | awk 'NR==2{print $3}')"
  pct=$((used * 100 / (total > 0 ? total : 1)))
  disk_pct="$(df / | awk 'NR==2{gsub(/%/,""); print $5}')"
  load1="$(awk '{print $1}' /proc/loadavg)"
  cores="$(nproc)"
  ngx="$(systemctl is-active "$NGINX_SVC" 2>/dev/null || echo unknown)"

  send_alert "heartbeat_$(date +%Y%m%d)" "info" "Daily check-in" \
    "All systems good 🪶\n\n• RAM ${pct}% (${used}MB/${total}MB)\n• Disk ${disk_pct}%\n• Load ${load1} on ${cores} core(s)\n• ${NGINX_SVC}: ${ngx}" \
    "$BTN_ACK_ONLY"
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 15 — Per-webapp stack health (auto-discovers all RunCloud webapps)
# ────────────────────────────────────────────────────────────────────────────────

rule_webapp_health() {
  command -v sudo >/dev/null 2>&1 || return 0

  local php_alerts=() pm2_alerts=()

  while IFS= read -r appdir; do
    [ -z "$appdir" ] && continue
    local appname; appname="$(basename "$appdir")"
    local username; username="$(printf '%s' "$appdir" | awk -F/ '{print $3}')"

    # Single find call to detect stack — checks all sentinel files at once
    local sentinels
    sentinels="$(sudo find "$appdir" -maxdepth 2 \
      \( -name "wp-config.php" -o -name "package.json" -o -name "requirements.txt" -o -name "artisan" \) \
      -type f 2>/dev/null | head -5)"

    local stack="unknown"
    printf '%s' "$sentinels" | grep -q "wp-config.php" && stack="wordpress"
    printf '%s' "$sentinels" | grep -q "artisan"        && stack="laravel"
    [ "$stack" = "unknown" ] && printf '%s' "$sentinels" | grep -q "package.json"     && stack="nodejs"
    [ "$stack" = "unknown" ] && printf '%s' "$sentinels" | grep -q "requirements.txt" && stack="python"

    # WordPress / Laravel — check PHP-FPM pool saturation in FPM logs
    if [ "$stack" = "wordpress" ] || [ "$stack" = "laravel" ]; then
      for fpmlog in /var/log/php*rc-fpm.log; do
        [ -f "$fpmlog" ] || continue
        local sat
        sat="$(sudo tail -200 "$fpmlog" 2>/dev/null | \
          grep -c "pool ${appname}.*max_children\|max_children.*pool ${appname}" 2>/dev/null || echo 0)"
        if [ "${sat:-0}" -gt 0 ]; then
          php_alerts+=("${appname}:sat:${sat}")
          break
        fi
      done
    fi

    # Node.js — check PM2 crash-loops for this specific app
    if [ "$stack" = "nodejs" ]; then
      local restarts
      restarts="$(pm2 list --no-color 2>/dev/null | awk -v app="$appname" '
        $0 ~ app {
          for(i=1;i<=NF;i++) if($i~/^[0-9]+$/ && $i+0 >= 10) { print $i; exit }
        }' | head -1)"
      [ -n "${restarts:-}" ] && pm2_alerts+=("${appname}:${username}:${restarts}")
    fi

  done < <(sudo find /home -mindepth 3 -maxdepth 3 -type d -path "*/webapps/*" 2>/dev/null | sort)

  # PHP-FPM pool saturation alerts
  if [ ${#php_alerts[@]} -gt 0 ]; then
    local body=""
    for entry in "${php_alerts[@]}"; do
      local aname atype aval
      IFS=: read -r aname atype aval <<< "$entry"
      body="${body}• *${aname}*: PHP-FPM pool hit max_children ${aval}× recently\n"
    done
    body="${body}\nAll PHP workers are allocated — new requests are queuing. This causes response delays and eventual 503s.\n\nQuick fix: Smart Fix restarts the pool. Long-term: reduce start_servers or memory_limit in RunCloud → PHP Settings."
    send_alert "webapp_phpsat" "warning" "PHP-FPM pool saturation" "$body" "$(BTN_3 webapp_php)"
  fi

  # PM2 app crash-loop alerts (webapp-specific, complements the global PM2 check in rule_orphans)
  if [ ${#pm2_alerts[@]} -gt 0 ]; then
    local body=""
    for entry in "${pm2_alerts[@]}"; do
      local aname auser aval
      IFS=: read -r aname auser aval <<< "$entry"
      body="${body}• *${aname}* (${auser}): ${aval} restarts\n"
    done
    body="${body}\nApp is in a crash-loop. Common causes: OOM kill, missing env var, unhandled exception.\n\nCheck PM2 logs: \`pm2 logs ${pm2_alerts[0]%%:*} --lines 30\`"
    send_alert "webapp_pm2crash" "warning" "Node.js app crash-loop" "$body" "$(BTN_3 webapp_pm2crash)"
  fi
}

# ── Run all rules ─────────────────────────────────────────────────────────────

rule_nginx
rule_php_fpm
rule_database
rule_disk
rule_ram
rule_cpu_load
rule_orphans
rule_webapp_health
rule_failed_services
rule_ssl_expiry
rule_http_availability
rule_custom_ports
rule_fail2ban_spike
rule_backup_age
rule_heartbeat

exit 0
