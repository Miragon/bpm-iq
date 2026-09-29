/**
 * Unfinished todo jobs (application/todo-jobs.ts), SQLite-backed in the same
 * live.db as sessions and lineages — so a host restart resumes a rename's
 * todo move instead of leaving half the todos behind. The todos themselves
 * never live here (they are the tracker's); a row is the job, and it is gone
 * once the job finished cleanly.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { TodoJobKind, TodoJobSpec, TodoJobStore } from "../../application/todo-jobs.ts";

export class SqliteTodoJobStore implements TodoJobStore {
  private readonly listState: StatementSync;
  private readonly putState: StatementSync;
  private readonly removeState: StatementSync;

  constructor(db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS todo_jobs (repo TEXT NOT NULL, kind TEXT NOT NULL, from_process TEXT NOT NULL, " +
        "to_process TEXT, to_file TEXT, by_login TEXT NOT NULL, PRIMARY KEY (repo, kind, from_process))",
    );
    this.listState = db.prepare("SELECT repo, kind, from_process, to_process, to_file, by_login FROM todo_jobs");
    this.putState = db.prepare(
      "INSERT OR REPLACE INTO todo_jobs (repo, kind, from_process, to_process, to_file, by_login) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.removeState = db.prepare("DELETE FROM todo_jobs WHERE repo = ? AND kind = ? AND from_process = ?");
  }

  list(): TodoJobSpec[] {
    const rows = this.listState.all() as Array<{
      repo: string;
      kind: string;
      from_process: string;
      to_process: string | null;
      to_file: string | null;
      by_login: string;
    }>;
    return rows
      .filter((r) => r.kind === "move" || r.kind === "close")
      .map((r) => ({
        repo: r.repo,
        kind: r.kind as TodoJobKind,
        from: r.from_process,
        ...(r.to_process ? { to: { process: r.to_process, file: r.to_file ?? "" } } : {}),
        by: r.by_login,
      }));
  }

  put(spec: TodoJobSpec): void {
    this.putState.run(spec.repo, spec.kind, spec.from, spec.to?.process ?? null, spec.to?.file ?? null, spec.by);
  }

  remove(repo: string, kind: TodoJobKind, from: string): void {
    this.removeState.run(repo, kind, from);
  }
}
