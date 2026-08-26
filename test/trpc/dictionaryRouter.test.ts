import type { Request, Response } from "express";
import { getMockUser, resetMockStore } from "../../src/repositories/mockStore";
import { ensureManageGuildWithUserToken } from "../../src/services/guildAccessService";
import { generateDictionaryTeachingDrafts } from "../../src/services/dictionaryTeachingService";

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
  generateDictionaryTeachingDrafts: jest.fn(),
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

const buildCaller = (user = getMockUser()) =>
  appRouter.createCaller({
    req: { session: {} } as Request,
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
});
