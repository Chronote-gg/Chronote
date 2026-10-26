import type { Page, Route } from "@playwright/test";

// Keep unrelated mock-runtime requests intact, including batched queries.
export async function mockFirstMeetingRequests(
  page: Page,
  replacements: Record<string, (url: URL) => unknown | Promise<unknown>>,
) {
  await page.route("**/trpc/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.split("/trpc/")[1]).split(
      ",",
    );
    if (!paths.some((path) => Object.hasOwn(replacements, path)))
      return route.continue();
    const response = paths.every((path) => Object.hasOwn(replacements, path))
      ? null
      : await route.fetch();
    const original = response ? await response.json() : [];
    const entries = Array.isArray(original) ? original : [original];
    const next = await Promise.all(
      paths.map(async (path, index) =>
        Object.hasOwn(replacements, path)
          ? { result: { data: await replacements[path](url) } }
          : entries[index],
      ),
    );
    return route.fulfill({
      status: 200,
      json: url.searchParams.get("batch") === "1" ? next : next[0],
    });
  });
}
