/** @jest-environment node */
import { resolveRuntimeIdentity } from "../../src/services/runtimeInstanceService";

test("metadata binds task and the current container image", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        DockerId: "container",
        ImageID: `sha256:${"a".repeat(64)}`,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        TaskARN: "arn:aws:ecs:us-east-1:123456789012:task/test/abc",
        Containers: [
          { DockerId: "sidecar", ImageID: `sha256:${"b".repeat(64)}` },
          { DockerId: "container", ImageID: `sha256:${"a".repeat(64)}` },
        ],
      }),
    );
  const identity = await resolveRuntimeIdentity({
    kind: "ecs",
    metadataUri: "http://169.254.170.2/v4/id",
    candidateId: "release",
    request,
  });
  expect(identity).toMatchObject({
    kind: "ecs",
    imageDigest: `sha256:${"a".repeat(64)}`,
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/abc",
    candidateId: "release",
  });
  expect(request.mock.calls.map((call) => call[0])).toEqual([
    "http://169.254.170.2/v4/id",
    "http://169.254.170.2/v4/id/task",
  ]);
});

test("ECS never falls back to HOSTNAME or a local identity", async () => {
  await expect(
    resolveRuntimeIdentity({
      kind: "ecs",
      metadataUri: "",
      candidateId: "release",
      request: jest.fn(),
    }),
  ).rejects.toThrow();
  await expect(
    resolveRuntimeIdentity({
      kind: "ecs",
      metadataUri: "http://agent",
      candidateId: "",
      request: jest.fn(),
    }),
  ).rejects.toThrow();
});

test("missing or mismatched image metadata fails closed", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        DockerId: "container",
        ImageID: `sha256:${"a".repeat(64)}`,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        TaskARN: "arn:aws:ecs:us-east-1:123456789012:task/test/abc",
        Containers: [
          { DockerId: "container", ImageID: `sha256:${"b".repeat(64)}` },
        ],
      }),
    );
  await expect(
    resolveRuntimeIdentity({
      kind: "ecs",
      metadataUri: "http://agent",
      candidateId: "release",
      request,
    }),
  ).rejects.toThrow();
});
