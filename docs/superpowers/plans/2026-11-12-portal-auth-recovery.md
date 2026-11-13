# Automatic portal sign-in recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover expired portal sessions automatically, skip repeat Discord approval where supported, and return to the intended page without losing work silently.

**Architecture:** Extend the existing AuthContext and tRPC transport with one actor-aware recovery episode. Keep return targets bound to individual Discord OAuth transactions, and use one protected-content boundary that retains unfinished local work while access is paused. Reuse existing query reset, session storage, validation and UI components.

**Tech stack:** TypeScript, React 19, TanStack Query/Router, tRPC, Express/Passport, existing DynamoDB SessionTable, Jest, Playwright and Mantine/Storybook. No new dependency or infrastructure.

**Spec:** [Approved design](../specs/2026-11-12-portal-auth-recovery-design.md).

## Review brief

The implementation has four connected parts: make Discord's round trip reliable, detect session rejection centrally, connect recovery to private pages without losing local work, then prove the complete journey. Ordinary sign-in uses `prompt=none`; Switch account and explicit interactive recovery retain user interaction.

Recommend native execution in the implementation chat because the server callback, client recovery budget and local-work boundary share a small set of interfaces. One independent whole-change review follows implementation. This plan does not authorize merge, production deployment, production auth-setting changes or customer-data reads.

## Global constraints

- Automatic recovery is the default on intentional private entry and confirmed expiry. Warn before leaving unfinished edits, selected files or active uploads.
- Allow one identity reconciliation and one resumed protected-read attempt per rejection episode. Never replay mutations or allow concurrent requests to create independent recovery loops.
- Keep scopes, session lifetime, permissions, OAuth state, CSRF and cookie/token validation unchanged. No persistent draft contents or credentials in browser storage, URLs or logs.
- Public landing/share/offer pages remain public. Preserve private paths, search and fragments, upgrade selections, account switching, MCP/desktop and install routing.
- Reuse actor-generation cancellation and public-query exemptions. A late old-actor response or rejection cannot affect the new actor.
- UI edits require Storybook screenshots, VLM inspection and relevant Playwright snapshots. No release claim follows from local or synthetic proof.

## Review focus

- Two authorization tabs can finish in either order; each must return to its own destination. Covered in Task 1.
- A callback can succeed while cookies are blocked; the app must stop automatic recovery rather than loop. Covered in Tasks 1, 2 and 4.
- A late request from an older actor must not clear a newer actor's session or draft. Covered in Tasks 2 and 3.
- Expiry can coincide with a dirty editor or selected upload; pausing auth must not unmount the draft before warning. Covered in Task 3.
- EventSource failures do not reveal a reliable HTTP status; a stream outage must not be interpreted directly as logout. Covered in Tasks 3 and 4.

## Source and execution setup

This shared checkout has unrelated dirty work and an older HEAD. Before implementation, use `superpowers:using-git-worktrees` to establish an isolated `codex/` branch from the current owning source. Preserve these approved documents in that branch, install its pinned dependencies using the existing project setup, and read its applicable instructions. Do not implement against the older dependencies used by the research check.

At plan time, selected auth files in the lead checkout match the inspected deployed baseline. Refresh the actual base at execution. If drift changes behavior, update the affected task rather than transplanting an old implementation.

## File ownership

| Area                          | Existing files to modify                                                                                                                 | New files only where needed                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| OAuth round trip              | `src/webserver.ts`, `src/services/discordInstallAuth.ts`, `src/services/oauthRedirectSession.ts`, `src/trpc/routers/auth.ts`             | `src/services/discordLoginStateStore.ts` and its test                                                                     |
| Recovery policy and transport | `src/frontend/contexts/AuthContext.tsx`, `src/frontend/queryClient.ts`, `src/frontend/services/trpcClient.ts`                            | `src/frontend/services/authRecovery.ts`, `src/frontend/services/authRecovery.test.ts`                                     |
| Protected UI and local work   | Portal/SuperAdmin layouts, LiveMeeting, auth/header controls, guild context, browse counts/results and editable callers listed in Task 3 | `src/frontend/components/ProtectedSessionBoundary.tsx`, its stories, and `src/frontend/hooks/useAuthNavigationBlocker.ts` |
| Acceptance                    | Existing auth, layout, callback, redirect, actor/public-query tests and frontend mocks                                                   | `test/e2e/auth-recovery.spec.ts`                                                                                          |

Do not split unrelated modules or introduce a second auth system. A file in this map is an implementation owner, not a mandatory file-count limit.

### Task 1: Secure Discord repeat-consent bypass and per-attempt return targets

