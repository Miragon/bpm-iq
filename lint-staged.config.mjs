// Pre-commit checks on STAGED files only (fast). Prettier honours .prettierignore,
// so model/content files pass through untouched.
export default {
  "*.{ts,tsx,mts}": ["eslint --fix", "prettier --write"],
  "*.{js,mjs,cjs,css,json,md,yml,yaml,html}": "prettier --write",
  // any change to the example content's BPMN → run the platform validator
  // (CLAUDE.md hard rule 1). Fast, no network; the function form runs it once.
  "process-documentation/processes/**/*.bpmn": () => "pnpm validate",
};
