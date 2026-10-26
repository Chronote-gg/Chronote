import { consumeMaximumRenewals } from "./fixtures/maximumIntroductionRenewals.js";
import { introduceProduction } from "../../scripts/deployment/introduce-production.cjs";
import { readIntroductionHistory } from "../../scripts/deployment/production-acceptance-history.cjs";
import { productionOrchestrationFixture } from "./fixtures/productionOrchestration.js";
import {
  buildReserveIntroductionAction,
  buildTransitionIntroductionAction,
  introductionActionSchema,
} from "../../src/services/productionIntroductionTransactions";
import { writeIntroduction } from "./fixtures/introductionStore";
import { putIntroductionDocument as put } from "./fixtures/introductionStore";
jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  execFileSync: jest.fn((_file, args) =>
    args[0] === "rev-parse" ? "a".repeat(40) : "",
  ),
}));
test.each(["normal", "repair"])(
  "actual native %s journal supplies typed historical handoff, with missing facts refused",
  async (path) => {
    const f = await productionOrchestrationFixture({ recordingDuration: 300 });
    consumeMaximumRenewals(f);
    Object.assign(f.options, { nowMilliseconds: () => f.state.time * 1000 });
    f.state.timed = true;
    if (path === "repair") {
      f.state.failReady = true;
      await expect(
        introduceProduction(f.options, "introduce"),
      ).rejects.toThrow();
      f.state.failReady = false;
    }
    await introduceProduction(
      f.options,
      path === "normal" ? "introduce" : "continue",
    );
    const input = {
      binding: f.binding,
      control: await f.read({ pk: "ENV", sk: "CONTROL" }),
      fixtureAuthority: await f.read({
        pk: "INTRODUCTION#intro",
        sk: "FIXTURE_COORDINATOR",
      }),
    };
    const result = await readIntroductionHistory(
      input,
      { read: f.read },
      f.state.time,
    );
    expect(result.entries.length).toBe(path === "normal" ? 95 : 107);
    expect(Date.parse(result.handoffAt)).toBeGreaterThanOrEqual(
      f.m.validFrom * 1000,
    );
    expect(result.retiredAt).toBeGreaterThanOrEqual(
      Date.parse(result.handoffAt) / 1000,
    );
    const awaitableHold = await f.read({ pk: "ENV", sk: "INTRODUCTION" });
    const observed = result.promotion;
    expect(() =>
      introductionActionSchema.parse({
        ...observed,
        expiresAt: f.state.time + 1,
      }),
    ).toThrow();
    for (const phase of ["reserved", "submitted", "acknowledged", "observed"])
      expect(() =>
        buildTransitionIntroductionAction({
          hold: awaitableHold,
          authority: result.authority,
          previous: observed,
          next: { ...observed, phase },
          now: f.state.time,
          tables: { deploymentControl: f.m.resources.tables.deploymentControl },
        }),
      ).toThrow();
    const base = Object.fromEntries(
      Object.entries(observed).filter(
        ([key]) =>
          ![
            "acknowledgment",
            "acknowledgedAt",
            "acknowledgedAtMilliseconds",
            "observation",
            "observedAt",
            "attemptId",
            "submittedAt",
          ].includes(key),
      ),
    );
    const reserved = introductionActionSchema.parse({
      ...base,
      phase: "reserved",
      version: 1,
    });
    await expect(
      writeIntroduction(
        buildReserveIntroductionAction({
          hold: awaitableHold,
          authority: result.authority,
          action: reserved,
          now: f.state.time,
          tables: { deploymentControl: f.m.resources.tables.deploymentControl },
        }),
      ),
    ).rejects.toThrow();
    expect(await f.read({ pk: observed.pk, sk: observed.sk })).toEqual(
      observed,
    );
    const key = { pk: result.promotion.pk, sk: result.promotion.sk };
    const broken = structuredClone(result.promotion);
    delete broken.acknowledgment.facts;
    await put(f.m.resources.tables.deploymentControl, broken);
    await expect(
      readIntroductionHistory(input, { read: f.read }, f.state.time),
    ).rejects.toThrow();
    expect(await f.read(key)).toMatchObject({ phase: "observed" });
  },
);

test("oversized initial retained metadata refuses before acquiring holds or stopping legacy", async () => {
  const f = await productionOrchestrationFixture();
  f.options.scan = async (_operation, input) => ({
    Items:
      input.TableName === f.m.resources.tables.meetingHistory
        ? [0, 1].map((n) => ({
            guildId: { S: "retained" },
            channelId_timestamp: { S: String(n) },
            status: { S: "complete" },
          }))
        : [],
  });
  await expect(introduceProduction(f.options, "introduce")).rejects.toThrow(
    "acceptance_capacity_refused",
  );
  expect(f.state.writes).toEqual([]);
  expect(await f.read({ pk: "ENV", sk: "INTRODUCTION" })).toBeUndefined();
  expect(f.service.desiredCount).toBe(1);
});
