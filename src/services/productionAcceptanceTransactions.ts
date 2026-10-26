import { isDeepStrictEqual as same } from "node:util";
import { z } from "zod";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  introductionHoldSchema,
  type IntroductionHold,
} from "../types/productionIntroduction";
import {
  controlRecordSchema,
  type ControlRecord,
} from "../types/deploymentControl";
import {
  introductionActionSchema,
  introductionAuthoritySchema,
  type IntroductionAction,
  type IntroductionAuthority,
} from "./productionIntroductionTransactions";
import { launcherObservationSchema } from "./productionIntroductionHistory";
import {
  snapshotCondition,
  completeItemSizeBound,
  assertTransactionCapacity,
} from "./productionAcceptanceConditions";
const id = z.string().min(1).max(1024),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const acceptanceRecordSchema = z
  .object({
    pk: id,
    sk: z.literal("ACCEPTANCE"),
    recordType: z.literal("production_acceptance"),
    protocolVersion: z.literal(1),
    acceptanceId: id,
    holdId: id,
    introductionId: id,
    manifestHash: hash,
    revision: z.literal(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    originalRunId: id,
    originalRunAttempt: z.literal("1"),
    supplementCommit: z.string().regex(/^[a-f0-9]{40}$/),
    supplementHash: hash,
    fixtureEvidenceHash: hash,
    historyEvidenceHash: hash,
    writerClosureHash: hash,
    retainedDispositionHash: hash,
    launcherBaselineHash: hash,
    handoffAt: z.string().datetime(),
    retiredAt: z.number().int().nonnegative(),
    servingGeneration: z.number().int().positive(),
    servingMembersHash: hash,
  })
  .strict();
export type AcceptanceRecord = z.infer<typeof acceptanceRecordSchema>;
export type AcceptancePurpose =
  "persist_acceptance" | "reopen_admission" | "release_deployment";
export type AcceptanceGuard = {
  table: string;
  key: Record<string, unknown>;
  row: Record<string, unknown>;
  fields: readonly string[];
  maximumItemBytes: number;
  presentFields?: readonly string[];
};
export type FinalAcceptanceInput = {
  purpose: AcceptancePurpose;
  table: string;
  hold: IntroductionHold;
  control: ControlRecord;
  authority: IntroductionAuthority;
  action: IntroductionAction;
  acceptance: AcceptanceRecord;
  guards: AcceptanceGuard[];
  now: number;
  launcher: z.infer<typeof launcherObservationSchema>;
};
function refuse(): never {
  throw new Error("acceptance_transaction_refused");
}
function check(
  table: string,
  row: Record<string, unknown>,
  fields = Object.keys(row),
): NonNullable<TransactWriteItem["ConditionCheck"]> {
  return snapshotCondition(table, { pk: row.pk, sk: row.sk }, row, fields);
}
function checkedPut(
  table: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  fields?: string[],
): TransactWriteItem {
  const condition = check(table, previous, fields);
  const {
    TableName,
    ConditionExpression,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  } = condition;
  return {
    Put: {
      TableName,
      ConditionExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      Item: marshall(next),
    },
  };
}
function assertAcceptanceIdentity(input: FinalAcceptanceInput) {
  const { hold, authority, action, acceptance: a } = input;
  for (const key of [
    "holdId",
    "introductionId",
    "manifestHash",
    "revision",
  ] as const)
    if (
      hold[key] !== authority[key] ||
      hold[key] !== action[key] ||
      hold[key] !== a[key]
    )
      refuse();
  for (const key of ["actor", "runToken", "operationId"] as const)
    if (action[key] !== authority[key]) refuse();
}
function assertAdmissionState(input: FinalAcceptanceInput) {
  const { hold, control, acceptance: a } = input;
  const held = {
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    revision: hold.revision,
  };
  if (input.purpose === "release_deployment") {
    if (
      hold.admission.state !== "reopened" ||
      hold.admission.receiptId !== a.acceptanceId ||
      control.maintenance !== undefined
    )
      refuse();
  } else if (
    hold.admission.state !== "held" ||
    !same(control.maintenance, held)
  )
    refuse();
}
function assertSubmittedAuthority({
  now,
  authority,
  action,
}: FinalAcceptanceInput) {
  if (
    !Number.isSafeInteger(now) ||
    now < authority.validFrom ||
    now >= authority.validUntil ||
    action.phase !== "submitted" ||
    action.kind !== "acceptance_write" ||
    authority.actions[action.actionId]?.intentHash !== action.intentHash ||
    authority.actions[action.actionId]?.kind !== action.kind
  )
    refuse();
}
function baseValidation(input: FinalAcceptanceInput) {
  const {
    hold,
    control,
    authority,
    action,
    acceptance: a,
    now,
    launcher,
  } = input;
  introductionHoldSchema.parse(hold);
  controlRecordSchema.parse(control);
  introductionAuthoritySchema.parse(authority);
  introductionActionSchema.parse(action);
  acceptanceRecordSchema.parse(a);
  launcherObservationSchema.parse(launcher);
  assertSubmittedAuthority(input);
  assertAcceptanceIdentity(input);
  if (
    a.pk !== `INTRODUCTION#${hold.introductionId}` ||
    control.deployment?.phase !== "complete" ||
    control.servingGeneration !== a.servingGeneration ||
    hold.deployment.state !== "held" ||
    launcher.manifestHash !== hold.manifestHash ||
    launcher.baselineHash !== a.launcherBaselineHash ||
    launcher.observedAt > now
  )
    refuse();
  assertAdmissionState(input);
}

export function finalState(input: FinalAcceptanceInput): {
  hold: IntroductionHold;
  control: ControlRecord;
} {
  const { hold, control, acceptance: a, purpose } = input;
  if (purpose === "reopen_admission") {
    const nextControl = { ...control };
    delete nextControl.maintenance;
    return {
      hold: {
        ...hold,
        admission: { state: "reopened", receiptId: a.acceptanceId },
      },
      control: nextControl,
    };
  }
  if (purpose === "release_deployment")
    return {
      hold: {
        ...hold,
        deployment: { state: "released", receiptId: a.acceptanceId },
      },
      control,
    };
  return { hold, control };
}
export function buildFinalAcceptanceTransaction(
  input: FinalAcceptanceInput,
): TransactWriteItemsCommandInput {
  baseValidation(input);
  const {
    table,
    hold,
    control,
    authority,
    action,
    acceptance,
    purpose,
    guards,
  } = input;
  const next = finalState(input);
  const controlFields = [
    "pk",
    "sk",
    "recordType",
    "protocolVersion",
    "runtimeEnvironment",
    "coordinatorToken",
    "coordinatorEpoch",
    "coordinatorExpiresAt",
    "servingGeneration",
    "servingMembers",
    "maintenance",
    "deployment",
    "compatibleReplacement",
    "recoveryScanCursor",
  ];
  const items: TransactWriteItem[] = [
    same(hold, next.hold)
      ? {
          ConditionCheck: check(table, hold, [
            ...Object.keys(hold),
            "fixtureGrantIds",
          ]),
        }
      : checkedPut(table, hold, next.hold, [
          ...new Set([...Object.keys(hold), "fixtureGrantIds"]),
        ]),
    same(control, next.control)
      ? { ConditionCheck: check(table, control, controlFields) }
      : checkedPut(table, control, next.control, controlFields),
    { ConditionCheck: check(table, authority) },
    { ConditionCheck: check(table, action) },
    purpose === "persist_acceptance"
      ? {
          Put: {
            TableName: table,
            Item: marshall(acceptance),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        }
      : { ConditionCheck: check(table, acceptance) },
    ...guards.map((g) => ({
      ConditionCheck: snapshotCondition(
        g.table,
        g.key,
        g.row,
        g.fields,
        g.presentFields,
      ),
    })),
  ];
  const sizes = [
    completeItemSizeBound(next.hold),
    completeItemSizeBound(next.control),
    completeItemSizeBound(authority),
    completeItemSizeBound(action),
    completeItemSizeBound(acceptance),
    ...guards.map((g) => g.maximumItemBytes),
  ];
  const transaction = { TransactItems: items };
  assertTransactionCapacity(transaction, sizes);
  return transaction;
}
type FinalJournalInput = {
  table: string;
  hold: IntroductionHold;
  authority: IntroductionAuthority;
  previous?: IntroductionAction;
  next: IntroductionAction;
  now: number;
};
function assertJournalIdentity({ hold, authority, next }: FinalJournalInput) {
  for (const key of [
    "holdId",
    "introductionId",
    "manifestHash",
    "revision",
  ] as const)
    if (hold[key] !== authority[key] || next[key] !== authority[key]) refuse();
  for (const key of ["actor", "runToken", "operationId"] as const)
    if (next[key] !== authority[key]) refuse();
}
function assertJournalSuccessor(
  hold: IntroductionHold,
  previous: IntroductionAction | undefined,
  next: IntroductionAction,
) {
  if (!previous) {
    if (next.phase !== "reserved" || hold.deployment.state !== "held") refuse();
  } else {
    introductionActionSchema.parse(previous);
    const order = {
      reserved: "submitted",
      submitted: "acknowledged",
      acknowledged: "observed",
      observed: undefined,
    };
    if (
      order[previous.phase] !== next.phase ||
      next.version !== previous.version + 1 ||
      Object.entries(previous).some(
        ([key, value]) =>
          !["phase", "version"].includes(key) &&
          !same(Reflect.get(next, key), value),
      )
    )
      refuse();
  }
}
/** Narrow final-action journal: the caller supplies the exact pre/post hold, never a generic hold bypass. */
export function buildFinalJournalWrite(
  input: FinalJournalInput,
): TransactWriteItemsCommandInput {
  const { table, hold, authority, previous, next, now } = input;
  introductionHoldSchema.parse(hold);
  introductionAuthoritySchema.parse(authority);
  introductionActionSchema.parse(next);
  if (
    next.kind !== "acceptance_write" ||
    authority.actions[next.actionId]?.kind !== "acceptance_write" ||
    authority.actions[next.actionId]?.intentHash !== next.intentHash
  )
    refuse();
  assertJournalIdentity(input);
  assertJournalSuccessor(hold, previous, next);
  if (
    ["reserved", "submitted"].includes(next.phase) &&
    (now < authority.validFrom || now >= authority.validUntil)
  )
    refuse();
  return {
    TransactItems: [
      { ConditionCheck: check(table, hold) },
      { ConditionCheck: check(table, authority) },
      previous
        ? checkedPut(table, previous, next)
        : {
            Put: {
              TableName: table,
              Item: marshall(next),
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
    ],
  };
}
