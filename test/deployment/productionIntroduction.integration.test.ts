import { PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../src/services/deploymentControlTransactions";
import {
  fixture,
  client,
  readStored,
  readControl,
} from "./fixtures/productionIntroduction";
test("real conditional receipts complete introduction and preserve all work tables", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  await f.run("activate", "3");
  await f.run("complete", "4");
  expect((await f.head())?.stage).toBe("complete");
  expect(f.isOwned()).toBe(false);
  const control = await readControl(f.controlTable);
  expect(control!.servingGeneration).toBe(1);
  expect(f.calls.filter((op) => op === "update-service")).toHaveLength(2);
});
test.each(["cacheReady", "dependenciesReady", "gatewayReady"] as const)(
  "candidate waits for %s warmup before promotion without repeating stop or launch",
  async (field) => {
    const f = await fixture();
    await f.run("fence", "1");
    await f.run("drain", "2");
    f.row.readiness[field] = false;
    let pauses = 0;
    f.options.pause = async () => {
      pauses++;
      expect((await f.head())?.stage).toBe("launch_acknowledged");
      expect((await readControl(f.controlTable))!.servingGeneration).toBe(0);
      f.row.readiness[field] = true;
      await client.send(
        new PutItemCommand({
          TableName: f.controlTable,
          Item: marshall(f.row),
        }),
      );
    };
    await f.run("activate", "3");
    expect(pauses).toBe(1);
    expect((await f.head())?.stage).toBe("promotion_acknowledged");
    expect((await readControl(f.controlTable))!.servingGeneration).toBe(1);
    expect(f.serviceRequests).toHaveLength(2);
    expect(f.serviceRequests[0]).toMatchObject({ desiredCount: 0 });
    expect(f.serviceRequests[1]).toMatchObject({
      desiredCount: 1,
      taskDefinition: f.m.taskDefinition,
    });
    expect(f.isOwned()).toBe(true);
  },
);

test("real conditional receipt lost acknowledgment prevents policy submission", async () => {
  const f = await fixture();
  f.setFault("receipt");
  await expect(f.run("fence", "1")).rejects.toThrow(
    "Lost receipt acknowledgment",
  );
  expect(f.isOwned()).toBe(false);
  expect((await f.head())?.stage).toBe("fence_submitted");
  await expect(f.run("fence", "2")).rejects.toThrow("Unknown acknowledgment");
});
test.each(["fence", "shutdown", "routing", "launch"])(
  "lost %s acknowledgment never repeats write",
  async (fault) => {
    const f = await fixture();
    if (fault !== "fence") {
      await f.run("fence", "1");
      await f.run("drain", "2");
    }
    f.setFault(fault);
    await expect(
      f.run(fault === "fence" ? "fence" : "activate", "3"),
    ).rejects.toThrow("Lost");
    expect(f.isOwned()).toBe(true);
    expect((await f.head())?.stage).toMatch(/_submitted$/);
    await expect(f.run("activate", "4")).rejects.toThrow(
      "Unknown acknowledgment",
    );
  },
);

test("pre-shutdown abort uses real receipt conditions and preserves generation absence", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("abort", "2");
  expect(f.isOwned()).toBe(false);
  const control = await readControl(f.controlTable);
  expect(control).toBeUndefined();
});
test("lost removal acknowledgment preserves submitted intent without another removal", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  await f.run("activate", "3");
  f.setFault("removal");
  await expect(f.run("complete", "4")).rejects.toThrow("Lost removal");
  expect((await f.head())?.stage).toBe("removal_submitted");
  await expect(f.run("complete", "5")).rejects.toThrow(
    "Unknown acknowledgment",
  );
  expect(f.calls.filter((op) => op === "delete-role-policy")).toHaveLength(1);
});

