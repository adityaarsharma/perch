"""Perch LLM module — BYOK Gemini Flash for conversational mode.

Optional. Without GEMINI_API_KEY in .env: every function returns None,
caller falls back to button/slash-command UX. With key: full conversational
intent routing + reply formatting.

Recommended model: Gemini Flash (free tier, low latency).
"""
from __future__ import annotations
import json
import os
import re
import time
import urllib.request
import urllib.error


# ── Config ────────────────────────────────────────────────────────────────

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_FALLBACKS = [
    "gemini-2.5-flash",
    "gemini-2.0-flash-001",
    "gemini-2.5-flash-lite",
]
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
TIMEOUT_SEC = 4.0


# ── Hard guardrail (never bypassed) ───────────────────────────────────────

DESTRUCTIVE_RE = re.compile(
    r"\b(delete|destroy|wipe|nuke|drop all|format|truncate)\s+"
    r"(server|database|webapp|site|wp|wordpress|disk|brain|memory|all|logs?|files?)|"
    r"\b(clear|empty|flush)\s+(all\s+)?(logs|database|brain|memory|cache)\b|"
    r"\b(shut\s?down|power\s?off|reboot)\s+(server|hetzner|machine|box)|"
    r"\bkill\s+(all|every)\s+(processes|services|webapps)|"
    r"\brm\s+-rf\s+/",
    re.I,
)

# DEEP_RE = cheap pre-filter — only call Gemini when message looks tech-y
DEEP_RE = re.compile(
    r"\b(audit|diagnos|why is|why was|what'?s wrong|white screen|"
    r"plugin (?:vuln|security|conflict|error)|wp_options|autoload|"
    r"history of|seen before|have we seen|what do you know about|"
    r"backup health|ssl status|ssl expir|wordpress|uptime|"
    r"website (?:up|down|slow)|site (?:up|down|slow)|"
    r"top ip|kaunsi ip|ips visit|visited the most|visitor|"
    r"server (?:load|status|pulse|health)|disk usage|memory pressure|"
    r"php (?:error|fpm)|mysql (?:error|slow)|nginx (?:error|down|log))\b",
    re.I,
)


def is_enabled() -> bool:
    """True when GEMINI_API_KEY is configured and non-empty."""
    return bool(GEMINI_KEY)


def is_destructive(text: str) -> bool:
    """Pre-flight guard. Caller MUST check this before reaching this module."""
    return bool(DESTRUCTIVE_RE.search(text or ""))


def looks_techy(text: str) -> bool:
    """Cheap regex filter — only worth calling Gemini on these."""
    return bool(DEEP_RE.search((text or "").lower()))


# ── Gemini client ─────────────────────────────────────────────────────────

def _call_gemini(prompt: str, max_tokens: int = 200, temperature: float = 0.2) -> str | None:
    """One call, multiple model fallbacks, hard timeout. Returns text or None."""
    if not GEMINI_KEY:
        return None
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    body = json.dumps(payload).encode()
    for model in [GEMINI_MODEL] + [m for m in GEMINI_FALLBACKS if m != GEMINI_MODEL]:
        url = GEMINI_BASE.format(model=model, key=GEMINI_KEY)
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            cand = (data.get("candidates") or [{}])[0]
            text = (cand.get("content", {}).get("parts") or [{}])[0].get("text", "")
            if text:
                return text.strip()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            continue
    return None


# ── Tool catalog (kept in sync with Perch HTTP API tools) ─────────────────

TOOL_CATALOG = """\
brain               : full snapshot — server count, webapps, problems
brain.history       : per-domain event history (needs DOMAIN)
access_top_ips      : top visitor IPs for a domain (needs DOMAIN)
access_summary      : traffic, status codes, top URLs (needs DOMAIN)
wp_errors           : WordPress debug.log + plugin errors (optional DOMAIN)
php_errors          : PHP-FPM error logs across all sites
mysql_errors        : MariaDB error + slow query log
server_pulse        : load, disk, RAM, top procs, failed services
"""


# ── Public functions ──────────────────────────────────────────────────────

