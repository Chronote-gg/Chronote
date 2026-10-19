import { introduceProduction } from "../../scripts/deployment/introduce-production.cjs";
import { productionOrchestrationFixture } from "./fixtures/productionOrchestration.js";
jest.mock("node:child_process", () => ({
  ...jest.requireActual("node:child_process"),
  execFileSync: jest.fn((_file, args) =>
    args[0] === "rev-parse" ? "a".repeat(40) : "",
  ),
}));
test.each(["normal", "repaired"])(
  "thin %s entrypoint preserves actual native lineage through fixture handoff",
  async (path) => {
    const f = await productionOrchestrationFixture();
    f.state.timed = true;
    if (path === "repaired") {
      f.state.failReady = true;
      await expect(introduceProduction(f.options, "introduce")).rejects.toThrow(
        "known readiness failure",
      );
      expect(
        (
          await f.read({
            pk: "INTRODUCTION#intro",
            sk: "ACTION#bootstrap-launch",
          })
        )?.phase,
      ).toBe("observed");
      f.state.failReady = false;
    }
    const result = await introduceProduction(
      f.options,
      path === "normal" ? "introduce" : "continue",
    );
    expect(result).toMatchObject({
      status: "fixture_handoff_complete",
      admission: "held",
      deployment: "held",
      acceptance: "pending",
    });
    const ctl = await f.read({ pk: "ENV", sk: "CONTROL" });
    expect(ctl).toMatchObject({
      coordinatorEpoch: path === "normal" ? 2 : 3,
      servingGeneration: 2,
      deployment: { phase: "complete" },
    });
    const slot = path === "normal" ? "bootstrap" : "replacement";
    expect(
      await f.read({ pk: "INTRODUCTION#intro", sk: `ACTION#${slot}-c1` }),
    ).toBeUndefined();
    expect(
      (await f.read({ pk: "INTRODUCTION#intro", sk: `ACTION#${slot}-c2` }))
        ?.predecessor.actionId,
    ).toBe(`${slot}-authorize`);
    const recording = f.state.recordings[0];
    expect(recording.endsAt - recording.startedAt).toBeGreaterThanOrEqual(180);
    expect(f.state.time - recording.endsAt).toBeGreaterThanOrEqual(300);
    const renewals = f.state.writeTimes.filter((x: { actionId: string }) =>
      x.actionId?.startsWith(`${slot}-c15`),
    );
    expect(renewals).toHaveLength(4);
    for (let i = 1; i < renewals.length; i++)
      expect(renewals[i].at - renewals[i - 1].at).toBe(120);
    expect(f.state.writes).not.toContain(`${slot}-c16`);
    expect(f.state.writes[0]).toBe("stop-service");
    expect(f.state.writes.indexOf("maintenance")).toBeGreaterThan(
      f.state.writes.indexOf("stop-service"),
    );
    if (path === "repaired")
      expect(f.state.writes.indexOf("replacement-launch")).toBeGreaterThan(
        f.state.writes.indexOf("stop-failed"),
      );
  },
);
test.each([
  "stop-service",
  "maintenance",
  "bootstrap-launch",
  "bootstrap-promote",
  "bootstrap-c0",
  "bootstrap-c2",
  "bootstrap-c4",
  "bootstrap-c9",
  "bootstrap-c14",
])(
  "thin entrypoint retains unknown %s ACK and refuses next mutation on restart/continuation",
  async (id) => {
    const f = await productionOrchestrationFixture();
    f.state.lose = id;
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    expect(
      (await f.read({ pk: "INTRODUCTION#intro", sk: `ACTION#${id}` }))?.phase,
    ).toBe("submitted");
    const writes = f.state.writes.length;
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    await expect(introduceProduction(f.options, "continue")).rejects.toThrow();
    expect(f.state.writes).toHaveLength(writes);
  },
);
test("missing topology prerequisite refuses before hold or stop", async () => {
  const f = await productionOrchestrationFixture();
  f.service.loadBalancers = [];
  await expect(introduceProduction(f.options, "introduce")).rejects.toThrow(
    "topology_prerequisite",
  );
  expect(f.state.writes).toEqual([]);
  expect(await f.read({ pk: "ENV", sk: "INTRODUCTION" })).toBeUndefined();
});

