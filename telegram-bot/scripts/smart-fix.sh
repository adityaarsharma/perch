#!/usr/bin/env bash
# Perch — Smart Fix: diagnose and auto-repair common issues (RunCloud-aware)
set -uo pipefail

NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
ISSUES=()
FIXES=()

# --- Check nginx-rc ---
NGINX_UP=$(systemctl is-active "$NSVC" 2>/dev/null || echo inactive)
if [ "$NGINX_UP" != "active" ]; then
  ISSUES+=("${NSVC} was ${NGINX_UP}")
  if sudo nginx-rc -t 2>&1 | grep -q "successful"; then
    sudo systemctl restart "$NSVC" 2>/dev/null
    sleep 1
    NEW_STATUS=$(systemctl is-active "$NSVC" 2>/dev/null)
    if [ "$NEW_STATUS" = "active" ]; then
      FIXES+=("Restarted ${NSVC} — now active")
    else
      FIXES+=("⚠️  ${NSVC} restart attempted but still ${NEW_STATUS}")
    fi
  else
    NGINX_ERR=$(nginx-rc -t 2>&1 | grep "error" | head -3)
    FIXES+=("⚠️  ${NSVC} config errors — NOT restarting: ${NGINX_ERR}")
  fi
fi

# --- Check MariaDB ---
MYSQL_SVC=""
for _svc in mariadb mysql; do
  systemctl is-active "$_svc" &>/dev/null && MYSQL_SVC="$_svc" && break
  systemctl list-units --all 2>/dev/null | grep -q " ${_svc}\." && MYSQL_SVC="$_svc" && break
done
if [ -n "$MYSQL_SVC" ]; then
  MYSQL_UP=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
  if [ "$MYSQL_UP" != "active" ]; then
    ISSUES+=("$MYSQL_SVC was $MYSQL_UP")
    sudo systemctl restart "$MYSQL_SVC" 2>/dev/null
    sleep 2
    NEW_MYSQL=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
    FIXES+=("Restarted $MYSQL_SVC — now $NEW_MYSQL")
  fi
fi

