/** @jest-environment node */
import {
  applyRecoveryDiscordPublication as apply,
  reconcileRecoveryDiscordPublication as reconcile,
  previewRecoveryDiscordPublication,
  publicationDigest,
  publicationMessageFingerprint,
  digest,
  type PublicationClaim,
  type PublicationReceipt,
  type PublicationDependencies,
} from "../../src/services/recoveryDiscordPublication";
import { DiscordMessageHttpError } from "../../src/services/discordMessageEditor";
import { fixture, input } from "./recoveryDiscordPublication.fixture";

function setup(two = false) {
  const f = fixture(two ? "Текст. ".repeat(800) : undefined);
  if (two) {
    f.history.notesMessageIds.push("401");
    const first = f.messages.get("400")!;
    first.embeds[0].title = "Meeting Notes (part 1/2)";
    f.messages.set("401", {
      ...structuredClone(first),
      id: "401",
      embeds: [{ ...first.embeds[0], title: "Meeting Notes (part 2/2)" }],
    });
  }
  let revision = 0;
  const receipts = new Map<
    string,
    { value: PublicationReceipt; etag: string }
  >();
  const claims = new Map<string, { value: PublicationClaim; etag: string }>();
  const events: string[] = [];
  const storage = {
    savePreview: jest.fn(async () => {}),
    readReceipt: jest.fn(async (key: string) =>
      structuredClone(receipts.get(key) ?? null),
    ),
    readClaim: jest.fn(async (key: string) =>
      structuredClone(claims.get(key) ?? null),
    ),
    saveReceipt: jest.fn(
      async ({
        key,
        receipt,
        condition,
      }: Parameters<PublicationDependencies["storage"]["saveReceipt"]>[0]) => {
        const old = receipts.get(key);
        if (condition.kind === "absent" ? old : old?.etag !== condition.etag)
          throw new Error("precondition");
        const etag = String(++revision);
        receipts.set(key, { value: structuredClone(receipt), etag });
        events.push(
          `receipt:${receipt.messages.map((m) => m.state).join(",")}`,
        );
        return etag;
      },
    ),
    writeClaim: jest.fn(
      async ({
        key,
        claim,
        condition,
      }: Parameters<PublicationDependencies["storage"]["writeClaim"]>[0]) => {
        const old = claims.get(key);
        if (condition.kind === "absent" ? old : old?.etag !== condition.etag)
          throw new Error("precondition");
        const etag = String(++revision);
        claims.set(key, { value: structuredClone(claim), etag });
        events.push(`claim:${claim.state}`);
        return etag;
      },
    ),
  } satisfies PublicationDependencies["storage"];
  const editEmbeds = jest.fn(
    async ({
      messageId,
      embeds,
    }: Parameters<PublicationDependencies["discord"]["editEmbeds"]>[0]) => {
      const owner = [...claims.values()][0].value.runId;
      const intent = [...receipts.values()].find(
        (saved) => saved.value.runId === owner,
      )!.value;
      expect(
        intent.messages.find((m) => m.messageId === messageId)?.state,
      ).toBe("submitted");
      expect([...claims.values()][0].value.runId).toBe(intent.runId);
      events.push(`patch:${messageId}`);
      f.messages.get(messageId)!.embeds = structuredClone(embeds);
      return "acknowledged" as "acknowledged" | "missing";
    },
  );
  const getMessage = jest.fn(
    async ({ messageId }: { channelId: string; messageId: string }) => {
      events.push(`get:${messageId}`);
      return structuredClone(f.messages.get(messageId) ?? null);
    },
  );
  const deps = {
    ...f.deps,
    storage,
    discord: { ...f.deps.discord, editEmbeds, getMessage },
  };
  const preview = () => previewRecoveryDiscordPublication(input, deps);
  return { ...f, deps, storage, receipts, claims, events, preview };
}

