import { config } from "../services/configService";
import {
  deleteStripeWebhookEvent,
  claimStripeWebhookEvent,
  finishStripeWebhookEvent,
  getStripeWebhookEvent,
  tryCreateStripeWebhookEvent,
} from "../db";
import type { StripeWebhookEvent } from "../types/db";
import { getMockStore } from "./mockStore";

export type StripeWebhookRepository = {
  claim: (event: StripeWebhookEvent) => Promise<boolean>;
  finish: (
    eventId: string,
    token: string,
    release?: boolean,
  ) => Promise<boolean>;
  get: (eventId: string) => Promise<StripeWebhookEvent | undefined>;
  tryCreate: (event: StripeWebhookEvent) => Promise<boolean>;
  delete: (eventId: string) => Promise<void>;
};

const realRepository: StripeWebhookRepository = {
  claim: claimStripeWebhookEvent,
  finish: (id, token, release = false) =>
    finishStripeWebhookEvent(id, token, release),
  get: getStripeWebhookEvent,
  tryCreate: tryCreateStripeWebhookEvent,
  delete: deleteStripeWebhookEvent,
};

const mockRepository: StripeWebhookRepository = {
  async claim(event) {
    const events = getMockStore().stripeWebhookEvents;
    const existing = events.get(event.eventId);
    if (
      existing &&
      !(
        existing.state === "processing" &&
        (existing.leaseUntil ?? Infinity) <= Date.now()
      )
    )
      return false;
    events.set(event.eventId, structuredClone(event));
    return true;
  },
  async finish(eventId, token, release = false) {
    const events = getMockStore().stripeWebhookEvents;
    const event = events.get(eventId);
    if (
      !event ||
      event.state !== "processing" ||
      event.leaseToken !== token ||
      (event.leaseUntil ?? 0) <= Date.now()
    )
      return false;
    if (release) events.delete(eventId);
    else {
      const completed: StripeWebhookEvent = {
        eventId,
        receivedAt: event.receivedAt,
        expiresAt: event.expiresAt,
        state: "completed",
      };
      events.set(eventId, completed);
    }
    return true;
  },
  async get(eventId) {
    return getMockStore().stripeWebhookEvents.get(eventId);
  },
  async tryCreate(event) {
    const events = getMockStore().stripeWebhookEvents;
    if (events.has(event.eventId)) return false;
    events.set(event.eventId, event);
    return true;
  },
  async delete(eventId) {
    getMockStore().stripeWebhookEvents.delete(eventId);
  },
};

export function getStripeWebhookRepository(): StripeWebhookRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
