# Docs Authoring Workflow (OpenCode wrapper)

Use this skill when a change affects user-visible behavior and needs public documentation at `docs.chronote.gg`.

This is a repo-specific workflow for creating or updating docs in `apps/docs-site`.

## Standing rules

- Public product docs live in `apps/docs-site`.
- Internal engineering notes and runbooks stay in `docs/`.
- User-facing PRs must include a docs delta, unless `docs-exempt` is explicitly used.
- Keep docs concise, actionable, and user-oriented.

## Authoring checklist

1. Identify user-facing behavior changes from code and issue scope.
2. Update or add the relevant docs page in `apps/docs-site/docs/`.
3. Add or update links in sidebars/navigation when needed.
4. For notable releases, update `apps/docs-site/docs/whats-new/index.md`.
5. Run docs validation:

```bash
yarn docs:check
```

6. Confirm no broken links and no stale setup instructions.

## Style expectations

- Use short headings and direct language.
- Prefer checklists and task-oriented steps.
- Avoid internal implementation details unless they are required for users.
- Keep examples realistic and minimal.

## Search and deployment notes

- Algolia config uses `DOCS_ALGOLIA_APP_ID`, `DOCS_ALGOLIA_API_KEY`, and `DOCS_ALGOLIA_INDEX_NAME`.
- If Algolia is not configured, local search can be used as the temporary fallback.
