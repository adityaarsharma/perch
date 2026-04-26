#!/usr/bin/env bash
# Perch — one-line installer
# Usage on a fresh server:
#   curl -fsSL https://raw.githubusercontent.com/adityaarsharma/perch/main/scripts/install.sh | bash
#
# Or in an existing checkout:
#   ./scripts/install.sh
#
# Idempotent — safe to run multiple times.

set -euo pipefail

PERCH_REPO="${PERCH_REPO:-https://github.com/adityaarsharma/perch}"
PERCH_DIR="${PERCH_DIR:-$PWD}"
PERCH_HOME="${PERCH_HOME:-$HOME/.perch}"
ENV_FILE="$PERCH_HOME/.env"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
ok()    { echo "$(color '32' '✓') $*"; }
warn()  { echo "$(color '33' '⚠') $*"; }
err()   { echo "$(color '31' '✗') $*" >&2; }
info()  { echo "$(color '36' '→') $*"; }

# ── 1. Pre-flight ──────────────────────────────────────────────────────────────

info "Perch installer — preparing $PERCH_DIR"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required (>=18). Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js 18+ required. You have $(node -v)."
  exit 1
fi
ok "Node.js $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  err "npm is required."
  exit 1
fi
ok "npm $(npm -v)"

# ── 2. Clone or use existing checkout ─────────────────────────────────────────

if [ -f "$PERCH_DIR/package.json" ] && grep -q '"name": "perch"' "$PERCH_DIR/package.json"; then
  info "Existing Perch checkout detected at $PERCH_DIR"
  cd "$PERCH_DIR"
  if [ -d .git ]; then
    info "Pulling latest..."
    git pull --ff-only origin main || warn "Could not pull — continuing with local code"
  fi
else
  info "Cloning $PERCH_REPO into $PERCH_DIR"
  git clone "$PERCH_REPO" "$PERCH_DIR"
  cd "$PERCH_DIR"
fi

# ── 3. Install dependencies ────────────────────────────────────────────────────

info "Installing npm dependencies..."
npm install --no-fund --no-audit
ok "Dependencies installed"

info "Building TypeScript..."
npm run build
ok "Build complete"

# ── 4. ~/.perch directory + permissions ────────────────────────────────────────

if [ ! -d "$PERCH_HOME" ]; then
  mkdir -p "$PERCH_HOME"
  chmod 700 "$PERCH_HOME"
  ok "Created $PERCH_HOME (mode 700)"
else
  chmod 700 "$PERCH_HOME"
  ok "$PERCH_HOME exists (mode 700)"
fi

# ── 5. Master key generation ───────────────────────────────────────────────────

if [ -f "$ENV_FILE" ] && grep -q "^PERCH_MASTER_KEY=" "$ENV_FILE"; then
  ok "Master key already set in $ENV_FILE — keeping it"
else
  if command -v openssl >/dev/null 2>&1; then
    MASTER_KEY="$(openssl rand -base64 32)"
  else
    MASTER_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  fi
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "PERCH_MASTER_KEY=$MASTER_KEY" >> "$ENV_FILE"
  ok "Generated PERCH_MASTER_KEY (saved to $ENV_FILE, mode 600)"
  warn "BACK UP this key — losing it means losing access to encrypted vault entries"
fi

# ── 6. RunCloud API key prompt (only if running interactively) ─────────────────

if [ -t 0 ] && [ -t 1 ]; then
  if grep -q "^RUNCLOUD_API_KEY=" "$ENV_FILE" 2>/dev/null; then
    ok "RUNCLOUD_API_KEY already set"
  else
    echo
    info "RunCloud API key (https://manage.runcloud.io/settings/api-key)"
    info "Press Enter to skip — you can add it later by editing $ENV_FILE"
    read -rp "RUNCLOUD_API_KEY: " RC_KEY
    if [ -n "$RC_KEY" ]; then
      echo "RUNCLOUD_API_KEY=$RC_KEY" >> "$ENV_FILE"
      ok "Saved RunCloud API key"
    else
      warn "Skipped — Perch RunCloud tools will not work until you add it"
    fi
  fi
fi

# ── 7. Optional: systemd service ───────────────────────────────────────────────

cat > /tmp/perch.service <<EOF
[Unit]
Description=Perch — Server Intelligence Layer
After=network.target

[Service]
Type=simple
WorkingDirectory=$PERCH_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(which node) $PERCH_DIR/dist/index.js
Restart=always
RestartSec=5
User=$(whoami)

[Install]
WantedBy=multi-user.target
EOF

info "systemd unit prepared at /tmp/perch.service"
echo "       To install as a system service (requires sudo):"
echo "         sudo mv /tmp/perch.service /etc/systemd/system/perch.service"
echo "         sudo systemctl daemon-reload && sudo systemctl enable --now perch"

# ── 8. Final summary ───────────────────────────────────────────────────────────

echo
ok "Perch installed at $PERCH_DIR"
echo "   Brain DB:  $PERCH_HOME/brain.db (created on first use)"
echo "   Vault:     $PERCH_HOME/vault.json (created on first use)"
echo "   .env file: $ENV_FILE"
echo
info "Next: load your server SSH keys into the encrypted vault:"
echo "   cd $PERCH_DIR"
echo "   set -a && . $ENV_FILE && set +a"
echo "   npm run vault add ssh:server-name -- --file=/path/to/ssh-key"
echo "   npm run vault list"
echo
info "Or import all RunCloud servers automatically:"
echo "   npm run import-runcloud"
echo
ok "Done."
