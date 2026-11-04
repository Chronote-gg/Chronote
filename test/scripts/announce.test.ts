/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnnounceDeps,
  parseAnnounceArgs,
  runAnnounce,
} from "../../scripts/announce";
import { DeliveryTableMissingError } from "../../src/services/announcements/announcementDeliveryStore";
import {
  createFakes,
  denyOnChannel,
  fakeGuild,
  guildId,
  PREVIEW_TIME,
  scope,
  updatesChannelId,
  VIEW_CHANNEL,
} from "../services/announcements/announcementRunner.fixture";

const ANNOUNCEMENT_FILE = [
  "---",
  "id: incident-2026-11-04",
  "kind: incident",
  "title: Example notice",
  "---",
  "Example body.",
  "",
].join("\n");

const scopeArgs = [
  "--account-id",
  scope.accountId,
  "--region",
  scope.region,
  "--config-table",
  scope.configTable,
  "--delivery-table",
  scope.deliveryTable,
];
const previewArgs = (out = "out") => [
  "--announcement",
  "notice.md",
  ...scopeArgs,
  "--out",
  out,
];

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "announce-cli-"));
  await writeFile(join(root, "notice.md"), ANNOUNCEMENT_FILE);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const harness = (fakes = createFakes([fakeGuild(1), fakeGuild(2)])) => {
  const lines: string[] = [];
  const connect = jest.fn<AnnounceDeps["connect"]>(async () => fakes.deps);
  const deps = {
    connect,
    isInteractive: () => true,
    report: (line: string) => {
      lines.push(line);
    },
    root,
  };
  return { fakes, lines, connect, deps };
};

const runPreview = async (h: ReturnType<typeof harness>) => {
  expect(await runAnnounce(previewArgs(), h.deps)).toBe(0);
  const raw = await readFile(join(root, "out", "preview.json"), "utf8");
  return JSON.parse(raw) as { sha256: string; createdAt: string };
};

const sendArgs = (sha256: string, path = "out/preview.json") => [
  "send",
  "--preview",
  path,
  "--expect-preview-sha256",
  sha256,
];

describe("parseAnnounceArgs", () => {
  it("defaults to preview and reads the scope, servers and format", () => {
    expect(
      parseAnnounceArgs([
        ...previewArgs(),
        "--guild-id",
        guildId(1),
        "--guild-id",
        guildId(2),
        "--retry-failed",
      ]),
    ).toEqual({
      kind: "preview",
      announcement: "notice.md",
      format: "markdown",
      scope,
      out: "out",
      guildIds: [guildId(1), guildId(2)],
      retryFailed: true,
    });
    const json = parseAnnounceArgs([
      "preview",
      ...previewArgs().map((arg) =>
        arg === "notice.md" ? "notice.JSON" : arg,
      ),
    ]);
    expect(json).toMatchObject({ format: "json", retryFailed: false });
    expect(json).not.toHaveProperty("guildIds");
  });

  it("accepts only the saved preview and digest for send", () => {
    const sha256 = "a".repeat(64);
    expect(parseAnnounceArgs(sendArgs(sha256))).toEqual({
      kind: "send",
      preview: "out/preview.json",
      expectPreviewSha256: sha256,
    });
  });

  it.each([
    ["a missing required flag", previewArgs().slice(2)],
    [
      "another extension",
      previewArgs().map((a) => (a === "notice.md" ? "notice.txt" : a)),
    ],
    ["a duplicate flag", [...previewArgs(), "--region", scope.region]],
    ["an unknown flag", [...previewArgs(), "--force"]],
    ["a bad guild id", [...previewArgs(), "--guild-id", "not-an-id"]],
    [
      "a repeated guild id",
      [...previewArgs(), "--guild-id", guildId(1), "--guild-id", guildId(1)],
    ],
    [
      "a scope flag on send",
      [...sendArgs("a".repeat(64)), "--region", scope.region],
    ],
    [
      "--guild-id on send",
      [...sendArgs("a".repeat(64)), "--guild-id", guildId(1)],
    ],
    ["a short digest", sendArgs("abc")],
    ["an unknown mode", ["apply", ...previewArgs()]],
  ])("rejects %s", (_label, args) => {
    expect(() => parseAnnounceArgs(args)).toThrow();
  });
});

