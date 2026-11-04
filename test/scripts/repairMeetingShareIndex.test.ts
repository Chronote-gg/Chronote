/** @jest-environment node */
import {
  parseRepairMeetingShareIndexArgs,
  runMeetingShareIndexRepair,
  assertRepairTarget,
  writeRepairCheckpointAtomic,
  type RepairTarget,
} from "../../scripts/repair-meeting-share-index";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseArgs = [
  "--expected-account",
  "123456789012",
  "--history-table",
  "syntheticMeetingHistoryTable",
  "--index-table",
  "syntheticMeetingUserIndexTable",
];
const identity = {
  account: "123456789012",
  region: "us-east-1",
  historyTable: "syntheticMeetingHistoryTable",
  indexTable: "syntheticMeetingUserIndexTable",
  historyArn:
    "arn:aws:dynamodb:us-east-1:123456789012:table/syntheticMeetingHistoryTable",
  indexArn:
    "arn:aws:dynamodb:us-east-1:123456789012:table/syntheticMeetingUserIndexTable",
  historyTableId: "synthetic-history-generation",
  indexTableId: "synthetic-index-generation",
} satisfies RepairTarget;
const receipt = {
  examined: 1,
  personalWithGuildGrants: 1,
  missingPointers: 0,
  written: 0,
  skippedChanged: 0,
  failed: 0,
};
const cursor = {
  guildId: { S: "synthetic-private-key" },
  channelId_timestamp: { S: "synthetic-private-sort" },
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "share-repair-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const input = (extra: string[] = []) =>
  parseRepairMeetingShareIndexArgs([
    ...baseArgs,
    "--checkpoint",
    join(directory, "progress.json"),
    ...extra,
  ]);

test("explicit apply, page limit and max-page budgets are validated", () => {
  expect(input(["--apply", "--max-pages", "2"])).toMatchObject({
    mode: "apply",
    maxPages: 2,
  });
  expect(() => input(["--limit", "101"])).toThrow();
  expect(() => input(["--max-pages", "0"])).toThrow();
  expect(() => input(["--limit", "0"])).toThrow();
});

test("account, exact table ARN, region and physical table identities are checked", () => {
  expect(() => assertRepairTarget(input(), identity)).not.toThrow();
  for (const changed of [
    { account: "999999999999" },
    { historyArn: identity.indexArn },
    { region: "us-west-2" },
    { historyTableId: "" },
  ])
    expect(() =>
      assertRepairTarget(input(), { ...identity, ...changed }),
    ).toThrow();
});

test("max-pages stops at one page, private checkpoint resumes, receipts have no cursor", async () => {
  const page = jest
    .fn()
    .mockResolvedValueOnce({ ...receipt, nextCursor: cursor })
    .mockResolvedValueOnce(receipt);
  const emit = jest.fn();
  const args = input();
  await runMeetingShareIndexRepair(args, {
    verifyTarget: async () => identity,
    page,
    emit,
  });
  expect(page).toHaveBeenCalledTimes(1);
  expect(page.mock.calls[0][0]).toMatchObject({ mode: "dry-run", limit: 100 });
  expect(JSON.stringify(emit.mock.calls)).not.toContain("synthetic-private");
  expect(await readFile(args.checkpoint, "utf8")).toContain(
    "synthetic-private-key",
  );
  await runMeetingShareIndexRepair(args, {
    verifyTarget: async () => identity,
    page,
    emit,
  });
  expect(page.mock.calls[1][0]).toMatchObject({ cursor });
  await runMeetingShareIndexRepair(args, {
    verifyTarget: async () => identity,
    page,
    emit,
  });
  expect(page).toHaveBeenCalledTimes(2);
});

test("resume refuses different target, physical table, or mode before inventory", async () => {
  const args = input();
  const page = jest.fn().mockResolvedValue({ ...receipt, nextCursor: cursor });
  await runMeetingShareIndexRepair(args, {
    verifyTarget: async () => identity,
    page,
    emit: jest.fn(),
  });
  page.mockClear();
  await expect(
    runMeetingShareIndexRepair(
      { ...args, mode: "apply" },
      { verifyTarget: async () => identity, page, emit: jest.fn() },
    ),
  ).rejects.toThrow();
  await expect(
    runMeetingShareIndexRepair(args, {
      verifyTarget: async () => ({ ...identity, indexTableId: "replacement" }),
      page,
      emit: jest.fn(),
    }),
  ).rejects.toThrow();
  await expect(
    runMeetingShareIndexRepair(args, {
      verifyTarget: async () => ({ ...identity, account: "999999999999" }),
      page,
      emit: jest.fn(),
    }),
  ).rejects.toThrow();
  expect(page).not.toHaveBeenCalled();
});

test("uncertain page never advances checkpoint; only an explicit resume retries", async () => {
  const args = input(["--apply"]);
  const page = jest
    .fn()
    .mockResolvedValueOnce({ ...receipt, failed: 1 })
    .mockResolvedValueOnce(receipt);
  await expect(
    runMeetingShareIndexRepair(args, {
      verifyTarget: async () => identity,
      page,
      emit: jest.fn(),
    }),
  ).rejects.toThrow();
  expect(page).toHaveBeenCalledTimes(1);
  const checkpoint = JSON.parse(await readFile(args.checkpoint, "utf8"));
  expect(checkpoint).toMatchObject({ complete: false, pages: 0 });
  await runMeetingShareIndexRepair(args, {
    verifyTarget: async () => identity,
    page,
    emit: jest.fn(),
  });
  expect(page).toHaveBeenCalledTimes(2);
});

test("atomic checkpoint replacement leaves a whole file and no temporary file", async () => {
  const path = join(directory, "atomic.json");
  await writeFile(path, "old");
  await writeRepairCheckpointAtomic(path, { synthetic: 42 });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ synthetic: 42 });
  expect(await readdir(directory)).toEqual(["atomic.json"]);
});

