#!/usr/bin/env bash
# Perch — Server profile: auto-discover all RunCloud webapps, detect stack, show health.
# Read-only. Output fed to Niyati LLM for context-aware analysis.
set -uo pipefail

echo "=== Server Profile: $(date '+%Y-%m-%d %H:%M:%S') ==="
echo "Host: $(hostname -f 2>/dev/null || hostname)"
echo "OS:   $(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' || echo unknown)"
echo ""

# ── Resources ─────────────────────────────────────────────────────────────────
echo "-- Resources --"
free -m | awk 'NR==2{printf "RAM:  %dMB used / %dMB total (%d%%)\n",$3,$2,int($3*100/$2)}'
df -h / | awk 'NR==2{printf "Disk: %s used / %s total (%s)\n",$3,$2,$5}'
echo "Load: $(awk '{print $1,$2,$3}' /proc/loadavg) ($(nproc) core(s))"
echo ""

# ── Services ──────────────────────────────────────────────────────────────────
echo "-- Services --"
for svc in nginx-rc nginx mariadb mysql redis memcached; do
  systemctl list-units --all 2>/dev/null | grep -q " ${svc}\." || continue
  status=$(systemctl is-active "$svc" 2>/dev/null || echo unknown)
  echo "  $svc: $status"
done
# PHP-FPM (RunCloud: php{ver}rc-fpm)
while IFS= read -r unit; do
  [ -z "$unit" ] && continue
  status=$(systemctl is-active "$unit" 2>/dev/null || echo unknown)
  echo "  $unit: $status"
done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
          | awk '/php[0-9]+rc-fpm\.service/{print $1}')
echo ""

