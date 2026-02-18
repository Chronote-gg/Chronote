# Public docs platform

This file documents the public docs platform that serves `docs.chronote.gg`.

## Scope

- Public product docs are built from `apps/docs-site` (Docusaurus).
- Internal engineering docs remain in `docs/`.

## Local commands

- `yarn docs:dev` - run docs dev server on port 3002.
- `yarn docs:build` - build docs into `build/docs-site`.
- `yarn docs:serve` - serve built docs from `build/docs-site` on port 3003.
- `yarn docs:check` - CI-oriented docs validation (build + link checks).

## Search

Algolia DocSearch (preferred):

- `DOCS_ALGOLIA_APP_ID`
- `DOCS_ALGOLIA_API_KEY`
- `DOCS_ALGOLIA_INDEX_NAME`

Fallback behavior:

- If Algolia values are not configured, docs use local search.

## Deployment variables

Terraform publishes these GitHub Actions environment variables:

- `DOCS_BUCKET`
- `DOCS_DISTRIBUTION_ID`

Deploy workflows use those variables to sync docs assets and invalidate CloudFront.

## PR policy

- User-facing changes should include a docs delta in `apps/docs-site`.
- Purely technical changes can use the `docs-exempt` label with rationale.
