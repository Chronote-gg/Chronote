import { z } from "zod";
import type { ECSClient } from "@aws-sdk/client-ecs";
import type { StripeClient } from "../types/stripe";
import {
  getRenewalRecoveryIndexStatus,
  scanGuildSubscriptionPage,
} from "../db";
import { getSubscriptionRepository } from "../repositories/subscriptionRepository";
import { getRenewalRecoveryRepository } from "../repositories/renewalRecoveryRepository";
import { config } from "./configService";
import { readRenewalCoverageCandidate } from "./renewalRecoveryCoverageEvidence";
import {
  verifyLedgerWriterDeployment,
  ledgerWriterDeploymentTargetSchema,
} from "./ledgerWriterDeployment";
import {
  RENEWAL_RECOVERY_WRITER_VERSION,
  type RenewalRecovery,
} from "../types/renewalRecovery";
export const STANDALONE_COVERAGE_APPLY_REFUSAL =
  "Standalone renewal coverage apply is disabled. Use read-only audit; restoring apply requires a separately reviewed admitted executor.";
const outcomeSchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    state: z.enum(["ignored", "covered", "would_register", "unresolved"]),
    reason: z.string().optional(),
  })
  .strict();
export const renewalCoverageReportSchema = z
  .object({
    accountId: z.string().min(1),
    mode: z.enum(["test", "live"]),
    apply: z.boolean(),
    startedAt: z.number().int().nonnegative(),
    phase: z.union([z.literal(1), z.literal(2)]),
    cursor: z.string().min(1).optional(),
    pages: z.number().int().nonnegative(),
    enumeration: z.enum(["incomplete", "complete"]),
    indexActive: z.boolean(),
    writerVerified: z.boolean(),
    coverageReady: z.boolean(),
    outcomes: z.array(outcomeSchema),
    error: z.string().optional(),
    writerSampleGuildId: z
      .string()
      .regex(/^\d{17,20}$/)
      .optional(),
  })
  .strict();