test("persists intent, preflights every target, preserves fields and reads each edit back", async () => {
  const f = setup(true);
  const preview = await f.preview();
  expect(preview.kind).toBe("ready");
  f.events.length = 0;
  const receipt = await apply(preview, f.deps);
  expect(receipt.status).toBe("verified");
  expect(receipt.messages.map((m) => m.state)).toEqual([
    "verified",
    "verified",
  ]);
  const firstPatch = f.events.indexOf("patch:400");
  expect(f.events.slice(0, firstPatch)).toEqual(
    expect.arrayContaining(["get:400", "get:401", "receipt:submitted,pending"]),
  );
  expect(f.events.slice(firstPatch + 1)).toContain("get:400");
  expect(f.messages.get("400")?.components).toEqual(
    preview.targets[0].before.components,
  );
  expect(f.messages.get("400")?.embeds).toEqual(preview.targets[0].afterEmbeds);
  expect([...f.claims.values()][0].value.state).toBe("terminal");
});

test("verified rerun reads only and rechecks final history", async () => {
  const f = setup();
  const preview = await f.preview();
  await apply(preview, f.deps);
  f.deps.discord.editEmbeds.mockClear();
  f.storage.saveReceipt.mockClear();
  f.storage.writeClaim.mockClear();
  f.storage.savePreview.mockClear();
  const before = f.deps.readHistory.mock.calls.length;
  expect((await apply(preview, f.deps)).status).toBe("verified");
  expect(f.deps.readHistory.mock.calls.length).toBeGreaterThan(before);
  expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
  expect(f.storage.saveReceipt).not.toHaveBeenCalled();
  expect(f.storage.writeClaim).not.toHaveBeenCalled();
  expect(f.storage.savePreview).not.toHaveBeenCalled();
});

test("rejects saved arbitrary edits even with recomputed digest", async () => {
  const f = setup();
  const preview = await f.preview();
  const target = preview.targets[0];
  target.afterEmbeds[0].description = "Unapproved";
  target.afterEmbedsDigest = digest(target.afterEmbeds);
  target.afterFingerprint = publicationMessageFingerprint({
    ...target.before,
    embeds: target.afterEmbeds,
  });
  target.changes = [
    {
      embedIndex: 0,
      before: target.before.embeds[0],
      after: target.afterEmbeds[0],
    },
  ];
  preview.previewDigest = publicationDigest(preview);
  await expect(apply(preview, f.deps)).rejects.toThrow();
  expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
  expect(f.storage.writeClaim).not.toHaveBeenCalled();
});

test("rejects a changed digest", async () => {
  const f = setup();
  const preview = await f.preview();
  preview.createdAt = "2026-02-01T00:00:00.000Z";
  await expect(apply(preview, f.deps)).rejects.toThrow();
  expect(f.storage.writeClaim).not.toHaveBeenCalled();
});

test("final-target preflight failure stops all edits", async () => {
  const f = setup(true);
  const preview = await f.preview();
  f.messages.get("401")!.content = "changed";
  const result = await apply(preview, f.deps);
  expect(result.status).not.toBe("verified");
  expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
});

