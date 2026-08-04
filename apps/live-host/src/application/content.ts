/**
 * Content read-model + write use-case over the LIVE documents — the REST/MCP
 * path to the same Y.Text the collaborative rooms edit. Reads and writes go
 * through a server-side Hocuspocus direct connection (injected as `openDoc`),
 * so a PUT lands in the live doc like any co-editor's keystrokes: broadcast to
 * open editors, then written through to the workspace tree.
 *
 * Direct connections bypass two ws-only gates, which therefore live HERE:
 *   - authorization: the HTTP route (repoOf/canWrite) authorizes per request —
 *     stronger than the ws model's authorize-once-at-socket-open
 *   - the ingest size cap (beforeHandleMessage): putContent enforces
 *     maxDocBytes itself, BEFORE any doc mutation (a CRDT can't shrink)
 *
 * Optimistic concurrency: baseVersion = a hash of the CONTENT the caller read.
 * Deliberately NOT the Yjs state vector: the vector is blind to delete-only
 * edits (deletions live in the DeleteSet) and is bound to the doc INSTANCE —
 * after an unload/reseed cycle it changes without any edit, which would fail
 * every save issued minutes after its read. The classic ABA objection to a
 * content hash does not apply here: writes go through the minimal-diff writer,
 * so overwriting identical bytes is a no-op — nothing existing is ever lost.
 * PUT REQUIRES the token from a prior GET; on mismatch it returns the current
 * content instead of writing — a caller can never overwrite an edit it has
 * not seen.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { CONTENT_KEY, roomName } from "@bpmiq/contracts/live";
import type {
  ContentConflictWire,
  ContentWire,
  PutContentBody,
  PutContentResultWire,
} from "@bpmiq/contracts/live-host";
import { AppError } from "@bpmiq/http-kit";
import { updateText } from "@bpmiq/live-client/text";
import { checkBpmnXml } from "@bpmiq/validator";
import type * as Y from "yjs";

import { type RegistryLookup, splitRoom, toDiskPath, type WorkspaceEnsure } from "../domain/rooms.ts";
import { discoverProcesses, loadContentConfig } from "../repos/content.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

/** the minimal direct-connection surface (structural — no @hocuspocus import) */
export interface DirectDoc {
  transact(cb: (doc: Y.Doc) => void): Promise<void>;
  disconnect(): Promise<void>;
  /** the underlying doc — probed for the open-during-unload race (see withDoc) */
  document?: { isDestroyed: boolean } | null;
}

export interface ContentDeps {
  registry: RegistryLookup;
  workspaces: WorkspaceEnsure;
  /** server-side handle to a live room (server.ts: hocuspocus.openDirectConnection) */
  openDoc: (room: string) => Promise<DirectDoc>;
  /** the room size cap — enforced here because beforeHandleMessage never runs
   *  for direct connections */
  maxDocBytes: number;
}

export type PutOutcome = { ok: true; result: PutContentResultWire } | { ok: false; conflict: ContentConflictWire };

/** opaque optimistic-concurrency token (see header) — clients never parse it.
 *  Content-derived, so it survives doc unload/reseed cycles between read and save. */
export function baseVersionOf(content: string): string {
  return createHash("sha256").update(content).digest("base64url");
}

/** the live content of one model file + its concurrency token */
export async function getContent(opts: ContentDeps, repo: ConnectedRepo, path: string): Promise<ContentWire> {
  const safePath = modelPath(opts, repo, path);
  await assertOnDisk(opts, repo, safePath);
  let out: ContentWire | undefined;
  await withDoc(opts, repo, safePath, async (conn) => {
    await conn.transact((doc) => {
      const xml = doc.getText(CONTENT_KEY).toString();
      out = { repo: repo.fullName, path: safePath, xml, baseVersion: baseVersionOf(xml) };
    });
  });
  if (!out) throw new Error(`read produced no content: ${safePath}`); // unreachable
  return out;
}