**Files:** OAuth row above; `test/services/discordInstallAuth.test.ts`, `test/services/oauthRedirectSession.test.ts`, `test/services/oauthRedirectService.test.ts`; add `test/services/discordLoginStateStore.test.ts` and `test/trpc/authRouter.test.ts`.

**Interfaces:** In `discordLoginStateStore.ts`, export `DiscordLoginIntent = { returnTo: string; prompt: "none" | "consent"; recoveryId: string | null }` and `DiscordLoginStateStore` implementing Passport's existing `store`/`verify` overloads. Add `consumeFailure(req: Request, state: unknown): Promise<DiscordLoginIntent | undefined>` for denial/error handling. Keep verified intent on the request, never read an unvalidated callback target. Constructor dependencies follow `DiscordInstallStateStore`'s existing Dynamo client/test pattern.

- [ ] Add failing tests that exercise the real Passport strategy URL construction and state contract. Ordinary login sends `none`; explicit interaction sends `consent`; scope stays `identify email guilds`; both have fresh state and the registered callback. Assert `auth.me` returns null without a usable access token, matching protected middleware.
- [ ] Test two starts in the same session, reverse-order callbacks, duplicate callback races, wrong session, expired/invalid state, denial and missing cookies. Assert each valid state is consumed at most once and can restore only its own validated target. A raw `redirect`, error description or state-shaped string never authorizes login or a return target.
- [ ] Run the new tests before implementation: `yarn jest --runInBand --coverage=false --runTestsByPath test/services/discordLoginStateStore.test.ts test/services/discordInstallAuth.test.ts test/services/oauthRedirectSession.test.ts test/services/oauthRedirectService.test.ts test/trpc/authRouter.test.ts`. Expect the new contract assertions to fail.
- [ ] Implement independent login-state records in the existing SessionTable using the install store's established atomic reservation/consumption pattern and existing bounded expiry policy. Do not put multiple return targets into a whole-session map vulnerable to last-writer-wins. Preserve the binding across Passport session regeneration. Keep the install store and its state prefix separate.
- [ ] Wire ordinary `/auth/discord` to `none`, allowing only the explicit supported interactive option to choose `consent`. Bind the validated return target and optional recovery ID to the transaction. On successful callback, use that verified intent; on failure, preserve the target only after state validation. Error/denial paths must consume and validate state too, even when Passport skips its normal state-store verification. Missing or invalid state reaches a fixed safe recovery destination without authenticating or trusting query inputs.
- [ ] Carry only an opaque recovery ID and a fixed success/failure outcome back to the validated frontend destination. This is an outcome hint, never authentication proof. Preserve the existing MCP/desktop precedence and install callback behavior. Update account-switch redirect construction so it returns to the interactive sign-in action rather than immediately repeating ordinary passthrough.
- [ ] Rerun the focused tests plus `test/services/discordInstallStateStore.test.ts` and existing MCP/desktop OAuth tests. Expect all to pass. Commit the tested OAuth change on the isolated branch.

### Task 2: One client recovery episode with explicit identity states

**Files:** Recovery row above; `test/frontend/authContext.test.tsx`, `src/frontend/contexts/AuthContext.actor.test.tsx`, `src/frontend/contexts/AuthContext.publicQueries.test.tsx`, `src/frontend/queryClient.test.ts` and existing auth mocks.

**Interfaces:** `authRecovery.ts` owns transport-generation events and browser-session recovery metadata, not React state or drafts. Export `AuthTransportEvent = { kind: "unauthorized" | "authorized-read"; generation: number; path: string }`, `setAuthRequestGeneration(generation: number): void` and `subscribeAuthTransport(listener: (event: AuthTransportEvent) => void): () => void`. Add AuthContext operations `ensureProtectedSession(): Promise<void>`, `retryRecovery(): Promise<void>` and `continueRecovery(): void`. Keep existing `refresh`, `loginUrl`, `logoutUrl` and `protectedQueriesReady` compatible while migrating callers. Use a discriminated recovery state instead of contradictory booleans.

- [ ] Add failing tests using a real QueryClient and tRPC transport with synthetic responses, not only mocked auth-hook snapshots. Cover mounted landing with stale actor then private entry; stale null after login elsewhere; initial/background identity errors; parallel query/mutation `UNAUTHORIZED`; a mixed-result batch; and identity success followed by another protected rejection.
- [ ] Express the episode contract directly in tests:

  ```ts
  expect(identityCheck).toHaveBeenCalledTimes(1);
  expect(repeatedMutation).not.toHaveBeenCalled();
  expect(secondCurrentGenerationRejection.state).toBe("recovery-required");
  expect(oldActorFailureChangedCurrentSession).toBe(false);
  ```

- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/frontend/services/authRecovery.test.ts test/frontend/authContext.test.tsx src/frontend/contexts/AuthContext.actor.test.tsx src/frontend/contexts/AuthContext.publicQueries.test.tsx src/frontend/queryClient.test.ts`. Confirm the new recovery cases fail against the existing behavior.
- [ ] Add a small tRPC observer link before `httpBatchLink`. Capture actor generation at operation start; report semantic current-session rejection and successful authenticated reads per operation without swallowing the original result/error or retrying mutations. Keep fetch credentials and CSRF handling unchanged. Exclude `auth.me` and public procedures from successful-protected-read proof. Public errors while anonymous must not trigger recovery. Avoid a queryClient/AuthContext circular dependency.
- [ ] Make AuthContext reconcile current-generation failures once. Stale protected entry rechecks identity and gates requests; fresh successful identity can be reused. Missing identity starts recovery, transport errors become unavailable, and a second post-check rejection becomes explicit recovery. Advance the request generation when an actor changes or a reconciliation supersedes prior requests; cancel obsolete reads and preserve the existing public-query exemptions.
- [ ] Persist the consumed automatic-attempt marker in `sessionStorage` before navigation, keyed by the opaque recovery ID. It contains recovery metadata only. Correlate callback outcome to that ID, retain failure across reload, and clear it only after valid identity plus a successful protected read, explicit retry, or deliberate navigation outside the failed recovery. Clear stale unrelated metadata on a later deliberate entry. If metadata cannot be read/written reliably, use explicit recovery. Never infer signed-in state from the callback hint.
- [ ] Add storage-denial, callback-without-session, reload-after-denial, expired metadata and older-episode-event cases. Rerun the focused group and existing query-reset tests; expect all to pass. Commit the tested shared recovery change.

### Task 3: Connect protected pages and preserve unfinished local work

**Files:** `PortalLayout.tsx`, `SuperAdminLayout.tsx`, `PortalServerLayout.tsx`, `pages/LiveMeeting.tsx`, `components/SiteHeader.tsx`, `components/AuthBanner.tsx`, `contexts/GuildContext.tsx`, `pages/UnifiedMeetingsPage.tsx`, `pages/UnifiedMeetingResults.tsx`, `pages/hooks/useMeetingBrowse.ts`, `hooks/useLiveMeetingStream.ts`, plus new boundary/hook/stories. Tests: `test/frontend/layouts.test.tsx`, existing library tests and affected component/page tests.

**Interfaces:** `ProtectedSessionBoundary({ children }: { children: ReactNode }): ReactElement` consumes AuthContext and owns the recovery presentation/departure decision. `useAuthNavigationBlocker(blocked: boolean): void` registers only whether mounted local work would be lost. Keep blockers in memory and associate them with the actor generation; never store content. The boundary retains the mounted local-work subtree while the same actor's recovery is paused, disables protected actions, and shows accessible recovery controls. It discards that subtree on an actual actor change.

- [ ] Add failing integration tests for private entry, unavailable check, forbidden data, successful complete empty discovery and filter-empty results. Assert that a rejected data request never becomes a zero-meetings claim and that Retry does not launch OAuth on 429/5xx/network failure. Reuse existing test fixtures and auth mocks.
- [ ] Add a dirty-editor and upload test before changing the layout:

  ```ts
  expect(editorValueAfterExpiry).toEqual(typedDraft);
  expect(oauthNavigation).not.toHaveBeenCalled();
  expect(protectedMutationWhilePaused).not.toHaveBeenCalled();
  expect(editorValueAfterChoosingStay).toEqual(typedDraft);
  ```

- [ ] Run the changed test paths with `yarn jest --runInBand --coverage=false --runTestsByPath ...` and verify the new cases fail. Implement the shared boundary and blocker hook, then replace repeated private-page sign-in branches with it. Initial sign-out can render a recovery view; mid-use pausing must not remove the editor before the navigation decision. Revalidation must not reset same-actor local form values through changed query defaults. Test this with query reset, not only an isolated text input.
- [ ] Integrate blockers at the actual state owner: notes editor/import/correction/rename/share/feedback in `pages/library/components/MeetingDetailDrawer.tsx` and its modals; drafts in `pages/Ask.tsx`; context/dictionary/service-account/config/Notion edits in `pages/Settings.tsx` and owning cards; `pages/PersonalSettings.tsx`; `pages/AdminConfig.tsx`, `pages/AdminEntitlements.tsx`, `pages/AdminFeedback.tsx`; selected file/pending upload in `pages/PersonalUpload.tsx`; and authenticated feedback draft/attachments in `pages/ContactFeedback.tsx`. Follow parent-owned state rather than registering every controlled input. Read each owner before editing and include any additional editable owner discovered by the caller search. Search/filter-only state that survives in the URL is not a lost draft.
- [ ] Keep pending saves/checkout/recording/upload operations visible as interrupted or uncertain where appropriate; do not replay them after recovery. Acknowledge saved state only from actual successful mutation results. Continuing to sign in may discard local work after an explicit warning; staying leaves authenticated actions disabled. A different actor must see none of the retained previous actor's work.
- [ ] Let guild and browse errors preserve semantic distinctions and suppress misleading counts. Use a single recovery UI with Checking sign-in, unavailable/Retry, unfinished-work warning, and terminal explicit recovery. Keep existing access-denied and empty-result components where correct.
- [ ] For EventSource failure, close the stream as today and request an identity check through the shared owner, never classify the stream error directly as `UNAUTHORIZED`. If identity remains valid, show/retry the stream error without OAuth. Do not change the existing rule about a settings change not terminating an already-open authorized transcript stream. Protected live controls and REST helpers must preserve 401 versus 403 if they feed shared recovery; do not globally map `AuthNeededError` to logout.
- [ ] Update mocks and stories for all auth outcomes and interactive Switch account. Run affected Jest paths including `test/frontend/layouts.test.tsx`, `test/frontend/pages.library.test.tsx`, `src/frontend/hooks/useLiveMeetingStream.test.tsx`, `src/frontend/pages/__tests__/PersonalUpload.test.tsx` and the editor/settings tests changed above. Expect all to pass, including late-old-actor and public-share regressions. Commit the tested UI integration.

### Task 4: Prove the full journey and prepare the reviewed change

**Files:** New `test/e2e/auth-recovery.spec.ts`; existing `test/e2e/visual.spec.ts`, relevant stories/mocks and snapshots. Preserve the approved design and this plan in the branch. Product documentation changes, if needed for user-facing instructions, follow `docs-authoring` and its existing What's New convention without adding an analytics event.

**Interfaces:** Consume Tasks 1-3 through real frontend routing and client transport. Mock provider/API boundaries with synthetic data; do not replace AuthContext with a signed-in fixture for the recovery proof.

- [ ] Add Playwright cases for landing-to-private navigation after expiry, direct private links with filters/fragment, mid-use expiry, dirty work and selected file, callback success, denial, blocked-cookie repeated sign-out, unavailable auth check, forbidden result, cross-tab sign-in, interactive account change, and public landing/share/offer pages. Assert final destination, navigation count, visible state and mutation count rather than only authorization URL construction. Include EventSource failure with a still-valid identity.
- [ ] Run `yarn playwright test test/e2e/auth-recovery.spec.ts --project=chromium` using the existing mock web-server setup. Expect all cases to pass. Run the relevant existing home/library/join/billing/offer navigation cases changed by this work; no live payment mutation.
- [ ] Run focused Jest suites, `yarn build`, `yarn build:web`, and read-only lint/format checks for changed files. Use `yarn eslint <changed TS/TSX files>` and `yarn prettier <changed files> --check`, not repo-wide auto-fix commands. Resolve genuine regressions without touching unrelated work.
- [ ] Start the existing Storybook on port 6006 after checking its owner; do not stop someone else's preview. Run `yarn test-storybook` for screenshot capture and inspect the changed recovery stories with the VLM. Review existing relevant Playwright snapshots before updating changed ones. Run relevant visual snapshots through the existing runner. If a changed container scrolls, add and run an actual scroll-range/scrollTop assertion.
- [ ] Record synthetic and controlled-browser evidence separately. Controlled Discord acceptance should use an authorized account in the test environment and the established environment instructions. Test previously granted, first-time, provider-signed-out, revoked, cancelled and private-browser cases; never export cookies/tokens. If that capability or authorization is unavailable, report the precise missing acceptance instead of claiming seamless live login. Do not deploy or alter production auth to finish a test.
- [ ] Perform one whole-change review against the approved design, including actor races, callback trust, local-work lifetime and actual operation classification. Apply valid fixes and rerun the affected checks. Commit the finished branch. If pushing a PR is authorized, load `pr-post-push-sop` and `pr-review-recycle` and follow exact-current-head checks/feedback requirements before claiming merge readiness. Merge and deployment remain separate.

## Completion evidence

The finished result must distinguish unit/integration proof, local browser proof and actual Discord acceptance. Summarize changed behavior, test commands/results, reviewed screenshots and any missing live case. Keep private provider evidence in the private operations repository; public code and PR prose contain only sanitized results.

Plan self-review: all design requirements map to Tasks 1-4. The five review-focus cases have assigned tests. Interfaces use the existing auth owner and query-reset boundary; local-work metadata carries no draft content. No new session policy, data migration, dependency, analytics, persistent drafts or deployment is included.
