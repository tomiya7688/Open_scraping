import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  RunJournalEvent,
  RunJournalSnapshot,
  RunStateStore,
  StoredRunJournal
} from "@open-scraping/core";

export interface SqliteRunStateStoreOptions {
  path: string;
}

function parseSnapshot(value: string): RunJournalSnapshot {
  return JSON.parse(value) as RunJournalSnapshot;
}

function parseEvent(value: string): RunJournalEvent {
  return JSON.parse(value) as RunJournalEvent;
}

export class SqliteRunStateStore implements RunStateStore {
  readonly #path: string;
  #db: DatabaseSync | undefined;

  constructor(options: SqliteRunStateStoreOptions) {
    this.#path = options.path;
  }

  async open(): Promise<void> {
    if (this.#db) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const db = new DatabaseSync(this.#path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_snapshots (
        run_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_run_events_generation
        ON run_events(run_id, generation, sequence);
    `);
    this.#db = db;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  async save_snapshot(snapshot: RunJournalSnapshot): Promise<void> {
    const db = this.#requireDb();
    const existing = db
      .prepare(
        "SELECT generation FROM run_snapshots WHERE run_id = ?"
      )
      .get(snapshot.run_id) as { generation: number } | undefined;

    if (
      existing !== undefined &&
      existing.generation > snapshot.generation
    ) {
      throw new Error(
        `refusing to overwrite generation ${existing.generation} with stale generation ${snapshot.generation}`
      );
    }

    db.prepare(`
      INSERT INTO run_snapshots(run_id, generation, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        generation = excluded.generation,
        updated_at = excluded.updated_at,
        snapshot_json = excluded.snapshot_json
    `).run(
      snapshot.run_id,
      snapshot.generation,
      snapshot.updated_at,
      JSON.stringify(snapshot)
    );
  }

  async append_event(event: RunJournalEvent): Promise<number> {
    const db = this.#requireDb();

    db.exec("BEGIN IMMEDIATE");
    try {
      const current = db
        .prepare(
          "SELECT generation FROM run_snapshots WHERE run_id = ?"
        )
        .get(event.run_id) as { generation: number } | undefined;

      if (
        current !== undefined &&
        event.generation < current.generation
      ) {
        throw new Error(
          `stale generation event ${event.generation}; current generation is ${current.generation}`
        );
      }

      const latest = db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_events WHERE run_id = ?"
        )
        .get(event.run_id) as { sequence: number };

      const sequence = latest.sequence + 1;
      const stored: RunJournalEvent = {
        ...event,
        sequence
      };

      db.prepare(`
        INSERT INTO run_events(
          run_id, sequence, generation, recorded_at, event_type, event_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        stored.run_id,
        sequence,
        stored.generation,
        stored.recorded_at,
        stored.event_type,
        JSON.stringify(stored)
      );
      db.exec("COMMIT");
      return sequence;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async load_run(run_id: string): Promise<StoredRunJournal | undefined> {
    const db = this.#requireDb();
    const row = db
      .prepare(
        "SELECT snapshot_json FROM run_snapshots WHERE run_id = ?"
      )
      .get(run_id) as { snapshot_json: string } | undefined;

    if (!row) return undefined;

    const eventRows = db
      .prepare(
        "SELECT event_json FROM run_events WHERE run_id = ? ORDER BY sequence ASC"
      )
      .all(run_id) as Array<{ event_json: string }>;

    return {
      snapshot: parseSnapshot(row.snapshot_json),
      events: eventRows.map((event) => parseEvent(event.event_json))
    };
  }

  #requireDb(): DatabaseSync {
    if (!this.#db) {
      throw new Error("SqliteRunStateStore is not open");
    }
    return this.#db;
  }
}