/** validate + compare-and-set the live document. Never writes on a stale token. */
export async function putContent(
  opts: ContentDeps,
  repo: ConnectedRepo,
  path: string,
  body: PutContentBody,
): Promise<PutOutcome> {
  const safePath = modelPath(opts, repo, path);
  if (typeof body?.xml !== "string") {
    throw new AppError("content/xml-required", "body.xml must be a string", { status: 400, expose: true });
  }
  if (typeof body.baseVersion !== "string" || body.baseVersion.length === 0) {
    throw new AppError(
      "content/base-version-required",
      "PUT requires baseVersion from a prior GET — read the current content first",
      { status: 400, expose: true },
    );
  }
  // size cap FIRST: a CRDT can't shrink after the fact, and the ws-side ingest
  // guard (beforeHandleMessage) does not run for direct connections
  if (Buffer.byteLength(body.xml, "utf8") > opts.maxDocBytes) {
    throw new AppError("content/too-large", `content exceeds the ${opts.maxDocBytes}-byte document cap`, {
      status: 413,
      expose: true,
    });
  }
  const workspace = await assertOnDisk(opts, repo, safePath);

  // full platform validation for BPMN (structure + BPMNDI coverage + callActivity
  // links); other editable notations (.dmn) pass through unvalidated.
  // lint:"warn" reports ERRORs on the result instead of refusing — the modeler
  // widget's autosave path; the ws rooms have never gated live edits, so this
  // is the same trust level, not a new one. Default stays "block" (REST + agents).
  let warnings: string[] = [];
  let lintErrors: string[] = [];
  if (safePath.endsWith(".bpmn")) {
    const cfg = loadContentConfig(workspace);
    const processIds = cfg ? new Set((await discoverProcesses(workspace, cfg)).map((p) => p.id)) : undefined;
    const { findings } = checkBpmnXml(body.xml, { file: safePath, processIds });
    const errors = findings.filter((f) => f.severity === "ERROR");
    if (errors.length > 0 && body.lint !== "warn") {
      throw new AppError(
        "content/invalid-model",
        `validation failed:\n- ${errors.map((f) => f.message).join("\n- ")}`,
        {
          status: 422,
          expose: true,
        },
      );
    }
    lintErrors = errors.map((f) => f.message);
    warnings = findings.filter((f) => f.severity === "WARN").map((f) => f.message);
  }

  let outcome: PutOutcome | undefined;
  await withDoc(opts, repo, safePath, async (conn) => {
    // CAS + write inside ONE synchronous transact callback — atomic on the event
    // loop, so no remote update can land between the compare and the write
    await conn.transact((doc) => {
      const ytext = doc.getText(CONTENT_KEY);
      const current = ytext.toString();
      const currentVersion = baseVersionOf(current);
      if (body.baseVersion !== currentVersion) {
        outcome = {
          ok: false,
          conflict: {
            error: "the document changed since your last read — re-derive your edit against currentXml and retry",
            code: "content/conflict",
            path: safePath,
            currentXml: current,
            baseVersion: currentVersion,
          },
        };
        return; // no mutation on conflict
      }
      // minimal diff (shared writer with web/vscode) — co-editors see an
      // incremental update, not a replace-all
      updateText(ytext, body.xml);
      outcome = {
        ok: true,
        result: {
          path: safePath,
          baseVersion: baseVersionOf(body.xml),
          warnings,
          ...(lintErrors.length > 0 ? { errors: lintErrors } : {}),
        },
      };
    });
  });
  if (!outcome) throw new Error(`write produced no outcome: ${safePath}`); // unreachable
  return outcome;
}

/** validate `path` through the live-room gate (splitRoom) against the ALREADY
 *  authorized repo — same pattern as history.ts modelPath */
