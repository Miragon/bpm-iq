## What changed & why

<!-- One or two sentences. Link the feedback entry (processes/<id>/feedback/) if this PR resolves one. -->

## Checklist

<!-- Delete lines that don't apply. Merge approval = release (docs/governance.md). -->

- [ ] `pnpm validate` passes with 0 errors
- [ ] Semantic model change → `version` bumped (semver) **and** a `history` entry added in `process.yaml`
- [ ] `last_reviewed` touched **only** if a human confirmed model = reality (never for CI or cosmetic edits)
- [ ] `as-is` model changed → `approval` block updated so `approval.version` equals the new `version`
- [ ] Affected exports re-run via `export-process-skill` → `dist/skills/<id>` matches the new version
- [ ] `processes/INDEX.md` row updated (status, version, last reviewed)
- [ ] New terms used in the model or docs added to `landscape/glossary.yaml` (with synonyms)
- [ ] Landscape / schema / convention change → affected process owners requested as reviewers
