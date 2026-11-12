import type { AsyncLocalStorage } from "node:async_hooks";
import type { WorkerGate } from "./world";

/** Where a scenario worker given `ECS_AGENT_URI` finds its container agent. */
export const SCENARIO_ECS_AGENT_URI = "http://scenario-ecs-agent.invalid";
const PROTECTION_PATH = "/task-protection/v1/state";
const REFUSED_STATUS = 400;
const MS_PER_MINUTE = 60_000;
const SCENARIO_TASK_ARN =
  "arn:aws:ecs:us-east-1:000000000000:task/scenario/00000000000000000000000000000000";
const JSON_HEADERS = { "content-type": "application/json" };

export type ProtectionCall = {
  atMs: number;
  /** The worker that asked; a dead worker's requests never reach the agent. */
  instanceId?: string;
  body: { ProtectionEnabled?: boolean; ExpiresInMinutes?: number };
  /** The expiry the agent granted, for an accepted enable. */
  expiresAtMs?: number;
};

const protection = (enabled: boolean, expiresAtMs?: number) =>
  new Response(
    JSON.stringify({
      protection: {
        TaskArn: SCENARIO_TASK_ARN,
        ProtectionEnabled: enabled,
        ExpirationDate:
          expiresAtMs === undefined
            ? null
            : new Date(expiresAtMs).toISOString(),
      },
    }),
    { status: 200, headers: JSON_HEADERS },
  );

/**
 * The ECS container agent's task protection endpoint. It records every
 * request, refuses the first `refusedEnables` enables (as ECS may for a second
 * task; every one by default), grants the rest for the minutes asked, and
 * accepts every disable, so a worker's clearing ends.
 */
export class FakeEcsAgent {
  readonly calls: ProtectionCall[] = [];
  refusedEnables = Number.POSITIVE_INFINITY;

  constructor(private readonly workers: AsyncLocalStorage<WorkerGate>) {}

  fetch(fallback: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SCENARIO_ECS_AGENT_URI + PROTECTION_PATH)
        return fallback(input, init);
      const worker = this.workers.getStore();
      worker?.assertAlive();
      const call: ProtectionCall = {
        atMs: Date.now(),
        instanceId: worker?.instanceId,
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      this.calls.push(call);
      if (call.body.ProtectionEnabled === false) return protection(false);
      const enables = this.calls.filter(
        (made) => made.body.ProtectionEnabled === true,
      ).length;
      if (enables > this.refusedEnables) {
        call.expiresAtMs =
          call.atMs + (call.body.ExpiresInMinutes ?? 0) * MS_PER_MINUTE;
        return protection(true, call.expiresAtMs);
      }
      return new Response(
        JSON.stringify({ failure: { Reason: "Scenario agent refuses" } }),
        { status: REFUSED_STATUS, headers: JSON_HEADERS },
      );
    };
  }
}
