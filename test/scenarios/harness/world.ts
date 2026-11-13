import type * as DynamoSdk from "@aws-sdk/client-dynamodb";
import type * as DiscordJs from "discord.js";
import type * as DiscordVoice from "@discordjs/voice";
import type * as PrismMedia from "prism-media";
import type * as LifecycleTiming from "../../../src/services/lifecycleTiming";
import type * as StorageService from "../../../src/services/storageService";
import type * as OpenAIClientModule from "../../../src/services/openaiClient";
import type * as LangfusePromptService from "../../../src/services/langfusePromptService";
import type * as SavedRecordingPrompt from "../../../src/services/savedRecordingPrompt";
import type { ActiveMeetingLease, MeetingHistory } from "../../../src/types/db";
import {
  createFakeClientClass,
  FakeDiscord,
  type FakeInteraction,
  type FakeMember,
} from "./fakeDiscord";
import { FakeEcsAgent } from "./fakeEcsAgent";
import { FakeStorage } from "./fakeStorage";
import {
  createPromptModule,
  createSavedPromptModule,
  FakeOpenAI,
} from "./fakeOpenAI";
import { FakeVoice, passthroughOpus } from "./fakeVoice";
import {
  createScenarioTables,
  scenarioDynamoConfig,
  type RegistryView,
} from "./tables";

export type ScenarioWorker = {
  instanceId: string;
  /** Pass the same `interactionId` to several workers to deliver one interaction to each, as Discord does. */
  command(
    name: string,
    options: object,
    as: FakeMember,
    interactionId?: string,
  ): Promise<FakeInteraction>;
  button(
    customId: string,
    messageId: string,
    as: FakeMember,
    interactionId?: string,
  ): Promise<FakeInteraction>;
  /** A modal submitted with its text inputs, keyed by input custom id. */
  modal(
    customId: string,
    fields: Record<string, string>,
    as: FakeMember,
    interactionId?: string,
  ): Promise<FakeInteraction>;
  /** Resolves with the time the turn's last frame was delivered. */
  speak(guildId: string, userId: string, pcm: Buffer): Promise<number>;
  /** Resolves once the worker's voice state handlers for the join have settled. */
  joinVoice(
    guildId: string,
    channelId: string,
    member: FakeMember,
  ): Promise<void>;
  /** The member leaves voice; resolves once the worker's handlers have settled. */
  leaveVoice(guildId: string, member: FakeMember): Promise<void>;
  /** This worker's voice connections and the departures it made. */
  voice: FakeVoice;
  network: { block(): void; unblock(): void };
  kill(): void;
  /** The worker's own shutdown sequence, as SIGTERM runs it, without exiting the process. */
  sigterm(): Promise<void>;
};

export type World = {
  discord: FakeDiscord;
  ecsAgent: FakeEcsAgent;
  storage: FakeStorage;
  openai: FakeOpenAI;
  startWorker(options: WorkerOptions): Promise<ScenarioWorker>;
  seedLegacyRuntime(heartbeatAt: number): Promise<void>;
  rows: {
    history(guildId: string): Promise<MeetingHistory[]>;
    /** Writes a history row directly, as an earlier worker would have left it. */
    seedHistory(row: MeetingHistory): Promise<void>;
    /** Writes any item, as the portal or an earlier configuration would have left it. */
    put(tableName: string, item: object): Promise<void>;
    get(
      tableName: string,
      key: Record<string, string>,
    ): Promise<Record<string, unknown> | undefined>;
    lease(guildId: string): Promise<ActiveMeetingLease | undefined>;
    registry(): Promise<RegistryView>;
  };
  dispose(): Promise<void>;
};

/** Second-scale lifecycle durations so scenarios run on the real clock. */
export const SCENARIO_LIFECYCLE_OVERRIDES = {
  leaseSeconds: 2,
  leaseHeartbeatMs: 500,
  registryHeartbeatMs: 500,
  finisherScanMs: 1_000,
  finishBackoffSeconds: [1, 2, 3],
  deliveryBackoffSeconds: [1, 2, 3],
} as const;

export type WorkerOptions = {
  release: number;
  instanceId?: string;
  /** Environment the worker reads at import, such as `ECS_AGENT_URI`. */
  env?: Record<string, string>;
  /** Scales down further durations for one worker, on top of the scenario defaults. */
  lifecycle?: Partial<
    Record<keyof typeof LifecycleTiming.LIFECYCLE, number | readonly number[]>
  >;
};

/**
 * One simulated worker's liveness. `block` holds its DynamoDB requests until
 * `unblock` (a partition that heals); `kill` makes every seam throw, including
 * requests already held.
 */
export class WorkerGate {
  private killed = false;
  private held: { promise: Promise<void>; release(): void } | undefined;

  constructor(readonly instanceId: string) {}

  get alive(): boolean {
    return !this.killed;
  }

  assertAlive(): void {
    if (this.killed)
      throw new Error(`Scenario worker ${this.instanceId} was killed`);
  }

  async passNetwork(): Promise<void> {
    this.assertAlive();
    while (this.held) await this.held.promise;
    this.assertAlive();
  }

  block(): void {
    if (this.held) return;
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { promise, release };
  }

  unblock(): void {
    this.held?.release();
    this.held = undefined;
  }

  kill(): void {
    this.killed = true;
    this.unblock();
  }
}