describe("runAnnounce preview", () => {
  it("writes the private preview files and reports the digest and summary", async () => {
    const guild = fakeGuild(2);
    denyOnChannel(guild, updatesChannelId(2), VIEW_CHANNEL);
    const h = harness(createFakes([fakeGuild(1), guild]));
    const preview = await runPreview(h);

    expect(h.connect).toHaveBeenCalledWith(scope);
    expect(h.lines).toEqual([
      `Preview written to ${join(root, "out")}; SHA-256 ${preview.sha256}`,
      "announcement incident-2026-11-04: would_send=2 owner_dm=1 skipped=0 (opted_out=0 no_channel=0 missing_permissions=0 owner_dms_closed=0 discord_error=0 already_sent=0 pending_unknown=0) failed=0 unknown=0",
    ]);
    const markdown = await readFile(join(root, "out", "preview.md"), "utf8");
    expect(markdown).toContain("# Announcement preview: incident-2026-11-04");
    expect(markdown).toContain("Kind: incident");
    expect(markdown).toContain("Example body.");
    expect(markdown).toContain(
      `| ${guildId(1)} | post | public_updates | ${updatesChannelId(1)} | - |`,
    );
    expect(markdown).toContain("OWNER DM (missing ViewChannel)");
    expect(markdown).toContain(
      `- ${guildId(2)}: Chronote could not post this notice in the community updates channel of Example Server 2 because it is missing: View Channel.`,
    );
    expect(h.fakes.discord.createMessage).not.toHaveBeenCalled();
  });

  it("reports warnings before the digest", async () => {
    const h = harness();
    h.fakes.store.listForAnnouncement.mockRejectedValueOnce(
      new DeliveryTableMissingError("missing"),
    );
    await runPreview(h);
    expect(h.lines[0]).toBe(
      "Warning: delivery table not found; send will refuse until the Terraform change is applied",
    );
  });

  it("refuses an existing output path before reading anything", async () => {
    await mkdir(join(root, "out"));
    const h = harness();
    expect(await runAnnounce(previewArgs(), h.deps)).toBe(2);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.lines[0]).toContain("already exists");
  });

  it("lists every problem in invalid announcement input", async () => {
    await writeFile(
      join(root, "notice.md"),
      ANNOUNCEMENT_FILE.replace(
        "Example body.",
        "{{status}} until {{ next_update }}",
      ),
    );
    const h = harness();
    expect(await runAnnounce(previewArgs(), h.deps)).toBe(2);
    expect(h.lines).toEqual([
      "Announcement input is invalid:",
      "- unfilled placeholder {{status}}",
      "- unfilled placeholder {{next_update}}",
    ]);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("reports a server the bot is not in", async () => {
    const h = harness();
    expect(
      await runAnnounce([...previewArgs(), "--guild-id", guildId(9)], h.deps),
    ).toBe(1);
    expect(h.lines.at(-1)).toContain(guildId(9));
  });

  it("rejects invalid arguments with exit code 2", async () => {
    const h = harness();
    expect(await runAnnounce(["--force"], h.deps)).toBe(2);
    expect(h.lines[0]).toContain("docs/operations/operator-announcements.md");
  });
});

describe("runAnnounce send", () => {
  it("sends the approved preview, one line per server, summary last", async () => {
    const h = harness();
    const { sha256 } = await runPreview(h);
    h.lines.length = 0;

    expect(await runAnnounce(sendArgs(sha256), h.deps)).toBe(0);
    expect(h.fakes.discord.createMessage).toHaveBeenCalledTimes(2);
    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toMatch(new RegExp(`^${guildId(1)}: sent to `));
    expect(h.lines[2]).toMatch(
      /^announcement incident-2026-11-04: sent=2 owner_dm=0 skipped=0 /,
    );
  });

  const refusals: [
    string,
    (h: ReturnType<typeof harness>, sha256: string) => Promise<string[]>,
    string,
  ][] = [
    [
      "without an interactive terminal",
      async (h, sha256) => {
        h.deps.isInteractive = () => false;
        return sendArgs(sha256);
      },
      "interactive terminal",
    ],
    [
      "when the flag does not match the preview",
      async () => sendArgs("b".repeat(64)),
      "digest",
    ],
    [
      "when the preview file was edited",
      async (_h, sha256) => {
        const path = join(root, "out", "preview.json");
        const raw = await readFile(path, "utf8");
        await writeFile(
          join(root, "edited.json"),
          raw.replace("Example body.", "Edited body."),
        );
        return sendArgs(sha256, "edited.json");
      },
      "digest",
    ],
    [
      "when the preview is older than 60 minutes",
      async (h, sha256) => {
        h.fakes.deps.now = () =>
          new Date(PREVIEW_TIME.getTime() + 61 * 60 * 1000);
        return sendArgs(sha256);
      },
      "older than 60 minutes",
    ],
    [
      "when the delivery table is missing",
      async (h, sha256) => {
        h.fakes.store.assertTableExists.mockRejectedValueOnce(
          new DeliveryTableMissingError("Delivery table is missing"),
        );
        return sendArgs(sha256);
      },
      "Delivery table is missing",
    ],
    [
      "when the bot token belongs to another bot",
      async (h, sha256) => {
        h.fakes.discord.getBotUserId.mockResolvedValueOnce(
          "100000000000000099",
        );
        return sendArgs(sha256);
      },
      "different bot",
    ],
  ];

  it.each(refusals)("refuses %s", async (_label, prepare, message) => {
    const h = harness();
    const { sha256 } = await runPreview(h);
    const args = await prepare(h, sha256);
    h.lines.length = 0;
    expect(await runAnnounce(args, h.deps)).toBe(2);
    expect(h.lines.join("\n")).toContain(message);
    expect(h.fakes.discord.createMessage).not.toHaveBeenCalled();
    expect(h.fakes.store.claimPending).not.toHaveBeenCalled();
  });

  it("exits 1 and still prints the summary after an interrupt", async () => {
    const h = harness();
    const { sha256 } = await runPreview(h);
    const controller = new AbortController();
    h.fakes.store.markSent.mockImplementationOnce(async () => {
      controller.abort();
    });
    h.lines.length = 0;
    expect(
      await runAnnounce(sendArgs(sha256), {
        ...h.deps,
        signal: controller.signal,
      }),
    ).toBe(1);
    expect(h.fakes.discord.createMessage).toHaveBeenCalledTimes(1);
    expect(h.lines.at(-1)).toMatch(/: sent=1 owner_dm=0 skipped=0 /);
  });
});

describe("config isolation", () => {
  // setupTests injects a full env, so only a throwing mock proves this.
  it("imports the CLI and runner without loading the application config", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("../../src/services/configService", () => {
        throw new Error("the announcement CLI must not load app config");
      });
      await expect(import("../../scripts/announce")).resolves.toHaveProperty(
        "runAnnounce",
      );
      await expect(
        import("../../src/services/announcements/announcementRunner"),
      ).resolves.toHaveProperty("sendAnnouncementPreview");
    });
  });
});
