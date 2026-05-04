#!/usr/bin/env bash
# Perch — Comprehensive loop/orphan/stuck-process detection. Read-only, no changes.
# Covers: zombies, WP-cron pile-up, PHP-FPM pool saturation, stuck workers,
#         CPU busy-loops, PM2 crash-storms, duplicate instances, stuck mail queues.
set -uo pipefail

FOUND=0
echo "=== Loop/Orphan Detection: $(date '+%Y-%m-%d %H:%M:%S') ==="

# --- 1. Zombie processes ---
echo ""
echo "-- Zombie Processes --"
ZOMBIES=$(ps -eo state,pid,user,comm --no-headers 2>/dev/null | awk '$1=="Z" {print $2, $3, $4}')
ZOMBIE_N=$(printf '%s\n' "$ZOMBIES" | grep -c '[0-9]' 2>/dev/null || echo 0)
if [ "${ZOMBIE_N:-0}" -gt 0 ]; then
  echo "  ⚠ ${ZOMBIE_N} zombie(s):"
  printf '%s\n' "$ZOMBIES" | head -5 | sed 's/^/    /'
  FOUND=1
else
  echo "  ✅ None"
fi

# --- 2. WP-Cron pile-up (WordPress HTTP cron spawns that never terminate) ---
echo ""
echo "-- WP-Cron Processes --"
WPCRON_LIST=$(pgrep -a -f 'wp-cron\.php' 2>/dev/null || true)
WPCRON_N=$(printf '%s\n' "$WPCRON_LIST" | grep -c '[0-9]' 2>/dev/null || echo 0)
if [ "${WPCRON_N:-0}" -gt 2 ]; then
  echo "  ⚠ ${WPCRON_N} wp-cron.php processes (pile-up — normal is ≤1):"
  printf '%s\n' "$WPCRON_LIST" | head -5 | sed 's/^/    /'
  FOUND=1
elif [ "${WPCRON_N:-0}" -gt 0 ]; then
  echo "  ✅ ${WPCRON_N} wp-cron (normal)"
else
  echo "  ✅ None"
fi

# --- 3. PHP-FPM pool saturation (workers maxed, new requests being queued) ---
echo ""
echo "-- PHP-FPM Pool Saturation (RunCloud: php{ver}rc-fpm) --"
FPM_FOUND=0
for log in /var/log/php*rc-fpm.log; do
  [ -f "$log" ] || continue
  FPM_FOUND=1
  ver=$(basename "$log" | grep -oE 'php[0-9]+rc')
  # max_children hits in last 200 lines (covers ~last hour depending on traffic)
  recent=$(sudo tail -200 "$log" 2>/dev/null | grep -c "max_children" 2>/dev/null || echo 0)
  oom=$(sudo tail -200 "$log" 2>/dev/null | grep -c "SIGKILL\|exited on signal 9" 2>/dev/null || echo 0)
  if [ "${recent:-0}" -gt 0 ] || [ "${oom:-0}" -gt 0 ]; then
    pools=$(sudo tail -200 "$log" 2>/dev/null | grep "max_children" | \
      sed 's/.*\[pool //' | sed 's/\].*//' | sort | uniq -c | sort -rn | head -3 | \
      awk '{print $2"("$1"x)"}' | paste -sd, 2>/dev/null || echo "unknown")
    echo "  ⚠ ${ver}: max_children hit ${recent}× | OOM kills: ${oom} | pools: ${pools}"
    FOUND=1
  else
    echo "  ✅ ${ver}: healthy"
  fi
done
[ "$FPM_FOUND" -eq 0 ] && echo "  (no php*rc-fpm.log found)"

# --- 4. Stuck PHP-FPM workers (running >5min = likely a hung request) ---
echo ""
echo "-- Stuck PHP Workers (running >5min) --"
STUCK_PHP=$(ps -eo pid,user,etimes,comm --no-headers 2>/dev/null | \
  awk '$4=="php-fpm" && $3 > 300 {printf "PID %s user=%s %dmin\n", $1, $2, int($3/60)}' | head -5)
