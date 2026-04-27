# Brain — rooms, schema, hooks

Per-host SQLite at `~/.perch/brain.db` (default). One file per server = trivial backup (`cp brain.db brain.db.bak`).

The brain is organised into **logical rooms**. Each room is a typed API surface in `src/core/brain-rooms.ts`. The underlying tables live in `src/core/brain.ts` (existing).

## Rooms (v2.3 status)

| Room | Backed by table | API surface | Status |
|---|---|---|---|
| 🔐 `secrets` | (vault file system) | `vaultGet/Put/List/Delete` | ✅ existing |
| 📋 `guardrails` | _placeholder_ | `core/guardrails.ts` (rules in code) | ⚠️ scaffold (v2.3); DB-backed in v2.4 |
| ⚠️ `problems` | `problems` | `rooms.problems.log()` | ✅ existing |
| 🔧 `actions` | `actions_log` | `rooms.actions.log()`, `recent()` | ✅ existing |
| 📚 `knowledge` | `knowledge` | `rooms.knowledge.remember(pattern, cause, fix)` | ✅ existing (no bi-temporal yet) |
| 🌐 `webapps` | `webapps` | _placeholder_ | ⚠️ direct table access today |
| 🚨 `incidents` | _placeholder_ | _placeholder_ | ⏳ v2.4 |
| 📊 `timeseries` | _placeholder_ | _placeholder_ | ⏳ v2.4 |
| 📜 `audit_log` | _placeholder_ | _placeholder_ | ⏳ v2.4 |

`openRooms(db)` returns the typed rooms wrapper.

## Self-updating jobs (v2.4)

Three LLM-driven jobs (Anthropic API, model from `PERCH_LLM_MODEL`, default `claude-haiku-4-5`):

1. **Fact extractor (post-event hook)** — when a problem is logged, Claude extracts structured facts into `knowledge` with bi-temporal fields (`learned_at`, `valid_at`, `superseded_by`).
2. **Pattern finder (nightly cron)** — Claude reads last-7-days problems, surfaces patterns into `knowledge` ("3 sites on server S had auth-redirect loops after WP 6.5").
3. **Conflict resolver (per-write)** — when new fact contradicts old, Claude judges; old marked `superseded_by` with timestamp + reason. No facts ever deleted.

## Vector sidecar (v2.4 optional)

Add `sqlite-vec` extension (single shared object, ~600 KB, no Qdrant/Neo4j) for embedding-based similarity search. Lets the Reasoning layer answer "have we seen this error before?" Pulls from `knowledge` and `problems`.

## Why not Mem0 / Graphiti

Mem0 and Graphiti are excellent — for chat-shaped memory. Perch's data is ops-shaped (host, webapp, action, outcome — not user, conversation, fact). Adopting them wholesale would force Qdrant/Neo4j into the deployment surface, breaking the "self-hosted free forever, no extra services" promise.

We borrow the best ideas from both:
- **Mem0**: auto fact-merge, embedding-based recall
- **Graphiti**: bi-temporal facts, explicit contradiction handling
- Implemented on our own SQLite via the LLM hooks above.

If a Perch user later needs the full power of Graphiti (cross-host fleet at 1000+ servers, time-travel queries), v3 will document a swap-in adapter. Not the default.

## Backup + portability

- Stop Perch (so SQLite isn't being written)
- `cp ~/.perch/brain.db /backup/brain-$(date +%F).db`
- Restart

To migrate to a new host: copy `brain.db` + `~/.perch/.env` (contains `PERCH_MASTER_KEY` for vault decryption).

v2.4 will add `brain.export` / `brain.import` HTTP endpoints with optional encryption.
