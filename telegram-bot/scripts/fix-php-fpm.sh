#!/usr/bin/env bash
# Perch — Restart any failed PHP-FPM service (RunCloud-aware: php{ver}-fpm-rc)
set -uo pipefail

echo "=== PHP-FPM Restart ==="

DOWN=()
RESTARTED=()
ALL=()

while IFS= read -r unit; do
  [ -z "$unit" ] && continue
  ALL+=("$unit")
  status="$(systemctl is-active "$unit" 2>/dev/null)"
  if [ "$status" != "active" ]; then
    DOWN+=("$unit:$status")
    if sudo systemctl restart "$unit" 2>/dev/null; then
      sleep 1
      new_status="$(systemctl is-active "$unit" 2>/dev/null)"
      if [ "$new_status" = "active" ]; then
        RESTARTED+=("$unit")
      else
        echo "⚠  $unit still $new_status after restart — check journalctl -u $unit -n 50"
      fi
    fi
  fi
done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
          | awk '/php[0-9]+rc-fpm\.service/{print $1}')

if [ ${#ALL[@]} -eq 0 ]; then
  echo "ℹ  No PHP-FPM services found on this system."
  exit 0
fi

echo "Found PHP-FPM units: ${ALL[*]}"
echo ""

if [ ${#DOWN[@]} -eq 0 ]; then
  echo "✅ All PHP-FPM services are active."
else
  echo "Was down: ${DOWN[*]}"
  if [ ${#RESTARTED[@]} -gt 0 ]; then
    echo "✅ Restarted: ${RESTARTED[*]}"
  fi
fi

# Show PHP-FPM pool health from RunCloud logs
echo ""
echo "--- Pool Health ---"
for log in /var/log/php*rc-fpm.log; do
  [ -f "$log" ] || continue
  ver=$(basename "$log" | grep -oE 'php[0-9]+rc')
  warns=$(grep -E "WARNING|CRITICAL|max_children|reached pm" "$log" 2>/dev/null | tail -5)
  if [ -n "$warns" ]; then
    echo "${ver} warnings:"
    echo "$warns" | sed 's/^/  /'
  else
    status=$(grep "NOTICE: fpm is running\|ready to handle" "$log" 2>/dev/null | tail -1)
    echo "${ver}: OK (${status:-no status})"
  fi
done
