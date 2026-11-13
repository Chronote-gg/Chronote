/** @jest-environment node */
import { config } from "../../src/services/configService";
import {
  getRuntimeInstanceId,
  resolveWorkerIdentity,
} from "../../src/services/runtimeInstanceService";

describe("worker identity", () => {
  const runtime = { ...config.runtime };
  afterEach(() => Object.assign(config.runtime, runtime));
  const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/test/abc";

  test("ECS takes the release from the task definition revision", async () => {
    config.runtime.metadataUri = "http://169.254.170.2/v4/id/";
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        Response.json({ TaskARN: taskArn, Containers: [], Revision: "42" }),
      );
    await expect(resolveWorkerIdentity(request)).resolves.toEqual({
      instanceId: getRuntimeInstanceId(),
      release: 42,
      taskArn,
    });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "http://169.254.170.2/v4/id/task",
    ]);
  });

  test.each([undefined, "latest"])(
    "ECS refuses a revision of %p",
    async (Revision) => {
      config.runtime.metadataUri = "http://169.254.170.2/v4/id";
      const request = jest
        .fn()
        .mockResolvedValueOnce(
          Response.json({ TaskARN: taskArn, Containers: [], Revision }),
        );
      await expect(resolveWorkerIdentity(request)).rejects.toThrow();
    },
  );

  test("outside ECS the configured release is used", async () => {
    config.runtime.metadataUri = "";
    config.runtime.release = 7;
    const request = jest.fn();
    await expect(resolveWorkerIdentity(request)).resolves.toEqual({
      instanceId: getRuntimeInstanceId(),
      release: 7,
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("the instance id", () => {
  const original = {
    instance: process.env.BOT_INSTANCE_ID,
    metadata: process.env.ECS_CONTAINER_METADATA_URI_V4,
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore("BOT_INSTANCE_ID", original.instance);
    restore("ECS_CONTAINER_METADATA_URI_V4", original.metadata);
  });
  const isolatedInstanceId = () => {
    let id = "";
    jest.isolateModules(() => {
      id = jest
        .requireActual<
          typeof import("../../src/services/runtimeInstanceService")
        >("../../src/services/runtimeInstanceService")
        .getRuntimeInstanceId();
    });
    return id;
  };

  test("comes from BOT_INSTANCE_ID outside ECS", () => {
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
    process.env.BOT_INSTANCE_ID = "synthetic-local-worker";
    expect(isolatedInstanceId()).toBe("synthetic-local-worker");
  });

  test("never comes from BOT_INSTANCE_ID on ECS, so two tasks cannot share one", () => {
    process.env.ECS_CONTAINER_METADATA_URI_V4 = "http://169.254.170.2/v4/id";
    process.env.BOT_INSTANCE_ID = "synthetic-shared-id";
    const first = isolatedInstanceId();
    const second = isolatedInstanceId();
    expect(first).not.toBe("synthetic-shared-id");
    expect(first).not.toBe(second);
  });
});
