import { config } from "../services/configService";
import {
  deleteStripeWebhookEvent,
  getStripeWebhookEvent,
  tryCreateStripeWebhookEvent,
} from "../db";
import type { StripeWebhookEvent } from "../types/db";
import { getMockStore } from "./mockStore";

export type StripeWebhookRepository = {
  get: (eventId: string) => Promise<StripeWebhookEvent | undefined>;
  tryCreate: (event: StripeWebhookEvent) => Promise<boolean>;
  delete: (eventId: string) => Promise<void>;
};

const realRepository: StripeWebhookRepository = {
  get: getStripeWebhookEvent,
  tryCreate: tryCreateStripeWebhookEvent,
  delete: deleteStripeWebhookEvent,
};

const mockRepository: StripeWebhookRepository = {
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
