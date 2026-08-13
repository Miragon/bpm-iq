/**
 * Static analysis of a DMN — everything that can be said about a decision
 * WITHOUT test cases: broken FEEL, rules that can never be reported, wiring
 * that silently does nothing, and the value set a test case should draw from.
 *
 * Why it earns its keep: the evaluation engine (like every FEEL engine) treats
 * a broken expression as "did not match" — so a typo in a rule looks exactly
 * like a rule that legitimately did not apply. Analysis is the only place that
 * tells the two apart, and it is the input an agent needs to write meaningful
 * test cases instead of guessing values.
 *
 * Deliberately conservative: a finding is only raised when it is certain from
 * the model alone. Shadowing, for instance, is reported only for entries that
 * literally subsume each other ("-" or an identical test), never for ranges
 * that would need interval arithmetic to compare.
 */
import type { DecisionView, DerivedDecision } from "@bpmiq/notations/derive";
import { parseExpression, parseUnaryTests } from "feelin";

import { decisionVariables } from "./model.ts";

export type Severity = "ERROR" | "WARN" | "INFO";

export interface DecisionFinding {
  severity: Severity;
  /** stable check id, e.g. "feel-syntax" — safe to key on */
  code: string;
  message: string;
  /** the decision this is about */
  decision?: string;
  /** the rule id, when the finding is about one row */
  rule?: string;
  /** the column label, when the finding is about one cell */
  column?: string;
}

/** the raw material for writing test cases against one variable */
export interface VariableProfile {
  name: string;
  typeRef: string;
  source: "inputData" | "free";
  /** distinct string literals the rules test against */
  literals: string[];
  /** numbers the rules compare against — the boundary candidates */
  boundaries: number[];
}

export interface DecisionAnalysis {
  findings: DecisionFinding[];
  /** what a scenario has to supply, with value candidates per variable */
  variables: VariableProfile[];
  /** per decision: the rule ids, so a caller can diff coverage against them */
  rules: Array<{ decision: string; ruleIds: string[] }>;
  ok: boolean;
}

/** "-" and "" both mean "any" in a decision table — never FEEL to parse */
const isAny = (entry: string): boolean => entry.trim() === "" || entry.trim() === "-";

/** does the lezer parse tree contain error nodes? feelin's parsers are
 *  error-tolerant and return a tree with ⚠ nodes rather than throwing */
function hasSyntaxError(parse: () => { iterate(spec: { enter(node: { type: { isError: boolean } }): void }): void }) {
  let broken = false;
  try {
    parse().iterate({
      enter(node) {
        if (node.type.isError) broken = true;
      },
    });
  } catch {
    return true;
  }
  return broken;
}

const unaryTestBroken = (text: string) => hasSyntaxError(() => parseUnaryTests(text, {}, undefined));
const expressionBroken = (text: string) => hasSyntaxError(() => parseExpression(text, {}, undefined));

