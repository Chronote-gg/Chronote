import { config } from "../services/configService";
import {
  deleteStripeWebhookEvent,
  claimStripeWebhookEvent,
  finishStripeWebhookEvent,
  getStripeWebhookEvent,
  tryCreateStripeWebhookEvent,
  admitStripeWebhookEvent,
  failStripeWebhookEvent,
} from "../db";
import type { StripeWebhookEvent } from "../types/db";
import type { AdmissionContext } from "../types/deploymentControl";
import {
  stripeReceiptBirthSchema,
  canAdmitStripeReceipt,
  stripeReceiptAdmissionSchema,
  STRIPE_RECEIPT_RETENTION_SECONDS,
} from "../types/stripeWebhookReceipt";
import { mockWorkAdmissionAllowed } from "./deploymentControlRepository";
import { getMockStore } from "./mockStore";
export type StripeWebhookRepository = {
  claim(event: StripeWebhookEvent): Promise<boolean>;
  admit(
    eventId: string,
    token: string,
    attemptId: string,
    context: AdmissionContext,
  ): Promise<boolean>;
  fail(eventId: string, token: string): Promise<boolean>;
  finish(eventId: string, token: string, release?: boolean): Promise<boolean>;
  get(eventId: string): Promise<StripeWebhookEvent | undefined>;
  tryCreate(event: StripeWebhookEvent): Promise<boolean>;
  delete(eventId: string): Promise<void>;
};
const realRepository: StripeWebhookRepository = {
  claim: claimStripeWebhookEvent,
  admit: admitStripeWebhookEvent,
  fail: failStripeWebhookEvent,
  finish: (id, token, release = false) =>
    finishStripeWebhookEvent(id, token, release),
  get: getStripeWebhookEvent,
  tryCreate: tryCreateStripeWebhookEvent,
  delete: deleteStripeWebhookEvent,
};
function owns(
  event: StripeWebhookEvent | undefined,
  token: string,
): event is StripeWebhookEvent {
  return Boolean(
    event?.state === "processing" &&
    event.leaseToken === token &&
    (event.leaseUntil ?? 0) > Date.now(),
  );
}
const mockRepository: StripeWebhookRepository = {
  async claim(event) {
    const events = getMockStore().stripeWebhookEvents,
      existing = events.get(event.eventId);
    if (
      existing &&
      !(
        existing.state === "processing" &&
        (existing.leaseUntil ?? Infinity) <= Date.now()
      )
    )
      return false;
    const next = existing
      ? {
          ...existing,
          leaseToken: event.leaseToken,
          leaseUntil: event.leaseUntil,
        }
      : structuredClone(event);
    delete next.expiresAt;
    events.set(event.eventId, next);
    return true;
  },
  async admit(eventId, token, attemptId, context) {
    const store = getMockStore(),
      event = store.stripeWebhookEvents.get(eventId);
    if (
      !owns(event, token) ||
      !stripeReceiptBirthSchema.safeParse(event.birth).success
    )
      return false;
    if (!canAdmitStripeReceipt(event)) return false;
    if (
      !mockWorkAdmissionAllowed(
        { kind: "serving", context },
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      )
    )
      return false;
    const admission = stripeReceiptAdmissionSchema.parse({
      attemptId,
      leaseToken: token,
      runtime: context.identity,
      generation: context.authorizedGeneration,
      admittedAt: context.now,
    });
    event.firstAdmission ??= structuredClone(admission);
    event.admission = { ...admission, status: "running" };
    event.continuation = "admitted";
    delete event.expiresAt;
    return true;
  },
  async fail(eventId, token) {
    const event = getMockStore().stripeWebhookEvents.get(eventId);
    if (!owns(event, token) || event.admission?.leaseToken !== token)
      return false;
    event.admission.status = "failed";
    event.leaseUntil = 0;
    delete event.expiresAt;
    return true;
  },
  async finish(eventId, token, release = false) {
    const event = getMockStore().stripeWebhookEvents.get(eventId);
    if (
      !owns(event, token) ||
      (event.firstAdmission && event.admission?.leaseToken !== token)
    )
      return false;
    if (release) {
      event.leaseUntil = 0;
      delete event.expiresAt;
    } else {
      event.state = "completed";
      event.expiresAt =
        Math.floor(Date.now() / 1000) + STRIPE_RECEIPT_RETENTION_SECONDS;
      delete event.leaseToken;
      delete event.leaseUntil;
    }
    return true;
  },
  async get(eventId) {
    return structuredClone(getMockStore().stripeWebhookEvents.get(eventId));
  },
  async tryCreate(event) {
    const events = getMockStore().stripeWebhookEvents;
    if (events.has(event.eventId)) return false;
    events.set(event.eventId, structuredClone(event));
    return true;
  },
  async delete(eventId) {
    getMockStore().stripeWebhookEvents.delete(eventId);
  },
};
export function getStripeWebhookRepository(): StripeWebhookRepository {
  return config.mock.enabled ? mockRepository : realRepository;
}
