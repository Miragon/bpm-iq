/**
 * Side panel for a live .dmn: what is wrong with the decision, and what it
 * would decide — both computed IN THE BROWSER by @bpmiq/decisions, the very
 * module the Live Host answers `analyze_decision` / `simulate_decision` with.
 *
 * That shared library is the whole point of this panel. A DMN's real problems
 * are invisible in the editor: every FEEL engine treats a broken expression as
 * "did not match", so a typo looks exactly like a rule that legitimately did
 * not apply. The findings below name it while the model is still being edited,
 * without a round-trip and without waiting for CI — and a scenario tried here
 * gives the same answer as the same scenario through the MCP endpoint or the
 * `pnpm validate` gate, because it is one implementation, not three.
 */
import {
  analyzeDecision,
  type DecisionFinding,
  type RawValue,
  type Scenario,
  simulateDecision,
  type SimulationResult,
  type VariableProfile,
} from "@bpmiq/decisions";
import { deriveDecision } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { AlertTriangle, Info, Play, ShieldCheck, X, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

/** the derived view + its findings, or the reason there are none */
function useDecision(xml: string, docPath: string) {
  return useMemo(() => {
    // a live document is malformed for as long as someone is typing into the
    // XML view — that is not a finding, it is a transient state
    const graph = (() => {
      try {
        return extractModelGraph(docPath, xml);
      } catch {
        return undefined;
      }
    })();
    if (!graph || graph.notation !== "dmn") return { unparsable: true as const };
    try {
      const view = deriveDecision(graph);
      return { unparsable: false as const, view, analysis: analyzeDecision(view) };
    } catch {
      return { unparsable: true as const };
    }
  }, [xml, docPath]);
}

const ICON = {
  ERROR: <XCircle className="text-destructive size-3.5 shrink-0" />,
  WARN: <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />,
  INFO: <Info className="text-muted-foreground size-3.5 shrink-0" />,
};

function Finding({ finding }: { finding: DecisionFinding }) {
  const where = [finding.decision, finding.rule, finding.column].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2 border-b px-3 py-2 text-xs last:border-b-0">
      {ICON[finding.severity]}
      <div className="min-w-0">
        <p className="break-words">{finding.message}</p>
        {where && <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{where}</p>}
      </div>
    </li>
  );
}

/** one input row — the literals/boundaries the rules use are the candidates */
function VariableInput({
  profile,
  value,
  onChange,
}: {
  profile: VariableProfile;
  value: string;
  onChange: (next: string) => void;
}) {
  const suggestions = [...profile.literals, ...profile.boundaries.map(String)];
  const listId = `dmn-var-${profile.name}`;
  return (
    <label className="block px-3 py-1.5 text-xs">
      <span className="font-mono">{profile.name}</span>
      <span className="text-muted-foreground ml-1 text-[10px]">{profile.typeRef}</span>
      <input
        className="border-input bg-background mt-1 h-7 w-full rounded-md border px-2 text-xs"
        value={value}
        list={suggestions.length > 0 ? listId : undefined}
        placeholder={suggestions.slice(0, 3).join(" / ") || "value"}
        onChange={(e) => onChange(e.target.value)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}

/** "" = unset (left out of the scenario), else the value in the column's type */
function coerce(raw: string, typeRef: string): RawValue | undefined {
  if (raw === "") return undefined;
  if (typeRef === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeRef === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  return raw;
}

function Outcome({ result }: { result: SimulationResult }) {
  return (
    <div className="border-t">
      {result.unknownInputs.length > 0 && (
        <p className="text-destructive px-3 py-1.5 text-xs">Not an input: {result.unknownInputs.join(", ")}</p>
      )}
      {result.decisions.map((d) => (
        <div key={d.id} className="border-b px-3 py-2 text-xs last:border-b-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{d.name ?? d.id}</span>
            <span className="flex-1" />
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
              {d.value === null || d.value === undefined ? "no match" : JSON.stringify(d.value)}
            </code>
          </div>
          {d.reportedRules.length > 0 && (
            <p className="text-muted-foreground mt-1 font-mono text-[10px]">via {d.reportedRules.join(", ")}</p>
          )}
          {d.violation && <p className="text-destructive mt-1">{d.violation}</p>}
        </div>
      ))}
    </div>
  );
}

export function DecisionChecksPanel({
  xml,
  docPath,
  onClose,
}: {
  /** the LIVE document's current content */
  xml: string;
  docPath: string;
  onClose: () => void;
}) {
  const decision = useDecision(xml, docPath);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SimulationResult | null>(null);

  const analysis = decision.unparsable ? undefined : decision.analysis;
  const errors = analysis?.findings.filter((f) => f.severity === "ERROR").length ?? 0;

  const run = () => {
    if (decision.unparsable) return;
    const scenario: Scenario = {};
    for (const variable of decision.analysis.variables) {
      const value = coerce(values[variable.name] ?? "", variable.typeRef);
      if (value !== undefined) scenario[variable.name] = value;
    }
    setResult(simulateDecision(decision.view, scenario));
  };

  return (
    <aside className="bg-background absolute inset-y-0 right-0 z-10 flex w-80 flex-col border-l shadow-lg">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ShieldCheck className="size-4" />
        <span className="text-sm font-medium">Decision checks</span>
        {analysis && (
          <Badge variant={errors > 0 ? "destructive" : analysis.findings.length > 0 ? "secondary" : "success"}>
            {errors > 0
              ? `${errors} error${errors > 1 ? "s" : ""}`
              : analysis.findings.length > 0
                ? `${analysis.findings.length} warning${analysis.findings.length > 1 ? "s" : ""}`
                : "sound"}
          </Badge>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {decision.unparsable ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">
            The document is not parsable as DMN right now — checks resume as soon as it is.
          </p>
        ) : (
          <>
            {analysis && analysis.findings.length > 0 ? (
              <ul>
                {analysis.findings.map((f, i) => (
                  <Finding key={i} finding={f} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground px-3 py-3 text-xs">
                No findings: the FEEL parses, no rule is dead, every requirement is read.
              </p>
            )}

            <div className="border-t">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium">Try a scenario</span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={run}
                  disabled={analysis?.variables.length === 0}
                >
                  <Play />
                  Run
                </Button>
              </div>
              {analysis?.variables.length === 0 && (
                <p className="text-muted-foreground px-3 pb-2 text-xs">
                  No input variable — the columns read nothing yet.
                </p>
              )}
              {analysis?.variables.map((v) => (
                <VariableInput
                  key={v.name}
                  profile={v}
                  value={values[v.name] ?? ""}
                  onChange={(next) => setValues((prev) => ({ ...prev, [v.name]: next }))}
                />
              ))}
              {result && <Outcome result={result} />}
              {result && result.missingInputs.length > 0 && (
                <p className="text-muted-foreground px-3 py-1.5 text-xs">
                  Left unset: {result.missingInputs.join(", ")}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
