import { randomUUID } from "node:crypto";
// discord.js requires some structures lazily. After a worker's isolated registry closes those
// requires resolve in the shared one, which must already hold the library loaded from its entry.
import "discord.js";
import type * as DiscordJs from "discord.js";
import type { Client } from "discord.js";
import type * as WorkerApp from "../../../src/apps/worker";
import type * as ClientAccessor from "../../../src/services/discordClientAccessor";
import { userPayload, type FakeMember, type RestCall } from "./fakeDiscord";
import {
  installWorkerSeams,
  type ScenarioWorker,
  type WorkerOptions,
  type World,
} from "./world";

const INTERACTION_TYPE = { command: 2, component: 3, modal: 5 } as const;
const CHAT_INPUT_COMMAND = 1;
const BUTTON_COMPONENT = 2;
const ACTION_ROW_COMPONENT = 1;
const TEXT_INPUT_COMPONENT = 4;
const SUBCOMMAND_OPTION = 1;
const STRING_OPTION = 3;

/** String options; a `subcommand` key names the subcommand they belong to. */
function commandOptionsPayload(options: object) {
  const { subcommand, ...rest } = Object.fromEntries(Object.entries(options));
  const values = Object.entries(rest).map(([name, value]) => ({
    name,
    type: STRING_OPTION,
    value,
  }));
  return typeof subcommand === "string"
    ? [{ name: subcommand, type: SUBCOMMAND_OPTION, options: values }]
    : values;
}
const TEXT_CHANNEL = 0;

/** Only the names the worker reads at import; they are restored once its configuration has loaded. */
const WORKER_ENV = {
  // A worker outside ECS refuses to start unless it targets local storage.
  NODE_ENV: "development",
  USE_LOCAL_DYNAMODB: "true",
};

function withEnv<T>(values: Record<string, string>, load: () => Promise<T>) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  return load().finally(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}

/** Emits a gateway event through discord.js and resolves once every listener the worker registered has settled. */
async function dispatch(
  client: Client,
  event: string,
  trigger: () => void,
): Promise<void> {
  const listeners = client.rawListeners(event);
  client.removeAllListeners(event);
  let args: unknown[] = [];
  client.once(event, (...received: unknown[]) => {
    args = received;
  });
  try {
    trigger();
  } finally {
    for (const listener of listeners)
      client.on(event, (...received: unknown[]) =>
        Reflect.apply(listener, client, received),
      );
  }
  await Promise.all(
    listeners.map((listener) => Reflect.apply(listener, client, args)),
  );
}

function guildOf(world: World, member: FakeMember) {
  for (const guild of world.discord.guilds.values())
    if (guild.members.has(member.id)) return guild;
  throw new Error(`Scenario member ${member.id} is in no guild`);
}

function textChannelOf(world: World, guildId: string): string {
  const guild = world.discord.guilds.get(guildId);
  const text = [...(guild?.channels.values() ?? [])].find(
    (channel) => channel.kind === "text",
  );
  if (!text) throw new Error(`Scenario guild ${guildId} has no text channel`);
  return text.id;
}

function memberPayload(member: FakeMember) {
  return {
    user: userPayload(member),
    roles: [],
    joined_at: new Date(0).toISOString(),
    deaf: false,
    mute: false,
    flags: 0,
  };
}

