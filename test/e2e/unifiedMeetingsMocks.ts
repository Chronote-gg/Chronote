import type { Page, Route } from "@playwright/test";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";
import {
  unifiedBrowse,
  unifiedDetail,
  unifiedGuilds,
  unifiedUser,
  type UnifiedScenario,
} from "../../src/frontend/storybook/unifiedMeetingsFixtures";
export { unifiedGuilds, unifiedUser };
export async function mockUnifiedMeetings(
  page: Page,
  options: {
    scenario?: UnifiedScenario;
    member?: boolean;
    signedOut?: boolean;
    manySources?: boolean;
  } = {},
) {
  const guilds = options.manySources
    ? [
        ...unifiedGuilds,
        ...Array.from({ length: 35 }, (_, i) => ({
          id: `source-${i}`,
          name: `Long collaboration source ${i + 1} with a missing icon`,
          canManage: false,
        })),
      ]
    : unifiedGuilds;
  await mockFirstMeetingRequests(page, {
    "auth.me": () => (options.signedOut ? null : unifiedUser),
    "servers.listEligible": () => ({
      guilds: guilds.map((guild) => ({
        ...guild,
        canManage: options.member ? false : guild.canManage,
      })),
    }),
    "meetings.myList": (url) => unifiedBrowse(url, options.scenario),
    "meetings.detail": (url) => unifiedDetail(url),
    "notion.automationStatus": () => ({ configured: false }),
    "notion.status": () => ({ configured: false, connected: false }),
    "notion.exportStatus": () => ({
      exported: false,
      currentNotesVersion: 1,
      outdated: false,
    }),
  });
  if (options.scenario === "error")
    await page.route("**/trpc/meetings.myList*", (route) =>
      route.fulfill({
        status: 403,
        json: [
          {
            error: {
              message: "Access denied",
              code: -32003,
              data: { code: "FORBIDDEN", httpStatus: 403 },
            },
          },
        ],
      }),
    );
  const pending: Route[] = [];
  if (options.scenario === "loading")
    await page.route("**/trpc/meetings.myList*", (route) => {
      pending.push(route);
    });
  return async () => {
    await Promise.all(pending.map((route) => route.abort().catch(() => {})));
  };
}