# ── PHP-FPM pool configs ───────────────────────────────────────────────────────
echo "-- PHP-FPM Pools --"
FPM_FOUND=0
for conf in /etc/php*rc/fpm.d/*.conf; do
  [ -f "$conf" ] || continue
  FPM_FOUND=1
  pool=$(grep -m1 '^\[' "$conf" 2>/dev/null | tr -d '[]')
  ver=$(echo "$conf" | grep -oE 'php[0-9]+rc')
  pm_mode=$(grep "^pm\s*=" "$conf" 2>/dev/null | awk '{print $NF}')
  pm_max=$(grep "^pm\.max_children" "$conf" 2>/dev/null | awk -F= '{print $2}' | tr -d ' ')
  pm_start=$(grep "^pm\.start_servers" "$conf" 2>/dev/null | awk -F= '{print $2}' | tr -d ' ')
  mem=$(grep "^php_admin_value\[memory_limit\]" "$conf" 2>/dev/null | awk -F= '{print $2}' | tr -d ' ')
  [ -z "$pool" ] && continue
  echo "  [$ver] $pool: pm=${pm_mode:-?} max_children=${pm_max:-?} start_servers=${pm_start:-?} memory=${mem:-?}"

  # Recent saturation hits
  for fpmlog in /var/log/php*rc-fpm.log; do
    [ -f "$fpmlog" ] || continue
    sat=$(sudo tail -200 "$fpmlog" 2>/dev/null | grep -c "pool ${pool}.*max_children\|max_children.*pool ${pool}" 2>/dev/null || echo 0)
    [ "${sat:-0}" -gt 0 ] && echo "    ⚠ pool ${pool}: max_children hit ${sat}× in recent log"
  done
done
[ "$FPM_FOUND" -eq 0 ] && echo "  (no PHP-FPM pool configs found)"
echo ""

# ── Webapp discovery ──────────────────────────────────────────────────────────
echo "-- Webapps --"
WEBAPP_COUNT=0
while IFS= read -r appdir; do
  [ -z "$appdir" ] && continue
  appname="$(basename "$appdir")"
  username="$(printf '%s\n' "$appdir" | awk -F/ '{print $3}')"
  WEBAPP_COUNT=$((WEBAPP_COUNT + 1))

  # Detect stack from sentinel files (single find call = fast)
  sentinels=$(sudo find "$appdir" -maxdepth 2 \
    \( -name "wp-config.php" -o -name "package.json" -o -name "requirements.txt" -o -name "artisan" \) \
    -type f 2>/dev/null | head -5)

  stack="unknown"
  echo "$sentinels" | grep -q "wp-config.php"    && stack="wordpress"
  echo "$sentinels" | grep -q "artisan"           && stack="laravel"
  [ "$stack" = "unknown" ] && echo "$sentinels" | grep -q "package.json" && stack="nodejs"
  [ "$stack" = "unknown" ] && echo "$sentinels" | grep -q "requirements.txt" && stack="python"

  echo "  $appname  (user: $username)  stack: $stack"

  # WordPress / Laravel: PHP-FPM pool saturation + nginx error summary
  if [ "$stack" = "wordpress" ] || [ "$stack" = "laravel" ]; then
    for fpmlog in /var/log/php*rc-fpm.log; do
      [ -f "$fpmlog" ] || continue
      sat=$(sudo tail -200 "$fpmlog" 2>/dev/null | grep -c "pool ${appname}.*max_children\|max_children.*pool ${appname}" 2>/dev/null || echo 0)
      [ "${sat:-0}" -gt 0 ] && echo "    ⚠ PHP-FPM pool ${appname}: max_children hit ${sat}× recently"
    done
    # wp-config DB host check
    dbhost=$(sudo grep "DB_HOST" "$appdir/wp-config.php" 2>/dev/null | grep -oE "localhost|127\.[0-9.]+" | head -1)
    [ -n "$dbhost" ] && echo "    WP DB host: $dbhost"
  fi

  # Node.js: PM2 status
  if [ "$stack" = "nodejs" ]; then
    pm2_line=$(pm2 list --no-color 2>/dev/null | grep -i "$appname" | head -1 || true)
    [ -n "$pm2_line" ] && echo "    PM2: $(printf '%s' "$pm2_line" | grep -oE '[a-z]+ +\| [0-9]+ +restart' | head -1 || printf '%s' "$pm2_line" | cut -c1-80)"
    pm2_rs=$(pm2 list --no-color 2>/dev/null | grep -i "$appname" | awk '{for(i=1;i<=NF;i++) if($i~/^[0-9]+$/ && $i+0 >= 5) print $i}' | head -1 || true)
    [ -n "$pm2_rs" ] && echo "    ⚠ PM2 restart count: $pm2_rs"
  fi

  # Python: live process count
  if [ "$stack" = "python" ]; then
    procs=$(pgrep -c -f "$appdir" 2>/dev/null || echo 0)
    echo "    Processes running from $appdir: $procs"
  fi

  # Recent nginx errors for this app
  errlog=$(sudo find /home/"$username"/logs/nginx -name "${appname}_error.log" -type f 2>/dev/null | head -1)
  if [ -n "$errlog" ]; then
    recent_errs=$(sudo tail -50 "$errlog" 2>/dev/null | grep -cE "PHP Fatal|WordPress database|connect\(\) failed|upstream" 2>/dev/null || echo 0)
    [ "${recent_errs:-0}" -gt 0 ] && echo "    ⚠ nginx error log: ${recent_errs} serious errors in last 50 lines"
    latest=$(sudo tail -3 "$errlog" 2>/dev/null | grep -v "^$" | tail -1 | cut -c1-100)
    [ -n "$latest" ] && echo "    Latest error: $latest"
  fi

done < <(sudo find /home -mindepth 3 -maxdepth 3 -type d -path "*/webapps/*" 2>/dev/null | sort)
[ "$WEBAPP_COUNT" -eq 0 ] && echo "  (no webapps found under /home)"
echo ""

# ── WP-Cron global status ─────────────────────────────────────────────────────
echo "-- WP-Cron Status --"
wpcron_n=$(pgrep -c -f 'wp-cron\.php' 2>/dev/null || echo 0)
if [ "${wpcron_n:-0}" -gt 0 ]; then
  echo "  ⚠ ${wpcron_n} wp-cron.php process(es) running (normal is ≤1)"
  pgrep -a -f 'wp-cron\.php' 2>/dev/null | head -3 | sed 's/^/    /'
else
  echo "  ✅ None running"
fi
echo ""

# ── PM2 global status ─────────────────────────────────────────────────────────
echo "-- PM2 Status --"
pm2_out=$(pm2 list --no-color 2>/dev/null || echo "(pm2 not accessible as current user)")
echo "$pm2_out" | head -25
echo ""

# ── CPU top consumers ─────────────────────────────────────────────────────────
echo "-- Top CPU/RAM Processes --"
ps -eo pid,user,comm,pcpu,pmem --sort=-pcpu --no-headers 2>/dev/null | head -8 | \
  awk '{printf "  PID %-7s %-15s CPU:%-6s MEM:%s%%\n",$1,$3,$4,$5}'
echo ""

echo "=== End Server Profile ==="
