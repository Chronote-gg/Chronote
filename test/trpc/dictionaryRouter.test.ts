import type { Request, Response } from "express";
import { getMockUser, resetMockStore } from "../../src/repositories/mockStore";
import { ensureManageGuildWithUserToken } from "../../src/services/guildAccessService";
import { generateDictionaryTeachingDrafts } from "../../src/services/dictionaryTeachingService";
import { upsertDictionaryEntryService } from "../../src/services/dictionaryService";
import { captureEvent } from "../../src/services/analyticsService";

const drafts = new Map<string, unknown>();
const contexts = new Map<string, unknown>();
const tokenStore = {
  getDraft: jest.fn(async (token: string) => drafts.get(token) ?? null),
  setDraft: jest.fn(async (token: string, record: unknown) => {
    drafts.set(token, record);
  }),
  deleteDraft: jest.fn(async (token: string) => {
    drafts.delete(token);
  }),
  getContext: jest.fn(async (token: string) => contexts.get(token) ?? null),
  setContext: jest.fn(async (token: string, record: unknown) => {
    contexts.set(token, record);
  }),
  deleteContext: jest.fn(async (token: string) => {
    contexts.delete(token);
  }),
};

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureUserInGuild: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));

jest.mock("../../src/services/dictionaryTeachingService", () => ({
  ...jest.requireActual("../../src/services/dictionaryTeachingService"),
  generateDictionaryTeachingDrafts: jest.fn(),
}));

jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
  shutdownAnalytics: jest.fn(),
}));

jest.mock("../../src/services/dictionaryTeachingTokenStore", () => ({
  createDictionaryTeachingTokenStore: () => tokenStore,
}));

jest.mock("../../src/services/openaiModelParams", () => ({
  resolveModelParamsForContext: jest.fn(async () => ({
    dictionaryTeaching: { samplingMode: "temperature", temperature: 0 },
  })),
  resolveChatParamsForRole: jest.fn(),
}));

jest.mock("../../src/services/modelChoiceService", () => ({
  resolveModelChoicesForContext: jest.fn(async () => ({
    dictionaryTeaching: "gpt-5-mini",
  })),
}));

jest.mock("uuid", () => {
  let index = 0;
  return {
    v4: () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
  };
});

import { appRouter } from "../../src/trpc/router";

const buildCaller = (user = getMockUser(), headers: Request["headers"] = {}) =>
  appRouter.createCaller({
    req: { session: {}, headers } as Request,
    res: { setHeader: jest.fn() } as unknown as Response,
    user,
  });

