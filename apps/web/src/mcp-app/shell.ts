/**
 * The mechanical widget shell shared by the BPMN and DMN single-file bundles:
 * element lookup, the toolbar/banner/status chrome, and the App lifecycle
 * tail (tool-input guard, the no-input timeout, connect).
 *
 * The save LIFECYCLE stays per widget ON PURPOSE: the two mains look alike
 * but are fused to different latch sets (the BPMN widget's Yjs upgrade and
 * recovery paths touch its latches at ~15 sites; the DMN widget's setDirty
 * owns the save button) — a shared lifecycle would be a bag of nine
 * callbacks, worse than the twin code. Same for the CAS conflict banner:
 * statement-identical today, but every action body writes the widget's own
 * latches. Keep the twins in sync by hand; this file owns only what is
 * mechanically identical.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

import { cometElement } from "@/lib/comet";

export const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface WidgetChrome {
  toolbar: { title: HTMLSpanElement; dirty: HTMLSpanElement };
  saveBtn: HTMLButtonElement;
  fullscreenBtn: HTMLButtonElement;
  banner: HTMLDivElement;
  /** exposed for `status.title` (the findings tooltip) */
  status: HTMLDivElement;
  setStatus: (text: string) => void;
  showBanner: (text: string, actions: Array<{ label: string; danger?: boolean; run: () => void }>) => void;
  hideBanner: () => void;
}

/** the fixed widget chrome both HTML entries carry (mcp-app*.html) */
export function mountChrome(): WidgetChrome {
  const banner = el<HTMLDivElement>("banner");
  const status = el<HTMLDivElement>("status");
  // the brand mark rides in from lib/comet rather than sitting in both HTML
  // entries — one geometry, not a path duplicated per widget
  const title = el<HTMLSpanElement>("title");
  title.before(cometElement(9));
  return {
    toolbar: { title, dirty: el<HTMLSpanElement>("dirty") },
    saveBtn: el<HTMLButtonElement>("save"),
    fullscreenBtn: el<HTMLButtonElement>("fullscreen"),
    banner,
    status,
    setStatus: (text) => {
      status.textContent = text;
    },
    showBanner: (text, actions) => {
      banner.innerHTML = "";
      const msg = document.createElement("span");
      msg.textContent = text;
      banner.append(msg);
      for (const a of actions) {
        const b = document.createElement("button");
        b.textContent = a.label;
        if (a.danger) b.classList.add("danger");
        b.onclick = () => a.run();
        banner.append(b);
      }
      banner.hidden = false;
    },
    hideBanner: () => {
      banner.hidden = true;
    },
  };
}

/**
 * The App handshake tail: guard the tool input (`repo` is the one required
 * argument), surface load failures in the status line, tell the user when a
 * host never delivers tool input at all (Claude iOS, ext-apps #734 — the
 * alternative is an eternal spinner), and connect.
 */
export function wireApp(
  app: App,
  opts: {
    setStatus: (text: string) => void;
    /** true once a load owns the widget — suppresses the no-input message */
    hasLoaded: () => boolean;
    onToolArgs: (args: { repo: string; id?: string; path?: string } & Record<string, unknown>) => Promise<void>;
  },
): void {
  app.ontoolinput = (params) => {
    const args = (params.arguments ?? {}) as { repo?: string; id?: string; path?: string };
    if (!args.repo) {
      opts.setStatus("Missing tool input (repo)");
      return;
    }
    opts.onToolArgs(args as { repo: string; id?: string; path?: string }).catch((err) => {
      opts.setStatus(`Load failed: ${(err as Error).message}`);
    });
  };
  setTimeout(() => {
    if (!opts.hasLoaded())
      opts.setStatus("No tool input received — open this connector in claude.ai or Claude Desktop.");
  }, 8000);
  app.connect().catch((err) => opts.setStatus(`Bridge connect failed: ${(err as Error).message}`));
}
