import express from "express";
import { SERVER_CONTEXT_KEY_LIST, SERVER_CONTEXT_KEYS } from "../config/keys";
import {
  clearConfigOverrideForScope,
  setConfigOverrideForScope,
} from "../services/configOverridesService";
import { config } from "../services/configService";
import {
  listAutoRecordSettings,
  removeAutoRecordSetting,
  saveAutoRecordSetting,
} from "../services/autorecordService";
import {
  ensureBotInGuild,
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../services/guildAccessService";
import {
  listBotGuildsCached,
  listGuildChannelsCached,
  listUserGuildsCached,
} from "../services/discordCacheService";
import type { DiscordGuild } from "../repositories/types";
import { answerQuestionService } from "../services/askService";
import { renderAskAnswer } from "../services/askCitations";
import {
  getSnapshotString,
  resolveConfigSnapshot,
} from "../services/unifiedConfigService";
import { normalizeTags, parseTags } from "../utils/tags";

type AuthedUser = {
  accessToken?: string;
  id?: string;
};

type SessionGuildCache = {
  guildIds?: string[];
  guildIdsFetchedAt?: number;
  userGuilds?: DiscordGuild[];
  userGuildsFetchedAt?: number;
  botGuildIds?: string[];
  botGuildIdsFetchedAt?: number;
};

export function registerGuildRoutes(app: express.Express) {
  const ensureBotPresence = async (
    req: express.Request,
    res: express.Response,
    guildId: string,
  ): Promise<boolean> => {
    const sessionData = req.session as typeof req.session & {
      botGuildIds?: string[];
      botGuildIdsFetchedAt?: number;
    };
    const cachedBotGuilds = sessionData.botGuildIds;
    const cacheAgeMs =
      sessionData.botGuildIdsFetchedAt != null
        ? Date.now() - sessionData.botGuildIdsFetchedAt
        : Number.POSITIVE_INFINITY;
    const cacheFresh = cacheAgeMs < 5 * 60 * 1000;
    if (cacheFresh && Array.isArray(cachedBotGuilds)) {
      if (cachedBotGuilds.includes(guildId)) {
        return true;
      }
      res.status(400).json({ error: "Bot is not in that guild" });
      return false;
    }
    const botCheck = await ensureBotInGuild(guildId);
    if (botCheck === null) {
      res.status(429).json({ error: "Discord rate limited. Please retry." });
      return false;
    }
    if (!botCheck) {
      res.status(400).json({ error: "Bot is not in that guild" });
      return false;
    }
    sessionData.botGuildIds = Array.from(
      new Set([...(cachedBotGuilds ?? []), guildId]),
    );
    sessionData.botGuildIdsFetchedAt = Date.now();
    return true;
  };

  const requireManageGuild = async (
    req: express.Request,
    res: express.Response,
    user: AuthedUser,
    guildId: string,
  ): Promise<boolean> => {
    const ok = await ensureManageGuildWithUserToken(user.accessToken, guildId, {
      userId: user.id,
      session: req.session,
    });
    if (ok === null) {
      res.status(429).json({ error: "Discord rate limited. Please retry." });
      return false;
    }
    if (!ok) {
      res.status(403).json({ error: "Manage Guild required" });
      return false;
    }
    return true;
  };

  // Context routes
  app.get(
    "/api/guilds/:guildId/context",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser;
      if (!(await requireManageGuild(req, res, user, guildId))) {
        console.warn("Context 403: missing Manage Guild", {
          guildId,
          userId: user?.id,
        });
        return;
      }
      if (!(await ensureBotPresence(req, res, guildId))) {
        return;
      }
      const snapshot = await resolveConfigSnapshot({ guildId });
      const contextValue =
        getSnapshotString(snapshot, SERVER_CONTEXT_KEYS.context, {
          trim: true,
        }) ?? "";
      const defaultNotesChannelId = getSnapshotString(
        snapshot,
        SERVER_CONTEXT_KEYS.defaultNotesChannelId,
        { trim: true },
      );
      const defaultTagsValue = getSnapshotString(
        snapshot,
        SERVER_CONTEXT_KEYS.defaultTags,
        { trim: true },
      );
      const defaultTags = defaultTagsValue
        ? (parseTags(defaultTagsValue) ?? [])
        : [];
      res.json({
        context: contextValue,
        defaultNotesChannelId,
        defaultTags,
      });
    },
  );

  app.post(
    "/api/guilds/:guildId/context",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser & { id: string };
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      if (!(await ensureBotPresence(req, res, guildId))) {
        return;
      }
      const { context, defaultNotesChannelId, defaultTags } = req.body as {
        context?: string;
        defaultNotesChannelId?: string | null;
        defaultTags?: string[];
      };
      if (
        context === undefined &&
        defaultNotesChannelId === undefined &&
        defaultTags === undefined
      ) {
        res.status(400).json({ error: "No updates provided" });
        return;
      }
      const scope = { scope: "server", guildId } as const;
      const tasks: Promise<void>[] = [];
      if (context !== undefined) {
        const trimmed = context.trim();
        if (trimmed.length > 0) {
          tasks.push(
            setConfigOverrideForScope(
              scope,
              SERVER_CONTEXT_KEYS.context,
              trimmed,
              user.id,
            ),
          );
        } else {
          tasks.push(
            clearConfigOverrideForScope(scope, SERVER_CONTEXT_KEYS.context),
          );
        }
      }
      if (defaultNotesChannelId !== undefined) {
        if (defaultNotesChannelId) {
          tasks.push(
            setConfigOverrideForScope(
              scope,
              SERVER_CONTEXT_KEYS.defaultNotesChannelId,
              defaultNotesChannelId,
              user.id,
            ),
          );
        } else {
          tasks.push(
            clearConfigOverrideForScope(
              scope,
              SERVER_CONTEXT_KEYS.defaultNotesChannelId,
            ),
          );
        }
      }
      if (defaultTags !== undefined) {
        const normalized = normalizeTags(defaultTags);
        if (normalized) {
          tasks.push(
            setConfigOverrideForScope(
              scope,
              SERVER_CONTEXT_KEYS.defaultTags,
              normalized.join(", "),
              user.id,
            ),
          );
        } else {
          tasks.push(
            clearConfigOverrideForScope(scope, SERVER_CONTEXT_KEYS.defaultTags),
          );
        }
      }
      await Promise.all(tasks);
      res.json({ ok: true });
    },
  );

  app.delete(
    "/api/guilds/:guildId/context",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser;
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      if (!(await ensureBotPresence(req, res, guildId))) {
        return;
      }
      const scope = { scope: "server", guildId } as const;
      await Promise.all(
        SERVER_CONTEXT_KEY_LIST.map((key) =>
          clearConfigOverrideForScope(scope, key),
        ),
      );
      res.json({ ok: true });
    },
  );

  // Autorecord routes
  app.get(
    "/api/guilds/:guildId/autorecord",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser & { id: string };
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      const rules = await listAutoRecordSettings(guildId);
      res.json({ rules });
    },
  );

  app.post(
    "/api/guilds/:guildId/autorecord",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser & { id: string };
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      const { mode, voiceChannelId, textChannelId, tags } = req.body as {
        mode: "one" | "all";
        voiceChannelId?: string;
        textChannelId?: string;
        tags?: string[];
      };
      if (mode === "one" && !voiceChannelId) {
        res.status(400).json({ error: "voiceChannelId required for mode=one" });
        return;
      }
      const rule = await saveAutoRecordSetting({
        guildId,
        channelId: mode === "all" ? "ALL" : voiceChannelId!,
        textChannelId,
        enabled: true,
        recordAll: mode === "all",
        createdBy: user.id,
        tags,
      });
      res.json({ rule });
    },
  );

  app.delete(
    "/api/guilds/:guildId/autorecord",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser;
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      const { channelId } = req.body as { channelId?: string };
      if (!channelId) {
        res.status(400).json({ error: "channelId is required" });
        return;
      }
      await removeAutoRecordSetting(guildId, channelId);
      res.json({ ok: true });
    },
  );

  // Channel list (text + voice)
  app.get(
    "/api/guilds/:guildId/channels",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser;
      if (!user?.accessToken) {
        res.status(401).json({ error: "No access token. Please re-login." });
        return;
      }
      const sessionData = req.session as typeof req.session & SessionGuildCache;
      const cachedGuilds = sessionData.guildIds ?? [];
      const cachedHasGuild = cachedGuilds.includes(guildId);
      if (!cachedHasGuild) {
        const accessCheck = await ensureUserInGuild(user.accessToken, guildId, {
          session: req.session,
          userId: user.id,
        });
        if (accessCheck === null) {
          res
            .status(429)
            .json({ error: "Discord rate limited. Please retry." });
          return;
        }
        if (!accessCheck) {
          console.warn("Channels 403: user not in guild", {
            guildId,
            userId: user?.id,
          });
          res.status(403).json({ error: "Guild access required" });
          return;
        }
      }
      if (!(await ensureBotPresence(req, res, guildId))) {
        return;
      }
      try {
        const channels = await listGuildChannelsCached(guildId);
        const voiceTypes = new Set([2, 13]);
        const textTypes = new Set([0, 5]);
        const byPosition = (
          a: { position?: number },
          b: { position?: number },
        ) => (a.position ?? 0) - (b.position ?? 0);
        const voiceChannels = channels
          .filter((channel) => voiceTypes.has(channel.type))
          .sort(byPosition)
          .map((channel) => ({ id: channel.id, name: channel.name }));
        const textChannels = channels
          .filter((channel) => textTypes.has(channel.type))
          .sort(byPosition)
          .map((channel) => ({ id: channel.id, name: channel.name }));
        res.json({ voiceChannels, textChannels });
      } catch (err) {
        console.error("Channel list error", err);
        res.status(500).json({ error: "Failed to load guild channels" });
      }
    },
  );

  // Ask route
  app.post(
    "/api/guilds/:guildId/ask",
    requireAuth,
    async (req, res): Promise<void> => {
      const guildId = req.params.guildId;
      const user = req.user as AuthedUser;
      if (!user?.accessToken) {
        res.status(401).json({ error: "No access token. Please re-login." });
        return;
      }
      if (!(await requireManageGuild(req, res, user, guildId))) {
        return;
      }
      const { question, tags, scope, channelId } = req.body as {
        question?: string;
        tags?: string[];
        scope?: "guild" | "channel";
        channelId?: string;
      };
      if (!question) {
        res.status(400).json({ error: "question is required" });
        return;
      }
      const { answer, citations } = await answerQuestionService({
        guildId,
        channelId: channelId || "",
        question,
        tags,
        scope,
        viewerUserId: user.id,
      });
      const portalBaseUrl = config.frontend.siteUrl.trim().replace(/\/$/, "");
      const rendered = renderAskAnswer({
        text: answer,
        citations: citations ?? [],
        guildId,
        portalBaseUrl,
      });
      res.json({ answer: rendered });
    },
  );

  // Guild list (manage-guild intersection)
  app.get("/api/guilds", requireAuth, async (req, res): Promise<void> => {
    const user = req.user as AuthedUser;
    if (!user.accessToken) {
      res.status(401).json({ error: "No access token. Please re-login." });
      return;
    }
    try {
      const userGuilds = await listUserGuildsCached({
        accessToken: user.accessToken,
        userId: user.id,
      });

      const sessionData = req.session as typeof req.session & SessionGuildCache;
      sessionData.guildIds = userGuilds.map((guild) => guild.id);
      sessionData.guildIdsFetchedAt = Date.now();
      sessionData.userGuilds = userGuilds;
      sessionData.userGuildsFetchedAt = sessionData.guildIdsFetchedAt;

      const botGuilds = await listBotGuildsCached();
      const botGuildIds = new Set(botGuilds.map((g) => g.id));
      sessionData.botGuildIds = botGuilds.map((guild) => guild.id);
      sessionData.botGuildIdsFetchedAt = Date.now();

      const MANAGE_GUILD = 1 << 5;
      const ADMIN = 1 << 3;

      const eligible = userGuilds
        .filter((g) => botGuildIds.has(g.id))
        .filter((g) => {
          const perms = BigInt(g.permissions ?? "0");
          return (
            g.owner ||
            (perms & BigInt(MANAGE_GUILD)) !== BigInt(0) ||
            (perms & BigInt(ADMIN)) !== BigInt(0)
          );
        })
        .map((g) => ({
          id: g.id,
          name: g.name,
          icon: g.icon,
        }));

      res.json({ guilds: eligible });
    } catch (err) {
      console.error("Guild list error", err);
      res.status(500).json({ error: "Failed to load guilds" });
    }
  });
}

function requireAuth(
  req: express.Request & { isAuthenticated?: () => boolean },
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.isAuthenticated && req.isAuthenticated()) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated" });
}
