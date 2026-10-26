/** @jest-environment node */
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  parseRecoveryDiscordPublicationArgs as parse,
  runRecoveryDiscordPublication as run,
} from "../../scripts/publish-recovered-meeting";
import {
  publicationDigest,
  recoveryDiscordPreviewSchema,
  publicationReceiptSchema,
  type PublicationDependencies,
  type PublicationClaim,
  type PublicationReceipt,
} from "../../src/services/recoveryDiscordPublication";
import { createDiscordMessageEditor } from "../../src/services/discordMessageEditor";
import { fixture, input } from "../services/recoveryDiscordPublication.fixture";

let root: string;
const servers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "publication-cli-"));
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(root, { recursive: true, force: true });
});
const previewArgs = (out: string) => [
  "--account-id",
  input.accountId,
  "--region",
  input.region,
  "--table",
  input.table,
  "--bucket",
  input.bucket,
  "--guild-id",
  input.guildId,
  "--meeting-key",
  input.meetingKey,
  "--recovery-manifest-key",
  input.recoveryManifestKey,
  "--out",
  out,
];
const savedArgs = (mode: string, path: string, hash: string) => [
  mode,
  "--preview",
  path,
  "--expect-preview-sha256",
  hash,
];
async function loadPreview(directory: string) {
  return recoveryDiscordPreviewSchema.parse(
    JSON.parse(await readFile(join(directory, "preview.json"), "utf8")),
  );
}
function memory() {
  const f = fixture();
  let revision = 0;
  const receipts = new Map<
    string,
    { value: PublicationReceipt; etag: string }
  >();
  const claims = new Map<string, { value: PublicationClaim; etag: string }>();
  const previews: string[] = [];
  type Condition = Parameters<
    PublicationDependencies["storage"]["saveReceipt"]
  >[0]["condition"];
  function save<T>(
    map: Map<string, { value: T; etag: string }>,
    key: string,
    value: T,
    condition: Condition,
  ) {
    const previous = map.get(key);
    if (
      condition.kind === "absent" ? previous : previous?.etag !== condition.etag
    )
      throw new Error("precondition");
    const etag = String(++revision);
    map.set(key, { value: structuredClone(value), etag });
    return etag;
  }
  const storage: PublicationDependencies["storage"] = {
    savePreview: async (preview) => {
      previews.push(preview.previewDigest);
    },
    readReceipt: async (key) => structuredClone(receipts.get(key) ?? null),
    readClaim: async (key) => structuredClone(claims.get(key) ?? null),
    saveReceipt: async ({ key, receipt, condition }) =>
      save(receipts, key, receipt, condition),
    writeClaim: async ({ key, claim, condition }) =>
      save(claims, key, claim, condition),
  };
  const lines: string[] = [];
  const publication: PublicationDependencies = { ...f.deps, storage };
  const deps = {
    connect: async () => publication,
    report: (line: string) => {
      lines.push(line);
    },
  };
  return { ...f, publication, deps, receipts, claims, previews, lines };
}

test("default preview requires the complete exact provider scope", () => {
  expect(parse(previewArgs("private"))).toEqual({
    kind: "preview",
    scope: input,
    out: "private",
  });
  expect(() => parse(previewArgs("private").slice(2))).toThrow();
});
test.each([
  ["preview", "apply"],
  ["apply"],
  ["--apply"],
  [...previewArgs("private"), "--confirm-run-stopped", "run"],
  [...savedArgs("apply", "preview.json", "a".repeat(64)), "--guild-id", "999"],
  [
    ...savedArgs("apply", "preview.json", "a".repeat(64)),
    "--confirm-run-stopped",
    "run",
  ],
  [...savedArgs("reconcile", "preview.json", "wrong")],
  [...previewArgs("private"), "--table", "other"],
])(
  "rejects conflicting, missing, duplicate or out-of-mode arguments: %j",
  (...args) => {
    expect(() => parse(args)).toThrow();
  },
);

test("preview writes private review files without a claim, provider writes or console content", async () => {
  const f = memory();
  const directory = join(root, "review");
  expect(await run(previewArgs(directory), f.deps)).toBe(0);
  const preview = await loadPreview(directory);
  expect(preview.kind).toBe("ready");
  expect(publicationDigest(preview)).toBe(preview.previewDigest);
  expect(await readdir(directory)).toEqual(["preview.json", "preview.md"]);
  expect(await readFile(join(directory, "preview.md"), "utf8")).toContain(
    "Обсуждение",
  );
  expect(f.receipts.size + f.claims.size + f.previews.length).toBe(0);
  expect(f.lines.join("\n")).not.toContain("Обсуждение");
  expect(f.lines.join("\n")).toContain(preview.previewDigest);
  if (process.platform === "win32") {
    const script = `$ProgressPreference = 'SilentlyContinue'; $acl = [System.IO.Directory]::GetAccessControl('${directory.replace(/'/g, "''")}'); [pscustomobject]@{Protected=$acl.AreAccessRulesProtected; Owner=$acl.Owner; Rules=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); Current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress`;
    const acl = z
      .object({
        Protected: z.literal(true),
        Owner: z.string(),
        Rules: z.array(z.string()),
        Current: z.string(),
      })
      .parse(
        JSON.parse(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            { encoding: "utf8" },
          ),
        ),
      );
    expect(acl.Rules.length).toBeGreaterThan(0);
    expect(acl.Rules.every((sid) => sid === acl.Current)).toBe(true);
  } else {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "preview.json"))).mode & 0o777).toBe(
      0o600,
    );
  }
});

