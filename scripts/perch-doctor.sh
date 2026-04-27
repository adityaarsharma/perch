#!/usr/bin/env bash
# perch doctor — 10-row health card for every Perch block.
#
# Usage:
#   ./scripts/perch-doctor.sh                  # full report
#   ./scripts/perch-doctor.sh --json           # JSON output for automation
#
# Each row shows: status emoji · block · check · detail.
# Exit code 0 = all healthy, 1 = at least one fail.

set -uo pipefail

JSON_MODE=0
[ "${1:-}" = "--json" ] && JSON_MODE=1

PERCH_HOME="${PERCH_HOME:-$HOME/.perch}"
BRAIN_DB="${PERCH_BRAIN_PATH:-$PERCH_HOME/brain.db}"
VAULT_FILE="${PERCH_VAULT_DIR:-$PERCH_HOME}/vault.json"
ENV_FILE="$PERCH_HOME/.env"
API_PORT="${PERCH_API_PORT:-3013}"
API_HOST="${PERCH_API_HOST:-127.0.0.1}"

# Try to source .env for tokens / config (read-only, soft-fail)
if [ -r "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE" 2>/dev/null || true; set +a
fi

OVERALL_OK=0
ROWS=()

row() {
  # row <ok|warn|fail> <block> <check> <detail>
  local status="$1" block="$2" check="$3" detail="$4"
  ROWS+=("${status}|${block}|${check}|${detail}")
  [ "$status" = "fail" ] && OVERALL_OK=1
}

# ── Block 01: Core/Brain ──────────────────────────────────────────────────
if [ -f "$BRAIN_DB" ]; then
  size=$(stat -c '%s' "$BRAIN_DB" 2>/dev/null || stat -f '%z' "$BRAIN_DB" 2>/dev/null || echo 0)
  if command -v sqlite3 >/dev/null 2>&1; then
    n_servers=$(sqlite3 "$BRAIN_DB" "SELECT count(*) FROM servers;" 2>/dev/null || echo "?")
    n_webapps=$(sqlite3 "$BRAIN_DB" "SELECT count(*) FROM webapps;" 2>/dev/null || echo "?")
    n_problems=$(sqlite3 "$BRAIN_DB" "SELECT count(*) FROM problems;" 2>/dev/null || echo "?")
    row ok "01 Core/Brain" "SQLite" "${n_servers} servers · ${n_webapps} webapps · ${n_problems} problems · ${size}B"
  else
    row warn "01 Core/Brain" "SQLite" "file present (${size}B), sqlite3 CLI missing — install for full check"
  fi
else
  row fail "01 Core/Brain" "SQLite" "missing at $BRAIN_DB"
fi

# ── Block 02: Vault ───────────────────────────────────────────────────────
if [ -f "$VAULT_FILE" ]; then
  if command -v jq >/dev/null 2>&1; then
    n_entries=$(jq -r '.entries | length' "$VAULT_FILE" 2>/dev/null || echo "?")
    row ok "02 Vault" "vault.json" "${n_entries} entries · mode $(stat -c '%a' "$VAULT_FILE" 2>/dev/null || echo ?)"
  else
    row ok "02 Vault" "vault.json" "present, jq missing for entry count"
  fi
else
  row warn "02 Vault" "vault.json" "no vault yet — run 'npm run vault put' to create"
fi

# ── Block 03: HTTP API + MCP ──────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  health_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://${API_HOST}:${API_PORT}/health" 2>/dev/null || echo "000")
  if [ "$health_code" = "200" ]; then
    if [ -n "${PERCH_API_TOKEN:-}" ]; then
      n_tools=$(curl -sS --max-time 3 -H "Authorization: Bearer ${PERCH_API_TOKEN}" "http://${API_HOST}:${API_PORT}/api/tools" 2>/dev/null | grep -oE '"[a-z_.]+"' | wc -l | tr -d ' ')
      row ok "03 HTTP API" "perch-api" "live on :${API_PORT} · ${n_tools} tool entries"
    else
      row warn "03 HTTP API" "perch-api" "live on :${API_PORT} · PERCH_API_TOKEN not set in .env"
    fi
  else
    row fail "03 HTTP API" "perch-api" "health returned ${health_code} — check 'systemctl status perch-api'"
  fi
else
  row warn "03 HTTP API" "perch-api" "curl missing — can't probe"
fi

# ── Block 04: Monitor ─────────────────────────────────────────────────────
cron_line=$(crontab -l 2>/dev/null | grep -E 'monitor\.sh' | head -1)
if [ -n "$cron_line" ]; then
  monitor_log="/tmp/perch-monitor.log"
  if [ -r "$monitor_log" ]; then
    last_mtime=$(stat -c '%Y' "$monitor_log" 2>/dev/null || stat -f '%m' "$monitor_log" 2>/dev/null || echo 0)
    age=$(( $(date +%s) - last_mtime ))
    if [ "$age" -lt 600 ]; then
      row ok "04 Monitor" "cron" "last run ${age}s ago"
    else
      row warn "04 Monitor" "cron" "last run ${age}s ago (>10 min — cron may have stalled)"
    fi
  else
    row warn "04 Monitor" "cron" "cron entry exists but log unreadable"
  fi
else
  row fail "04 Monitor" "cron" "no monitor.sh entry in crontab — run setup"
fi

mute_file="${MONITOR_MUTE_FILE:-/tmp/perch-monitor-muted}"
if [ -f "$mute_file" ]; then
  expiry=$(cat "$mute_file" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$expiry" -gt "$now" ] 2>/dev/null; then
    until_str=$(date -d @"$expiry" '+%H:%M' 2>/dev/null || echo "?")
    row warn "04 Monitor" "mute" "ACTIVE until ${until_str}"
  fi
fi

# ── Block 05: Notifier (Telegram) ─────────────────────────────────────────
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  bot_check=$(curl -sS --max-time 3 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" 2>/dev/null | grep -oE '"ok":true' || echo "")
  if [ -n "$bot_check" ]; then
    row ok "05 Notifier" "Telegram" "bot token valid"
  else
    row fail "05 Notifier" "Telegram" "token rejected by api.telegram.org"
  fi
else
  row warn "05 Notifier" "Telegram" "TELEGRAM_BOT_TOKEN not set"
fi

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  row ok "05 Notifier" "Slack" "webhook configured"
else
  row warn "05 Notifier" "Slack" "SLACK_WEBHOOK_URL not set (optional)"
fi

# ── Block 06: LLM ─────────────────────────────────────────────────────────
if [ -n "${GEMINI_API_KEY:-}" ]; then
  resp=$(curl -sS --max-time 5 -X POST \
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}" \
    -H 'Content-Type: application/json' \
    -d '{"contents":[{"parts":[{"text":"reply only YES"}]}],"generationConfig":{"maxOutputTokens":5}}' 2>/dev/null)
  if echo "$resp" | grep -q '"candidates"'; then
    row ok "06 LLM" "Gemini" "Flash responding · conversational mode ON"
  else
    err=$(echo "$resp" | grep -oE '"message":"[^"]+"' | head -1 | cut -d'"' -f4)
    row fail "06 LLM" "Gemini" "key set but rejected: ${err:-unknown error}"
  fi
else
  row warn "06 LLM" "Gemini" "GEMINI_API_KEY not set — buttons-only mode (still works)"
fi

# ── Block 07: RunCloud ────────────────────────────────────────────────────
if [ -n "${RUNCLOUD_API_KEY:-}" ]; then
  rc_resp=$(curl -sS --max-time 5 -H "Authorization: Bearer ${RUNCLOUD_API_KEY}" \
    "https://manage.runcloud.io/api/v3/servers?perPage=1" 2>/dev/null)
  if echo "$rc_resp" | grep -q '"data"'; then
    row ok "07 RunCloud" "API" "key valid · API reachable"
  else
    row fail "07 RunCloud" "API" "key set but API call failed"
  fi
else
  row warn "07 RunCloud" "API" "RUNCLOUD_API_KEY not set — fs-aware scripts still work"
fi

if systemctl is-active nginx-rc >/dev/null 2>&1; then
  row ok "07 RunCloud" "nginx-rc" "service active"
else
  row fail "07 RunCloud" "nginx-rc" "service not active — RunCloud install may be broken"
fi

# ── Block 08: WordPress (samples webapp registry) ─────────────────────────
if [ -f "$BRAIN_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  n_wp=$(sqlite3 "$BRAIN_DB" "SELECT count(*) FROM webapps WHERE framework LIKE '%wordpress%' OR framework='wp';" 2>/dev/null || echo 0)
  row ok "08 WordPress" "registry" "${n_wp} WP webapps tracked in brain.db"
else
  row warn "08 WordPress" "registry" "brain.db unavailable — can't enumerate"
fi

# ── Block 09: Lifecycle (this script presence) ────────────────────────────
if [ -f "$(dirname "$0")/install.sh" ]; then
  row ok "09 Lifecycle" "scripts" "install/update/uninstall present"
else
  row warn "09 Lifecycle" "scripts" "install.sh missing in this checkout"
fi

# ── Block 10: Distribution (repo + landing) ───────────────────────────────
if [ -d "$(dirname "$0")/../web" ]; then
  row ok "10 Distribution" "landing" "web/ directory present"
else
  row warn "10 Distribution" "landing" "web/ missing in this checkout"
fi

# ── Render ────────────────────────────────────────────────────────────────

emoji_for() {
  case "$1" in
    ok) echo "✅" ;;
    warn) echo "⚠️ " ;;
    fail) echo "❌" ;;
    *) echo "•" ;;
  esac
}

