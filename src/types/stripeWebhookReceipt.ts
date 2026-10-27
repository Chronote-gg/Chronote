import { z } from "zod";
import { runtimeIdentitySchema } from "./deploymentControl";
import { maintenanceHoldSchema } from "./productionIntroduction";
export const STRIPE_RECEIPT_BOUNDARY = "stripe-receipt-admission-v1";
export const stripeReceiptBirthSchema = z
  .object({
    version: z.literal(STRIPE_RECEIPT_BOUNDARY),
    writer: runtimeIdentitySchema,
    hold: maintenanceHoldSchema.optional(),
  })
  .strict();
export type StripeReceiptBirth = z.infer<typeof stripeReceiptBirthSchema>;
export const stripeReceiptAdmissionSchema = z
  .object({
    attemptId: z.string().uuid(),
    leaseToken: z.string().min(1),
    runtime: runtimeIdentitySchema,
    generation: z.number().int().nonnegative(),
    admittedAt: z.number().int().nonnegative(),
  })
  .strict();
export type StripeReceiptAdmission = z.infer<
  typeof stripeReceiptAdmissionSchema
>;
export const STRIPE_RECEIPT_RETENTION_SECONDS = 60 * 60 * 24 * 30;

export interface StripeWebhookEvent {
  birth?: StripeReceiptBirth;
  continuation?: "not_admitted" | "admitted";
  firstAdmission?: StripeReceiptAdmission;
  admission?: StripeReceiptAdmission & {
    status: "running" | "failed";
  };
  state?: "processing" | "completed";
  leaseToken?: string;
  leaseUntil?: number;
  eventId: string;
  receivedAt: string;
  expiresAt?: number;
}

const failedAdmissionSchema = stripeReceiptAdmissionSchema.extend({
  status: z.literal("failed"),
});
export function canAdmitStripeReceipt(event: StripeWebhookEvent): boolean {
  if (event.continuation === "not_admitted")
    return event.firstAdmission === undefined && event.admission === undefined;
  return (
    event.continuation === "admitted" &&
    stripeReceiptAdmissionSchema.safeParse(event.firstAdmission).success &&
    failedAdmissionSchema.safeParse(event.admission).success
  );
}
