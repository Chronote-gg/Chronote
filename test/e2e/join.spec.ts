import { expect, test } from "./fixtures";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";
import type { FirstMeetingState } from "../../src/types/firstMeeting";

const serverId = "111111111111111111";
const otherServerId = "222222222222222222";
const historyId = "333333333333333333#2026-10-19T12:00:00.000Z";
const meeting = {
  historyId,
  title: "Permitted first meeting",
  portalUrl: `http://127.0.0.1:5173/portal/meetings/${serverId}/${encodeURIComponent(historyId)}`,
  discordUrl: `https://discord.com/channels/${serverId}/444444444444444444/555555555555555555`,
  captureNotice: "Some audio could not be captured.",
  recoveryNotice: "Recording recovered after an interruption.",
};
const guilds = {
  guilds: [
    { id: serverId, name: "Member server", canManage: false },
    { id: otherServerId, name: "Other server", canManage: true },
  ],
};

test("join page renders", async ({ joinPage }) => {
  await joinPage.goto();
  await expect(joinPage.hero()).toBeVisible();
  await expect(joinPage.ctaDiscord()).toBeVisible();
});

for (const width of [390, 768, 1280]) {
  test(`first recording guide at ${width}px starts in Discord and scrolls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto("/join");
    await expect(
      page.getByRole("heading", { name: "Record your first meeting." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Discord" }),
    ).toHaveAttribute("href", "https://discord.com/channels/@me");
    await expect(page.getByTestId("sample-summary")).toBeVisible();
    await expect(
      page.getByText(
        "Chronote replies privately with a link to your recording. Follow it to find the controls and notes.",
      ),
    ).toBeVisible();
    expect(await page.locator("details").getAttribute("open")).toBeNull();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const scroll = await page.evaluate(() => {
      const element = document.scrollingElement!;
      const canScroll = element.scrollHeight > element.clientHeight;
      element.scrollTop = 200;
      return { canScroll, top: element.scrollTop };
    });
    expect(scroll.canScroll).toBe(true);
    expect(scroll.top).toBeGreaterThan(0);
    await page
      .getByTestId("join-hero")
      .getByRole("link", { name: "Open portal" })
      .click();
    await expect(page).toHaveURL(/\/portal/);
  });
}

test("guide pins the permitted meeting, follows processing and preserves warnings", async ({
  page,
}) => {
  let state: FirstMeetingState = { kind: "recording", meeting };
  const inputs: string[] = [];
  await mockFirstMeetingRequests(page, {
    "servers.listEligible": () => guilds,
    "meetings.firstMeeting": (url) => {
      inputs.push(url.searchParams.get("input") ?? "");
      return state;
    },
  });
  await page.goto(`/join?serverId=${serverId}`);
  await expect(page.getByText("Recording in progress")).toBeVisible();
  await expect(page).toHaveURL(new RegExp("historyId="));
  await expect(
    page.getByRole("link", { name: "View recording" }),
  ).toHaveAttribute("href", meeting.discordUrl);
  state = { kind: "processing", meeting };
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Preparing your notes")).toBeVisible();
  state = { kind: "delivery_attention", delivery: "partial", meeting };
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(
    page.getByText("Notes saved. Some notes could not be posted to Discord."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open meeting" }),
  ).toHaveAttribute("href", meeting.portalUrl);
  await expect(page.getByText(meeting.captureNotice)).toBeVisible();
  await expect(page.getByText(meeting.recoveryNotice)).toBeVisible();
  expect(inputs.some((input) => input.includes(historyId))).toBe(true);
});

test("switching servers clears the pinned target and ignores an old response", async ({
  page,
}) => {
  let releaseOld: (() => void) | undefined;
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldRequests = 0;
  const otherInputs: string[] = [];
  await mockFirstMeetingRequests(page, {
    "servers.listEligible": () => guilds,
    "meetings.firstMeeting": async (url) => {
      const input = url.searchParams.get("input") ?? "";
      if (input.includes(otherServerId)) {
        otherInputs.push(input);
        return { kind: "guide" };
      }
      oldRequests += 1;
      if (oldRequests > 2) await oldResponse;
      return { kind: "recording", meeting };
    },
  });
  try {
    await page.goto(`/join?serverId=${serverId}`);
    await expect(page.getByText(meeting.title)).toBeVisible();
    await expect.poll(() => oldRequests).toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => oldRequests).toBe(3);
    await page.getByRole("button", { name: "Choose a server" }).click();
    await page.getByText("Other server", { exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`serverId=(?:%22)?${otherServerId}(?:%22)?$`),
    );
    await expect(page.getByText(meeting.title)).toBeHidden();
    releaseOld?.();
    await expect(
      page.getByTestId("join-hero").getByRole("link", { name: "Open portal" }),
    ).toHaveAttribute(
      "href",
      `/portal/meetings?scope=guild&serverId=${otherServerId}`,
    );
    await expect(
      page.getByRole("link", { name: "View recording" }),
    ).toHaveCount(0);
    expect(otherInputs.every((input) => !input.includes(historyId))).toBe(true);
  } finally {
    releaseOld?.();
  }
});

test("invalid guide search stays generic and sign-in preserves a valid target", async ({
  page,
}) => {
  let progressRequests = 0;
  await mockFirstMeetingRequests(page, {
    "auth.me": () => null,
    "servers.listEligible": () => guilds,
    "meetings.firstMeeting": () => {
      progressRequests += 1;
      return { kind: "guide" };
    },
  });
  await page.goto("/join?serverId=invalid&historyId=invalid");
  await expect(
    page.getByRole("link", { name: "Open Discord" }),
  ).toHaveAttribute("href", "https://discord.com/channels/@me");
  expect(progressRequests).toBe(0);
  await page.goto(
    `/join?serverId=${serverId}&historyId=${encodeURIComponent(historyId)}`,
  );
  const login = await page
    .getByRole("link", { name: "Sign in to check progress" })
    .getAttribute("href");
  if (!login) throw new Error("Missing sign-in URL");
  const redirect = new URL(login, page.url()).searchParams.get("redirect");
  if (!redirect) throw new Error("Missing sign-in return URL");
  expect(new URL(redirect).pathname).toBe("/join");
  expect(new URL(redirect).searchParams.get("historyId")).toBe(historyId);
});

test("focus checks before discovery and visible live polling stops at a terminal result", async ({
  page,
}) => {
  await page.clock.install();
  let state: FirstMeetingState = { kind: "guide" };
  let requests = 0;
  let releaseInitial!: () => void;
  const initialResponse = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  const pinnedResponse = Promise.withResolvers<void>();
  await mockFirstMeetingRequests(page, {
    "servers.listEligible": () => guilds,
    "meetings.firstMeeting": async (url) => {
      await initialResponse;
      requests += 1;
      if (url.searchParams.get("input")?.includes(historyId)) {
        await pinnedResponse.promise;
      }
      return state;
    },
  });
  try {
    await page.goto(`/join?serverId=${serverId}`);
    await expect(
      page.getByRole("button", { name: "Check again" }),
    ).toBeVisible();
    await expect(page.getByText("Checking meeting status...")).toBeVisible();
  } finally {
    releaseInitial();
  }
  await expect(
    page.getByText("No accessible recent meeting found yet."),
  ).toBeVisible();
  const beforeFocus = requests;
  await page.clock.fastForward(30_000);
  expect(requests).toBe(beforeFocus);
  state = { kind: "recording", meeting };
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await expect(page.getByText("Recording in progress")).toBeVisible();
  await expect(page).toHaveURL(/historyId=/);
  await expect.poll(() => requests).toBeGreaterThanOrEqual(beforeFocus + 2);
  await expect(page.getByText("Checking meeting status...")).toBeVisible();
  // Model a pinned response that finishes after the browser's next event turn.
  setTimeout(() => pinnedResponse.resolve(), 100);
  await expect(page.getByText("Checking meeting status...")).toBeHidden();
  const whileRecording = requests;
  await page.clock.fastForward(10_000);
  await expect.poll(() => requests).toBeGreaterThan(whileRecording);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  const whileHidden = requests;
  await page.clock.fastForward(30_000);
  expect(requests).toBe(whileHidden);
  state = { kind: "ready", meeting };
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await expect(page.getByText("Your notes are ready")).toBeVisible();
  const terminalRequests = requests;
  await page.clock.fastForward(30_000);
  expect(requests).toBe(terminalRequests);
});

for (const encoding of ["raw", "quoted"]) {
  test(`installer optional-setup link preserves a 20-digit server in ${encoding} search`, async ({
    page,
  }) => {
    const intendedServerId = "12345678901234567890";
    const progressInputs: string[] = [];
    await mockFirstMeetingRequests(page, {
      "servers.listEligible": () => ({
        guilds: [
          { id: intendedServerId, name: "Exact server", canManage: false },
        ],
      }),
      "meetings.firstMeeting": (url) => {
        progressInputs.push(url.searchParams.get("input") ?? "");
        return { kind: "guide" };
      },
    });
    const queryValue =
      encoding === "raw"
        ? intendedServerId
        : encodeURIComponent(JSON.stringify(intendedServerId));
    await page.goto(`/join?serverId=${queryValue}#optional-setup`);
    await expect(
      page.getByRole("link", { name: "Open Discord" }),
    ).toHaveAttribute(
      "href",
      `https://discord.com/channels/${intendedServerId}`,
    );
    await expect(
      page.getByTestId("join-hero").getByRole("link", { name: "Open portal" }),
    ).toHaveAttribute(
      "href",
      `/portal/meetings?scope=guild&serverId=${intendedServerId}`,
    );
    await expect(page.locator("details")).toHaveAttribute("open", "");
    expect(progressInputs[0]).toContain(intendedServerId);
  });
}

test("an invalid explicit history target cannot fall back to another meeting", async ({
  page,
}) => {
  let requests = 0;
  await mockFirstMeetingRequests(page, {
    "servers.listEligible": () => guilds,
    "meetings.firstMeeting": () => {
      requests += 1;
      return { kind: "ready", meeting };
    },
  });
  await page.goto(`/join?serverId=${serverId}&historyId=invalid`);
  await page.getByRole("button", { name: "Choose a server" }).click();
  await expect(page.getByText("Member server", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose a server" }).click();
  await expect(
    page.getByRole("link", { name: "Open Discord" }),
  ).toHaveAttribute("href", "https://discord.com/channels/@me");
  await expect(page.getByRole("link", { name: "Open meeting" })).toHaveCount(0);
  expect(requests).toBe(0);
});
