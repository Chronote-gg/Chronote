import type { Page } from "@playwright/test";

export async function applyVisualDefaults(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.setAttribute("data-visual-test", "true");
    style.textContent = `
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
          font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif !important;
        }
        html {
          scroll-behavior: auto !important;
        }
        body {
          caret-color: transparent !important;
        }
        * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        *::-webkit-scrollbar {
          width: 0 !important;
          height: 0 !important;
        }
        * {
          -webkit-font-smoothing: antialiased !important;
          -moz-osx-font-smoothing: grayscale !important;
        }
      `;
    (document.head || document.documentElement).appendChild(style);

    // Freeze time for deterministic snapshots
    const fixedTime = Date.parse("2025-01-01T12:00:00.000Z");
    const NativeDate = Date;
    const FixedDate = function FixedDate(
      this: Date,
      ...args: [] | ConstructorParameters<typeof Date>
    ): Date {
      if (!(this instanceof FixedDate)) return new NativeDate(fixedTime);
      if (args.length === 0) {
        return new NativeDate(fixedTime);
      }
      return new NativeDate(...args);
    };
    FixedDate.prototype = NativeDate.prototype;
    FixedDate.now = () => fixedTime;
    FixedDate.parse = NativeDate.parse;
    FixedDate.UTC = NativeDate.UTC;
    window.Date = FixedDate as unknown as DateConstructor;
  });
}

export async function waitForVisualReady(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
  });
}