test.each([false, true])(
  "known settled FAILED candidate permits only explicitly approved fallback recovery (same definition=%s)",
  async (sameDefinition) => {
    const f = await fixture(sameDefinition);
    await f.run("fence", "1");
    await f.run("drain", "2");
    f.setFault("failed");
    await expect(f.run("activate", "3")).rejects.toThrow(
      "Known candidate startup failure",
    );
    expect((await f.head())?.stage).toBe("candidate_failed");
    expect(f.isOwned()).toBe(true);
    await expect(f.run("activate", "4")).rejects.toThrow();
    f.setFault("");
    await f.run("activate", "5", true);
    await f.run("complete", "6");
    expect((await f.head())?.stage).toBe("complete");
    expect(f.calls.filter((op) => op === "update-service")).toHaveLength(3);
    const expected = {
      cluster: f.m.cluster,
      service: f.m.service,
      taskDefinition: f.m.fallbackTaskDefinition,
      desiredCount: 1,
      deploymentConfiguration: f.m.targetDeploymentConfiguration,
      ...(sameDefinition ? { forceNewDeployment: true } : {}),
    };
    expect(f.serviceRequests.at(-1)).toEqual(expected);
    expect(f.serviceRequests.slice(0, 2)).toEqual([
      { cluster: f.m.cluster, service: f.m.service, desiredCount: 0 },
      {
        cluster: f.m.cluster,
        service: f.m.service,
        taskDefinition: f.m.taskDefinition,
        desiredCount: 1,
        deploymentConfiguration: f.m.targetDeploymentConfiguration,
      },
    ]);
    const journal = await client.send(
      new ScanCommand({ TableName: f.controlTable }),
    );
    const intent = journal
      .Items!.map(unmarshall)
      .filter((item) => item.bodyJson)
      .map((item) => JSON.parse(item.bodyJson))
      .find((body) => body.stage === "fallback_submitted");
    expect(intent.providerRequest).toEqual({
      service: "ecs",
      operation: "update-service",
      input: expected,
    });
  },
);

test.each(["initialize", "promotion"])(
  "unknown %s transaction retains submitted stage",
  async (fault) => {
    const f = await fixture();
    await f.run("fence", "1");
    await f.run("drain", "2");
    f.setFault(fault);
    await expect(f.run("activate", "3")).rejects.toThrow("Lost " + fault);
    expect((await f.head())?.stage).toBe(fault + "_submitted");
    expect(f.isOwned()).toBe(true);
    await expect(f.run("complete", "4")).rejects.toThrow(
      "Unknown acknowledgment",
    );
  },
);

test("reconciliation validates approved persisted evidence but never advances unknown stage", async () => {
  const f = await fixture();
  f.setFault("fence");
  await expect(f.run("fence", "1")).rejects.toThrow();
  const before = await f.head();
  const writes = f.calls.filter((op) =>
    ["put-role-policy", "update-service", "modify-listener"].includes(op),
  ).length;
  await expect(f.run("reconcile", "2")).rejects.toThrow("Explicit recovery");
  await f.run("reconcile", "3", true);
  expect(await f.head()).toEqual(before);
  expect(
    f.calls.filter((op) =>
      ["put-role-policy", "update-service", "modify-listener"].includes(op),
    ),
  ).toHaveLength(writes);
});
test("authority expiry after native shutdown preserves owned fence", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  f.setFault("shutdown");
  await expect(f.run("activate", "3")).rejects.toThrow("Lost shutdown");
  f.setClock(2000);
  await expect(f.run("activate", "4")).rejects.toThrow("expired");
  expect(f.isOwned()).toBe(true);
  expect(f.calls.filter((op) => op === "update-service")).toHaveLength(1);
});

