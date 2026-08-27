/**
 * Moderation panel (#54) — the facilitator's view of a t.BPM session: every
 * sticky on the diagram, grouped by kind (questions first — they are the open
 * ends a workshop must close), click reveals it on the canvas. Fed the
 * debounced live text like every notation panel, parsed with the browser's
 * namespace-aware DOMParser — remote stickies appear as they are created.
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { StickyNote } from "lucide-react";
import { useMemo, useRef } from "react";
import { toast } from "sonner";

import { SidePanel } from "@/components/side-panel";
import type { NotationPanelProps } from "@/notations/registry";

const BPMIQ_NS = "https://bpmiq.io/schema/1.0/bpmiq";

/** facilitator priority: open ends first, context last */
const KIND_ORDER = ["question", "decision", "note", "role"] as const;
type Kind = (typeof KIND_ORDER)[number];

const KIND_LABEL: Record<Kind, string> = {
  question: "Open questions",
  decision: "Decisions",
  note: "Notes",
  role: "Roles",
};
const KIND_DOT: Record<Kind, string> = {
  question: "#ef6c00",
  decision: "#2e7d32",
  note: "#f9a825",
  role: "#1565c0",
};

interface StickyRow {
  id: string;
  text: string;
  kind: Kind;
}

/** parse the live XML's bpmiq:sticky extension elements — namespace-aware,
 *  total: a mid-edit malformed document simply yields the previous list */
function parseStickies(xml: string): StickyRow[] | undefined {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return undefined;
  const rows: StickyRow[] = [];
  for (const el of [...doc.getElementsByTagNameNS(BPMIQ_NS, "sticky")]) {
    const id = el.getAttribute("id");
    if (!id) continue;
    const kind = el.getAttribute("kind") ?? "note";
    rows.push({
      id,
      text: el.getAttribute("text") ?? "",
      kind: (KIND_ORDER as readonly string[]).includes(kind) ? (kind as Kind) : "note",
    });
  }
  return rows;
}

export function ModerationPanel({ content, onRevealElement, onClose }: NotationPanelProps) {
  const parsed = useMemo(() => parseStickies(content), [content]);
  // a mid-edit malformed document (someone typing in the XML tab) keeps the
  // previous list instead of flashing the empty state
  const lastGood = useRef<StickyRow[]>([]);
  if (parsed) lastGood.current = parsed;
  const stickies = parsed ?? lastGood.current;
  const groups = useMemo(() => {
    const byKind = new Map<Kind, StickyRow[]>();
    for (const row of stickies ?? []) {
      const list = byKind.get(row.kind) ?? [];
      list.push(row);
      byKind.set(row.kind, list);
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, rows: byKind.get(k)! }));
  }, [stickies]);

  const total = stickies?.length ?? 0;
  const questions = stickies?.filter((s) => s.kind === "question").length ?? 0;

  return (
    <SidePanel
      icon={StickyNote}
      title="Moderation"
      badge={
        total > 0 ? (
          <Badge variant={questions > 0 ? "warning" : "secondary"}>
            {total}
            {questions > 0 ? ` · ${questions} open` : ""}
          </Badge>
        ) : undefined
      }
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {total === 0 && (
          <p className="text-muted-foreground text-xs">
            No stickies on this diagram yet. In t.BPM workshop mode, press <kbd>n</kbd> (or use the palette) to drop one
            — notes, open questions, decisions and role remarks all live right in the model.
          </p>
        )}
        {groups.map(({ kind, rows }) => (
          <section key={kind} className="mb-4">
            <h3 className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase">
              <span className="size-2 rounded-full" style={{ background: KIND_DOT[kind] }} />
              {KIND_LABEL[kind]} ({rows.length})
            </h3>
            <ul className="space-y-1">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="hover:bg-accent w-full rounded border px-2 py-1.5 text-left text-xs disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
                    title={onRevealElement ? "Reveal on the canvas" : "No visual editor is up — text view only"}
                    disabled={!onRevealElement}
                    onClick={() => {
                      if (onRevealElement && !onRevealElement(row.id)) {
                        toast("Could not reveal this sticky on the canvas.");
                      }
                    }}
                  >
                    {row.text.trim() === "" ? <span className="text-muted-foreground italic">(empty)</span> : row.text}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </SidePanel>
  );
}
