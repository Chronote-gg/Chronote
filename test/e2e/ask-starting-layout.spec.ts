import { test, expect, type Page } from "@playwright/test";
import { assertPageCanScroll } from "./scrollAssertions";

async function mockAsk(
  page: Page,
  submissionFails = false,
  existingConversation = false,
) {
  await page.route("**/api/csrf-token", (route) =>
    route.fulfill({ json: { csrfToken: "test-only-csrf" } }),
  );
  const conversation = {
    id: "preview-chat",
    title: "Preview question",
    summary: "Preview answer",
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
    visibility: "private",
  };
  const messages = [
    {
      id: "preview-user",
      role: "user",
      text: "Preview question",
      createdAt: conversation.createdAt,
    },
    {
      id: "preview-answer",
      role: "chronote",
      text: "Preview answer",
      createdAt: conversation.createdAt,
    },
  ];
  const data: Record<string, unknown> = {
    "auth.me": { id: "ask-preview-user", username: "Preview", avatar: null },
    "servers.listEligible": {
      guilds: [{ id: "example", name: "Engineering HQ", canManage: true }],
    },
    "servers.channels": { voiceChannels: [], textChannels: [] },
    "ask.settings": { askMembersEnabled: true, askSharingPolicy: "server" },
    "ask.listConversations": {
      conversations: existingConversation ? [conversation] : [],
    },
    "ask.startingContext": {
      coverage: {
        status: "ready",
        semanticStatus: "ready",
        ranking: "authorized_partition_order",
      },
      count: 8,
      notesCount: 6,
      meetings: [
        {
          id: "planning",
          title: "Product planning",
          timestamp: "2026-11-16T14:00:00Z",
        },
        {
          id: "team",
          title: "Weekly team catch-up",
          timestamp: "2026-11-15T14:00:00Z",
        },
        {
          id: "launch",
          title: "Launch review",
          timestamp: "2026-11-14T14:00:00Z",
        },
      ],
    },
    "ask.startRun": {
      runId: "preview-run",
      requestId: "preview-request",
      status: "completed",
      text: "Preview answer",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      result: {
        conversationId: conversation.id,
        answer: "Preview answer",
        conversation,
        messages,
      },
      conversationId: conversation.id,
      answer: "Preview answer",
      conversation,
      messages,
    },
    "ask.searchMeetings": {
      hits: [
        {
          meeting: { serverId: "example", id: "older" },
          title: "Earlier planning",
          startedAt: "2025-01-01T14:00:00Z",
        },
      ],
      nextCursor: null,
      coverage: { status: "partial", semanticStatus: "partial" },
    },
    "ask.getConversation": { conversation, messages },
  };
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/trpc/")[1],
    ).split(",");
    if (paths.includes("ask.startRun"))
      expect(Object.values(route.request().postDataJSON())[0]).toMatchObject({
        contextMeetingIds: ["planning"],
      });
    await route.fulfill({
      json: paths.map((path) =>
        submissionFails && path === "ask.startRun"
          ? {
              error: {
                message: "Preview: question could not be sent",
                code: -32603,
                data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
              },
            }
          : { result: { data: data[path] ?? null } },
      ),
    });
  });
}

test("selected Ask context does not cross browser conversation navigation", async ({
  page,
}) => {
  await mockAsk(page, false, true);
  await page.goto("/portal/server/example/ask");
  await expect(page.getByTestId("ask-title")).toHaveText("Preview question");
  await page.getByTestId("ask-new").click();
  await page.getByRole("button", { name: "Add to context" }).first().click();
  const chipCopy = page.getByText(
    "Included with your next question as meeting context",
  );
  await expect(chipCopy).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("ask-title")).toHaveText("Preview question");
  await expect(chipCopy).not.toBeVisible();
  await page.goForward();
  await expect(page.getByTestId("ask-title")).toHaveText("Preview question");
  await expect(chipCopy).not.toBeVisible();
});

for (const viewport of [
  { width: 1366, height: 600 },
  { width: 390, height: 844 },
]) {
  test(`Ask starting layout ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAsk(page);
    await page.goto("/portal/server/example/ask");
    await expect(
      page.getByRole("button", { name: "Add to context" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ask-input")).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("ask-send")).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "Add to context" }).first(),
    ).toBeInViewport({ ratio: 1 });
    const messages = page
      .getByTestId("ask-messages")
      .locator("[data-scrollarea-viewport]");
    if (viewport.width < 1000)
      await page.setViewportSize({ width: viewport.width, height: 640 });
    await assertPageCanScroll(page, messages);
    await page.setViewportSize(viewport);
    if (viewport.width < 1000) {
      await page.getByRole("button", { name: "Chats", exact: true }).click();
      await expect(
        page.getByRole("dialog").getByTestId("ask-search"),
      ).toBeVisible();
      await page.getByRole("dialog").getByTestId("ask-new").click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      await expect(page.getByTestId("ask-input")).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({
      path: `test-results/ask-starting-${viewport.width}-${viewport.height}.png`,
    });
    if (process.env.PW_VISUAL === "true")
      await expect(page).toHaveScreenshot(
        `ask-starting-${viewport.width}-${viewport.height}.png`,
        { animations: "disabled" },
      );
  });
}

for (const fails of [false, true]) {
  test(`selected Ask context ${fails ? "survives failure" : "clears after success"}`, async ({
    page,
  }) => {
    await mockAsk(page, fails);
    await page.goto("/portal/server/example/ask");
    await page.getByRole("button", { name: "Add to context" }).first().click();
    const chipCopy = page.getByText(
      "Included with your next question as meeting context",
    );
    await expect(chipCopy).toBeVisible();
    await expect(page.getByTestId("ask-input")).toHaveValue("");
    await page.getByRole("button", { name: "Decisions", exact: true }).click();
    await expect(page.getByTestId("ask-input")).toHaveValue(
      "What decisions were made in our meetings?",
    );
    await expect(page.getByText("Preview answer", { exact: true })).toHaveCount(
      0,
    );
    await page.getByTestId("ask-input").fill("Preview question");
    await page.getByTestId("ask-send").click();
    if (fails) {
      await expect(
        page.getByText("Preview: question could not be sent", { exact: true }),
      ).toBeVisible();
      await expect(chipCopy).toBeVisible();
      await expect(page.getByTestId("ask-input")).toHaveValue(
        "Preview question",
      );
    } else {
      await expect(
        page.getByText("Preview answer", { exact: true }).first(),
      ).toBeVisible();
      await expect(chipCopy).not.toBeVisible();
      await expect(page.getByTestId("ask-input")).toHaveValue("");
    }
  });
}

test("full meeting search adds older context while keeping the question and page", async ({
  page,
}) => {
  await mockAsk(page);
  await page.goto("/portal/server/example/ask");
  await page.getByTestId("ask-input").fill("Keep this draft");
  await page
    .getByRole("button", { name: "Add meeting context", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Find meeting context" })
    .fill("earlier");
  await expect(
    page.getByRole("dialog").getByText("Earlier planning", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("note")).toContainText(
    "Some accessible meetings may be missing",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add to context", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("ask-input")).toHaveValue("Keep this draft");
  await expect(page).toHaveURL(/\/portal\/server\/example\/ask$/);
});