/** One worker started through the production composition root, inside its own module registry. */
export function startScenarioWorker(
  world: World,
  options: WorkerOptions,
): Promise<ScenarioWorker> {
  const instanceId = options.instanceId ?? `scenario-worker-${randomUUID()}`;
  let worker: ScenarioWorker | undefined;
  // A running worker's lazy import after its isolated registry closed resolves in the shared
  // registry, which caches the mocks it builds there; an isolated registry still finds a mock
  // cached in the shared one, so a later worker would receive an earlier worker's fakes.
  // The shared registry starts again, from discord.js's own entry as noted above.
  jest.resetModules();
  jest.requireActual("discord.js");
  // Resolved only once the isolated registry has closed, so the next worker can open its own.
  return jest
    .isolateModulesAsync(async () => {
      const seams = installWorkerSeams(world, {
        instanceId,
        release: options.release,
        lifecycle: options.lifecycle,
      });
      const [app, accessor, djs] = await withEnv(
        { ...WORKER_ENV, ...options.env },
        () =>
          seams.run(() =>
            Promise.all([
              import("../../../src/apps/worker") as Promise<typeof WorkerApp>,
              import("../../../src/services/discordClientAccessor") as Promise<
                typeof ClientAccessor
              >,
              import("discord.js") as Promise<typeof DiscordJs>,
            ]),
          ),
      );
      const started = await seams.run(() => app.startWorker({ mode: "bot" }));
      const client = accessor.getDiscordClient();
      if (!client) throw new Error("The scenario worker did not log in");
      const actions: Record<string, { handle(data: unknown): void }> =
        Reflect.get(client, "actions");

      const interact = async (
        as: FakeMember,
        payload: (base: Record<string, unknown>) => Record<string, unknown>,
        interactionId?: string,
      ) => {
        const guild = guildOf(world, as);
        const channelId = textChannelOf(world, guild.id);
        const id = interactionId ?? djs.SnowflakeUtil.generate().toString();
        const token = `scenario-token-${id}`;
        const base = {
          id,
          token,
          application_id: client.application?.id ?? world.discord.bot.id,
          version: 1,
          guild_id: guild.id,
          channel_id: channelId,
          channel: { id: channelId, type: TEXT_CHANNEL, guild_id: guild.id },
          member: memberPayload(as),
          app_permissions: String(djs.PermissionFlagsBits.Administrator),
          locale: "en-US",
          guild_locale: "en-US",
          entitlements: [],
          // A guild install; discord.js reads the owners map for every interaction.
          authorizing_integration_owners: { "0": guild.id },
          context: 0,
        };
        await seams.run(() =>
          dispatch(client, djs.Events.InteractionCreate, () =>
            actions.InteractionCreate.handle(payload(base)),
          ),
        );
        const responses = world.discord.rest
          .requests()
          .filter(
            (call: RestCall) =>
              call.path.includes(`/interactions/${id}/`) ||
              call.path.includes(`/${token}`),
          );
        return { id, responses };
      };

      const voiceState = (
        guildId: string,
        channelId: string | null,
        member: FakeMember,
      ) =>
        seams.run(() =>
          dispatch(client, djs.Events.VoiceStateUpdate, () =>
            actions.VoiceStateUpdate.handle({
              guild_id: guildId,
              channel_id: channelId,
              user_id: member.id,
              member: memberPayload(member),
              session_id: `scenario-session-${member.id}`,
              deaf: false,
              mute: false,
              self_deaf: false,
              self_mute: false,
              self_video: false,
              suppress: false,
              request_to_speak_timestamp: null,
            }),
          ),
        );

      worker = {
        instanceId,
        command: (name, commandOptions, as, interactionId) =>
          interact(
            as,
            (base) => ({
              ...base,
              type: INTERACTION_TYPE.command,
              data: {
                id: djs.SnowflakeUtil.generate().toString(),
                name,
                type: CHAT_INPUT_COMMAND,
                options: commandOptionsPayload(commandOptions),
              },
            }),
            interactionId,
          ),
        button: (customId, messageId, as, interactionId) =>
          interact(
            as,
            (base) => ({
              ...base,
              type: INTERACTION_TYPE.component,
              data: { custom_id: customId, component_type: BUTTON_COMPONENT },
              message: world.discord.rest.messageData(messageId),
            }),
            interactionId,
          ),
        modal: (customId, fields, as, interactionId) =>
          interact(
            as,
            (base) => ({
              ...base,
              type: INTERACTION_TYPE.modal,
              data: {
                custom_id: customId,
                components: Object.entries(fields).map(([id, value]) => ({
                  type: ACTION_ROW_COMPONENT,
                  components: [
                    { type: TEXT_INPUT_COMPONENT, custom_id: id, value },
                  ],
                })),
              },
            }),
            interactionId,
          ),
        speak: (guildId, userId, pcm) =>
          seams.run(() => seams.voice.speak(guildId, userId, pcm)),
        joinVoice: (guildId, channelId, member) =>
          voiceState(guildId, channelId, member),
        leaveVoice: (guildId, member) => voiceState(guildId, null, member),
        voice: seams.voice,
        network: seams.network,
        kill: seams.kill,
        sigterm: () => seams.run(() => started.stop()),
      };
    })
    .then(() => {
      if (!worker) throw new Error("The scenario worker did not start");
      return worker;
    });
}