test("changed next post stops after first verified edit", async () => {
  const f = setup(true);
  const preview = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockImplementation(async (args) => {
    const result = await edit(args);
    f.messages.get("401")!.content = "new control text";
    return result;
  });
  const result = await apply(preview, f.deps);
  expect(result.status).toBe("partial");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test("stored version changing between edits is superseded", async () => {
  const f = setup(true);
  const preview = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockImplementation(async (args) => {
    const result = await edit(args);
    f.history.notesVersion++;
    return result;
  });
  const result = await apply(preview, f.deps);
  expect(result.status).toBe("superseded");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test("final history change prevents synchronization claim", async () => {
  const f = setup();
  const preview = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockImplementation(async (args) => {
    const result = await edit(args);
    f.history.notesVersion++;
    return result;
  });
  expect((await apply(preview, f.deps)).status).toBe("superseded");
});

test.each([true, false])(
  "lost PATCH acknowledgment, readback matches=%s",
  async (matches) => {
    const f = setup(true);
    const preview = await f.preview();
    const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
    f.deps.discord.editEmbeds.mockImplementation(async (args) => {
      if (matches) await edit(args);
      throw new Error("timeout");
    });
    const result = await apply(preview, f.deps);
    expect(result.messages[0].state).toBe(matches ? "verified" : "uncertain");
    expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
    if (!matches) {
      expect(result.status).toBe("uncertain");
      await expect(apply(preview, f.deps)).rejects.toThrow();
      expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
    }
  },
);

test("readback failure after acknowledged edit remains uncertain", async () => {
  const f = setup();
  const preview = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockImplementation(async (args) => {
    const result = await edit(args);
    f.deps.discord.getMessage.mockRejectedValue(new Error("offline"));
    return result;
  });
  expect((await apply(preview, f.deps)).status).toBe("uncertain");
});

test.each([400, 401, 403, 404, 429])(
  "known rejection %s is failed",
  async (status) => {
    const f = setup();
    const preview = await f.preview();
    f.deps.discord.editEmbeds.mockRejectedValue(
      new DiscordMessageHttpError("edit", status),
    );
    expect((await apply(preview, f.deps)).messages[0].state).toBe("failed");
  },
);

test("5xx acknowledgment is uncertain", async () => {
  const f = setup();
  const preview = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(
    new DiscordMessageHttpError("edit", 500),
  );
  expect((await apply(preview, f.deps)).status).toBe("uncertain");
});

async function expectAcknowledgementOutcome(
  f: ReturnType<typeof setup>,
  persisted: boolean,
) {
  const preview = await f.preview();
  if (persisted) expect((await apply(preview, f.deps)).status).toBe("verified");
  else {
    await expect(apply(preview, f.deps)).rejects.toThrow();
    expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
  }
}

test.each([true, false])(
  "lost claim acknowledgment persisted=%s",
  async (persisted) => {
    const f = setup();
    const write = f.storage.writeClaim.getMockImplementation()!;
    f.storage.writeClaim.mockImplementationOnce(async (args) => {
      if (persisted) await write(args);
      throw new Error("lost acknowledgment");
    });
    await expectAcknowledgementOutcome(f, persisted);
  },
);

test.each([true, false])(
  "lost intent acknowledgment persisted=%s",
  async (persisted) => {
    const f = setup();
    const save = f.storage.saveReceipt.getMockImplementation()!;
    f.storage.saveReceipt.mockImplementation(async (args) => {
      if (args.receipt.messages[0].state === "submitted") {
        if (persisted) await save(args);
        throw new Error("lost acknowledgment");
      }
      return save(args);
    });
    await expectAcknowledgementOutcome(f, persisted);
  },
);

test("receipt save failure after edit stops further PATCH and retains durable submitted intent", async () => {
  const f = setup(true);
  const preview = await f.preview();
  const save = f.storage.saveReceipt.getMockImplementation()!;
  f.storage.saveReceipt.mockImplementation(async (args) => {
    if (args.receipt.messages[0].state === "verified")
      throw new Error("storage down");
    return save(args);
  });
  await expect(apply(preview, f.deps)).rejects.toThrow();
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
  expect([...f.receipts.values()][0].value.messages[0].state).toBe("submitted");
  expect([...f.claims.values()][0].value.state).toBe("running");
});

test("concurrent applies cannot both own the claim", async () => {
  const f = setup();
  const preview = await f.preview();
  await Promise.allSettled([apply(preview, f.deps), apply(preview, f.deps)]);
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test("reconcile verifies late success without writing Discord and requires exact stopped-run assertion", async () => {
  const f = setup();
  const preview = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
  const uncertain = await apply(preview, f.deps);
  f.messages.get("400")!.embeds = preview.targets[0].afterEmbeds;
  const result = await reconcile(preview, f.deps);
  expect(result.messages[0].state).toBe("verified");
  expect(result.status).toBe("running");
  expect(result.messages[0].reason).toContain(uncertain.runId);
  expect([...f.claims.values()][0].value.state).toBe("running");
  await expect(
    reconcile(preview, f.deps, { confirmRunStopped: "wrong" }),
  ).rejects.toThrow();
  await reconcile(preview, f.deps, { confirmRunStopped: uncertain.runId });
  expect([...f.claims.values()][0].value.state).toBe("terminal");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test("operator assertion never clears a still-uncertain request", async () => {
  const f = setup();
  const preview = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
  const result = await apply(preview, f.deps);
  expect(
    (await reconcile(preview, f.deps, { confirmRunStopped: result.runId }))
      .status,
  ).toBe("uncertain");
  expect([...f.claims.values()][0].value.state).toBe("running");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});
test("reconcile classifies a changed stored version without clearing unresolved requests", async () => {
  const f = setup();
  const preview = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
  const prior = await apply(preview, f.deps);
  f.history.notesVersion++;
  const result = await reconcile(preview, f.deps, {
    confirmRunStopped: prior.runId,
  });
  expect(result.status).toBe("superseded");
  expect(result.messages[0].state).toBe("uncertain");
  expect([...f.claims.values()][0].value.state).toBe("running");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});
test("different previews of the same version contend on one non-expiring claim", async () => {
  const f = setup();
  const first = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
  await apply(first, f.deps);
  f.deps.now = () => "2036-01-01T00:00:00.000Z";
  const later = await f.preview();
  expect(later.previewDigest).not.toBe(first.previewDigest);
  expect(later.binding?.claimKey).toBe(first.binding?.claimKey);
  await expect(apply(later, f.deps)).rejects.toThrow("claim");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test.each(["claim", "receipt"])(
  "terminal claim cannot hide unresolved intent in %s",
  async (field) => {
    const f = setup();
    const first = await f.preview();
    f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
    await apply(first, f.deps);
    const saved = [...f.claims.values()][0];
    saved.value.state = "terminal";
    if (field === "receipt") saved.value.unresolvedMessageIds = [];
    f.deps.now = () => "2026-01-03T00:00:00.000Z";
    await expect(apply(await f.preview(), f.deps)).rejects.toThrow();
    expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
  },
);

test("fresh preview may replace a terminal definitively failed run using its ETag", async () => {
  const f = setup();
  const first = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockRejectedValueOnce(
    new DiscordMessageHttpError("edit", 403),
  );
  expect((await apply(first, f.deps)).status).toBe("failed");
  f.deps.discord.editEmbeds.mockImplementation(edit);
  f.deps.now = () => "2026-01-03T00:00:00.000Z";
  expect((await apply(await f.preview(), f.deps)).status).toBe("verified");
  expect(
    f.storage.writeClaim.mock.calls.some(
      ([args]) => args.condition.kind === "match",
    ),
  ).toBe(true);
});

test("all matching targets are skipped without PATCH", async () => {
  const f = setup();
  const first = await f.preview();
  f.messages.get("400")!.embeds = first.targets[0].afterEmbeds;
  expect((await apply(first, f.deps)).status).toBe("verified");
  expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
});

test("reconciliation rejects a forged desired target even with a new digest", async () => {
  const f = setup();
  const preview = await f.preview();
  f.deps.discord.editEmbeds.mockRejectedValue(new Error("timeout"));
  await apply(preview, f.deps);
  preview.targets[0].afterFingerprint = "a".repeat(64);
  preview.previewDigest = publicationDigest(preview);
  await expect(reconcile(preview, f.deps)).rejects.toThrow();
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});
test("reconcile closes a claim abandoned before its initial receipt only with stopped-run confirmation", async () => {
  const f = setup();
  const preview = await f.preview();
  f.storage.saveReceipt.mockRejectedValueOnce(new Error("not saved"));
  await expect(apply(preview, f.deps)).rejects.toThrow();
  const runId = [...f.claims.values()][0].value.runId;
  await reconcile(preview, f.deps);
  expect([...f.claims.values()][0].value.state).toBe("running");
  await reconcile(preview, f.deps, { confirmRunStopped: runId });
  expect([...f.claims.values()][0].value.state).toBe("terminal");
  expect(f.deps.discord.editEmbeds).not.toHaveBeenCalled();
});

test("verified rerun reports superseded after a later stored edit and writes nothing", async () => {
  const f = setup();
  const preview = await f.preview();
  await apply(preview, f.deps);
  f.history.notesVersion++;
  f.storage.saveReceipt.mockClear();
  f.storage.writeClaim.mockClear();
  expect((await apply(preview, f.deps)).status).toBe("superseded");
  expect(f.storage.saveReceipt).not.toHaveBeenCalled();
  expect(f.storage.writeClaim).not.toHaveBeenCalled();
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});
test("a failed final history read reports unverified, not superseded or synchronized", async () => {
  const f = setup();
  const preview = await f.preview();
  const edit = f.deps.discord.editEmbeds.getMockImplementation()!;
  f.deps.discord.editEmbeds.mockImplementation(async (args) => {
    const result = await edit(args);
    f.deps.readHistory.mockRejectedValue(new Error("history unavailable"));
    return result;
  });
  const result = await apply(preview, f.deps);
  expect(result.status).toBe("partial");
  expect(result.messages[0].reason).toContain("unverified");
});
test("verified rerun reports a running claim after final claim persistence fails", async () => {
  const f = setup();
  const preview = await f.preview();
  const write = f.storage.writeClaim.getMockImplementation()!;
  f.storage.writeClaim.mockImplementation(async (args) => {
    if (args.claim.state === "terminal")
      throw new Error("terminal claim not saved");
    return write(args);
  });
  await expect(apply(preview, f.deps)).rejects.toThrow(
    "Claim ownership is unproven",
  );
  const saved = [...f.receipts.values()][0].value;
  expect(saved.status).toBe("verified");
  expect([...f.claims.values()][0].value.state).toBe("running");
  f.storage.saveReceipt.mockClear();
  f.storage.writeClaim.mockClear();
  f.storage.savePreview.mockClear();
  const rerun = await apply(preview, f.deps);
  expect(rerun.status).toBe("running");
  expect(rerun.messages[0].reason).toContain(saved.runId);
  expect(f.storage.saveReceipt).not.toHaveBeenCalled();
  expect(f.storage.writeClaim).not.toHaveBeenCalled();
  expect(f.storage.savePreview).not.toHaveBeenCalled();
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
  f.storage.writeClaim.mockImplementation(write);
  expect(
    (await reconcile(preview, f.deps, { confirmRunStopped: saved.runId }))
      .status,
  ).toBe("verified");
  expect([...f.claims.values()][0].value.state).toBe("terminal");
  expect((await apply(preview, f.deps)).status).toBe("verified");
  expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
});

test.each(["missing", "unreadable", "otherRun", "otherPreview", "unresolved"])(
  "verified rerun rejects %s claim evidence without writes",
  async (evidence) => {
    const f = setup();
    const preview = await f.preview();
    await apply(preview, f.deps);
    const claim = [...f.claims.values()][0].value;
    if (evidence === "missing") f.claims.clear();
    if (evidence === "unreadable")
      f.storage.readClaim.mockRejectedValue(new Error("claim unavailable"));
    if (evidence === "otherRun") claim.runId = "other-run";
    if (evidence === "otherPreview") claim.previewDigest = "a".repeat(64);
    if (evidence === "unresolved") claim.unresolvedMessageIds = ["400"];
    f.storage.saveReceipt.mockClear();
    f.storage.writeClaim.mockClear();
    f.storage.savePreview.mockClear();
    await expect(apply(preview, f.deps)).rejects.toThrow();
    expect(f.storage.saveReceipt).not.toHaveBeenCalled();
    expect(f.storage.writeClaim).not.toHaveBeenCalled();
    expect(f.storage.savePreview).not.toHaveBeenCalled();
    expect(f.deps.discord.editEmbeds).toHaveBeenCalledTimes(1);
  },
);
