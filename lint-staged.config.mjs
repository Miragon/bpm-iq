// Pre-commit checks on STAGED files only (fast). Prettier honours .prettierignore,
// so model/content files pass through untouched.
export default {
  "*.{ts,tsx,mts}": ["eslint --fix", "prettier --write"],
  "*.{js,mjs,cjs,css,json,md,yml,yaml,html}": "prettier --write",
  // any change under the content repo's data trees → run the platform validator
  // (CLAUDE.md hard rule 1). Fast, no network; the function form runs it once.
  "process-documentation/{processes,landscape,schemas}/**/*": () => "pnpm validate",
};
