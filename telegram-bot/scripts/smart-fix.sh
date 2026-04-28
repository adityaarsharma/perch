#!/usr/bin/env bash
# Perch — Smart Fix: diagnose and auto-repair common issues
set -uo pipefail

NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
ISSUES=()
FIXES=()

# --- Check nginx ---
NGINX_UP=$(systemctl is-active "$NSVC" 2>/dev/null || echo inactive)
if [ "$NGINX_UP" != "active" ]; then
  ISSUES+=("${NSVC} was ${NGINX_UP}")
  # Check config first
  if nginx -t 2>&1 | grep -q "successful"; then
    systemctl restart "$NSVC" 2>/dev/null
    sleep 1
    NEW_STATUS=$(systemctl is-active "$NSVC" 2>/dev/null)
    if [ "$NEW_STATUS" = "active" ]; then
      FIXES+=("Restarted ${NSVC} — now active")
    else
      FIXES+=("⚠️  ${NSVC} restart attempted but still ${NEW_STATUS} — check logs")
    fi
  else
    NGINX_ERR=$(nginx -t 2>&1 | grep "error" | head -3)
    FIXES+=("⚠️  ${NSVC} config has errors — NOT restarting: ${NGINX_ERR}")
  fi
fi

# --- Check MySQL ---
MYSQL_SVC=""
systemctl is-active mysql &>/dev/null && MYSQL_SVC=mysql
systemctl is-active mariadb &>/dev/null && MYSQL_SVC=mariadb
if [ -n "$MYSQL_SVC" ]; then
  MYSQL_UP=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
  if [ "$MYSQL_UP" != "active" ]; then
    ISSUES+=("MySQL (${MYSQL_SVC}) was ${MYSQL_UP}")
    systemctl restart "$MYSQL_SVC" 2>/dev/null
    sleep 2
    NEW_MYSQL=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
    FIXES+=("Restarted ${MYSQL_SVC} — now ${NEW_MYSQL}")
  fi
fi

# --- Check memory ---
MEM_PCT=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
if [ "$MEM_PCT" -gt 88 ]; then
  ISSUES+=("Memory at ${MEM_PCT}%")
  # Try PM2 restart first (usually the leaker on RunCloud setups)
  PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1)
  if [ -n "$PM2" ]; then
    $PM2 restart all 2>/dev/null
    sleep 3
    NEW_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
    FIXES+=("Restarted PM2 processes — memory now ${NEW_MEM}%")
  else
    FIXES+=("⚠️  Memory at ${MEM_PCT}% but no PM2 found — manual investigation needed")
  fi
fi

# --- Check disk ---
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
if [ "$DISK_PCT" -gt 88 ]; then
  ISSUES+=("Disk at ${DISK_PCT}%")
  # Clear large log files (>50MB)
  CLEARED=$(find /var/log /home -name "*.log" -size +50M 2>/dev/null \
    -exec sh -c 'sz=$(du -sh "$1" 2>/dev/null|cut -f1); truncate -s 0 "$1" && echo "$sz: $1"' _ {} \; | head -10)
  NEW_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
  if [ -n "$CLEARED" ]; then
    FIXES+=("Cleared large logs — disk now ${NEW_DISK}%: ${CLEARED}")
  else
    FIXES+=("⚠️  Disk at ${NEW_DISK}% but no large logs found — check /home for large files")
  fi
fi

# --- Reap PROVEN-DEAD processes only (SAFE replacement, see commit msg) ---
# Two narrow categories:
#   1. Actual zombies (state=Z) — already exited, just need parent reap.
#   2. Known stuck-loop signatures (sudo cat / sendmail -t / postdrop -r
#      reparented to PID 1) — fallout from the perch-api timeout bug.
# We deliberately do NOT kill arbitrary PPID=1 processes. On a RunCloud box
# that would include nginx-rc, php-fpm masters, mariadb, redis, dockerd,
# supervisord, fail2ban, the RunCloud agent — Smart Fix would crash the box.

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
  ISSUES+=("${STUCK_N} stuck sudo/sendmail/postdrop loops")
  printf '%s\n' "$STUCK_PIDS" | xargs -r kill -9 2>/dev/null || true
  FIXES+=("Killed ${STUCK_N} stuck loops (mail/postdrop)")
fi

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
fi
