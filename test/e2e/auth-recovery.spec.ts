import { test, expect, type Page } from "@playwright/test";

async function sessionFixture(
  page: Page,
  options: { callbackSession?: boolean; pollDetail?: boolean } = {},
) {
  let signedIn = true;
  let authUnavailable = false;
  let forbidden = false;
  let detailDenied = false;
  let identityReads = 0;
  const navigations: URL[] = [];
  await page.route("**/trpc/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.split("/trpc/")[1]).split(
      ",",
    );
    const original = await upstream.json();
    const results = Array.isArray(original) ? original : [original];
    const reject = (code: string, status: number) => ({
      error: {
        message: "Fixture request failed",
        code: -32001,
        data: { code, httpStatus: status },
      },
    });
    names.forEach((name, index) => {
      if (name === "auth.me") {
        identityReads++;
        results[index] = authUnavailable
          ? reject("INTERNAL_SERVER_ERROR", 500)
          : {
              result: {
                data: signedIn
                  ? { id: "fixture-user", username: "fixture", avatar: null }
                  : null,
              },
            };
      } else if (!signedIn) results[index] = reject("UNAUTHORIZED", 401);
      else if (detailDenied && name === "meetings.detail")
        results[index] = reject("UNAUTHORIZED", 401);
      else if (options.pollDetail && name === "meetings.detail")
        results[index].result.data.meeting.updateDelivery = {
          status: "pending",
          reason: null,
          pollable: true,
          desiredRevision: 2,
          syncedRevision: null,
          lastSuccess: null,
        };
      else if (forbidden && name === "meetings.myList")
        results[index] = reject("FORBIDDEN", 403);
    });
    await route.fulfill({
      response: upstream,
      json: url.searchParams.get("batch") === "1" ? results : results[0],
    });
  });
  await page.route("**/auth/discord?**", async (route) => {
    const login = new URL(route.request().url());
    navigations.push(login);
    signedIn = options.callbackSession !== false;
    const destination = new URL(login.searchParams.get("redirect")!);
    destination.searchParams.set(
      "authRecovery",
      login.searchParams.get("authRecovery")!,
    );
    destination.searchParams.set("authOutcome", "ok");
    await route.fulfill({
      status: 302,
      headers: { location: destination.toString() },
      body: "",
    });
  });
  return {
    navigations,
    get identityReads() {
      return identityReads;
    },
    expire: () => {
      signedIn = false;
    },
    unavailable: () => {
      authUnavailable = true;
    },
    denyDetail: () => {
      detailDenied = true;
    },
    deny: () => {
      forbidden = true;
    },
  };
}

test("landing-to-portal navigation recovers an expired session without a manual refresh", async ({
  page,
}) => {
  const session = await sessionFixture(page);
  await page.goto("/");
  await expect(page.getByTestId("portal-cta")).toBeVisible();
  await expect(page.getByTestId("logout-cta")).toBeVisible();
  session.expire();
  await page.getByTestId("portal-cta").click();
  await expect(page.getByTestId("unified-meetings-page")).toBeVisible();
  await expect(page.getByTestId("library-meeting-row").first()).toBeVisible();
  expect(session.navigations).toHaveLength(1);
});

test("a callback without a usable cookie stops after one automatic attempt, including reload", async ({
  page,
}) => {
  const session = await sessionFixture(page, { callbackSession: false });
  session.expire();
  await page.goto("/portal/meetings?scope=personal#notes");
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  expect(session.navigations).toHaveLength(1);
  const returned = new URL(
    session.navigations[0].searchParams.get("redirect")!,
  );
  expect(returned.searchParams.get("scope")).toBe("personal");
  expect(returned.hash).toBe("#notes");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  expect(session.navigations).toHaveLength(1);
});

test("auth outages and forbidden data never launch Discord", async ({
  page,
}) => {
  const session = await sessionFixture(page);
  session.unavailable();
  await page.goto("/portal/meetings");
  await expect(
    page.getByText("We couldn't check your sign-in", { exact: true }),
  ).toBeVisible();
  expect(session.navigations).toHaveLength(0);
});

test("forbidden data is a data error rather than an empty meeting list or login", async ({
  page,
}) => {
  const session = await sessionFixture(page);
  session.deny();
  await page.goto("/portal/meetings");
  await expect(
    page.getByText("Unable to load meetings. Try again shortly."),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("0 loaded meetings", { exact: true }),
  ).toHaveCount(0);
  expect(session.navigations).toHaveLength(0);
});

test("an upload draft stays in the tab until the user chooses to sign in", async ({
  page,
}) => {
  const session = await sessionFixture(page);
  await page.goto("/portal/upload");
  await page
    .getByLabel("Title", { exact: true })
    .fill("Fixture unfinished recording");
  await page.locator('input[type="file"]').setInputFiles({
    name: "fixture.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF" + "0".repeat(44)),
  });
  session.expire();
  await page
    .getByRole("button", { name: "Upload and process", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue to sign in" }),
  ).toBeVisible();
  expect(session.navigations).toHaveLength(0);
  await page.getByRole("button", { name: "Stay here" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Fixture unfinished recording",
  );
  expect(session.navigations).toHaveLength(0);
});

test("a notes import draft survives a terminal detail rejection after a valid identity recheck", async ({
  page,
}) => {
  const session = await sessionFixture(page, { pollDetail: true });
  await page.goto("/portal/meetings");
  await page.getByTestId("library-meeting-row").first().click();
  await page.getByRole("button", { name: "Notes actions" }).click();
  await page
    .getByRole("menuitem", { name: "Import notes", exact: true })
    .click();
  const notes = page
    .getByRole("dialog", { name: "Import notes", exact: true })
    .getByRole("textbox", { name: "Notes", exact: true });
  await notes.fill("Fixture unfinished import");
  session.denyDetail();
  await expect(
    page.getByRole("button", { name: "Continue to sign in" }),
  ).toBeVisible({ timeout: 20000 });
  expect(session.navigations).toHaveLength(0);
  await expect(notes).toHaveValue("Fixture unfinished import");
});

test("repeated stream failures retain a valid session and the live retry controls", async ({
  page,
}) => {
  const session = await sessionFixture(page);
  let streams = 0;
  await page.route("**/api/live/**/stream", async (route) => {
    streams++;
    await route.fulfill({ status: 404, body: "Fixture stream unavailable" });
  });
  await page.goto("/live/fixture/fixture");
  const error = page.getByText(
    "Unable to connect. Check your access to the voice channel and try again.",
    { exact: true },
  );
  await expect(error).toBeVisible();
  await expect.poll(() => session.identityReads).toBe(2);
  expect(streams).toBe(1);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toBeVisible();
  await expect.poll(() => session.identityReads).toBe(3);
  expect(streams).toBe(2);
  expect(session.navigations).toHaveLength(0);
  await expect(page.getByTestId("live-meeting-page")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in again", exact: true }),
  ).toHaveCount(0);
});
