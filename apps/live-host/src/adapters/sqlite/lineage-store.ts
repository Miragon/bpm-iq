/**
 * Yjs lineage persistence, SQLite-backed (same .live/live.db as the sessions).
 *
 * The SAME document lineage must survive restarts, otherwise reconnecting
 * clients merge their old history into a freshly seeded doc and every
 * character duplicates (observed live — see apps/live-host/README.md).
 * Extracted from server.ts; the original SQL (tables, migration, statements)
 * is unchanged so existing live.db files keep working as-is — the `seed`
 * column (#103) is additive, backfilled as 0 (= treated as edited, never
 * dropped: the pre-#103 restore semantics).
 *
 * `seed = 1` marks a row as a PURE SEED: written by onLoadDocument's eager
 * persist, cleared by the first real store. The distinction matters because a
 * pure seed is replaceable (the workspace file it mirrors is authoritative —
 * if the file changed out of band, the row may be dropped and re-seeded), while
 * a row with edits anchors client history that exists nowhere else and must
 * NEVER be dropped in favour of the file. The flag lives IN the documents row
 * so every mutation is ONE autocommitted statement — a crash can never leave
 * flag and state out of sync (with a separate marker table, a host dying
 * between the two statements of the first real store left the edited row still
 * seed-marked, and the next load dropped irreplaceable client history —
 * adversarial review, major).
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

export class LineageStore {
  private readonly loadState: StatementSync;
  private readonly saveState: StatementSync;
  private readonly saveSeedState: StatementSync;
  private readonly isSeedState: StatementSync;
  private readonly dropState: StatementSync;

  constructor(db: DatabaseSync, hostRepo: string) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, state BLOB, seed INTEGER NOT NULL DEFAULT 0)",
    );
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    // additive migration for pre-seed-flag live.db files (idempotent by inspection)
    const cols = db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "seed")) {
      db.exec("ALTER TABLE documents ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
    }
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
      "INSERT INTO documents (name, state, seed) VALUES (?, ?, 0) ON CONFLICT(name) DO UPDATE SET state = excluded.state, seed = 0",
    );
    this.saveSeedState = db.prepare(
      "INSERT INTO documents (name, state, seed) VALUES (?, ?, 1) ON CONFLICT(name) DO UPDATE SET state = excluded.state, seed = 1",
    );
    this.isSeedState = db.prepare("SELECT seed FROM documents WHERE name = ?");
    this.dropState = db.prepare("DELETE FROM documents WHERE name = ?");
  }

  /** the persisted Yjs update blob for a room, or undefined if never stored */
  load(name: string): Uint8Array | undefined {
    const row = this.loadState.get(name) as { state?: Uint8Array } | undefined;
    return row?.state ?? undefined;
  }

  /** a real store: the row now anchors client history — the seed flag goes */
  save(name: string, state: Uint8Array): void {
    this.saveState.run(name, Buffer.from(state));
  }

  /** the eager seed persist (#103): same row, but flagged replaceable */
  saveSeed(name: string, state: Uint8Array): void {
    this.saveSeedState.run(name, Buffer.from(state));
  }

  /** true while the row is a pure seed no client has ever edited */
  isSeed(name: string): boolean {
    const row = this.isSeedState.get(name) as { seed?: number | bigint } | undefined;
    return Number(row?.seed ?? 0) === 1;
  }

  drop(name: string): void {
    this.dropState.run(name);
  }
}
