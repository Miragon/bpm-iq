/**
 * Yjs lineage persistence, SQLite-backed (same .live/live.db as the sessions).
 *
 * The SAME document lineage must survive restarts, otherwise reconnecting
 * clients merge their old history into a freshly seeded doc and every
 * character duplicates (observed live — see apps/live-host/README.md).
 * Extracted from server.ts; the SQL (tables, migration, statements) is
 * unchanged so existing live.db files keep working as-is.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export class LineageStore {
  private readonly loadState: StatementSync;
  private readonly saveState: StatementSync;
  private readonly dropState: StatementSync;

  constructor(db: DatabaseSync, hostRepo: string) {
    db.exec("CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB)");
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    // ONE-TIME migration: pre-multi-repo rows used bare repo-relative paths — they
    // all belonged to the host repo; prefix once so their lineage survives. Guarded
    // by a flag so it NEVER runs twice: re-running would re-prefix legitimate
    // multi-repo rooms whose owner happens to be "processes"/"landscape"/"docs" and
    // eventually crash on the PRIMARY KEY (adversarial review, critical).
    if (!db.prepare("SELECT value FROM meta WHERE key = 'multirepo_migration'").get()) {
      db.prepare(
        "UPDATE documents SET name = ? || '/' || name WHERE name LIKE 'processes/%' OR name LIKE 'landscape/%' OR name LIKE 'docs/%'",
      ).run(hostRepo);
      db.prepare("INSERT INTO meta (key, value) VALUES ('multirepo_migration', '1')").run();
    }
    this.loadState = db.prepare("SELECT state FROM documents WHERE name = ?");
    this.saveState = db.prepare(
      "INSERT INTO documents (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state",
    );
    this.dropState = db.prepare("DELETE FROM documents WHERE name = ?");
  }

  /** the persisted Yjs update blob for a room, or undefined if never stored */
  load(name: string): Uint8Array | undefined {
    const row = this.loadState.get(name) as { state?: Uint8Array } | undefined;
    return row?.state ?? undefined;
  }

  save(name: string, state: Uint8Array): void {
    this.saveState.run(name, Buffer.from(state));
  }

  drop(name: string): void {
    this.dropState.run(name);
  }
}
