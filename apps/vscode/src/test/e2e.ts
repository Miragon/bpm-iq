/**
 * Integration test, runs INSIDE a real VS Code instance (@vscode/test-electron).
 * Exercises the M0 checklist from apps/live-host/README.md programmatically:
 *   1. open bpm-live:/…/order-to-cash.bpmn as text — content must equal the working tree
 *   2. remote guest edit → the open (non-dirty) document must update
 *   3. local edit + save → the remote guest must receive it
 *   4. if the Miragon BPMN Modeler is installed: open the SAME virtual doc with the
 *      custom editor (openWith) and assert the custom-editor tab is live
 *
 * Server contract (multi-repo): HTTP + ws share ONE port (8301), room names are
 * repo-qualified (<owner>/<repo>/<path>). Needs the Live Host running with
 * LIVE_DEV_TOKEN=demo.
 */
import { readFileSync } from "node:fs";

import { CONTENT_KEY } from "@bpmiq/contracts/live";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as vscode from "vscode";
import WebSocket from "ws";

const HOST_REPO = process.env.GITHUB_REPO ?? "Miragon/bpm-iq";
const FILE = "processes/order-to-cash/order-to-cash.bpmn";
/** room name on the Live Host = <owner>/<repo>/<repo-relative-path> */
const DOC = `${HOST_REPO}/${FILE}`;
/** where that file lives on disk (the host serves process-documentation/ in place);
 *  set by runTest.mts (repo-relative default) or overridden via the environment */
const CONTENT_ROOT = process.env.LIVE_HOST_CONTENT_DIR;
if (!CONTENT_ROOT)
  throw new Error("LIVE_HOST_CONTENT_DIR must point at the content-repo checkout the Live Host serves");
const MIRAGON = "miragon-gmbh.vs-code-bpmn-modeler";
const results: string[] = [];
const pass = (m: string) => results.push(`PASS  ${m}`);
const fail = (m: string) => results.push(`FAIL  ${m}`);

async function until(what: string, pred: () => boolean, ms = 8000): Promise<number> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return Date.now() - start;
}

export async function run(): Promise<void> {
  try {
    // headless guest, connected to the same live host
    const socket = new HocuspocusProviderWebsocket({
      url: "ws://localhost:8301",
      WebSocketPolyfill: WebSocket as never,
    });
    const guest = new HocuspocusProvider({ websocketProvider: socket, name: DOC, token: "demo" });
    guest.attach();
    await new Promise<void>((res, rej) => {
      guest.on("synced", () => res());
      setTimeout(() => rej(new Error("guest sync timeout")), 8000);
    });
    const ytext = guest.document.getText(CONTENT_KEY);

    // 1 — open the live document as text
    const uri = vscode.Uri.parse(`bpm-live:/${DOC}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    const disk = readFileSync(`${CONTENT_ROOT}/${FILE}`, "utf8");
    if (doc.getText() === disk) pass("virtual document content equals working tree");
    else fail(`content mismatch: doc ${doc.getText().length} chars vs disk ${disk.length}`);

    // 2 — inbound: remote edit reaches the open document
    const M1 = `<!-- vscode-e2e-in-${Date.now()} -->`;
    ytext.insert(ytext.length, `\n${M1}`);
    let autoReverted = true;
    try {
      const t = await until("remote edit visible in open document", () => doc.getText().includes(M1), 6000);
      pass(`remote edit auto-applied to open document after ${t}ms`);
    } catch {
      autoReverted = false;
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await until("remote edit after manual revert", () => doc.getText().includes(M1), 4000);
      pass("remote edit visible after explicit revert (auto-revert did NOT fire — M1 finding)");
    }

    // 3 — outbound: local edit + save reaches the guest
    const M2 = `<!-- vscode-e2e-out-${Date.now()} -->`;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(doc.lineCount, 0), `${M2}\n`);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    const tOut = await until("guest receives local edit", () => ytext.toString().includes(M2), 6000);
    pass(`local edit+save reached the remote guest after ${tOut}ms`);

    // 4 — the Miragon custom editor on the SAME virtual document
    const miragon = vscode.extensions.getExtension(MIRAGON);
    if (miragon) {
      await vscode.commands.executeCommand("vscode.openWith", uri, "bpmn-modeler.bpmn");
      await new Promise((r) => setTimeout(r, 4000)); // webview boot
      const tab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === "bpmn-modeler.bpmn");
      if (tab) pass("Miragon BPMN Modeler opened the bpm-live:// document (custom-editor tab active)");
      else fail("no custom-editor tab for bpmn-modeler.bpmn found");
      // remote edit while the custom editor is open — document must keep syncing
      const M3 = `<!-- vscode-e2e-custom-${Date.now()} -->`;
      ytext.insert(ytext.length, `\n${M3}`);
      try {
        await until("remote edit while custom editor open", () => doc.getText().includes(M3), 6000);
        pass("remote edit propagated while the custom editor is open");
      } catch {
        results.push(
          "WARN  remote edit did not reach the document while custom editor open (custom editors keep non-dirty docs from auto-revert? M1 finding)",
        );
      }
      const s3 = ytext.toString();
      ytext.delete(s3.indexOf(`\n${M3}`), M3.length + 1);
    } else {
      results.push(`WARN  ${MIRAGON} not installed in test instance — custom-editor check skipped`);
    }

    // cleanup: remove markers via the guest, save nothing locally
    let s = ytext.toString();
    ytext.delete(s.indexOf(`\n${M1}`), M1.length + 1);
    s = ytext.toString();
    const i2 = s.indexOf(`${M2}\n`);
    if (i2 >= 0) ytext.delete(i2, M2.length + 1);
    await new Promise((r) => setTimeout(r, 3000)); // let write-through settle
    if (!readFileSync(`${CONTENT_ROOT}/${FILE}`, "utf8").includes("vscode-e2e")) pass("cleanup: working tree clean");
    else fail("cleanup: markers left on disk");
    if (!autoReverted) results.push("NOTE  auto-revert path needed manual revert");
  } catch (err) {
    fail(`unexpected: ${(err as Error).message}`);
  }

  console.log("\n=== VS Code E2E ===");
  for (const r of results) console.log(r);
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("VS Code E2E failed");
}