export type WorkerSeams = {
  instanceId: string;
  voice: FakeVoice;
  network: { block(): void; unblock(): void };
  kill(): void;
  /**
   * Runs worker code in this worker's async context, so the timers and
   * promises it creates stay attributed to it and its Discord REST and fetch
   * calls throw once it is killed. Every entry point that drives the worker
   * (start-up, command, button, speak, joinVoice, sigterm) goes through it.
   */
  run<T>(work: () => T): T;
};

/**
 * Registers this worker's fakes with `jest.doMock`. Call it inside
 * `jest.isolateModulesAsync` and import the worker's modules in the same
 * callback, so its singletons and seams belong to it alone.
 */
export function installWorkerSeams(
  world: Pick<World, "discord" | "storage" | "openai">,
  options: {
    instanceId: string;
    release: number;
    lifecycle?: WorkerOptions["lifecycle"];
  },
): WorkerSeams {
  const gate = new WorkerGate(options.instanceId);
  const voice = new FakeVoice(gate);
  process.env.BOT_INSTANCE_ID = options.instanceId;
  process.env.WORKER_RELEASE = String(options.release);

  // Several repositories build their own client, so the gate goes on the SDK class.
  jest.doMock("@aws-sdk/client-dynamodb", () => {
    const sdk = jest.requireActual<typeof DynamoSdk>(
      "@aws-sdk/client-dynamodb",
    );
    class GatedDynamoDBClient extends sdk.DynamoDBClient {
      constructor() {
        super(scenarioDynamoConfig());
        this.middlewareStack.add(
          (next) => async (args) => {
            await gate.passNetwork();
            return next(args);
          },
          { step: "initialize", name: "scenarioWorkerGate" },
        );
      }
    }
    return { ...sdk, DynamoDBClient: GatedDynamoDBClient };
  });
  jest.doMock("../../../src/services/lifecycleTiming", () => {
    const actual = jest.requireActual<typeof LifecycleTiming>(
      "../../../src/services/lifecycleTiming",
    );
    const lifecycle = {
      ...actual.LIFECYCLE,
      ...SCENARIO_LIFECYCLE_OVERRIDES,
      ...options.lifecycle,
    };
    return {
      ...actual,
      LIFECYCLE: lifecycle,
      // The actual function reads the actual grace; shifting the duration applies this worker's.
      leaseCapEpochSeconds: (reservedAtMs: number, maxDurationMs: number) =>
        actual.leaseCapEpochSeconds(
          reservedAtMs,
          maxDurationMs +
            Number(lifecycle.leaseCapGraceMs) -
            actual.LIFECYCLE.leaseCapGraceMs,
        ),
    };
  });
  jest.doMock("../../../src/services/storageService", () =>
    world.storage.createModule(
      jest.requireActual<typeof StorageService>(
        "../../../src/services/storageService",
      ),
      gate,
    ),
  );
  jest.doMock("../../../src/services/openaiClient", () =>
    world.openai.createModule(
      jest.requireActual<typeof OpenAIClientModule>(
        "../../../src/services/openaiClient",
      ),
      gate,
    ),
  );
  jest.doMock("../../../src/services/langfusePromptService", () =>
    createPromptModule(
      jest.requireActual<typeof LangfusePromptService>(
        "../../../src/services/langfusePromptService",
      ),
    ),
  );
  jest.doMock("../../../src/services/savedRecordingPrompt", () =>
    createSavedPromptModule(
      jest.requireActual<typeof SavedRecordingPrompt>(
        "../../../src/services/savedRecordingPrompt",
      ),
    ),
  );
  jest.doMock("discord.js", () => {
    const actual = jest.requireActual<typeof DiscordJs>("discord.js");
    return {
      ...actual,
      Client: createFakeClientClass(actual, world.discord, gate),
    };
  });
  jest.doMock("@discordjs/voice", () =>
    voice.createModule(
      jest.requireActual<typeof DiscordVoice>("@discordjs/voice"),
    ),
  );
  jest.doMock("prism-media", () =>
    passthroughOpus(jest.requireActual<typeof PrismMedia>("prism-media")),
  );

  return {
    instanceId: options.instanceId,
    voice,
    network: { block: () => gate.block(), unblock: () => gate.unblock() },
    kill: () => gate.kill(),
    run: (work) => world.discord.workers.run(gate, work),
  };
}

export async function createWorld(): Promise<World> {
  // Loaded here, not at the top, because the worker entry imports this module's seams.
  const { startScenarioWorker } = await import("./worker");
  const tables = await createScenarioTables();
  const previousPrefix = process.env.DDB_TABLE_PREFIX;
  process.env.DDB_TABLE_PREFIX = tables.prefix;
  const discord = new FakeDiscord();
  const ecsAgent = new FakeEcsAgent(discord.workers);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ecsAgent.fetch(discord.fetch(originalFetch));
  const world: World = {
    discord,
    ecsAgent,
    storage: new FakeStorage(),
    openai: new FakeOpenAI(),
    startWorker: (options) => startScenarioWorker(world, options),
    seedLegacyRuntime: tables.seedLegacyRuntime,
    rows: tables.rows,
    async dispose() {
      globalThis.fetch = originalFetch;
      if (previousPrefix === undefined) delete process.env.DDB_TABLE_PREFIX;
      else process.env.DDB_TABLE_PREFIX = previousPrefix;
      await tables.dispose();
    },
  };
  return world;
}
