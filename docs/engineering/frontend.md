# Frontend reference

## Frontend

### Portal session recovery

`AuthContext` owns identity checks and a bounded recovery episode. Private layouts use `ProtectedSessionBoundary`; state-owning editors and uploads register `useAuthNavigationBlocker` so a paused session does not unmount local work before warning. The tRPC observer and live REST controls distinguish session rejection from permission and transport failures. Public routes do not initiate automatic sign-in.

Stream transport failures check identity in the background without spending the session-rejection budget or remounting a valid page. Notion credential failures use `PRECONDITION_FAILED` and retain their reconnect guidance; `UNAUTHORIZED` identifies a rejected portal session.

A successful authenticated operation on the rejected path ends its recovery episode. This includes a mutation the user deliberately retries; failed mutations are never replayed automatically.

Ordinary Discord login uses `prompt=none`; interactive recovery and Switch account use `consent`. The shared atomic OAuth state store keeps login and install transactions in separate namespaces and preserves each attempt's return target across session regeneration. Session lifetime and scopes are unchanged. Callback outcomes and browser recovery metadata are never proof of authentication.

## Frontend tooling

- Vite + React 19 lives in `src/frontend/`; production build is static assets in `build/frontend/` served via S3/CloudFront (see deploy workflow). Use `yarn frontend:dev` for local HMR.
- Public product docs live in `apps/docs-site/`; run `yarn docs:dev` for local authoring and `yarn docs:check` before merging docs changes.
- **A new publicly indexable route has to be added to `scripts/public-routes.json`, or it ships disowning itself.** The app is one bundle, so every route is served the same `index.html` and inherits the homepage's canonical URL and Open Graph tags. A crawler reads that as "this page is really the homepage" and folds it in rather than indexing it, and a link shared in Discord previews as the homepage pitch. `scripts/build-route-html.mjs` runs after `vite build` and rewrites those tags into `build/frontend-routes/<key>.html` per route; `deploy.yml` uploads each to an **extensionless** S3 key so CloudFront serves `/join` from its own document instead of falling through the 404-to-`index.html` SPA fallback. The `key` therefore has to match the path. That same file generates `build/frontend/sitemap.xml`, so the sitemap cannot advertise a route that lacks correct metadata; there is deliberately no hand-maintained `public/sitemap.xml` to drift from it. The script throws when a tag it needs is missing from the head, because quietly shipping the homepage's canonical URL is the failure it exists to prevent. An optional `ogImage` per route overrides the shared share card; leave it unset unless the image would carry route-specific information, since one card per route is one more asset to keep on-brand for no gain. The upload itself lives in the `./.github/actions/sync-frontend` composite action, used by both `deploy.yml` and `deploy-staging.yml`, because the two hand-maintained copies had already drifted once.
- Storybook lives in `.storybook/` for component development. Start it with `yarn storybook` (port 6006 by default, no auto-open). Use `yarn storybook:open` when you want the browser to open automatically.
- **Storybook must keep `typescript.reactDocgen: "react-docgen-typescript"`.** The default `react-docgen` parser reads the root `babel.config.js`, which exists for Jest and carries `@babel/preset-typescript` with no JSX support, so it parses every `.tsx` as plain TS and throws on the first `<Component prop={x}>`. The failure is total and misleading: every `.tsx` in the project 404s, the preview renders blank, and `test-storybook` fails all suites with `Cannot access 'StorybookTestRunnerError' before initialization`, which points nowhere near the cause. `Storybook Build` in `ci-core.yml` guards it.
- Restarting Storybook needs the port freed first. `storybook dev` survives a `pkill -f storybook`, and a fresh start silently offers port 6007 instead, so a config change can look like it did nothing while the old server is still answering on 6006. Kill by port: `Get-NetTCPConnection -LocalPort 6006 | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`.
- To capture component screenshots, run `yarn test-storybook` while Storybook is running. Screenshots are written to `test/storybook/screenshots`.
- When making UI changes, run Storybook and capture screenshots with `yarn test-storybook` before finishing. If the UI change is not covered by a story, add or update a story first.
- Always run Storybook screenshot capture and do a VLM review for any UI change before responding with final UI edits.
- When making UI changes, use the VLM to review the Storybook screenshots so you can verify the component changes without scanning the full page.
- When making UI changes, review Playwright visual snapshots in `test/e2e/visual.spec.ts-snapshots` with the VLM to understand existing UI flows. It is OK to update snapshots with `yarn test:visual:update` or use the Playwright MCP during UI work.
- Scroll regressions: add a Playwright assertion test that proves the intended scroll container actually scrolls (for example, checking `scrollHeight > clientHeight` and that `scrollTop` changes) and run it locally alongside visual snapshots.