test("existing output is never overwritten and prevents provider connection", async () => {
  const f = memory();
  const path = join(root, "unrelated");
  await writeFile(path, "keep me");
  const connect = jest.fn(f.deps.connect);
  expect(await run(previewArgs(path), { ...f.deps, connect })).toBe(1);
  expect(connect).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("keep me");
});

test("tampered preview or confirmation hash is invalid before provider access", async () => {
  const f = memory();
  const directory = join(root, "review");
  await run(previewArgs(directory), f.deps);
  const preview = await loadPreview(directory);
  const path = join(directory, "preview.json");
  const connect = jest.fn(f.deps.connect);
  expect(
    await run(savedArgs("apply", path, "b".repeat(64)), { ...f.deps, connect }),
  ).toBe(2);
  preview.targets[0].afterEmbeds[0].description = "tampered";
  await writeFile(path, JSON.stringify(preview));
  expect(
    await run(savedArgs("apply", path, preview.previewDigest), {
      ...f.deps,
      connect,
    }),
  ).toBe(2);
  expect(connect).not.toHaveBeenCalled();
  expect(f.claims.size).toBe(0);
});

async function httpDiscord(
  f: ReturnType<typeof memory>,
  fail: "none" | "timeout" | "reject-second" = "none",
) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    const path = request.url ?? "";
    const method = request.method ?? "";
    requests.push({ method, path, body });
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/users/@me")
      return void response.end(JSON.stringify({ id: "500", bot: true }));
    if (path === "/api/channels/300")
      return void response.end(
        JSON.stringify({ id: "300", guild_id: "100", type: 0 }),
      );
    const id = path.split("/").pop() ?? "";
    const message = f.messages.get(id);
    if (!message) {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    if (method === "PATCH") {
      if (fail === "timeout") return;
      if (fail === "reject-second" && id === "401") {
        response.statusCode = 403;
        response.end("{}");
        return;
      }
      const payload = z
        .object({
          embeds: z.array(z.record(z.string(), z.unknown())),
          allowed_mentions: z.object({ parse: z.array(z.never()).length(0) }),
        })
        .strict()
        .parse(body);
      message.embeds = payload.embeds;
    }
    response.end(JSON.stringify(message));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test listener");
  f.publication.discord = createDiscordMessageEditor({
    token: "synthetic",
    fetchImpl: async (url, init) => {
      const original = new URL(String(url));
      expect(original.origin).toBe("https://discord.com");
      return fetch(`http://127.0.0.1:${address.port}${original.pathname}`, {
        ...init,
        signal: AbortSignal.timeout(
          init?.method === "PATCH" && fail === "timeout" ? 60 : 3000,
        ),
      });
    },
  });
  return requests;
}
function twoSlots(f: ReturnType<typeof memory>, batched: boolean) {
  const notes = "Имя говорящего не подтверждено. " + "Текст. ".repeat(800);
  const updated = fixture(notes);
  Object.assign(f.history, updated.history);
  Object.assign(f.manifest, updated.manifest);
  const first = f.messages.get("400")!;
  first.content = "unchanged content";
  first.embeds[0].title = "Meeting Notes (part 1/2)";
  const second = { ...first.embeds[0], title: "Meeting Notes (part 2/2)" };
  if (batched) first.embeds.push(second);
  else {
    f.history.notesMessageIds.push("401");
    f.messages.set("401", {
      ...structuredClone(first),
      id: "401",
      embeds: [second],
    });
  }
}

