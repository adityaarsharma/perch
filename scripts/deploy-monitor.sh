#!/bin/bash
# Deploys Perch monitor.sh + .env to Niyati's scripts dir after git pull.
# Run as root: bash /home/serverbrain/perch-src/scripts/deploy-monitor.sh
set -e
SRC="/home/serverbrain/perch-src/telegram-bot"
DST="/home/adityamcps/webapps/my-mcps/scripts"

cp "$SRC/monitor.sh" "$DST/monitor.sh"
cp "$SRC/.env"        "$DST/.env"
chown adityamcps:adityamcps "$DST/monitor.sh" "$DST/.env"
chmod 755 "$DST/monitor.sh"
chmod 600 "$DST/.env"
echo "Deployed monitor.sh + .env → $DST"