if [ "$JSON_MODE" = "1" ]; then
  echo "{"
  echo "  \"overall_ok\": $([ $OVERALL_OK -eq 0 ] && echo true || echo false),"
  echo "  \"checks\": ["
  for ((i=0; i<${#ROWS[@]}; i++)); do
    IFS='|' read -r status block check detail <<< "${ROWS[$i]}"
    sep=","; [ $i -eq $((${#ROWS[@]}-1)) ] && sep=""
    printf '    {"status":"%s","block":"%s","check":"%s","detail":"%s"}%s\n' \
      "$status" "$block" "$check" "$detail" "$sep"
  done
  echo "  ]"
  echo "}"
else
  echo ""
  echo "🪶  Perch doctor  ·  $(date '+%Y-%m-%d %H:%M %Z')"
  echo "─────────────────────────────────────────────────────────────────────────"
  printf "%-3s %-18s %-14s %s\n" "" "Block" "Check" "Detail"
  echo "─────────────────────────────────────────────────────────────────────────"
  for line in "${ROWS[@]}"; do
    IFS='|' read -r status block check detail <<< "$line"
    printf "%-3s %-18s %-14s %s\n" "$(emoji_for "$status")" "$block" "$check" "$detail"
  done
  echo "─────────────────────────────────────────────────────────────────────────"
  if [ $OVERALL_OK -eq 0 ]; then
    echo "Status: ✅  all green"
  else
    echo "Status: ❌  at least one block needs attention (see ❌ rows above)"
  fi
fi

exit $OVERALL_OK
