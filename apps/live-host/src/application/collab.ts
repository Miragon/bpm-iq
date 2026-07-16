/**
 * The Hocuspocus collaboration hooks — the room lifecycle, extracted from
 * server.ts so it is unit-testable (server.ts opens a listener on import).
 *
 *   onAuthenticate   → session (from OAuth login) + PER-REPO write permission
 *                      for the room being joined (AccessCache)
 *   onLoadDocument   → restore Yjs lineage from SQLite, else seed from the
 *                      repo's workspace tree
 *   onStoreDocument  → persist lineage + debounced write-through to the tree
 *
 * Every dependency is injected (no module state); the hook parameter types are
 * the MINIMAL structural surfaces each hook reads, so tests call them directly
 * with fake payloads while server.ts spreads them into `new Server({...})`
 * (a hook taking a narrower payload accepts Hocuspocus' full one).
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { CONTENT_KEY } from "@bpmiq/contracts/live";
import * as Y from "yjs";

import type { LineageStore } from "../adapters/sqlite/lineage-store.ts";
import type { Session } from "../adapters/sqlite/sessions.ts";
import type { DocSizeGuard } from "../domain/doc-size-guard.ts";
import {
  type ContentConfigLookup,
  type RegistryLookup,
  splitRoom,
  toDiskPath,
  type WorkspaceEnsure,
} from "../domain/rooms.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export interface CollabDeps {
  lineage: Pick<LineageStore, "load" | "save">;
  docGuard: DocSizeGuard;
  maxDocBytes: number;
  sessions: { get(id: string | undefined): Session | undefined };
  access: { canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> };
  registry: RegistryLookup;
  workspaces: WorkspaceEnsure;
  /** the repo's content config (bpmiq.yml) — rooms exist only inside its processes folder */
  contentConfig: ContentConfigLookup;
  /** optional shared token for headless clients (tests, VS Code) — off if unset */
  devToken: () => string | undefined;
  /** repo-qualified document names of live rooms (shared with reconcile + API) */
  liveDocs: Set<string>;
}

