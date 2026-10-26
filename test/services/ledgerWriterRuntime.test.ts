/** @jest-environment node */
import { readLedgerWriterRuntime } from "../../src/services/ledgerWriterRuntime";
const imageDigest = "sha256:" + "a".repeat(64);
const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/test/task-one";
const uri = "http://169.254.170.2/v4/container-one";
afterEach(() => jest.restoreAllMocks());
test("binds the current container image to its actual task", async () => {
  const fetcher = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ DockerId: "docker-one", ImageID: imageDigest }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          TaskARN: taskArn,
          Containers: [{ DockerId: "docker-one", ImageID: imageDigest }],
        }),
      ),
    );
  expect(await readLedgerWriterRuntime(uri)).toEqual({ taskArn, imageDigest });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test("local runtime without metadata cannot assert cloud deployment proof", async () => {
  const fetcher = jest.spyOn(globalThis, "fetch");
  expect(await readLedgerWriterRuntime(undefined)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
test("metadata points only to the native ECS endpoint", async () => {
  const fetcher = jest.spyOn(globalThis, "fetch");
  expect(
    await readLedgerWriterRuntime("https://example.invalid/v4/task"),
  ).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
test("mismatched or unavailable metadata cannot mint a writer witness", async () => {
  jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ DockerId: "one", ImageID: imageDigest })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          TaskARN: taskArn,
          Containers: [{ DockerId: "other", ImageID: imageDigest }],
        }),
      ),
    );
  expect(await readLedgerWriterRuntime(uri)).toBeUndefined();
});