test("promotion builds its time condition after delayed intent and STS", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  const native = f.options.aws;
  let submitted = false;
  const promotion = jest.spyOn(builders, "buildPromotionTransaction");
  f.options.aws = async (service, operation, input) => {
    const result = await native(service, operation, input);
    if (
      operation === "transact-write-items" &&
      JSON.stringify(input).includes('"promotion_submitted"')
    ) {
      submitted = true;
      f.setClock(1010);
    } else if (submitted && service === "sts") f.setClock(1020);
    return result;
  };
  try {
    await f.run("activate", "3");
    expect(promotion).toHaveBeenCalledWith(
      expect.objectContaining({ now: 1020 }),
    );
  } finally {
    promotion.mockRestore();
  }
});

test.each(["readiness", "runtime-protection", "native-protection"])(
  "candidate proof cannot outlive short %s lifetime",
  async (kind) => {
    const f = await fixture();
    await f.run("fence", "1");
    await f.run("drain", "2");
    if (kind === "readiness") f.row.readiness.expiresAt = 1040;
    if (kind === "runtime-protection") f.row.protection.expiresAt = 1160;
    const native = f.options.aws;
    f.options.aws = async (service, operation, input) => {
      const result = await native(service, operation, input);
      if (kind === "native-protection" && operation === "get-task-protection")
        return {
          protectedTasks: [
            {
              taskArn: f.row.identity.taskArn,
              protectionEnabled: true,
              expirationDate: new Date(1160000).toISOString(),
            },
          ],
        };
      return result;
    };
    await expect(f.run("activate", "3")).rejects.toThrow();
    expect(f.isOwned()).toBe(true);
    expect((await f.head())?.stage).toBe("launch_acknowledged");
  },
);

test("expired proof after final promotion STS preserves generation zero and fence", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  const native = f.options.aws;
  let submitted = false;
  f.options.aws = async (service, operation, input) => {
    const result = await native(service, operation, input);
    if (
      operation === "transact-write-items" &&
      JSON.stringify(input).includes('"promotion_submitted"')
    )
      submitted = true;
    else if (submitted && service === "sts") f.setClock(1060);
    return result;
  };
  await expect(f.run("activate", "3")).rejects.toThrow("expired");
  expect((await f.head())?.stage).toBe("promotion_submitted");
  expect(f.isOwned()).toBe(true);
  const control = await readControl(f.controlTable);
  expect(control!.servingGeneration).toBe(0);
});

test("completion preserves recording and upload started immediately after policy removal", async () => {
  const f = await fixture();
  await f.run("fence", "1");
  await f.run("drain", "2");
  await f.run("activate", "3");
  const native = f.options.aws;
  const records = [
    {
      TableName: f.physical.get(f.m.binding.tableArns.leases)!,
      key: { guildId: "new-recording" },
      value: {
        guildId: "new-recording",
        meetingId: "meeting",
        ownerInstanceId: "candidate",
        status: "recording",
        leaseExpiresAt: 1100,
      },
    },
    {
      TableName: f.physical.get(f.m.binding.tableArns.uploads)!,
      key: { uploadId: "new-upload" },
      value: {
        uploadId: "new-upload",
        ownerUserId: "user",
        status: "processing",
        processingOwnerInstanceId: "candidate",
        processingClaimId: "claim",
        claimExpiresAt: 1100,
      },
    },
  ];
  let activeRuntime: object | undefined;
  f.options.aws = async (service, operation, input) => {
    const result = await native(service, operation, input);
    if (operation === "delete-role-policy") {
      expect(f.isOwned()).toBe(false);
      for (const record of records)
        await client.send(
          new PutItemCommand({
            TableName: record.TableName,
            Item: marshall(record.value),
          }),
        );
      const stored = await readStored(
        f.controlTable,
        marshall({ pk: f.row.pk, sk: f.row.sk }),
      );
      const live = unmarshall(stored!);
      live.workCounts.recording = 1;
      live.workCounts.personal_processing = 1;
      activeRuntime = marshall(live);
      await client.send(
        new PutItemCommand({ TableName: f.controlTable, Item: marshall(live) }),
      );
    }
    return result;
  };
  await f.run("complete", "4");
  expect((await f.head())?.stage).toBe("complete");
  for (const record of records) {
    const stored = await readStored(record.TableName, marshall(record.key));
    expect(stored).toEqual(marshall(record.value));
  }
  const stored = await readStored(
    f.controlTable,
    marshall({ pk: f.row.pk, sk: f.row.sk }),
  );
  expect(stored).toEqual(activeRuntime);
  expect(f.calls.filter((op) => op === "delete-role-policy")).toHaveLength(1);
});