describe("dictionary teaching router", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drafts.clear();
    contexts.clear();
    resetMockStore();
    jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(true);
    jest.mocked(generateDictionaryTeachingDrafts).mockResolvedValue({
      drafts: [
        {
          draftId: "10000000-0000-4000-8000-000000000001",
          preferredTerm: "Jon Smythe",
          observedForms: ["John Smith"],
          description: "Apollo contact",
          ambiguity: null,
          evidence: [
            { source: "instruction", quote: "the exact name is Jon Smythe" },
          ],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
        promptVersion: 1,
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("requires Manage Server permission", async () => {
    jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(false);

    await expect(
      buildCaller().dictionary.previewTeaching({
        serverId: "guild-1",
        instruction: "The exact name is Jon Smythe.",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("stores an expiring editable preview without raw instruction text", async () => {
    const result = await buildCaller().dictionary.previewTeaching({
      serverId: "guild-1",
      instruction: "The exact name is Jon Smythe, not John Smith.",
    });

    expect(result.drafts[0].preferredTerm).toBe("Jon Smythe");
    expect(tokenStore.setDraft).toHaveBeenCalledTimes(1);
    const stored = tokenStore.setDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(stored).not.toHaveProperty("instruction");
    expect(stored).toMatchObject({
      guildId: "guild-1",
      requesterId: getMockUser().id,
      source: "settings",
    });
  });

  test.each([
    { headers: { dnt: "1" }, doNotTrack: false },
    { headers: {}, doNotTrack: true },
  ])(
    "does not capture teaching analytics when browser DNT is enabled",
    async ({ headers, doNotTrack }) => {
      jest.mocked(captureEvent).mockClear();
      const caller = buildCaller(getMockUser(), headers);
      const preview = await caller.dictionary.previewTeaching({
        serverId: "guild-1",
        instruction: "The exact name is Jon Smythe, not John Smith.",
        doNotTrack,
      });

      await caller.dictionary.commitTeaching({
        serverId: "guild-1",
        token: preview.token,
        doNotTrack,
        entries: [
          {
            draftId: preview.drafts[0].draftId,
            preferredTerm: preview.drafts[0].preferredTerm,
            observedForms: preview.drafts[0].observedForms,
            description: preview.drafts[0].description ?? undefined,
          },
        ],
      });

      expect(captureEvent).not.toHaveBeenCalledWith(
        "dictionary_teaching_previewed",
        expect.anything(),
      );
      expect(captureEvent).not.toHaveBeenCalledWith(
        "dictionary_teaching_committed",
        expect.anything(),
      );
      expect(captureEvent).not.toHaveBeenCalledWith(
        "dictionary_updated",
        expect.anything(),
      );
    },
  );

  test("rejects a correction context owned by another user", async () => {
    const token = "20000000-0000-4000-8000-000000000001";
    contexts.set(token, {
      guildId: "guild-1",
      requesterId: "other-user",
      expiresAtMs: Date.now() + 60_000,
      context: { source: "notes_correction" },
    });

    await expect(
      buildCaller().dictionary.previewTeaching({
        serverId: "guild-1",
        instruction: "The exact name is Jon Smythe.",
        correctionContextToken: token,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("keeps correction context available while the user revises the request", async () => {
    const token = "20000000-0000-4000-8000-000000000002";
    contexts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      context: {
        source: "notes_correction",
        notesDiff: "+ Jon Smythe",
      },
    });

    const input = {
      serverId: "guild-1",
      instruction: "The exact name is Jon Smythe.",
      correctionContextToken: token,
    };
    await buildCaller().dictionary.previewTeaching(input);
    await buildCaller().dictionary.previewTeaching(input);

    expect(tokenStore.deleteContext).not.toHaveBeenCalled();
    expect(generateDictionaryTeachingDrafts).toHaveBeenCalledTimes(2);
  });

  test("rejects commit entries that were not in the draft", async () => {
    const token = "30000000-0000-4000-8000-000000000001";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId: "10000000-0000-4000-8000-000000000001",
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    await expect(
      buildCaller().dictionary.commitTeaching({
        serverId: "guild-1",
        token,
        entries: [
          {
            draftId: "99999999-0000-4000-8000-000000000999",
            preferredTerm: "Injected term",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("commits approved edits with scoped provenance", async () => {
    const token = "40000000-0000-4000-8000-000000000001";
    const draftId = "10000000-0000-4000-8000-000000000001";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "notes_correction",
      meetingId: "channel-1#date",
      correctionId: "50000000-0000-4000-8000-000000000001",
      drafts: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: ["John Smith"],
          description: "Apollo contact",
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
        promptVersion: 1,
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: ["John Smith"],
          description: "Apollo account manager",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(result.results[0].entry).toMatchObject({
      term: "Jon Smythe",
      definition: "Apollo account manager",
      observedForms: ["John Smith"],
      lastTeaching: {
        method: "llm_assisted",
        source: "notes_correction",
        meetingId: "channel-1#date",
        approvedBy: getMockUser().id,
      },
    });
    expect(tokenStore.deleteDraft).toHaveBeenCalledWith(token);
  });

  test("returns successful writes when completed-draft cleanup fails", async () => {
    const token = "41000000-0000-4000-8000-000000000001";
    const draftId = "41000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });
    tokenStore.deleteDraft.mockRejectedValueOnce(
      new Error("temporary cleanup failure"),
    );
    const warn = jest.spyOn(console, "warn").mockImplementation();

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [{ draftId, preferredTerm: "Jon Smythe" }],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      entry: { term: "Jon Smythe" },
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed deleting completed dictionary teaching draft",
      expect.any(Error),
    );
  });

  test("rejects duplicate exact spellings in one approval batch", async () => {
    const token = "60000000-0000-4000-8000-000000000001";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId: "70000000-0000-4000-8000-000000000001",
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
        {
          draftId: "70000000-0000-4000-8000-000000000002",
          preferredTerm: "Jane Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
        promptVersion: 1,
      },
    });

    await expect(
      buildCaller().dictionary.commitTeaching({
        serverId: "guild-1",
        token,
        entries: [
          {
            draftId: "70000000-0000-4000-8000-000000000001",
            preferredTerm: "Jon Smythe",
            observedForms: [],
          },
          {
            draftId: "70000000-0000-4000-8000-000000000002",
            preferredTerm: " jon   smythe ",
            observedForms: [],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Each approved entry needs unique exact spelling.",
    });
  });

  test("rejects an edit that would update an unreviewed existing entry", async () => {
    const existing = await buildCaller().dictionary.upsert({
      serverId: "guild-1",
      term: "Apollo",
      definition: "Existing project",
    });
    const token = "80000000-0000-4000-8000-000000000001";
    const draftId = "80000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: "New contact",
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Apollo",
          description: "Overwritten project",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("existing entry"),
    });
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries).toContainEqual(existing.entry);
    expect(tokenStore.deleteDraft).not.toHaveBeenCalled();
  });

  test("rejects an edit that collides with another entry's observed form", async () => {
    const existing = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Apollo",
      observedForms: ["A polo"],
      userId: getMockUser().id,
    });
    const token = "82000000-0000-4000-8000-000000000001";
    const draftId = "82000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [{ draftId, preferredTerm: "A polo", observedForms: [] }],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("observed forms"),
    });
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries).toEqual([existing]);
    expect(tokenStore.deleteDraft).not.toHaveBeenCalled();
  });

  test("rejects renaming a reviewed update to an unused exact spelling", async () => {
    const existing = await buildCaller().dictionary.upsert({
      serverId: "guild-1",
      term: "Apollo",
      definition: "Existing project",
    });
    const token = "82500000-0000-4000-8000-000000000001";
    const draftId = "82500000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: [],
          description: "Existing project",
          ambiguity: null,
          evidence: [],
          action: "update",
          existingEntry: existing.entry,
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Artemis",
          description: "Renamed project",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed from the reviewed"),
    });
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries).toEqual([existing.entry]);
    expect(tokenStore.deleteDraft).not.toHaveBeenCalled();
  });

  test("allows a conflict draft to be corrected to unused exact spelling", async () => {
    const existing = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Jonathan Smythe",
      observedForms: ["Jon Smythe"],
      userId: getMockUser().id,
    });
    const token = "82600000-0000-4000-8000-000000000001";
    const draftId = "82600000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Jon Smythe",
          observedForms: [],
          description: "Apollo contact",
          ambiguity: "This spelling conflicts with an existing entry.",
          evidence: [],
          action: "conflict",
          existingEntry: existing,
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Jon Smythe Jr",
          description: "Apollo contact",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      entry: { term: "Jon Smythe Jr" },
    });
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries.map((entry) => entry.term)).toEqual([
      "Jon Smythe Jr",
      "Jonathan Smythe",
    ]);
  });

  test("rejects observed-form conflicts within one approval batch", async () => {
    const token = "82700000-0000-4000-8000-000000000001";
    const firstDraftId = "82700000-0000-4000-8000-000000000002";
    const secondDraftId = "82700000-0000-4000-8000-000000000003";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId: firstDraftId,
          preferredTerm: "Apollo",
          observedForms: ["A polo"],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
        {
          draftId: secondDraftId,
          preferredTerm: "A polo",
          observedForms: [],
          description: null,
          ambiguity: null,
          evidence: [],
          action: "create",
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId: firstDraftId,
          preferredTerm: "Apollo",
          observedForms: ["A polo"],
        },
        {
          draftId: secondDraftId,
          preferredTerm: "A polo",
          observedForms: [],
        },
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          draftId: firstDraftId,
          ok: false,
          error: expect.stringContaining("same approval batch"),
        }),
        expect.objectContaining({
          draftId: secondDraftId,
          ok: false,
          error: expect.stringContaining("same approval batch"),
        }),
      ]),
    );
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries).toEqual([]);
    expect(tokenStore.deleteDraft).not.toHaveBeenCalled();
  });

  test("rejects an update when the reviewed entry changed after preview", async () => {
    const reviewed = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Apollo",
      definition: "Reviewed description",
      userId: getMockUser().id,
    });
    const current = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Apollo",
      definition: "Concurrent admin edit",
      userId: "other-admin",
    });
    const token = "83000000-0000-4000-8000-000000000001";
    const draftId = "83000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: [],
          description: "Reviewed description",
          ambiguity: null,
          evidence: [],
          action: "update",
          existingEntry: { ...reviewed, updatedAt: "2000-01-01T00:00:00.000Z" },
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Apollo",
          description: "Stale reviewer overwrite",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed after the proposal"),
    });
    const list = await buildCaller().dictionary.list({ serverId: "guild-1" });
    expect(list.entries).toEqual([current]);
    expect(tokenStore.deleteDraft).not.toHaveBeenCalled();
  });

  test("clears an existing description when the reviewer submits an empty value", async () => {
    const existing = await buildCaller().dictionary.upsert({
      serverId: "guild-1",
      term: "Apollo",
      definition: "Existing project",
    });
    const token = "90000000-0000-4000-8000-000000000001";
    const draftId = "90000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: existing.entry.term,
          observedForms: [],
          description: existing.entry.definition,
          ambiguity: null,
          evidence: [],
          action: "update",
          existingEntry: existing.entry,
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [{ draftId, preferredTerm: "Apollo", description: "" }],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      entry: { term: "Apollo", definition: undefined },
    });
  });

  test("does not count preserved stored observed forms as reviewer edits", async () => {
    const existing = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Apollo",
      definition: "Existing project",
      observedForms: ["A polo"],
      userId: getMockUser().id,
    });
    jest.mocked(captureEvent).mockClear();
    const token = "91000000-0000-4000-8000-000000000001";
    const draftId = "91000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: [],
          description: "Existing project",
          ambiguity: null,
          evidence: [],
          action: "update",
          existingEntry: existing,
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: [],
          description: "Existing project",
        },
      ],
    });

    expect(captureEvent).toHaveBeenCalledWith(
      "dictionary_teaching_committed",
      expect.objectContaining({
        properties: expect.objectContaining({ edited_draft_count: 0 }),
      }),
    );
  });

  test("retains newly approved observed forms when an entry is at capacity", async () => {
    const existing = await upsertDictionaryEntryService({
      guildId: "guild-1",
      term: "Apollo",
      definition: "Existing project",
      observedForms: [
        "Old one",
        "Old two",
        "Old three",
        "Old four",
        "Old five",
      ],
      userId: getMockUser().id,
    });
    const token = "92000000-0000-4000-8000-000000000001";
    const draftId = "92000000-0000-4000-8000-000000000002";
    drafts.set(token, {
      guildId: "guild-1",
      requesterId: getMockUser().id,
      expiresAtMs: Date.now() + 60_000,
      source: "settings",
      drafts: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: ["New form"],
          description: "Existing project",
          ambiguity: null,
          evidence: [],
          action: "update",
          existingEntry: existing,
        },
      ],
      model: {
        model: "gpt-5-mini",
        promptName: "chronote-dictionary-teaching-chat",
      },
    });

    const result = await buildCaller().dictionary.commitTeaching({
      serverId: "guild-1",
      token,
      entries: [
        {
          draftId,
          preferredTerm: "Apollo",
          observedForms: ["New form"],
          description: "Existing project",
        },
      ],
    });

    expect(result.results[0]).toMatchObject({
      ok: true,
      entry: {
        term: "Apollo",
        observedForms: [
          "New form",
          "Old one",
          "Old two",
          "Old three",
          "Old four",
        ],
      },
    });
  });
});
