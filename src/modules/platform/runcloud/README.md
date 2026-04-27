# RunCloud v1 — preserved 135-tool MCP

This directory contains the original RunCloud-MCP that existed before the
Perch v2 rebrand (HEAD ≤ commit `825d3c3`). It's a self-contained MCP server
exposing **135 tools** across 23 categories.

**It was stripped during the v2 rebrand. This is the restoration.**

## Why preserve it

The v1 catalog is the deepest RunCloud API integration in the wild —
`server_create`, `webapp_create`, `database_create`, `ssl_install`,
`firewall_rule_create`, `cron_create`, `supervisor_create`, `git_clone`,
`deploy_and_verify`, `wordpress_quickstart`, plus 30+ SSH/self-healing
tools. Throwing that out is a regression.

## Tool catalog (23 categories, 135 tools)

| Category | Tools |
|---|---|
| 🖥️ Servers | 17 |
| 🌐 Web Applications | 12 |
| 🔧 PHP Script Installer | 3 |
| 🌿 Git | 6 |
| 🌍 Domains | 3 |
| 🔒 SSL Certificates | 10 |
| 🗄️ Databases | 12 |
| 👤 System Users | 6 |
| 🔑 SSH Keys | 4 |
| ⏰ Cron Jobs | 5 |
| 📋 Supervisor | 8 |
| 🛡️ Firewall & Security | 9 |
| ⚙️ Services | 2 |
| 🔗 External APIs | 5 |
| 🔍 Cross-Server Search & Inventory | 4 |
| 📈 Health, Monitoring & Performance | 7 |
| 🚀 Deployments | 2 |
| 🟦 WordPress Management (SSH) | 5 |
| 🖥️ SSH Direct Execution | 4 |
| 🔧 Server Monitoring & Self-Healing | 7 |

## How to use

### Standalone MCP (works today)

Build the v1 entry point and register it with Claude Code as a separate MCP:

```bash
# In perch-src
npx tsc src/modules/runcloud-v1/index.ts --outDir dist/runcloud-v1 \
  --module ESNext --target ES2022 --moduleResolution node
```

Then in Claude Code's `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "runcloud-v1": {
      "command": "node",
      "args": ["/path/to/perch-src/dist/runcloud-v1/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your-key-here"
      }
    }
  }
}
```

All 135 tools are then available as `mcp__runcloud-v1__*` to Claude.

### Future: unified HANDLERS port

The block 7 roadmap is to migrate these 135 tools into the current
`src/api/server.ts` HANDLERS pattern, prefixed `runcloud.*`, so they're
available via:

- HTTP API at `127.0.0.1:3013` (Niyati, Slack, any external caller)
- Same MCP server as the rest of Perch (one install, all tools)

That's a multi-day port — kept as a block 7 task. Until then, this
directory exists as the **preserved canonical implementation** and a
working separate MCP.

## File

- `index.ts` — the original 3009-line MCP server, byte-for-byte from
  commit `825d3c3`. Don't edit it inline — fork into the new architecture
  if you want to evolve a tool.