export type RenewalCoverageReport = z.infer<typeof renewalCoverageReportSchema>;
type Input = {
  stripe: StripeClient;
  accountId: string;
  mode: "test" | "live";
  maxPages: number;
  apply: boolean;
  now: number;
  resume?: RenewalCoverageReport;
  onProgress?: (report: RenewalCoverageReport) => Promise<void>;
  deployment?: {
    ecs: ECSClient;
    target: z.infer<typeof ledgerWriterDeploymentTargetSchema>;
  };
};
async function inspectGuild(
  input: Input,
  guildId: string,
  witnesses: RenewalRecovery[],
): Promise<z.infer<typeof outcomeSchema>> {
  const saved = await getSubscriptionRepository().get(guildId);
  if (
    !saved?.stripeSubscriptionId ||
    !["active", "past_due", "unpaid", "trialing"].includes(saved.status)
  )
    return { guildId, state: "ignored" };
  const repository = getRenewalRecoveryRepository();
  const current = await repository.getCurrent(guildId);
  if (
    current?.subscriptionId === saved.stripeSubscriptionId &&
    current.mode === input.mode &&
    current.enforcementAccepted
  ) {
    witnesses.push(current);
    return { guildId, state: "covered" };
  }
  const candidate = await readRenewalCoverageCandidate({
    stripe: input.stripe,
    saved,
    mode: input.mode,
  });
  if (!candidate) return { guildId, state: "ignored" };
  if (
    current?.subscriptionId === candidate.subscriptionId &&
    current.mode === candidate.mode &&
    current.paid.periodEnd === candidate.paid.periodEnd
  ) {
    witnesses.push(current);
    return { guildId, state: "covered" };
  }
  if (current?.subscriptionId === candidate.subscriptionId)
    return {
      guildId,
      state: "unresolved",
      reason: "existing_cycle_requires_reconciliation",
    };
  return { guildId, state: "would_register" };
}
async function verifyWriter(
  input: Input,
  report: RenewalCoverageReport,
): Promise<boolean> {
  if (!input.deployment) return false;
  const candidates = new Set([
    ...(report.writerSampleGuildId ? [report.writerSampleGuildId] : []),
    ...report.outcomes
      .filter((outcome) => outcome.state === "covered")
      .map((outcome) => outcome.guildId),
  ]);
  const attemptedTasks = new Set<string>();
  let failed = false;
  for (const guildId of candidates) {
    const record = await getRenewalRecoveryRepository().getCurrent(guildId);
    const witness = record?.writerRuntime;
    if (
      record?.mode !== input.mode ||
      record.writerVersion !== RENEWAL_RECOVERY_WRITER_VERSION ||
      !witness ||
      witness.imageDigest !== input.deployment.target.imageDigest ||
      attemptedTasks.has(witness.taskArn)
    )
      continue;
    attemptedTasks.add(witness.taskArn);
    try {
      await verifyLedgerWriterDeployment(
        input.deployment.ecs,
        input.deployment.target,
        witness,
      );
      report.writerSampleGuildId = guildId;
      return true;
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Deployed renewal writer could not be verified");
  return false;
}
function initialReport(input: Input): RenewalCoverageReport {
  if (!input.resume)
    return {
      accountId: input.accountId,
      mode: input.mode,
      apply: input.apply,
      startedAt: input.now,
      phase: 1,
      pages: 0,
      enumeration: "incomplete",
      indexActive: false,
      writerVerified: false,
      coverageReady: false,
      outcomes: [],
    };
  const report = renewalCoverageReportSchema.parse(input.resume);
  if (
    report.accountId !== input.accountId ||
    report.mode !== input.mode ||
    report.apply !== input.apply ||
    report.enumeration === "complete"
  )
    throw new Error("Coverage resume scope does not match an incomplete run");
  return {
    ...report,
    error: undefined,
    writerVerified: false,
    coverageReady: false,
  };
}
export async function auditRenewalCoverage(
  input: Input,
): Promise<RenewalCoverageReport> {
  z.number().int().min(1).max(1000).parse(input.maxPages);
  if (input.apply) throw new Error(STANDALONE_COVERAGE_APPLY_REFUSAL);
  if (input.mode !== config.subscription.stripeMode)
    throw new Error("Configured provider mode mismatch");
  const report = initialReport(input);
  const [account, balance] = await Promise.all([
    input.stripe.accounts.retrieve(null),
    input.stripe.balance.retrieve(),
  ]);
  if (
    account.id !== input.accountId ||
    balance.livemode !== (input.mode === "live")
  )
    throw new Error("Coverage provider identity mismatch");
  report.indexActive = (await getRenewalRecoveryIndexStatus()) === "ACTIVE";
  const outcomes = new Map(
    report.outcomes.map((outcome) => [outcome.guildId, outcome]),
  );
  const witnesses: RenewalRecovery[] = [];
  for (
    let page = 0;
    page < input.maxPages && report.enumeration !== "complete";
    page++
  ) {
    try {
      const result = await scanGuildSubscriptionPage(report.cursor);
      for (const guildId of result.guildIds) {
        try {
          outcomes.set(guildId, await inspectGuild(input, guildId, witnesses));
        } catch {
          outcomes.set(guildId, {
            guildId,
            state: "unresolved",
            reason: "provider_or_source_unverified",
          });
        }
      }
      const sample = witnesses.find(
        (record) =>
          record.writerVersion === RENEWAL_RECOVERY_WRITER_VERSION &&
          record.writerRuntime?.imageDigest ===
            input.deployment?.target.imageDigest,
      );
      if (sample) report.writerSampleGuildId = sample.guildId;
      report.pages++;
      report.cursor = result.cursor;
      if (!result.cursor) {
        if (report.phase === 1) {
          report.phase = 2;
          witnesses.length = 0;
        } else report.enumeration = "complete";
      }
    } catch {
      report.error = "subscription_scan_incomplete";
      break;
    }
    report.outcomes = [...outcomes.values()];
    await input.onProgress?.(report);
  }
  report.outcomes = [...outcomes.values()];
  if (report.enumeration === "complete") {
    try {
      report.writerVerified = await verifyWriter(input, report);
    } catch {
      report.writerVerified = false;
      report.error = "deployed_writer_unverified";
    }
  }
  report.coverageReady =
    report.enumeration === "complete" &&
    report.indexActive &&
    report.writerVerified &&
    report.outcomes.every(
      (outcome) => outcome.state === "covered" || outcome.state === "ignored",
    );
  await input.onProgress?.(report);
  return report;
}