test("same-run warming continuation preserves active original fixture and resumes exact candidate without reacquiring", async () => {
  const f = await productionOrchestrationFixture();
  f.state.timed = true;
  f.state.pauseWarming = true;
  await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
  const before = await f.read({ pk: "ENV", sk: "CONTROL" });
  expect(before?.deployment.phase).toBe("warming");
  const old = await f.read({ pk: "ENV", sk: "RUNTIME#bootstrap" });
  expect(old?.role).toBe("serving");
  expect(old?.retirementRequest).toBeUndefined();
  expect(
    Object.values(old!.workCounts as Record<string, number>).some((n) => n > 0),
  ).toBe(true);
  const writes = [...f.state.writes];
  await expect(
    introduceProduction(f.options, "continue"),
  ).resolves.toMatchObject({
    status: "fixture_handoff_complete",
    admission: "held",
  });
  const after = await f.read({ pk: "ENV", sk: "CONTROL" });
  expect(after?.coordinatorEpoch).toBe(before?.coordinatorEpoch);
  expect(
    f.state.writes.filter((id: string) => id === "bootstrap-c0"),
  ).toHaveLength(1);
  expect(
    f.state.writes.filter((id: string) => id === "bootstrap-c4"),
  ).toHaveLength(1);
  expect(f.state.writes.slice(writes.length)).not.toContain("replace-control");
});
test("expired original warming lease refuses continuation without mutation or forced retirement", async () => {
  const f = await productionOrchestrationFixture();
  f.state.pauseWarming = true;
  await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
  const ctl = await f.read({ pk: "ENV", sk: "CONTROL" });
  f.state.time = ctl!.coordinatorExpiresAt;
  const writes = f.state.writes.length;
  await expect(introduceProduction(f.options, "continue")).rejects.toThrow();
  expect(f.state.writes).toHaveLength(writes);
  expect(
    (await f.read({ pk: "ENV", sk: "RUNTIME#bootstrap" }))?.retirementRequest,
  ).toBeUndefined();
});

test.each(["persistence", "final-read"])(
  "lease expiry during %s blocks fixture launch at actual dispatch",
  async (boundary) => {
    const f = await productionOrchestrationFixture();
    if (boundary === "persistence") f.state.expireOnSubmitted = "bootstrap-c4";
    else f.state.expireAfterControlRead = "bootstrap-c4";
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    expect(
      (await f.read({ pk: "INTRODUCTION#intro", sk: "ACTION#bootstrap-c4" }))
        ?.phase,
    ).toBe("submitted");
    expect(f.state.writes).not.toContain("bootstrap-c4");
    expect(
      f.state.tasks.some((t: { slot: string }) => t.slot === "handoff"),
    ).toBe(false);
    expect(
      (await f.read({ pk: "ENV", sk: "RUNTIME#bootstrap" }))?.retirementRequest,
    ).toBeUndefined();
  },
);
test.each(["retirement", "launch"])(
  "slow known-ACK replacement %s cannot force or replay after lease expiry",
  async (stage) => {
    const f = await productionOrchestrationFixture();
    f.state.failReady = true;
    await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
    f.state.failReady = false;
    if (stage === "retirement") f.state.delayFailedRetirement = 181;
    else f.state.delayReplacementLaunch = 181;
    await expect(introduceProduction(f.options, "continue")).rejects.toThrow();
    const known =
      stage === "retirement" ? "retire-failed" : "replacement-launch";
    expect(
      (await f.read({ pk: "INTRODUCTION#intro", sk: `ACTION#${known}` }))
        ?.phase,
    ).toBe(stage === "retirement" ? "acknowledged" : "observed");
    expect(f.state.writes).not.toContain(
      stage === "retirement" ? "stop-failed" : "replacement-promote",
    );
    const writes = f.state.writes.length;
    await expect(introduceProduction(f.options, "continue")).rejects.toThrow();
    expect(f.state.writes).toHaveLength(writes);
    expect(
      (await f.read({ pk: "ENV", sk: "INTRODUCTION" }))?.admission.state,
    ).toBe("held");
  },
);

test("known coordinator direct ACK remains recorded when original lease expires before response returns", async () => {
  const f = await productionOrchestrationFixture();
  f.state.expireAfterDirectAck = "bootstrap-c2";
  await expect(introduceProduction(f.options, "introduce")).rejects.toThrow();
  expect(
    (await f.read({ pk: "INTRODUCTION#intro", sk: "ACTION#bootstrap-c2" }))
      ?.phase,
  ).toBe("observed");
  expect(
    f.state.writes.filter((id: string) => id === "bootstrap-c2"),
  ).toHaveLength(1);
  expect(f.state.writes).not.toContain("bootstrap-c3");
  expect(
    (await f.read({ pk: "ENV", sk: "INTRODUCTION" }))?.admission.state,
  ).toBe("held");
});
