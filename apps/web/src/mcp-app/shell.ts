/**
 * The mechanical widget shell shared by every single-file bundle: element
 * lookup, the toolbar/banner/status chrome, and the App lifecycle tail
 * (tool-input guard, the no-input timeout, connect).
 *
 * The save LIFECYCLE used to stay per widget on purpose (two mains, two latch
 * sets). #156 reversed that: a third fork was the tipping point, so the
 * canvas widgets (bpmn, wardley, team topology, event storming) run ONE
 * lifecycle — core/lifecycle.ts behind the ChromePort / ModelBridge /
 * LiveUpgrade / ClaimDocument ports, composed in core/widget.ts. The
 * decision widget (dmn-main.ts) is the one remaining hand-kept twin: its
 * differences are real (multi-view, the simulator, the tests panel, no live)
 * and stay so until a second such need appears. This file still owns only
 * what is mechanically identical across all of them.
 */
import type { App } from "@modelcontextprotocol/ext-apps";

import { cometElement } from "@/lib/comet";

export const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface WidgetChrome {
  toolbar: { title: HTMLSpanElement; dirty: HTMLSpanElement };
  saveBtn: HTMLButtonElement;
  /** "Open in bpmiq" — hidden until a model is loaded AND a deep-link base is
   *  known; each widget wires its own URL builder (per-widget link shapes) */
  openBtn: HTMLButtonElement;
  fullscreenBtn: HTMLButtonElement;
  banner: HTMLDivElement;
  /** exposed for `status.title` (the findings tooltip) */
  status: HTMLDivElement;
  setStatus: (text: string) => void;
  showBanner: (text: string, actions: Array<{ label: string; danger?: boolean; run: () => void }>) => void;
  hideBanner: () => void;
}

/** the fixed widget chrome every HTML entry carries (mcp-app*.html) */
export function mountChrome(): WidgetChrome {
  const banner = el<HTMLDivElement>("banner");
  const status = el<HTMLDivElement>("status");
  // the brand mark rides in from lib/comet rather than sitting in every HTML
  // entry — one geometry, not a path duplicated per widget
  const title = el<HTMLSpanElement>("title");
  title.before(cometElement(9));
  return {
    toolbar: { title, dirty: el<HTMLSpanElement>("dirty") },
    saveBtn: el<HTMLButtonElement>("save"),
    openBtn: el<HTMLButtonElement>("open"),
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
 * Open an external URL from inside the app sandbox: the sandbox blocks plain
 * navigation, so the HOST opens it (`ui/open-link`). A denial or a missing
 * bridge (the dev preview outside a host) falls back to window.open; if that
 * is blocked too, tell the caller instead of swallowing the click. Callers own
 * the error sink (toolbar status line vs. the todo panel's error row).
 */
export async function openExternal(app: App, url: string, onBlocked: (msg: string) => void): Promise<void> {
  try {
    const { isError } = await app.openLink({ url });
    if (!isError) return;
  } catch {
    /* no host bridge — try the browser directly */
  }
  // NOT the "noopener" feature: that makes window.open return null even on
  // success, which would misreport every working fallback as blocked — sever
  // the opener on the returned proxy instead
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
    return;
  }
  onBlocked(`Could not open ${url} — your client blocked it.`);
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
