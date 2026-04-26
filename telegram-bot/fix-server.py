#!/usr/bin/env python3
"""
Fix Server — Local HTTP API for self-healing actions
Listens on 127.0.0.1 only. Called by bot.py and monitor.sh buttons.
"""
import os, subprocess, json, sys, hmac, time, urllib.request, urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

def load_env():
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

TOKEN   = os.environ.get('FIX_SERVER_TOKEN', '')
# SECURITY [H4]: enforce minimum token entropy to block weak shared secrets.
MIN_TOKEN_LEN = 32
if not TOKEN:
    print("FATAL: FIX_SERVER_TOKEN is required. Set it in .env", flush=True)
    sys.exit(1)
if len(TOKEN) < MIN_TOKEN_LEN:
    print(f"FATAL: FIX_SERVER_TOKEN must be at least {MIN_TOKEN_LEN} chars (current: {len(TOKEN)}).", flush=True)
    print("       Generate a strong one: openssl rand -hex 32", flush=True)
    sys.exit(1)

try:
    PORT = int(os.environ.get('FIX_SERVER_PORT', '3011'))
except ValueError:
    print("FATAL: FIX_SERVER_PORT must be a number", flush=True)
    sys.exit(1)

# SECURITY [H4]: refuse non-loopback bind unless explicitly opted in via env flag.
HOST = os.environ.get('FIX_SERVER_HOST', '127.0.0.1')
ALLOW_PUBLIC = os.environ.get('PERCH_ALLOW_PUBLIC_FIX', '0') == '1'
if HOST not in ('127.0.0.1', '::1', 'localhost'):
    if not ALLOW_PUBLIC:
        print(f"FATAL: refusing to bind to {HOST}.", flush=True)
        print("       Set PERCH_ALLOW_PUBLIC_FIX=1 to override (and ensure firewall blocks port).", flush=True)
        sys.exit(1)
    print(f"WARNING: binding to {HOST} — ensure firewall blocks port {PORT} from public access.", flush=True)

SCRIPTS = Path(__file__).parent / 'scripts'

# Audit trail: every action this server runs is POSTed to Perch's HTTP API
# /api/log_action so it lands in brain.actions_log alongside MCP-side actions.
# Best-effort — failure to log never blocks the actual action.
PERCH_API_BASE  = os.environ.get('PERCH_API_BASE',  'http://127.0.0.1:3013')
PERCH_API_TOKEN = os.environ.get('PERCH_API_TOKEN', '')

def log_action_to_brain(action_type: str, target: str, args: dict,
                         result: dict, ok: bool) -> None:
    """Best-effort audit log. Never raises."""
    if not PERCH_API_TOKEN:
        return
    try:
        body = json.dumps({
            'args': {
                'action_type': action_type,
                'target': target,
                'args': args,
                'result': result,
                'ok': ok,
            }
        }).encode()
        req = urllib.request.Request(
            url=f'{PERCH_API_BASE}/api/log_action',
            data=body,
            method='POST',
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {PERCH_API_TOKEN}',
            },
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            r.read()
    except Exception as e:
        # Never let audit failures block the action — log and move on
        print(f'[fix] audit log failed (non-fatal): {e}', flush=True)

ROUTES = {
    # Core fix actions
    '/fix':          'smart-fix.sh',
    '/fix-nginx':    'fix-nginx.sh',
    '/fix-php-fpm':  'fix-php-fpm.sh',
    '/fix-mysql':    'fix-mysql.sh',
    '/fix-services': 'fix-services.sh',
    '/fix-n8n':      'fix-n8n.sh',         # optional — if user runs n8n
    # Status & diagnostics
    '/status':       'check-status.sh',
    '/status-brief': 'status-brief.sh',
    '/disk':         'check-disk.sh',
    '/check-ports':  'check-ports.sh',
    '/top-procs':    'top-procs.sh',
    # Logs
    '/logs-nginx':   'logs-nginx.sh',
    '/logs-php':     'logs-php.sh',
    # SSL
    '/ssl-status':   'ssl-status.sh',
    '/renew-ssl':    'renew-ssl.sh',
    # Maintenance
    '/clear-logs':   'clear-logs.sh',
}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # SECURITY [H4]: constant-time auth comparison to defeat timing attacks.
        provided = self.headers.get('Authorization', '')
        expected = f'Bearer {TOKEN}'
        if not hmac.compare_digest(provided, expected):
            print(f'[fix] AUTH FAILED from {self.client_address[0]}', flush=True)
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return

        script = ROUTES.get(self.path)
        if not script:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'Unknown endpoint: {self.path}'}).encode())
            return

        script_path = SCRIPTS / script
        if not script_path.exists():
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'Script not found: {script}'}).encode())
            return

        action_ok = True
        started = time.time()
        try:
            r = subprocess.run(
                ['bash', str(script_path)],
                capture_output=True, text=True, timeout=60
            )
            output = (r.stdout + r.stderr).strip()
            action_ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            output = 'Script timed out after 60s'
            action_ok = False
        except Exception as e:
            output = f'Error: {e}'
            action_ok = False

        duration_ms = int((time.time() - started) * 1000)

        # Audit trail to Perch brain (best-effort, never blocks response)
        log_action_to_brain(
            action_type='fix_server.' + self.path.lstrip('/'),
            target='localhost',
            args={'script': script, 'duration_ms': duration_ms},
            result={'output_truncated': output[:500] if output else ''},
            ok=action_ok,
        )

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'output': output, 'ok': action_ok}).encode())

    def log_message(self, *args):
        pass  # Suppress access logs

if __name__ == '__main__':
    print(f'[fix-server] Listening on {HOST}:{PORT}', flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
