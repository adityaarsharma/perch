#!/usr/bin/env bash
# Perch — Deep server diagnostics for RunCloud. No changes to system — read-only.
# Called by /analyze endpoint and by smart-fix for LLM context.
set -uo pipefail

echo "=== Perch Diagnostics: $(date '+%Y-%m-%d %H:%M:%S') ==="

# --- RAM ---
echo ""
echo "-- Memory --"
free -h | awk 'NR<=2'
echo "Top RAM consumers:"
ps -eo comm,user,rss --sort=-rss 2>/dev/null | head -13 | tail -12 | \
  awk '{printf "  %-22s %-16s %dMB\n", $1, $2, int($3/1024)}'

# --- Load ---
echo ""
echo "-- Load --"
uptime | awk -F'load average:' '{print "  " $2}' | tr -d ' '
echo "  CPUs: $(nproc)"

# --- PHP-FPM Pool Health ---
echo ""
echo "-- PHP-FPM Pools (RunCloud: php{ver}rc-fpm) --"
PHP_FOUND=0
for log in /var/log/php*rc-fpm.log; do
  [ -f "$log" ] || continue
  PHP_FOUND=1
  ver=$(basename "$log" | grep -oE 'php[0-9]+rc')
  svc="${ver}-fpm"
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  echo "  ${svc}: ${status}"
  # Warnings (last 100 log lines)
  warns=$(tail -100 "$log" 2>/dev/null | grep -E "WARNING|CRITICAL|max_children|reached pm" | \
    sed 's/.*\] //' | head -5)
  if [ -n "$warns" ]; then
    echo "  ⚠  Pool warnings:"
    echo "$warns" | sed 's/^/      /'
  fi
  # Last errors
  errs=$(tail -50 "$log" 2>/dev/null | grep -iE "ERROR|FATAL" | tail -3)
  if [ -n "$errs" ]; then
    echo "  ✗  Errors:"
    echo "$errs" | sed 's/^/      /'
  fi
done
[ "$PHP_FOUND" -eq 0 ] && echo "  (no php*rc-fpm.log files found)"

# --- nginx-rc Errors Per Webapp ---
echo ""
echo "-- nginx-rc Errors per Webapp --"
ERRS_FOUND=0
for errlog in /home/*/logs/nginx/*_error.log; do
  [ -f "$errlog" ] || continue
  app=$(basename "$errlog" | sed 's/_error.log//')
  # Count errors in tail-500 lines
  cnt=$(tail -500 "$errlog" 2>/dev/null | grep -cE "\[error\]|\[crit\]|\[emerg\]" 2>/dev/null || echo 0)
  [ "$cnt" -eq 0 ] && continue
  ERRS_FOUND=1
  echo "  ${app}: ${cnt} errors"
  # Top 3 most recent distinct error messages
  tail -500 "$errlog" 2>/dev/null | grep -E "\[error\]|\[crit\]|\[emerg\]" | \
    sed 's/.*\] //' | sed 's/, client:.*//' | sort | uniq -c | sort -rn | head -3 | \
    sed 's/^/    /'
done
[ "$ERRS_FOUND" -eq 0 ] && echo "  No recent errors in nginx-rc logs"

# --- 5xx Responses Per Webapp (last 500 access log lines) ---
echo ""
echo "-- 5xx Responses per Webapp --"
FIVE_FOUND=0
for acclog in /home/*/logs/nginx/*_access.log; do
  [ -f "$acclog" ] || continue
  app=$(basename "$acclog" | sed 's/_access.log//')
  fivex=$(tail -500 "$acclog" 2>/dev/null | awk '$9+0>=500 && $9+0<600 {print $9, $7}' | \
    sort | uniq -c | sort -rn | head -5)
  [ -z "$fivex" ] && continue
  FIVE_FOUND=1
  echo "  ${app}:"
  echo "$fivex" | sed 's/^/    /'
done
[ "$FIVE_FOUND" -eq 0 ] && echo "  No 5xx responses in recent access logs"

# --- Top URL patterns by request count (last 200 per app) ---
echo ""
echo "-- Top Requested URLs (last 200 per app, 5xx-heavy only) --"
for acclog in /home/*/logs/nginx/*_access.log; do
  [ -f "$acclog" ] || continue
  app=$(basename "$acclog" | sed 's/_access.log//')
  # Only show if has 5xx
  has_5xx=$(tail -200 "$acclog" 2>/dev/null | awk '$9+0>=500{c++} END{print c+0}')
  [ "${has_5xx:-0}" -eq 0 ] && continue
  echo "  ${app} top paths hitting 5xx:"
  tail -200 "$acclog" 2>/dev/null | awk '$9+0>=500{print $7}' | \
    sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
done

# --- Service Status ---
echo ""
echo "-- Service Status --"
for svc in nginx-rc php81rc-fpm php82rc-fpm php83rc-fpm php84rc-fpm mariadb redis; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
  icon="✅"; [ "$status" != "active" ] && icon="❌"
  echo "  ${icon} ${svc}: ${status}"
done

# --- Disk ---
echo ""
echo "-- Disk --"
df -h / | tail -1 | awk '{printf "  / → %s used of %s (%s)\n", $3, $2, $5}'
# Largest dirs under /home if >90%
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
if [ "${DISK_PCT:-0}" -gt 85 ]; then
  echo "  ⚠  Disk ${DISK_PCT}% — top dirs:"
  du -sh /home/*/ 2>/dev/null | sort -rh | head -6 | sed 's/^/    /'
fi

# --- ClickHouse (RunCloud Hub analytics — non-systemd) ---
CH_PID=$(pgrep -f 'clickhouse-server' 2>/dev/null | head -1)
if [ -n "${CH_PID:-}" ]; then
  CH_RAM=$(ps -p "$CH_PID" -o rss= 2>/dev/null | awk '{printf "%dMB", int($1/1024)}')
  echo ""
  echo "-- ClickHouse (RunCloud Hub) --"
  echo "  PID ${CH_PID}: ${CH_RAM} RAM — non-systemd, RunCloud-managed"
fi

echo ""
echo "=== End Diagnostics ==="
