// Pre-commit checks on STAGED files only (fast). Prettier honours .prettierignore,
// so model/content files pass through untouched.
export default {
  "*.{ts,tsx,mts}": ["eslint --fix", "prettier --write"],
  "*.{js,mjs,cjs,css,json,md,yml,yaml,html}": "prettier --write",
  // any change to the example content's models — or to a decision's test cases
  // → run the platform validator AND the decision tests (CLAUDE.md hard rules
  // 1 and 5). Fast, no network; the function form runs it once for the group.
  "process-documentation/processes/**/*.{bpmn,dmn,tests.yaml}": () => "pnpm validate",
};