function modelPath(opts: ContentDeps, repo: ConnectedRepo, path: string): string {
  let split: { repo: ConnectedRepo; path: string };
  try {
    split = splitRoom(roomName(repo.fullName, path), opts.registry);
  } catch (e) {
    throw new AppError("content/invalid-path", (e as Error).message, { status: 400, expose: true });
  }
  if (split.repo.fullName !== repo.fullName) {
    throw new AppError("content/invalid-path", `path resolves outside ${repo.fullName}: ${path}`, {
      status: 400,
      expose: true,
    });
  }
  return split.path;
}

/** pre-flight: content repo + file exists (typed errors BEFORE any doc work).
 *  Returns the workspace root. The authoritative checks (incl. the realpath
 *  symlink guard) re-run inside onLoadDocument when the doc is opened. */
async function assertOnDisk(opts: ContentDeps, repo: ConnectedRepo, safePath: string): Promise<string> {
  const room = roomName(repo.fullName, safePath);
  let disk: string;
  try {
    disk = await toDiskPath(room, opts.registry, opts.workspaces, loadContentConfig);
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("no bpmiq.yml")) {
      throw new AppError("content/not-a-content-repo", message, { status: 422, expose: true });
    }
    throw new AppError("content/invalid-path", message, { status: 400, expose: true });
  }
  if (!existsSync(disk)) {
    throw new AppError("content/not-found", `no such file: ${safePath} (${repo.fullName})`, {
      status: 404,
      expose: true,
    });
  }
  return opts.workspaces.ensure(repo);
}

/** per-room operation queue: Hocuspocus unloads a doc ASYNCHRONOUSLY after the
 *  last disconnect when a store is mid-flight, and createDocument happily
 *  returns a doc whose unload is in flight — so a rapid get→save on one room
 *  (the normal agent pattern) could acquire a DYING doc. Serializing our
 *  direct-connection operations per room closes the common window; the
 *  destroyed-doc retry in withDoc closes the residual one. */
const roomQueues = new Map<string, Promise<unknown>>();

/** open the room, run `fn`, ALWAYS disconnect — a leaked direct connection
 *  would pin the doc live forever (blocking sync-to-default). disconnect()
 *  also force-runs the store hook, so the write-through hits the workspace
 *  tree before the HTTP response goes out. */
async function withDoc(
  opts: ContentDeps,
  repo: ConnectedRepo,
  safePath: string,
  fn: (conn: DirectDoc) => Promise<void>,
): Promise<void> {
  const room = roomName(repo.fullName, safePath);
  const run = async (): Promise<void> => {
    const conn = await openLive(opts, room);
    try {
      await fn(conn);
    } finally {
      await conn.disconnect();
    }
  };
  const queued = (roomQueues.get(room) ?? Promise.resolve()).then(run, run);
  // the tail swallows the error (it propagates to THIS caller via `queued`) so
  // one failing operation never poisons the queue for the next
  const tail = queued.catch(() => undefined);
  roomQueues.set(room, tail);
  try {
    return await queued;
  } finally {
    // last waiter cleans up so the map doesn't grow with dead rooms
    if (roomQueues.get(room) === tail) roomQueues.delete(room);
  }
}

/** open with a bounded retry when the acquired doc is already being destroyed
 *  (an unload that our own previous disconnect left in flight) */
async function openLive(opts: ContentDeps, room: string): Promise<DirectDoc> {
  for (let attempt = 0; ; attempt++) {
    let conn: DirectDoc;
    try {
      conn = await opts.openDoc(room);
    } catch (e) {
      // TOCTOU backstop: file deleted between pre-flight and open
      const message = (e as Error).message;
      if (message.startsWith("no such file:")) {
        throw new AppError("content/not-found", message, { status: 404, expose: true });
      }
      throw e;
    }
    if (!conn.document?.isDestroyed) return conn;
    await conn.disconnect().catch(() => undefined);
    if (attempt >= 3) throw new Error(`room is stuck unloading: ${room}`);
    await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
  }
}
