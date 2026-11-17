# Visual regression tests

Playwright visual tests capture screenshots for key UI pages and compare them
against baselines to detect unintended UI changes.
Keep a small set of representative viewport screenshots for page layout and
journeys. Cover component states, permissions, errors and billing permutations
with Storybook fixtures and interaction assertions. Do not multiply screenshots
across every theme, width, billing period and full-page mode.
Scroll behavior needs assertions that the intended container actually scrolls.

## Running locally

- Update baselines: `yarn test:visual:update`
- Compare against current baselines: `yarn test:visual`

The visual tests run in mock mode, use fixed mock timestamps, and disable
animations for stable snapshots.

Short-screen Ask and upgrade checks protect first-load visibility of the input,
prices and plan action. Functional checks still exercise both billing periods
and responsive widths without capturing every permutation.

Run `yarn storybook` and then `yarn test-storybook` for isolated state and
interaction coverage. CI tests the built Storybook. Screenshots are opt-in:
set `STORYBOOK_SCREENSHOTS=true` before running the test runner, and use
`--includeTags` to capture the relevant stories only. Captures are written to
`test/storybook/screenshots` for visual review.

## Handling nondeterministic UI

- Prefer deterministic mock data first. Keep timestamps, random IDs, and seeded
  lists derived from the fixed mock time instead of `Date.now()`.
- If time needs to be frozen in the browser, use Playwright Clock
  (`page.clock.setFixedTime(...)`) for the test or test suite.
- If a small region is intentionally dynamic, mask it with `toHaveScreenshot`
  options (`mask`, `maskColor`, or `stylePath`) rather than loosening the whole
  diff.
- If you must allow small pixel drift, use `maxDiffPixels`,
  `maxDiffPixelRatio`, or `threshold` on that specific screenshot assertion.

Note: Snapshots are OS-specific. CI runs on Windows, so baselines use the
win32 suffix. If you update snapshots on macOS or Linux, expect different
filenames and diffs.

## CI behavior

- PRs with visual-relevant changes run the Visual Regression job.
- Pixel differences and any visual test failure fail the check, including
  missing baselines and runs that never reach screenshot comparison. Reports
  and previews are still attempted after a failure. Requiring this check for
  merging is a separate repository branch-protection setting.
- Preview publishing is optional, so a shared preview-branch push conflict
  does not fail a passing screenshot run. Failed runs are identified in the
  report even when the PR also contains committed baseline updates.
- The job checks out base branch snapshots, runs visual tests on the PR, and
  uploads artifacts:
  - `playwright-report` HTML report
  - `test-results` with expected, actual, and diff images
  - `visual-summary.md` with the change list
- A PR comment is posted with the summary, committed snapshot file changes, and
  a link to the Actions run. For same-repository PRs with generated visual
  diffs, the job also publishes preview images to the
  `visual-regression-previews` branch so the comment can render inline diff
  images.

## Adding new views

- Add a new `@visual` test in `test/e2e/visual.spec.ts`.
- Run `yarn test:visual:update`.
- Inspect each new or changed screenshot before accepting it. Baseline updates
  are deliberate review decisions, not an automatic response to a failing check.
- Commit the new snapshots in `test/e2e/visual.spec.ts-snapshots`.
- Prefer one viewport snapshot per representative layout. Add a second only
  when it protects a distinct layout failure that assertions cannot cover.
