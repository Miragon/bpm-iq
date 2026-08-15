/**
 * Side panel for a live .dmn — three things, all computed IN THE BROWSER by
 * @bpmiq/decisions, the very module the Live Host answers `analyze_decision` /
 * `simulate_decision` / `run_decision_tests` with:
 *
 *   findings   what is wrong with the decision without any test data
 *   scenario   what it would decide for values you type
 *   tests      the stored `<stem>.tests.yaml` cases, run against the LIVE model
 *
 * That shared library is the whole point of the panel. A DMN's real problems
 * are invisible in the editor: every FEEL engine treats a broken expression as
 * "did not match", so a typo looks exactly like a rule that legitimately did
 * not apply. And the test cases are the team's own answers — being able to see
 * them go red WHILE editing, rather than in CI after the release PR, is the
 * difference between a guard rail and a post-mortem.
 *
 * Everything here is one implementation, not three: the same run through MCP,
 * through `pnpm validate` and through this panel cannot disagree.
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
import {
  type CaseOutcome,
  parseTestSuite,
  runDecisionTests,
  type SuiteOutcome,
  testsPathFor,
} from "@bpmiq/decisions/tests";
import { deriveDecision } from "@bpmiq/notations/derive";
import { extractModelGraph } from "@bpmiq/notations/extract";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, Play, ShieldCheck, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { SidePanel } from "@/components/side-panel";
import { ApiError, fetchContent } from "@/lib/api";
import { caseGlyph, pendingActualLine, uncoveredRulesLine } from "@/lib/decision-view";

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

function CaseRow({ result }: { result: CaseOutcome }) {
  const mark = caseGlyph(result.status);
  return (
    <li className="border-b px-3 py-2 text-xs last:border-b-0">
      <div className="flex gap-2">
        <span
          className={
            result.status === "fail"
              ? "text-destructive"
              : result.status === "pass"
                ? "text-emerald-600"
                : "text-muted-foreground"
          }
        >
          {mark}
        </span>
        <span className="min-w-0 break-words">{result.name}</span>
      </div>
      {result.failures.map((f, i) => (
        <p key={i} className="text-destructive mt-1 pl-4">
          {f}
        </p>
      ))}
      {result.status === "pending" && (
        <p className="text-muted-foreground mt-1 pl-4">{pendingActualLine(result.actual.value)}</p>
      )}
    </li>
  );
}

export function DecisionChecksPanel({
  repo,
  xml,
  docPath,
  onClose,
}: {
  repo: string;
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

  // The stored suite is an ordinary live document next to the model, so the
  // panel simply READS it — no dedicated endpoint, no server-side runner. A
  // decision without cases 404s, which is a normal state, not an error.
  const testsPath = testsPathFor(docPath);
  const suiteQuery = useQuery({
    queryKey: ["decision-tests", repo, testsPath],
    queryFn: async () => {
      try {
        return parseTestSuite((await fetchContent(repo, testsPath)).xml, testsPath);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null; // no suite yet
        throw e;
      }
    },
  });

  // …and runs it against the LIVE model, so an edit turns a case red HERE,
  // with the same engine CI will use on the release PR
  const suiteRun: SuiteOutcome | undefined = useMemo(() => {
    if (decision.unparsable || !suiteQuery.data) return undefined;
    try {
      return runDecisionTests(decision.view, suiteQuery.data);
    } catch {
      return undefined;
    }
  }, [decision, suiteQuery.data]);

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
    <SidePanel
      icon={ShieldCheck}
      title="Decision checks"
      badge={
        analysis && (
          <Badge variant={errors > 0 ? "destructive" : analysis.findings.length > 0 ? "secondary" : "success"}>
            {errors > 0
              ? `${errors} error${errors > 1 ? "s" : ""}`
              : analysis.findings.length > 0
                ? `${analysis.findings.length} warning${analysis.findings.length > 1 ? "s" : ""}`
                : "sound"}
          </Badge>
        )
      }
      onClose={onClose}
    >
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

            <div className="border-t">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-sm font-medium">Test cases</span>
                {suiteRun && (
                  <Badge variant={suiteRun.failed > 0 ? "destructive" : "success"}>
                    {suiteRun.failed > 0
                      ? `${suiteRun.failed} failing`
                      : `${suiteRun.passed}/${suiteRun.cases.length} pass`}
                  </Badge>
                )}
              </div>
              {suiteQuery.isLoading && <p className="text-muted-foreground px-3 pb-2 text-xs">Loading…</p>}
              {suiteQuery.error && (
                <p className="text-destructive px-3 pb-2 text-xs">{(suiteQuery.error as Error).message}</p>
              )}
              {suiteQuery.isSuccess && !suiteQuery.data && (
                <p className="text-muted-foreground px-3 pb-2 text-xs">
                  No <code className="font-mono">{testsPath.split("/").pop()}</code> yet — nothing pins this decision's
                  behaviour.
                </p>
              )}
              {suiteRun && (
                <>
                  <ul>
                    {suiteRun.cases.map((c, i) => (
                      <CaseRow key={i} result={c} />
                    ))}
                  </ul>
                  {suiteRun.uncoveredRules.length > 0 && (
                    <p className="text-muted-foreground px-3 py-1.5 text-xs">
                      {uncoveredRulesLine(suiteRun.uncoveredRules)}
                    </p>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </SidePanel>
  );
}
