#!/usr/bin/env node

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_SECRET_ID = "meeting-notes-prod/discord-bot-token";
const CHRONOTE_BOT_ID = "1278729036528619633";
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const fail = (message) => {
  throw new Error(message);
};

const parseArgs = (argv) => {
  const options = { guildIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--guild-id") {
      const value = argv[index + 1];
      if (!value) fail("Missing value for --guild-id");
      options.guildIds.push(value);
      index += 1;
      continue;
    }
    if (
      ["--region", "--secret-id", "--expected-bot-id", "--token-env"].includes(
        argument,
      )
    ) {
      const value = argv[index + 1];
      if (!value) fail(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`Unexpected argument: ${argument}`);
  }
  if (options.guildIds.length === 0) fail("Provide at least one --guild-id");
  options.guildIds = [...new Set(options.guildIds)];
  for (const guildId of options.guildIds) {
    if (!SNOWFLAKE_PATTERN.test(guildId))
      fail(`Invalid Discord guild ID: ${guildId}`);
  }
  return options;
};

const extractToken = (secretString) => {
  const trimmed = secretString?.trim();
  if (!trimmed) fail("The Discord bot token secret is empty");
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    const token = parsed.token ?? parsed.DISCORD_BOT_TOKEN;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    // Fall through to the non-sensitive error below.
  }
  fail("The Discord bot token secret has an unsupported JSON shape");
};

const readToken = async (options) => {
  if (options["token-env"]) {
    const token = process.env[options["token-env"]];
    if (!token) fail(`Environment variable ${options["token-env"]} is not set`);
    return token;
  }
  const client = new SecretsManagerClient({
    region: options.region ?? DEFAULT_REGION,
  });
  let response;
  try {
    response = await client.send(
      new GetSecretValueCommand({
        SecretId: options["secret-id"] ?? DEFAULT_SECRET_ID,
      }),
    );
  } finally {
    client.destroy();
  }
  if (response.SecretString) return extractToken(response.SecretString);
  if (response.SecretBinary) {
    return extractToken(Buffer.from(response.SecretBinary).toString("utf8"));
  }
  fail("The Discord bot token secret has no value");
};

const discordGet = async (token, path) => {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    fail(`Discord HTTP ${response.status} while reading ${path.split("?")[0]}`);
  }
  return response.json();
};

const listGuilds = async (token) => {
  const guilds = [];
  let after;
  while (true) {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);
    const page = await discordGet(token, `/users/@me/guilds?${query}`);
    if (!Array.isArray(page)) fail("Discord returned an invalid guild list");
    guilds.push(...page);
    if (page.length < 200) return guilds;
    after = page.at(-1)?.id;
    if (!after) fail("Discord guild pagination did not provide a cursor");
  }
};

try {
  const options = parseArgs(process.argv.slice(2));
  const token = await readToken(options);
  const bot = await discordGet(token, "/users/@me");
  const expectedBotId = options["expected-bot-id"] ?? CHRONOTE_BOT_ID;
  if (bot.id !== expectedBotId) {
    fail(
      `Refusing lookup: credential belongs to bot ${bot.id}, expected ${expectedBotId}`,
    );
  }

  const guilds = await listGuilds(token);
  const namesById = new Map(guilds.map((guild) => [guild.id, guild.name]));
  const results = options.guildIds.map((guildId) => ({
    guildId,
    name: namesById.get(guildId) ?? null,
    installed: namesById.has(guildId),
  }));

  console.log(
    JSON.stringify(
      {
        bot: { id: bot.id, username: bot.username },
        requestedGuildCount: options.guildIds.length,
        matchedGuildCount: results.filter((result) => result.installed).length,
        results,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Guild lookup failed");
  process.exitCode = 1;
}