# --- Check memory — RunCloud: restart php{ver}rc-fpm, not PM2 ---
MEM_PCT=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
if [ "$MEM_PCT" -gt 88 ]; then
  ISSUES+=("Memory at ${MEM_PCT}%")

  # Identify top consumers
  TOP_PROCS=$(ps -eo comm,user,rss --sort=-rss 2>/dev/null | head -8 | tail -7 | \
    awk '{printf "%s(%s)=%dMB ", $1,$2,int($3/1024)}' | sed 's/ $//')

  # Check PHP-FPM pool warnings — which pool is maxing out
  PHP_POOL_WARN=""
  for log in /var/log/php*rc-fpm.log; do
    [ -f "$log" ] || continue
    ver=$(basename "$log" | grep -oE 'php[0-9]+rc')
    w=$(sudo grep -E "max_children|reached pm|WARNING|CRITICAL" "$log" 2>/dev/null | tail -5 | \
      sed 's/.*\[pool /pool /' | sed 's/\] server reached.*/: hit max_children/' | \
      sed 's/\] WARNING:.*/: warning/' | head -3 | tr '\n' ' ')
    [ -n "$w" ] && PHP_POOL_WARN="${PHP_POOL_WARN}${ver}: ${w}| "
  done

  # Restart all RunCloud PHP-FPM services
  PHP_RESTARTED=()
  PHP_FAILED=()
  while IFS= read -r unit; do
    [ -z "$unit" ] && continue
    if sudo systemctl restart "$unit" 2>/dev/null; then
      PHP_RESTARTED+=("$unit")
    else
      PHP_FAILED+=("$unit")
    fi
  done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
            | awk '/php[0-9]+rc-fpm\.service/{print $1}')

  sleep 3
  NEW_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')

  FIX_MSG="Memory ${MEM_PCT}% → ${NEW_MEM}%"
  if [ ${#PHP_RESTARTED[@]} -gt 0 ]; then
    FIX_MSG="Restarted PHP-FPM (${PHP_RESTARTED[*]}) | RAM: ${MEM_PCT}% → ${NEW_MEM}%"
  fi
  [ ${#PHP_FAILED[@]} -gt 0 ] && FIX_MSG="${FIX_MSG} | Failed: ${PHP_FAILED[*]}"
  [ -n "$TOP_PROCS" ]          && FIX_MSG="${FIX_MSG} | Top: ${TOP_PROCS}"
  [ -n "$PHP_POOL_WARN" ]      && FIX_MSG="${FIX_MSG} | Pool warnings: ${PHP_POOL_WARN}"

  if [ ${#PHP_RESTARTED[@]} -eq 0 ] && [ ${#PHP_FAILED[@]} -eq 0 ]; then
    FIX_MSG="⚠️  RAM at ${MEM_PCT}% | Top: ${TOP_PROCS} | No PHP-FPM found"
  fi
  FIXES+=("$FIX_MSG")
fi

# --- Check disk ---
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
if [ "$DISK_PCT" -gt 88 ]; then
  ISSUES+=("Disk at ${DISK_PCT}%")
  CLEARED=$(find /var/log /home -name "*.log" -size +50M 2>/dev/null \
    -exec sh -c 'sz=$(du -sh "$1" 2>/dev/null|cut -f1); truncate -s 0 "$1" && echo "$sz: $1"' _ {} \; | head -10)
  NEW_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
  if [ -n "$CLEARED" ]; then
    FIXES+=("Cleared large logs — disk ${DISK_PCT}% → ${NEW_DISK}%: ${CLEARED}")
  else
    FIXES+=("⚠️  Disk at ${NEW_DISK}% — no large logs found, check /home manually")
  fi
fi

# --- Reap zombie processes only (never kill arbitrary PPID=1 on RunCloud) ---
ZOMBIE_PIDS=$(ps -eo state,pid --no-headers 2>/dev/null | awk '$1=="Z" {print $2}')
if [ -n "${ZOMBIE_PIDS:-}" ]; then
  ZOMBIE_N=$(printf '%s\n' "$ZOMBIE_PIDS" | wc -l | tr -d ' ')
  ISSUES+=("${ZOMBIE_N} zombie processes")
  printf '%s\n' "$ZOMBIE_PIDS" | xargs -r kill -9 2>/dev/null || true
  FIXES+=("Reaped ${ZOMBIE_N} zombies")
fi

STUCK_PIDS=$(pgrep -f 'sudo cat |sendmail -t|postdrop -r' 2>/dev/null | head -100)
if [ -n "${STUCK_PIDS:-}" ]; then
  STUCK_N=$(printf '%s\n' "$STUCK_PIDS" | wc -l | tr -d ' ')
  ISSUES+=("${STUCK_N} stuck mail/postdrop loops")
  printf '%s\n' "$STUCK_PIDS" | xargs -r kill -9 2>/dev/null || true
  FIXES+=("Killed ${STUCK_N} stuck loops")
fi

# --- Diagnostics: recent nginx errors per webapp ---
NGINX_ERRORS=""
for errlog in /home/*/logs/nginx/*_error.log; do
  [ -f "$errlog" ] || continue
  app=$(basename "$errlog" | sed 's/_error.log//')
  cnt=$(tail -200 "$errlog" 2>/dev/null | grep -cE "error|crit|emerg" 2>/dev/null || echo 0)
  if [ "$cnt" -gt 0 ]; then
    snippet=$(tail -200 "$errlog" 2>/dev/null | grep -E "error|crit|emerg" | tail -2 | \
      sed 's/.*\] //' | tr '\n' ' ')
    NGINX_ERRORS="${NGINX_ERRORS}${app}(${cnt}): ${snippet}| "
  fi
done

# --- Report ---
FINAL_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
FINAL_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
FINAL_NGINX=$(systemctl is-active "$NSVC" 2>/dev/null || echo unknown)

if [ ${#ISSUES[@]} -eq 0 ]; then
  echo "✅ All systems healthy — nothing needed fixing"
  echo "RAM: ${FINAL_MEM}% | Disk: ${FINAL_DISK}% | ${NSVC}: ${FINAL_NGINX}"
else
  echo "${#ISSUES[@]} issue(s) found:"
  for i in "${ISSUES[@]}"; do echo "  • $i"; done
  echo ""
  echo "Actions taken:"
  for f in "${FIXES[@]}"; do echo "  ✓ $f"; done
  echo ""
  echo "After fix: RAM ${FINAL_MEM}% | Disk ${FINAL_DISK}% | ${NSVC}: ${FINAL_NGINX}"
  [ -n "${NGINX_ERRORS:-}" ] && echo "" && echo "nginx errors: ${NGINX_ERRORS}"
fi
