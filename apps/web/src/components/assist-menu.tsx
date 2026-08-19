/**
 * "Analyse with AI" — the doorway from a model into an AI chat whose prefilled
 * first move is this connector's modeler widget. @bpmiq/contracts/assist
 * builds the work order and the deep link; this menu only picks the
 * destination: Claude Desktop, ChatGPT, or the clipboard. Two shapes: the
 * editor-toolbar button (the canvas selection rides along) and the compact
 * per-row trigger on the repo overview.
 *
 * The handover is a PREFILL on every target — the chat opens with the prompt
 * prepared, the user reviews and sends. Whether claude:// is handled cannot be
 * read from a page (by design): fire it and, if the page never lost focus,
 * softly offer the copy fallback — the browser's own "Open …?" consent dialog
 * blurs the page too, so a quiet miss is a hint, never proof of a missing
 * install.
 */
import { ASSIST_TARGETS, type AssistTargetId, buildAssistPrompt, buildAssistUrl } from "@bpmiq/contracts/assist";
import { Button } from "@bpmiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bpmiq/ui-kit/components/dropdown-menu";
import { BookOpen, Sparkles } from "lucide-react";
import { toast } from "sonner";

import type { TodoElementWire } from "@/lib/api";
import { useConfig } from "@/lib/queries";

const SETUP_URL = "https://github.com/Miragon/bpm-iq/blob/main/docs/mcp-integration.md";

const copyPrompt = async (prompt: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(prompt);
    toast.success("Prompt copied", { description: "Paste it into a chat connected to the bpmiq connector." });
  } catch {
    // clipboard needs a secure context (https/localhost) — surface it to copy by hand
    toast.info("Copy the prompt by hand", { description: prompt, duration: 15_000 });
  }
};

/** fire the claude:// scheme; still visible+focused after the grace period →
 *  probably unhandled (or consented away) — offer the way out, softly */
const openClaude = (url: string, prompt: string): void => {
  let left = false;
  const onLeave = (): void => {
    left = true;
  };
  window.addEventListener("blur", onLeave);
  document.addEventListener("visibilitychange", onLeave);
  window.location.href = url;
  window.setTimeout(() => {
    window.removeEventListener("blur", onLeave);
    document.removeEventListener("visibilitychange", onLeave);
    if (left) return;
    toast("Claude Desktop didn't open?", {
      description: "It may not be installed — copy the prompt for any chat with the bpmiq connector instead.",
      action: { label: "Copy prompt", onClick: () => void copyPrompt(prompt) },
      duration: 10_000,
    });
  }, 1_500);
};

export function AssistMenu({
  repo,
  path,
  notation,
  selection,
  variant = "toolbar",
}: {
  /** repository full name, "owner/name" */
  repo: string;
  /** repo-relative model path */
  path: string;
  notation: "bpmn" | "dmn";
  /** current canvas selection — rides along as data (BPMN editor only) */
  selection?: TodoElementWire[];
  /** "row" = compact icon trigger for an overview table row */
  variant?: "toolbar" | "row";
}) {
  const cfg = useConfig();
  // same-origin by construction — the config round trip only makes it explicit
  const mcpUrl = cfg.data?.mcpUrl ?? `${location.origin}/mcp`;

  const fire = (target: AssistTargetId): void => {
    const prompt = buildAssistPrompt({ repo, path, notation, mcpUrl, selection });
    const url = buildAssistUrl(target, prompt);
    if (url === null) return void copyPrompt(prompt);
    if (target === "claude-desktop") return openClaude(url, prompt);
    window.open(url, "_blank", "noopener");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "toolbar" ? (
          <Button
            variant="outline"
            size="sm"
            title="Open this model in an AI chat — the modeler widget renders in the conversation, live-synced with this editor"
          >
            <Sparkles />
            Analyse with AI
          </Button>
        ) : (
          // rows navigate on click — the trigger must not (same rule as the row's links)
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Analyse with AI"
            onClick={(e) => e.stopPropagation()}
          >
            <Sparkles />
          </Button>
        )}
      </DropdownMenuTrigger>
      {/* the content PORTALS out of the DOM but not out of the React tree: item
          clicks (incl. Radix's synthesized Enter/Space click) bubble into the
          clickable overview row and would navigate — stop them here */}
      <DropdownMenuContent align="end" className="max-w-72" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Opens a chat whose prefilled first move brings this model up as a live widget, synced with this editor — you
          review and send.
          {selection && selection.length > 0
            ? ` Your ${selection.length} selected element${selection.length === 1 ? "" : "s"} ride along.`
            : ""}
        </DropdownMenuLabel>
        {ASSIST_TARGETS.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={() => fire(t.id)}>
            {t.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* the hard prerequisite, stated where the feature lives: no connector, no widget */}
        <DropdownMenuItem asChild>
          <a href={SETUP_URL} target="_blank" rel="noreferrer">
            <BookOpen />
            Requires the bpmiq connector — setup
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
