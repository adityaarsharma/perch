/**
 * brain-rooms.ts — Typed "rooms" API on top of brain.ts
 *
 * brain.ts ships per-table function helpers (logProblem, logAction, …). That
 * works but is verbose at the call site and mixes concerns.
 *
 * brain-rooms.ts gives every domain a typed API so calls read like:
 *
 *     const rooms = openRooms(brain);
 *     await rooms.problems.log({ ... });
 *     const recent = await rooms.actions.recent(10);
 *     const facts  = await rooms.knowledge.search({ host: 'foo.com' });
 *
 * STATUS: scaffold (v2.3) — facade over the existing brain.ts functions.
 * v2.4 adds: bi-temporal columns to knowledge, conflict detection on upsert,
 * embeddings table (sqlite-vec sidecar), audit_log room.
 */

import type { default as Database } from 'better-sqlite3';
import {
  logProblem, logAction, getRecentActions, incrementKnowledge,
  getBrain,
  type ProblemInput, type ActionLogInput, type ActionLogEntry,
  type BrainSummary,
} from './brain.js';

// ─── Room interfaces ─────────────────────────────────────────────────────────

export interface ProblemsRoom {
  log(input: ProblemInput): number;
}

export interface ActionsRoom {
  log(input: ActionLogInput): number;
  recent(limit?: number): ActionLogEntry[];
}

export interface KnowledgeRoom {
  /** Record a pattern → cause → fix triple (existing brain.ts surface) */
  remember(pattern: string, cause: string, fix: string): void;
  /** v2.4: search by host/domain/tag */
  search?(filter: { host?: string; domain?: string }): unknown[];
}

export interface SecretsRoom {
  // Backed by core/vault.ts; thin facade for symmetry
  // v2.4: implement get/put/list/delete here
  placeholder: true;
}

export interface GuardrailsRoom {
  // v2.4: rules editable via API
  placeholder: true;
}

export interface IncidentsRoom {
  // v2.4: open/ack/resolve lifecycle
  placeholder: true;
}

export interface TimeseriesRoom {
  // v2.4: write metric points; read over a window
  placeholder: true;
}

export interface AuditLogRoom {
  // v2.4: append-only every-decision trail
  placeholder: true;
}

export interface WebappsRoom {
  // v2.4: typed wrapper over the existing webapps table
  placeholder: true;
}

export interface BrainRooms {
  problems: ProblemsRoom;
  actions: ActionsRoom;
  knowledge: KnowledgeRoom;
  secrets: SecretsRoom;
  guardrails: GuardrailsRoom;
  incidents: IncidentsRoom;
  timeseries: TimeseriesRoom;
  audit_log: AuditLogRoom;
  webapps: WebappsRoom;
  /** Read-only roll-up across rooms */
  summary(): BrainSummary;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function openRooms(db: Database.Database): BrainRooms {
  return {
    problems: {
      log: (input) => logProblem(db, input),
    },
    actions: {
      log: (input) => logAction(db, input),
      recent: (limit = 10) => getRecentActions(db, limit),
    },
    knowledge: {
      remember: (pattern, cause, fix) => incrementKnowledge(db, pattern, cause, fix),
    },
    secrets: { placeholder: true },
    guardrails: { placeholder: true },
    incidents: { placeholder: true },
    timeseries: { placeholder: true },
    audit_log: { placeholder: true },
    webapps: { placeholder: true },
    summary: () => getBrain(db),
  };
}