def route_intent(text: str, known_domains: list[str] | None = None) -> dict | None:
    """Classify the question — static answer vs dynamic tool call vs nothing.

    Returns:
      None — LLM disabled, text not tech-y, or Gemini failed/refused
      {"mode": "static"} — answerable from brain snapshot, no session needed
      {"mode": "dynamic", "tool": "...", "domain": "..." | None} — needs a
        live tool, caller should open a Perch session and run it

    Pass known_domains to enable fuzzy resolution ("thebigskyfarm" →
    "thebigskyfarm.com").
    """
    if not is_enabled():
        return None
    if not looks_techy(text):
        return None

    domain_hint = ""
    if known_domains:
        domain_hint = "\nKnown domains on this server: " + ", ".join(known_domains[:30])

    prompt = (
        "Classify this Perch (server-management) question:\n"
        "  - STATIC: answerable from durable brain snapshot (server count, webapp count,\n"
        "    open problems, top issue types, what is Perch, etc.) — NO session needed.\n"
        "  - DYNAMIC: needs LIVE shell / log / api call from this list of tools:\n"
        + TOOL_CATALOG +
        domain_hint +
        "\nIf STATIC, reply: {\"mode\":\"static\"}\n"
        "If DYNAMIC, reply: {\"mode\":\"dynamic\",\"tool\":\"<name>\",\"domain\":\"<domain or null>\"}\n"
        "If neither (generic chat), reply: {\"mode\":null}\n"
        "ONE LINE JSON only.\n\n"
        f'Q: "{text[:200]}"'
    )
    reply = _call_gemini(prompt, max_tokens=80, temperature=0.0)
    if not reply:
        return None
    m = re.search(r"\{[^}]+\}", reply)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    mode = data.get("mode")
    if mode == "static":
        return {"mode": "static"}
    if mode == "dynamic":
        tool = data.get("tool")
        if not tool or tool == "null":
            return None
        return {"mode": "dynamic", "tool": tool, "domain": data.get("domain")}
    return None


def format_static_reply(user_q: str, brain_context: str) -> str | None:
    """Static-mode answer using the brain snapshot. No tool was run.

    Caller passes a string with [Perch brain snapshot] block — server count,
    webapp count, problems, etc. Gemini formats a conversational reply that
    doesn't pretend to have run anything live.
    """
    if not is_enabled():
        return None
    prompt = (
        "You are Perch, a server-management assistant. The user asked a question "
        "answerable from durable brain memory — no live tool was run. "
        "Reply conversationally in 3-7 lines. Use *single-asterisk* bold for Telegram. "
        "If user wants live data (top IPs, error logs, etc.), suggest they send "
        "`/perch_start` to open a session.\n\n"
        f"User: \"{user_q[:200]}\"\n"
        f"Brain context:\n{brain_context[:1500]}"
    )
    reply = _call_gemini(prompt, max_tokens=300, temperature=0.4)
    return md_safe(reply) if reply else None


def format_reply(user_q: str, tool_output: str, tool_name: str = "") -> str | None:
    """Turn raw tool output into a conversational chat reply.

    Returns None when no key or Gemini fails — caller should fall back to
    sending the raw output (markdown-safe).
    """
    if not is_enabled():
        return None
    if not tool_output:
        return None
    prompt = (
        "You are a calm, watchful server-admin assistant (Perch). "
        "User asked something about their server/sites. "
        "A read-only tool ran and returned the data below. "
        "Reply conversationally in 3-8 lines. "
        "Use *single-asterisk* for bold (Telegram-legacy markdown — never **double**). "
        "Call out anything noteworthy (Cloudflare proxies, bots, CF IPs masking real visitors, "
        "high error counts, near-expiry SSLs). "
        "Don't dump raw data — summarize. Sober tone, no fluff.\n\n"
        f"User asked: \"{user_q[:200]}\"\n"
        f"Tool: {tool_name or 'unknown'}\n"
        f"Tool output:\n{tool_output[:2500]}"
    )
    reply = _call_gemini(prompt, max_tokens=400, temperature=0.4)
    return md_safe(reply) if reply else None


def md_safe(text: str | None) -> str | None:
    """Convert standard markdown to Telegram-legacy parse_mode='Markdown'.

    Telegram legacy supports *bold* / _italic_ / `code` / [link](url).
    It does NOT support **double-asterisk bold**. Gemini emits **X** by
    default; this normalises before send.
    """
    if not text:
        return text
    # **X** -> *X* (bold)
    text = re.sub(r"\*\*(?!\*)([^*\n]+?)\*\*", r"*\1*", text)
    # __X__ -> _X_ (italic)
    text = re.sub(r"__(?!_)([^_\n]+?)__", r"_\1_", text)
    # Strip stray empty bold/italic markers that confuse Telegram
    text = re.sub(r"\*\*+", "*", text)
    return text