/** every number a unary test compares against — `>= 500` → 500, `[1..5]` → 1,5 */
function boundariesOf(entry: string): number[] {
  if (isAny(entry)) return [];
  const numbers: number[] = [];
  for (const match of entry.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

/** the string literals a unary test accepts — `"AT","CH"` → AT, CH */
function literalsOf(entry: string): string[] {
  if (isAny(entry)) return [];
  return [...entry.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/** conservative subsumption: does `general` accept everything `specific` does?
 *  Only "any" and an identical test are compared — anything else is unknown. */
function subsumes(general: string[], specific: string[]): boolean {
  if (general.length !== specific.length) return false;
  return general.every((entry, n) => {
    const other = specific[n] ?? "";
    return isAny(entry) || entry.trim() === other.trim();
  });
}

/** hit policies where an earlier rule makes a subsumed later one unreachable */
const FIRST_WINS = new Set(["FIRST", "UNIQUE", "ANY"]);

function analyzeTable(view: DecisionView, findings: DecisionFinding[]): void {
  const at = (rule?: string, column?: string): Pick<DecisionFinding, "decision" | "rule" | "column"> => ({
    decision: view.id,
    ...(rule ? { rule } : {}),
    ...(column ? { column } : {}),
  });

  if (!view.hitPolicy) {
    findings.push({
      severity: "WARN",
      code: "hit-policy-unknown",
      message: `decision '${view.id}' has no recognizable hit policy — evaluation falls back to UNIQUE`,
      ...at(),
    });
  }
  if (view.aggregation && view.hitPolicy !== "COLLECT") {
    findings.push({
      severity: "WARN",
      code: "aggregation-without-collect",
      message: `aggregation '${view.aggregation}' is ignored under hit policy ${view.hitPolicy ?? "UNIQUE"}`,
      ...at(),
    });
  }
  if (view.rules.length === 0) {
    findings.push({
      severity: "WARN",
      code: "no-rules",
      message: `decision '${view.id}' has no rules — it can never produce a result`,
      ...at(),
    });
  }
  if (view.outputs.length === 0) {
    findings.push({
      severity: "ERROR",
      code: "no-outputs",
      message: `decision '${view.id}' has no output column`,
      ...at(),
    });
  }
  if (view.outputs.length > 1 && view.outputs.some((o) => !o.name)) {
    findings.push({
      severity: "ERROR",
      code: "output-unnamed",
      message: `decision '${view.id}' has several outputs but not all are named — results are not addressable`,
      ...at(),
    });
  }

  view.inputs.forEach((input, n) => {
    const column = input.label || `#${n + 1}`;
    if (input.expression.trim() === "") {
      // WARN, not ERROR: the blank-decision template ships exactly like this,
      // so an unfinished table must not read as a broken one
      findings.push({
        severity: "WARN",
        code: "input-expression-missing",
        message: `input column '${column}' has no expression — it reads nothing, so no rule can match on it`,
        ...at(undefined, column),
      });
    } else if (expressionBroken(input.expression)) {
      findings.push({
        severity: "ERROR",
        code: "feel-syntax",
        message: `input column '${column}': '${input.expression}' is not valid FEEL`,
        ...at(undefined, column),
      });
    }
  });

  for (const rule of view.rules) {
    if (rule.when.length !== view.inputs.length) {
      findings.push({
        severity: "ERROR",
        code: "entry-arity",
        message: `rule '${rule.id}' has ${rule.when.length} input entries but the table has ${view.inputs.length} columns`,
        ...at(rule.id),
      });
    }
    if (rule.then.length !== view.outputs.length) {
      findings.push({
        severity: "ERROR",
        code: "entry-arity",
        message: `rule '${rule.id}' has ${rule.then.length} output entries but the table has ${view.outputs.length} outputs`,
        ...at(rule.id),
      });
    }
    rule.when.forEach((entry, n) => {
      if (isAny(entry) || !unaryTestBroken(entry)) return;
      findings.push({
        severity: "ERROR",
        code: "feel-syntax",
        message: `rule '${rule.id}', column '${view.inputs[n]?.label || `#${n + 1}`}': '${entry}' is not a valid FEEL unary test — it silently matches nothing`,
        ...at(rule.id, view.inputs[n]?.label),
      });
    });
    rule.then.forEach((entry, n) => {
      const output = view.outputs[n]?.name || `#${n + 1}`;
      if (entry.trim() === "") {
        findings.push({
          severity: "WARN",
          code: "output-empty",
          message: `rule '${rule.id}' leaves output '${output}' empty — it yields null when this rule fires`,
          ...at(rule.id, output),
        });
        return;
      }
      if (expressionBroken(entry)) {
        findings.push({
          severity: "ERROR",
          code: "feel-syntax",
          message: `rule '${rule.id}', output '${output}': '${entry}' is not a valid FEEL expression`,
          ...at(rule.id, output),
        });
        return;
      }
      const allowed = view.outputs[n]?.outputValues ?? [];
      if (allowed.length > 0 && !allowed.some((v) => v.trim() === entry.trim())) {
        findings.push({
          severity: "WARN",
          code: "output-value-not-allowed",
          message: `rule '${rule.id}' returns ${entry} for '${output}', which is not among its allowed values (${allowed.join(", ")})`,
          ...at(rule.id, output),
        });
      }
    });
  }

  // shadowing / duplicates — only where subsumption is certain
  for (let later = 0; later < view.rules.length; later++) {
    const rule = view.rules[later];
    if (!rule) continue;
    for (let earlier = 0; earlier < later; earlier++) {
      const before = view.rules[earlier];
      if (!before || !subsumes(before.when, rule.when)) continue;
      const identical = subsumes(rule.when, before.when);
      if (identical) {
        findings.push({
          severity: "WARN",
          code: "duplicate-rule",
          message: `rule '${rule.id}' tests exactly the same inputs as '${before.id}'`,
          ...at(rule.id),
        });
      } else if (FIRST_WINS.has(view.hitPolicy ?? "UNIQUE")) {
        findings.push({
          severity: "WARN",
          code: "rule-shadowed",
          message:
            view.hitPolicy === "UNIQUE" || view.hitPolicy === "ANY"
              ? `rule '${rule.id}' can only fire together with the more general '${before.id}' — a ${view.hitPolicy ?? "UNIQUE"} violation whenever it matches`
              : `rule '${rule.id}' is unreachable: the earlier '${before.id}' matches whenever it does`,
          ...at(rule.id),
        });
      }
      break; // one shadow per rule is enough to act on
    }
  }
}

/** wiring: an information requirement whose value nothing reads does nothing */
function analyzeWiring(view: DerivedDecision, findings: DecisionFinding[]): void {
  const byId = new Map(view.decisions.map((d) => [d.id, d]));
  const inputById = new Map(view.inputData.map((i) => [i.id, i]));

  for (const decision of view.decisions) {
    const reads = new Set(
      decisionVariables(view)
        .filter((v) => v.usedBy.includes(decision.id))
        .map((v) => v.name),
    );
    // a decision's expressions also read upstream decision variables
    const expressions = [...decision.inputs.map((i) => i.expression), decision.expression ?? ""].join(" ");
    for (const required of decision.requires.decisions) {
      const upstream = byId.get(required);
      if (!upstream) {
        findings.push({
          severity: "ERROR",
          code: "requirement-dangling",
          message: `decision '${decision.id}' requires '${required}', which does not exist in this file`,
          decision: decision.id,
        });
        continue;
      }
      // the variable name is what the expressions must mention — matching on the
      // raw text keeps compound expressions (`upper case(zone)`) in scope
      if (!new RegExp(`\\b${upstream.variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(expressions)) {
        findings.push({
          severity: "WARN",
          code: "requirement-unused",
          message: `decision '${decision.id}' requires '${upstream.id}' but never reads its result variable '${upstream.variable}' — the chain has no effect (case-sensitive)`,
          decision: decision.id,
        });
      }
    }
    for (const required of decision.requires.inputData) {
      const input = inputById.get(required);
      if (!input) {
        findings.push({
          severity: "ERROR",
          code: "requirement-dangling",
          message: `decision '${decision.id}' requires input data '${required}', which does not exist in this file`,
          decision: decision.id,
        });
        continue;
      }
      if (!reads.has(input.variable)) {
        findings.push({
          severity: "WARN",
          code: "requirement-unused",
          message: `decision '${decision.id}' requires input data '${input.id}' but no column reads its variable '${input.variable}'`,
          decision: decision.id,
        });
      }
    }
  }

  // a cycle never evaluates — the engine would silently skip the decisions
  const state = new Map<string, "open" | "done">();
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      findings.push({
        severity: "ERROR",
        code: "requirement-cycle",
        message: `decisions form a cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" → ")} — none of them can evaluate`,
        decision: id,
      });
      return;
    }
    state.set(id, "open");
    for (const next of byId.get(id)?.requires.decisions ?? []) walk(next, [...trail, id]);
    state.set(id, "done");
  };
  for (const decision of view.decisions) walk(decision.id, []);
}

/** the value candidates a test case can draw from, per variable */
function profileVariables(view: DerivedDecision): VariableProfile[] {
  return decisionVariables(view).map((variable) => {
    const literals = new Set<string>();
    const boundaries = new Set<number>();
    for (const decision of view.decisions) {
      const columns = decision.inputs
        .map((input, n) => ({ input, n }))
        .filter(({ input }) => input.expression.trim() === variable.name);
      for (const { input, n } of columns) {
        for (const value of input.inputValues) for (const l of literalsOf(value)) literals.add(l);
        for (const rule of decision.rules) {
          const entry = rule.when[n] ?? "";
          for (const l of literalsOf(entry)) literals.add(l);
          for (const b of boundariesOf(entry)) boundaries.add(b);
        }
      }
    }
    return {
      name: variable.name,
      typeRef: variable.typeRef,
      source: variable.source,
      literals: [...literals],
      boundaries: [...boundaries].sort((a, b) => a - b),
    };
  });
}

/** Static analysis of a whole DMN file. `ok` is false iff an ERROR was found. */
export function analyzeDecision(view: DerivedDecision): DecisionAnalysis {
  const findings: DecisionFinding[] = [];
  if (view.decisions.length === 0) {
    findings.push({ severity: "ERROR", code: "no-decisions", message: "the file declares no decision" });
  }
  for (const decision of view.decisions) {
    if (decision.kind === "decisionTable") analyzeTable(decision, findings);
    else if (decision.kind === "literalExpression") {
      const expression = decision.expression ?? "";
      if (expression.trim() === "" || expressionBroken(expression)) {
        findings.push({
          severity: "ERROR",
          code: "feel-syntax",
          message: `decision '${decision.id}': '${expression}' is not a valid FEEL expression`,
          decision: decision.id,
        });
      }
    } else {
      findings.push({
        severity: "WARN",
        code: "decision-without-logic",
        message: `decision '${decision.id}' has neither a decision table nor a literal expression`,
        decision: decision.id,
      });
    }
  }
  analyzeWiring(view, findings);

  return {
    findings,
    variables: profileVariables(view),
    rules: view.decisions.map((d) => ({ decision: d.id, ruleIds: d.rules.map((r) => r.id) })),
    ok: !findings.some((f) => f.severity === "ERROR"),
  };
}
