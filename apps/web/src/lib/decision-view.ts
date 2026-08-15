/**
 * Shared decision-test wording of the SPA Checks panel (components/
 * decision-checks-panel.tsx) and the DMN widget (mcp-app/dmn-tests.ts) —
 * the derivations both frontends must phrase identically. Colours stay per
 * frontend on purpose (Tailwind classes vs widget CSS classes — two token
 * systems). Framework-free, like lib/todo-view.ts.
 */

/** status glyph of one test case; `undefined` = stored but never run */
export const caseGlyph = (status: "pass" | "fail" | "pending" | undefined): string =>
  status ? { pass: "✓", fail: "✗", pending: "?" }[status] : "·";

/** the golden-master hint under a case without an expectation */
export const pendingActualLine = (actualValue: unknown): string =>
  `no expectation — currently produces ${JSON.stringify(actualValue)}`;

/** the rules no test case decides (rule ids are "<decision>/<rule>") */
export const uncoveredRulesLine = (rules: string[]): string =>
  `No case decides: ${rules.map((r) => r.split("/").pop()).join(", ")}`;