export function makeCollabHooks(deps: CollabDeps) {
  const { lineage, docGuard, maxDocBytes, sessions, access, registry, workspaces, contentConfig, devToken, liveDocs } =
    deps;

  /**
   * Resolve a room to disk AND reject symlink escapes. toDiskPath (pure domain)
   * does the lexical containment; resolve() is blind to symlinks, so a *.bpmn
   * symlink escaping the checkout would otherwise be read/written through. Once
   * the target exists, canonicalize it and re-check it stays inside the workspace
   * (realpath lives here in the application layer — the domain module stays pure).
   */
  const resolveRoom = async (documentName: string): Promise<string> => {
    const disk = await toDiskPath(documentName, registry, workspaces, contentConfig);
    if (existsSync(disk)) {
      const { repo } = splitRoom(documentName, registry);
      const workspace = await workspaces.ensure(repo);
      if (!realpathSync(disk).startsWith(realpathSync(workspace) + "/")) {
        throw new Error(`path escapes workspace (symlink): ${documentName}`);
      }
    }
    return disk;
  };

  return {
    async onAuthenticate({ token, documentName }: { token: string; documentName: string }) {
      const { repo } = splitRoom(documentName, registry); // reject malformed/unknown rooms first
      // ws token = session id (issued after the provider's OAuth grant) …
      const session = sessions.get(token);
      if (session) {
        if (!(await access.canWrite(session, repo))) {
          throw new Error(`@${session.user.login}: no write access to ${repo.fullName}`);
        }
        return { user: session.user, documentName };
      }
      // … or the explicit dev token for headless clients (all-repos semantics).
      const dev = devToken();
      if (dev && token === dev) {
        return { user: { login: "dev-token", provider: "dev" }, documentName };
      }
      throw new Error("invalid session — log in via the web app (git provider OAuth)");
    },

    async onLoadDocument({ document, documentName }: { document: Y.Doc; documentName: string }) {
      const disk = await resolveRoom(documentName);
      if (!existsSync(disk)) throw new Error(`no such file: ${documentName}`);
      // NB docGuard.load() below must stay AFTER every throw site in this hook: a
      // failed load never fires afterUnloadDocument (no document registered), so a
      // guard entry registered before a throw would leak forever.
      const stored = lineage.load(documentName);
      if (stored) {
        // resume the persisted lineage — never re-seed on top of it
        Y.applyUpdate(document, new Uint8Array(stored));
        docGuard.load(documentName, stored.length); // the blob IS the encoded size
        if (stored.length > maxDocBytes) {
          // pre-cap legacy blob: every edit session on it will be rejected at ingest.
          // Recovery: delete the row (reseeds from the workspace file) or raise the cap.
          console.log(
            `WARN: ${documentName} restored at ${stored.length}B (> ${maxDocBytes}B cap) — ws edits will be refused`,
          );
        }
        console.log(`restored: ${documentName} (${document.getText(CONTENT_KEY).length} chars from live.db)`);
      } else {
        const ytext = document.getText(CONTENT_KEY);
        if (ytext.length === 0) {
          const content = await readFile(disk, "utf8");
          ytext.insert(0, content);
          // estimate; the guard re-measures precisely if a doc ever nears the cap
          docGuard.load(documentName, Buffer.byteLength(content));
          console.log(`seeded: ${documentName} (${ytext.length} chars from workspace)`);
        }
      }
      // track the room as live ONLY here: onAuthenticate has passed, splitRoom +
      // toDiskPath + existsSync validated it, and a Document IS being created so
      // afterUnloadDocument will symmetrically remove it. (Doing this in the pre-auth
      // onConnect leaked unauthenticated/garbage names forever — no Document means no
      // unload — an unauth DoS of the hasLiveDocs-gated release/reconcile path.)
      liveDocs.add(documentName);
      return document;
    },

    // ingest-side size cap (M3): reject an update that would push the doc past
    // MAX_DOC_BYTES *before* it is applied. NB Hocuspocus CLOSES the connection
    // whose beforeHandleMessage rejects (code 4205; the client auto-reconnects and
    // hits the cap again) — so an at-cap doc can't be edited over ws at all, only
    // read via the REST/portal paths. Operator recovery for an over-cap doc:
    // delete its live.db `documents` row (it reseeds from the ≤cap workspace
    // file) or temporarily raise LIVE_MAX_DOC_BYTES. The measure cooldown in the
    // guard bounds the cost of reconnect hammering to ~1 encode / 5s / doc.
    async beforeHandleMessage({
      documentName,
      document,
      update,
    }: {
      documentName: string;
      document: Y.Doc;
      update: Uint8Array;
    }) {
      if (!docGuard.admit(documentName, update.length, () => Y.encodeStateAsUpdate(document).length)) {
        throw new Error(`${documentName}: update rejected — document is at the ${maxDocBytes}B cap`);
      }
    },

    // Debounced by Hocuspocus itself (default: 2s after last change, max 10s).
    async onStoreDocument({ document, documentName }: { document: Y.Doc; documentName: string }) {
      const update = Y.encodeStateAsUpdate(document);
      docGuard.stored(documentName, update.length); // re-anchor the ingest guard's estimate
      if (update.length > maxDocBytes) {
        // refuse to persist an oversized room — bounds disk + restart-reload memory.
        // The in-memory doc is left as-is; the cap keeps the DURABLE footprint bounded.
        console.log(`skip persist: ${documentName} is ${update.length}B (> ${maxDocBytes}B cap) — not written`);
        return;
      }
      lineage.save(documentName, update);
      const content = document.getText(CONTENT_KEY).toString();
      await writeFile(await resolveRoom(documentName), content);
      console.log(`write-through: ${documentName} (${content.length} chars)`);
    },

    async onConnect({ documentName }: { documentName: string }) {
      // do NOT touch liveDocs here — onConnect runs BEFORE onAuthenticate, so
      // documentName is unauthenticated + unvalidated (attacker-controlled). liveDocs
      // is populated post-auth in onLoadDocument and cleared in afterUnloadDocument.
      console.log(`connect: ${documentName}`);
    },
    async onDisconnect({ documentName }: { documentName: string }) {
      console.log(`disconnect: ${documentName}`);
    },
    // fires when the LAST connection closed and Hocuspocus dropped the document —
    // without this, liveDocs only ever grows and the live counters stay wrong forever
    async afterUnloadDocument({ documentName }: { documentName: string }) {
      liveDocs.delete(documentName);
      docGuard.drop(documentName); // symmetric with load() — the guard map must not grow
      console.log(`unloaded: ${documentName}`);
    },
  };
}
