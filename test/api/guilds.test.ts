/** @jest-environment node */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerGuildRoutes } from "../../src/api/guilds";
import {
  ensureBotInGuild,
  ensureManageGuildWithUserToken,
} from "../../src/services/guildAccessService";
import { listGuildChannelsCached } from "../../src/services/discordCacheService";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureBotInGuild: jest.fn(),
  ensureManageGuildWithUserToken: jest.fn(),
}));

jest.mock("../../src/services/discordCacheService", () => ({
  listBotGuildsCached: jest.fn(),
  listGuildChannelsCached: jest.fn(),
  listUserGuildsCached: jest.fn(),
}));

const mockedEnsureBotInGuild = jest.mocked(ensureBotInGuild);
const mockedEnsureManageGuild = jest.mocked(ensureManageGuildWithUserToken);
const mockedListGuildChannels = jest.mocked(listGuildChannelsCached);

const createServer = () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as { isAuthenticated?: () => boolean }).isAuthenticated = () => true;
    req.user = { id: "user-1", accessToken: "token" };
    req.session = {} as never;
    next();
  });
  registerGuildRoutes(app);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const requestJson = async (url: string) =>
  new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });

const closeServer = async (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

describe("guild REST routes", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedEnsureBotInGuild.mockResolvedValue(true);
    mockedListGuildChannels.mockResolvedValue([
      { id: "voice-1", name: "Voice", type: 2, position: 2 },
      { id: "text-1", name: "Text", type: 0, position: 1 },
    ]);
  });

  test("requires Manage Server for the legacy channel list route", async () => {
    mockedEnsureManageGuild.mockResolvedValue(false);
    const { server, baseUrl } = createServer();
    try {
      const response = await requestJson(
        `${baseUrl}/api/guilds/guild-1/channels`,
      );

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        error: "Manage Guild required",
      });
      expect(mockedListGuildChannels).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  test("returns channels to users with Manage Server", async () => {
    mockedEnsureManageGuild.mockResolvedValue(true);
    const { server, baseUrl } = createServer();
    try {
      const response = await requestJson(
        `${baseUrl}/api/guilds/guild-1/channels`,
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        voiceChannels: [{ id: "voice-1", name: "Voice" }],
        textChannels: [{ id: "text-1", name: "Text" }],
      });
    } finally {
      await closeServer(server);
    }
  });
});
