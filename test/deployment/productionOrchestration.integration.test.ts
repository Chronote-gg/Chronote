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
