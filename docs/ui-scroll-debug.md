# UI scroll debugging

This repo has a handful of nested scroll containers (Drawers, ScrollArea viewports, fullscreen split layouts). When scroll breaks, it is usually one of:

- A flex child missing `min-height: 0` and/or `flex: 1`, causing the intended scrollable viewport to expand instead of scrolling.
- A parent using `overflow: hidden` without an alternative scrollable container.
- A layout wrapping at smaller breakpoints, causing a second "row" of content to be clipped inside a fixed-height container.

## Quick workflow (repeatable)

1. Reproduce with Playwright locally

   ```bash
   yarn test:e2e test/e2e/meetingDetailScroll.spec.ts
   ```

2. Inspect interactively if needed

   ```bash
   yarn test:e2e test/e2e/meetingDetailScroll.spec.ts --ui
   ```

3. If the failure is viewport sizing related, run the test with a mobile viewport (the spec already sets one for the mobile case).

## What to look for

- The scroll target should be the ScrollArea viewport element, not the wrapper.
- In a column flex layout, ensure every ancestor between the root and the ScrollArea has `minHeight: 0`.
- Avoid wrapped grid layouts inside a fixed-height container for mobile; prefer a single column flex layout with each panel `flex: 1`.