test("private batched preview applies exactly once, preserves fields and reconciles read-only", async () => {
  const f = memory();
  twoSlots(f, true);
  const before = structuredClone(f.messages.get("400")!);
  const history = JSON.stringify(f.history);
  const requests = await httpDiscord(f);
  const directory = join(root, "review");
  expect(await run(previewArgs(directory), f.deps)).toBe(0);
  const preview = await loadPreview(directory);
  expect(preview.targets[0].afterEmbeds).toHaveLength(2);
  const args = savedArgs(
    "apply",
    join(directory, "preview.json"),
    preview.previewDigest,
  );
  expect(await run(args, f.deps)).toBe(0);
  const patches = requests.filter((r) => r.method === "PATCH");
  expect(patches).toEqual([
    {
      method: "PATCH",
      path: "/api/channels/300/messages/400",
      body: {
        embeds: preview.targets[0].afterEmbeds,
        allowed_mentions: { parse: [] },
      },
    },
  ]);
  expect(f.messages.get("400")).toEqual({
    ...before,
    embeds: preview.targets[0].afterEmbeds,
  });
  expect(JSON.stringify(f.history)).toBe(history);
  const after = JSON.stringify(preview.targets[0].afterEmbeds);
  expect(after).toContain("Текст.");
  expect(after).toContain("v2 | Recovered notes");
  expect(after).toContain(
    "Some audio could not be transcribed. These notes may be incomplete.",
  );
  expect(after).toContain("Имя говорящего не подтверждено.");
  const receiptDirs = (await readdir(directory)).filter((name) =>
    name.startsWith("apply-"),
  );
  const receipt = publicationReceiptSchema.parse(
    JSON.parse(
      await readFile(join(directory, receiptDirs[0], "receipt.json"), "utf8"),
    ),
  );
  expect(receipt.status).toBe("verified");
  const remote = JSON.stringify([...f.receipts, ...f.claims]);
  expect(await run(args, f.deps)).toBe(0);
  expect(
    await run(
      savedArgs(
        "reconcile",
        join(directory, "preview.json"),
        preview.previewDigest,
      ),
      f.deps,
    ),
  ).toBe(0);
  expect(JSON.stringify([...f.receipts, ...f.claims])).toBe(remote);
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  expect(
    requests.every((r) => r.method === "GET" || r.method === "PATCH"),
  ).toBe(true);
  expect(f.lines.join("\n")).not.toContain("Текст.");
});

test("a timeout stays uncertain without another PATCH and wrong stopped run is invalid", async () => {
  const f = memory();
  const requests = await httpDiscord(f, "timeout");
  const directory = join(root, "review");
  await run(previewArgs(directory), f.deps);
  const preview = await loadPreview(directory);
  const path = join(directory, "preview.json");
  expect(
    await run(savedArgs("apply", path, preview.previewDigest), f.deps),
  ).toBe(1);
  expect([...f.receipts.values()][0].value.status).toBe("uncertain");
  expect(
    await run(
      [
        ...savedArgs("reconcile", path, preview.previewDigest),
        "--confirm-run-stopped",
        "other-run",
      ],
      f.deps,
    ),
  ).toBe(2);
  expect(
    await run(savedArgs("reconcile", path, preview.previewDigest), f.deps),
  ).toBe(1);
  expect(
    await run(savedArgs("apply", path, preview.previewDigest), f.deps),
  ).toBe(1);
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});

test("a definite second-post rejection reports partial publication", async () => {
  const f = memory();
  twoSlots(f, false);
  const requests = await httpDiscord(f, "reject-second");
  const directory = join(root, "review");
  await run(previewArgs(directory), f.deps);
  const preview = await loadPreview(directory);
  expect(
    await run(
      savedArgs(
        "apply",
        join(directory, "preview.json"),
        preview.previewDigest,
      ),
      f.deps,
    ),
  ).toBe(1);
  expect([...f.receipts.values()][0].value.status).toBe("partial");
  expect(
    requests.filter((r) => r.method === "PATCH").map((r) => r.path),
  ).toEqual([
    "/api/channels/300/messages/400",
    "/api/channels/300/messages/401",
  ]);
});

test("the CLI dependency path does not load app config, Notion or LLM clients", () => {
  const modules = Object.keys(require.cache);
  expect(
    modules.filter((path) =>
      /[\\/]src[\\/](?:services[\\/](?:configService|notion|openai)|config)|[\\/]node_modules[\\/]openai[\\/]/i.test(
        path,
      ),
    ),
  ).toEqual([]);
});

test("stopped-run assertion must be exact and can close only the matching stopped run", async () => {
  const f = memory();
  const requests = await httpDiscord(f);
  const writeClaim = f.publication.storage.writeClaim;
  f.publication.storage.writeClaim = async (args) => {
    if (args.claim.state === "terminal")
      throw new Error("lost terminal claim acknowledgement");
    return writeClaim(args);
  };
  const directory = join(root, "review");
  expect(await run(previewArgs(directory), f.deps)).toBe(0);
  const preview = await loadPreview(directory);
  const path = join(directory, "preview.json");
  expect(
    await run(savedArgs("apply", path, preview.previewDigest), f.deps),
  ).toBe(1);
  const runId = [...f.receipts.values()][0].value.runId;
  f.publication.storage.writeClaim = writeClaim;
  expect(
    await run(savedArgs("apply", path, preview.previewDigest), f.deps),
  ).toBe(1);
  expect([...f.claims.values()][0].value.state).toBe("running");
  expect(
    await run(
      [
        ...savedArgs("reconcile", path, preview.previewDigest),
        "--confirm-run-stopped",
        ` ${runId} `,
      ],
      f.deps,
    ),
  ).toBe(2);
  expect([...f.claims.values()][0].value.state).toBe("running");
  expect(
    await run(
      [
        ...savedArgs("reconcile", path, preview.previewDigest),
        "--confirm-run-stopped",
        runId,
      ],
      f.deps,
    ),
  ).toBe(0);
  expect([...f.claims.values()][0].value.state).toBe("terminal");
  expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
});
