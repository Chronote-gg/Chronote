import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { StripeWebhookEvent } from "../types/db";
import type {
  AdmissionContext,
  ControlTableNames,
} from "../types/deploymentControl";
import {
  stripeReceiptBirthSchema,
  canAdmitStripeReceipt,
  stripeReceiptAdmissionSchema,
  STRIPE_RECEIPT_RETENTION_SECONDS,
} from "../types/stripeWebhookReceipt";
import { buildRuntimeAdmissionChecks } from "../services/deploymentControlTransactions";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";
async function conditional(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") return false;
    throw error;
  }
}
export function createStripeWebhookDynamoRepository(
  client: DynamoDBClient,
  table: string,
  tables: ControlTableNames,
) {
  const get = async (
    eventId: string,
  ): Promise<StripeWebhookEvent | undefined> => {
    const result = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall({ eventId }),
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? (unmarshall(result.Item) as StripeWebhookEvent)
      : undefined;
  };
  const tryCreate = (event: StripeWebhookEvent) =>
    conditional(() =>
      client.send(
        new PutItemCommand({
          TableName: table,
          Item: marshall(event, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(eventId)",
        }),
      ),
    );
  return {
    get,
    tryCreate,
    delete: async (eventId: string) => {
      await client.send(
        new DeleteItemCommand({ TableName: table, Key: marshall({ eventId }) }),
      );
    },
    async claim(event: StripeWebhookEvent) {
      const { expiresAt, ...retained } = event;
      void expiresAt;
      if (await tryCreate(retained)) return true;
      return conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: marshall({ eventId: event.eventId }),
            ConditionExpression: "#state = :processing AND leaseUntil <= :now",
            UpdateExpression:
              "SET leaseToken = :token, leaseUntil = :until REMOVE expiresAt",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: marshall({
              ":processing": "processing",
              ":now": Date.now(),
              ":token": event.leaseToken,
              ":until": event.leaseUntil,
            }),
          }),
        ),
      );
    },
    async admit(
      eventId: string,
      leaseToken: string,
      attemptId: string,
      context: AdmissionContext,
    ) {
      const event = await get(eventId);
      const birth = stripeReceiptBirthSchema.safeParse(event?.birth);
      if (!birth.success || !event || !canAdmitStripeReceipt(event))
        return false;
      const admission = stripeReceiptAdmissionSchema.parse({
        attemptId,
        leaseToken,
        runtime: context.identity,
        generation: context.authorizedGeneration,
        admittedAt: context.now,
      });
      return conditional(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              ...buildRuntimeAdmissionChecks(context, tables),
              {
                Update: {
                  TableName: table,
                  Key: marshall({ eventId }),
                  ConditionExpression:
                    "#state = :processing AND leaseToken = :token AND leaseUntil > :now AND birth = :birth AND " +
                    (event.continuation === "not_admitted"
                      ? "(continuation = :new AND attribute_not_exists(firstAdmission) AND attribute_not_exists(admission))"
                      : "(continuation = :admitted AND firstAdmission = :priorFirst AND admission = :priorAttempt)"),
                  UpdateExpression:
                    "SET firstAdmission = if_not_exists(firstAdmission, :first), admission = :attempt, continuation = :admitted REMOVE expiresAt",
                  ExpressionAttributeNames: {
                    "#state": "state",
                  },
                  ExpressionAttributeValues: marshall({
                    ":processing": "processing",
                    ":token": leaseToken,
                    ":now": Date.now(),
                    ":birth": birth.data,
                    ":admitted": "admitted",
                    ...(event.continuation === "not_admitted"
                      ? { ":new": "not_admitted" }
                      : {
                          ":priorFirst": event.firstAdmission,
                          ":priorAttempt": event.admission,
                        }),
                    ":first": admission,
                    ":attempt": { ...admission, status: "running" },
                  }),
                },
              },
            ],
          }),
        ),
      );
    },
    finish(eventId: string, leaseToken: string, release = false) {
      return conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: marshall({ eventId }),
            ConditionExpression:
              "#state = :processing AND leaseToken = :token AND leaseUntil > :now AND (attribute_not_exists(firstAdmission) OR admission.leaseToken = :token)",
            UpdateExpression: release
              ? "SET leaseUntil = :released REMOVE expiresAt"
              : "SET #state = :completed, expiresAt = :expiry REMOVE leaseToken, leaseUntil",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: marshall({
              ":processing": "processing",
              ":token": leaseToken,
              ":now": Date.now(),
              ...(release
                ? { ":released": 0 }
                : {
                    ":completed": "completed",
                    ":expiry":
                      Math.floor(Date.now() / 1000) +
                      STRIPE_RECEIPT_RETENTION_SECONDS,
                  }),
            }),
          }),
        ),
      );
    },
    fail(eventId: string, leaseToken: string) {
      return conditional(() =>
        client.send(
          new UpdateItemCommand({
            TableName: table,
            Key: marshall({ eventId }),
            ConditionExpression:
              "#state = :processing AND leaseToken = :token AND leaseUntil > :now AND admission.leaseToken = :token",
            UpdateExpression:
              "SET admission.#status = :failed, leaseUntil = :released REMOVE expiresAt",
            ExpressionAttributeNames: {
              "#state": "state",
              "#status": "status",
            },
            ExpressionAttributeValues: marshall({
              ":processing": "processing",
              ":token": leaseToken,
              ":now": Date.now(),
              ":failed": "failed",
              ":released": 0,
            }),
          }),
        ),
      );
    },
  };
}