if [ -n "${STUCK_PHP:-}" ]; then
  echo "  ⚠ Long-running PHP workers:"
  printf '%s\n' "$STUCK_PHP" | sed 's/^/    /'
  FOUND=1
else
  echo "  ✅ All workers within normal time"
fi

# --- 5. CPU busy-loop (non-kernel processes using >85% CPU) ---
echo ""
echo "-- CPU Busy-Loops --"
BUSY=$(ps -eo pid,user,comm,pcpu --sort=-pcpu --no-headers 2>/dev/null | \
  awk '$4+0 > 85.0 && $3 !~ /^(kworker|migration|rcu_|ksoftirqd|irq|cpuhp|scsi_|mmcqd|jbd2|ext4)/' | head -5)
if [ -n "${BUSY:-}" ]; then
  echo "  ⚠ High-CPU (possible busy-loop):"
  printf '%s\n' "$BUSY" | sed 's/^/    /'
  FOUND=1
else
  echo "  ✅ None"
fi

# --- 6. PM2 crash-loops (restart count ≥10) ---
echo ""
echo "-- PM2 Crash-Loop Detection --"
PM2_OUT=$(sudo -u adityamcps pm2 list --no-color 2>/dev/null || true)
if [ -n "${PM2_OUT:-}" ]; then
  # Parse pm2 table: look for lines with high restart count
  PM2_LOOPS=$(echo "$PM2_OUT" | awk '
    /^│/ {
      gsub(/│/, "")
      # field 1=id, 2=name, skip, eventually restarts column
      split($0, f, " ")
      n=0; name=""; restarts=0
      for (i=1; i<=length(f); i++) {
        if (f[i] ~ /^[0-9]+$/ && n==0) n=f[i]+0
        else if (f[i] ~ /^[a-z]/ && length(f[i])>1 && name=="") name=f[i]
        else if (f[i] ~ /^[0-9]+$/ && restarts==0 && name!="") restarts=f[i]+0
      }
      if (restarts >= 10 && name != "" && name != "id") print name " → " restarts " restarts"
    }')
  if [ -n "${PM2_LOOPS:-}" ]; then
    echo "  ⚠ PM2 crash-loop apps:"
    printf '%s\n' "$PM2_LOOPS" | head -5 | sed 's/^/    /'
    FOUND=1
  else
    echo "  ✅ No crash loops"
  fi
  # Show all PM2 apps summary
  echo "  PM2 summary:"
  echo "$PM2_OUT" | grep "^│" | grep -v "^│ id\|┼\|└\|┘\|─" | \
    awk '{gsub(/│/, ""); if(NF>=3) printf "    %-20s status=%-10s restarts=%s\n", $2, $NF, $(NF-3)}' | head -10
else
  echo "  (pm2 not accessible)"
fi

# --- 7. Duplicate process instances ---
echo ""
echo "-- Duplicate App Instances --"
DUP_FOUND=0
for pattern in "niyati.py" "fix-server.py" "perch-api"; do
  n=$(pgrep -c -f "$pattern" 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt 1 ]; then
    echo "  ⚠ ${pattern} running ×${n} (expected 1):"
    pgrep -a -f "$pattern" 2>/dev/null | head -3 | sed 's/^/    /'
    FOUND=1; DUP_FOUND=1
  fi
done
[ "$DUP_FOUND" -eq 0 ] && echo "  ✅ No duplicates"

# --- 8. Stuck mail queue background jobs ---
echo ""
echo "-- Background Job Queue --"
BGPROCS=$(pgrep -a -f 'sendmail -t|postdrop -r|sudo cat' 2>/dev/null | grep -v grep | wc -l | tr -d ' ')
if [ "${BGPROCS:-0}" -gt 0 ]; then
  echo "  ⚠ ${BGPROCS} stuck background job(s):"
  pgrep -a -f 'sendmail -t|postdrop -r|sudo cat' 2>/dev/null | head -5 | sed 's/^/    /'
  FOUND=1
else
  echo "  ✅ None"
fi

echo ""
if [ "$FOUND" -eq 0 ]; then
  echo "✅ All clear — no loops, orphans, or stuck processes"
fi
echo "=== End Loop/Orphan Detection ==="
