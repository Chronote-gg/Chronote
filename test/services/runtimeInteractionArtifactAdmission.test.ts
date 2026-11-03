/** @jest-environment node */
import { createArtifactAdmissionGate } from "../../src/services/artifactAdmissionGate";
import { beginRuntimeWorkClaim } from "../../src/services/runtimeWorkAdmissionService";

const mockGate = createArtifactAdmissionGate();
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: (_kind: string, producesArtifacts: boolean) => {
    const ticket = producesArtifacts ? mockGate.begin() : undefined;
    return { settle: () => ticket?.settle(), transition: jest.fn() };
  },
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));

test("sealed artifact preparation admits ordinary interactions but refuses new artifact jobs", async () => {
  await mockGate.seal();
  const interaction = beginRuntimeWorkClaim("interaction", "billing-command");
  await interaction.settle();
  expect(mockGate.active).toBe(0);
  for (const domain of ["personal", "recovery", "control"] as const)
    expect(() => beginRuntimeWorkClaim(domain, domain)).toThrow("sealed");
});