test.each(["candidate", "pre-removal"])(
  "active work still blocks %s boundary",
  async (stage) => {
    const f = await fixture();
    await f.run("fence", "1");
    await f.run("drain", "2");
    if (stage === "candidate") f.row.workCounts!.recording = 1;
    else {
      await f.run("activate", "3");
      const item = await readStored(
        f.controlTable,
        marshall({ pk: f.row.pk, sk: f.row.sk }),
      );
      const live = unmarshall(item!);
      live.workCounts.recording = 1;
      await client.send(
        new PutItemCommand({ TableName: f.controlTable, Item: marshall(live) }),
      );
    }
    await expect(
      f.run(stage === "candidate" ? "activate" : "complete", "4"),
    ).rejects.toThrow();
    expect(f.isOwned()).toBe(true);
    expect((await f.head())?.stage).toBe(
      stage === "candidate" ? "launch_acknowledged" : "promotion_acknowledged",
    );
    const item = await readStored(
      f.controlTable,
      marshall({ pk: f.row.pk, sk: f.row.sk }),
    );
    expect(unmarshall(item!).workCounts.recording).toBe(1);
    expect(f.calls).not.toContain("delete-role-policy");
  },
);

test.each(["live", "serving", "unknown-launch"])(
  "same-definition recovery refuses %s state without deployment replay",
  async (fault) => {
    const f = await fixture(true);
    await f.run("fence", "1");
    await f.run("drain", "2");
    f.setFault(fault === "unknown-launch" ? "launch" : "failed");
    await expect(f.run("activate", "3")).rejects.toThrow();
    const before = await f.head();
    if (fault === "live") f.svc.runningCount = 1;
    if (fault === "serving") {
      const control = await readControl(f.controlTable);
      control!.servingGeneration = 1;
      await client.send(
        new PutItemCommand({
          TableName: f.controlTable,
          Item: marshall(control!),
        }),
      );
    }
    f.setFault("");
    await expect(f.run("activate", "4", true)).rejects.toThrow();
    expect(await f.head()).toEqual(before);
    expect(f.serviceRequests).toHaveLength(2);
    expect(
      f.serviceRequests.every(
        (request) => !Object.hasOwn(request, "forceNewDeployment"),
      ),
    ).toBe(true);
    expect(f.isOwned()).toBe(true);
  },
);

test("lost same-definition fallback acknowledgment cannot replay deployment", async () => {
  const f = await fixture(true);
  await f.run("fence", "1");
  await f.run("drain", "2");
  f.setFault("failed");
  await expect(f.run("activate", "3")).rejects.toThrow(
    "Known candidate startup failure",
  );
  f.setFault("launch");
  await expect(f.run("activate", "4", true)).rejects.toThrow(
    "Lost launch acknowledgment",
  );
  const submitted = await f.head();
  expect(submitted?.stage).toBe("fallback_submitted");
  expect(f.serviceRequests).toHaveLength(3);
  expect(f.serviceRequests.at(-1)).toEqual({
    cluster: f.m.cluster,
    service: f.m.service,
    taskDefinition: f.m.fallbackTaskDefinition,
    desiredCount: 1,
    deploymentConfiguration: f.m.targetDeploymentConfiguration,
    forceNewDeployment: true,
  });
  f.setFault("");
  await expect(f.run("activate", "5", true)).rejects.toThrow();
  expect(await f.head()).toEqual(submitted);
  expect(f.serviceRequests).toHaveLength(3);
  expect(f.isOwned()).toBe(true);
});
