/**
 * Widget wiring: App handshake → tool input → load the live XML → modeler,
 * plus the save lifecycle with the baseVersion CAS conflict flow (the same
 * GET→edit→PUT-CAS dance every AI client does — deliberately NOT the Yjs path).
 *
 * Data path is ontoolinput + an app-initiated get_bpmn_xml — never the tool
 * result (Claude Desktop strips structuredContent, ext-apps #696), and never
 * a payload big enough to trip the hosts' ~150k-char result limit.
 */
import "./styles.css";

import {
  bootConfig,
  claimDocument,
  getBpmnXml,
  makeApp,
  type ProcessRef,
  saveBpmnXml,
  type SaveConflict,
  validateBpmn,
} from "./bridge";
import { loadBpmnFont } from "./font";
import { type ModelerHandle, mountModeler } from "./modeler";

// kick off immediately — palette icons need it, but nothing blocks on it
loadBpmnFont().catch(() => {
  /* icons degrade to tofu; the modeler itself is unaffected */
});

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const toolbar = { title: el<HTMLSpanElement>("title"), dirty: el<HTMLSpanElement>("dirty") };
const saveBtn = el<HTMLButtonElement>("save");
const fullscreenBtn = el<HTMLButtonElement>("fullscreen");
const banner = el<HTMLDivElement>("banner");
const status = el<HTMLDivElement>("status");

const cfg = bootConfig();
const app = makeApp();

let modeler: ModelerHandle | undefined;
let ref: ProcessRef | undefined;
let baseVersion = "";

const setStatus = (text: string): void => {
  status.textContent = text;
};
const setDirty = (d: boolean): void => {
  toolbar.dirty.hidden = !d;
};

function showBanner(html: string, actions: Array<{ label: string; danger?: boolean; run: () => void }>): void {
  banner.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = html;
  banner.append(msg);
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    if (a.danger) b.classList.add("danger");
    b.onclick = () => a.run();
    banner.append(b);
  }
  banner.hidden = false;
}
const hideBanner = (): void => {
  banner.hidden = true;
};

async function load(processRef: ProcessRef): Promise<void> {
  ref = processRef;
  setStatus("Loading model…");
  const content = await getBpmnXml(app, processRef);
  ref = { repo: processRef.repo, path: content.path };
  toolbar.title.textContent = `${processRef.repo} · ${content.path}`;
  baseVersion = content.baseVersion;
  if (!modeler) {
    modeler = mountModeler(el<HTMLDivElement>("canvas"), cfg.readonly);
    modeler.onDirty(() => setDirty(true));
    saveBtn.hidden = !modeler.editable;
  }
  await modeler.importXml(content.xml);
  setDirty(false);
  claimDocument(`${processRef.repo}/${content.path}`, () => {
    showBanner("This document was opened in a newer widget — this instance is now inactive.", []);
    saveBtn.disabled = true;
  });
  setStatus(cfg.readonly ? "Read-only view" : "Ready");
}

async function save(xmlOverride?: string, versionOverride?: string): Promise<void> {
  if (!modeler || !ref) return;
  hideBanner();
  saveBtn.disabled = true;
  try {
    const xml = xmlOverride ?? (await modeler.saveXml());
    setStatus("Validating…");
    const check = await validateBpmn(app, xml, ref);
    const errors = check.findings.filter((f) => f.severity === "ERROR");
    if (errors.length > 0) {
      showBanner(
        `Validation failed: ${errors[0]?.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`,
        [{ label: "Dismiss", run: hideBanner }],
      );
      setStatus("Not saved");
      return;
    }
    setStatus("Saving…");
    const result = await saveBpmnXml(app, ref, xml, versionOverride ?? baseVersion);
    if (!result.ok) {
      onConflict(result, xml);
      return;
    }
    baseVersion = result.baseVersion;
    setDirty(false);
    setStatus("Saved");
    // tell the model the live state moved — it re-reads instead of trusting stale XML
    void app.updateModelContext({
      content: [{ type: "text", text: `User saved ${ref.repo}/${ref.path} in the modeler widget.` }],
    });
  } catch (err) {
    showBanner(`Save failed: ${(err as Error).message}`, [{ label: "Dismiss", run: hideBanner }]);
    setStatus("Not saved");
  } finally {
    saveBtn.disabled = false;
  }
}

function onConflict(conflict: SaveConflict, myXml: string): void {
  setStatus("Conflict");
  showBanner("Someone saved this model in the meantime.", [
    {
      label: "Load their version",
      run: () => {
        void (async () => {
          hideBanner();
          await modeler?.importXml(conflict.currentXml);
          baseVersion = conflict.baseVersion;
          setDirty(false);
          setStatus("Reloaded");
        })();
      },
    },
    {
      label: "Overwrite anyway",
      danger: true,
      // resend MY xml against the FRESH token — CAS passes, their edit loses
      run: () => void save(myXml, conflict.baseVersion),
    },
    { label: "Keep editing", run: hideBanner },
  ]);
}

saveBtn.onclick = () => void save();
fullscreenBtn.onclick = () => void app.requestDisplayMode({ mode: "fullscreen" });

app.ontoolinput = (params) => {
  const args = (params.arguments ?? {}) as { repo?: string; id?: string; path?: string };
  if (!args.repo) {
    setStatus("Missing tool input (repo)");
    return;
  }
  load({ repo: args.repo, id: args.id, path: args.path }).catch((err) => {
    setStatus(`Load failed: ${(err as Error).message}`);
  });
};

// hosts without lifecycle notifications (Claude iOS, ext-apps #734) never send
// tool input — surface that instead of an eternal spinner
setTimeout(() => {
  if (!ref) setStatus("No tool input received — open this connector in claude.ai or Claude Desktop.");
}, 8000);

app.connect().catch((err) => setStatus(`Bridge connect failed: ${(err as Error).message}`));