test("failed atomic promotion leaves existing destination and removes its temporary file", async () => {
  const path = join(directory, "destination");
  await mkdir(path);
  await writeFile(join(path, "retained"), "retained");
  await expect(
    writeRepairCheckpointAtomic(path, { synthetic: 42 }),
  ).rejects.toThrow();
  expect(await readFile(join(path, "retained"), "utf8")).toBe("retained");
  expect(await readdir(directory)).toEqual(["destination"]);
});

test("an existing invocation lock refuses another run before inventory", async () => {
  const args = input();
  await writeFile(`${args.checkpoint}.lock`, "");
  const page = jest.fn();
  await expect(
    runMeetingShareIndexRepair(args, {
      verifyTarget: async () => identity,
      page,
      emit: jest.fn(),
    }),
  ).rejects.toThrow();
  expect(page).not.toHaveBeenCalled();
});

test("interrupted page preserves prior checkpoint and releases invocation lock", async () => {
  const args = input();
  const controller = new AbortController();
  const page = jest.fn().mockImplementation(async () => {
    controller.abort();
    throw new Error("synthetic abort");
  });
  await expect(
    runMeetingShareIndexRepair(
      args,
      { verifyTarget: async () => identity, page, emit: jest.fn() },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(args.checkpoint, "utf8"))).toMatchObject({
    complete: false,
    pages: 0,
  });
  expect(await readdir(directory)).toEqual(["progress.json"]);
});

test("defaults to a bounded dry run and requires an explicit target", () => {
  expect(() => parseRepairMeetingShareIndexArgs([])).toThrow();
  expect(
    parseRepairMeetingShareIndexArgs([
      "--expected-account",
      "123456789012",
      "--history-table",
      "syntheticMeetingHistoryTable",
      "--index-table",
      "syntheticMeetingUserIndexTable",
      "--checkpoint",
      "synthetic.json",
    ]),
  ).toMatchObject({ mode: "dry-run", limit: 100, maxPages: 1 });
});
