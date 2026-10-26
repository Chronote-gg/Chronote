import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ECSClient } from "@aws-sdk/client-ecs";
import { z } from "zod";
import { getStripeClient } from "../src/services/stripeClient";
import {
  auditRenewalCoverage,
  STANDALONE_COVERAGE_APPLY_REFUSAL,
  renewalCoverageReportSchema,
  type RenewalCoverageReport,
} from "../src/services/renewalRecoveryCoverage";
import { ledgerWriterDeploymentTargetSchema } from "../src/services/ledgerWriterDeployment";
export function parseBillingRenewalRecoveryArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      account: { type: "string" },
      mode: { type: "string" },
      report: { type: "string" },
      "max-pages": { type: "string" },
      apply: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      cluster: { type: "string" },
      service: { type: "string" },
      container: { type: "string" },
      image: { type: "string" },
    },
  });
  const deploymentRequested = [
    values.cluster,
    values.service,
    values.container,
    values.image,
  ].some((value) => value !== undefined);
  return {
    accountId: z
      .string()
      .regex(/^acct_/)
      .parse(values.account),
    mode: z.enum(["test", "live"]).parse(values.mode),
    report: z.string().min(1).parse(values.report),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(Number(z.string().regex(/^\d+$/).parse(values["max-pages"]))),
    apply: values.apply,
    resume: values.resume,
    target: deploymentRequested
      ? ledgerWriterDeploymentTargetSchema.parse({
          clusterArn: values.cluster,
          serviceArn: values.service,
          containerName: values.container,
          imageDigest: values.image,
        })
      : undefined,
  };
}
export function renewalCoverageExitCode(report: RenewalCoverageReport): 0 | 1 {
  return report.enumeration !== "complete" ||
    report.outcomes.some((outcome) => outcome.state === "unresolved") ||
    (report.apply && !report.coverageReady)
    ? 1
    : 0;
}
async function main() {
  const args = parseBillingRenewalRecoveryArgs(process.argv.slice(2));
  const stripe = getStripeClient();
  if (!stripe) throw new Error("Stripe is not configured");
  const resume = args.resume
    ? renewalCoverageReportSchema.parse(
        JSON.parse(await readFile(args.report, "utf8")),
      )
    : undefined;
  await mkdir(dirname(args.report), { recursive: true });
  const report = await auditRenewalCoverage({
    ...args,
    stripe,
    now: Math.floor(Date.now() / 1000),
    resume,
    deployment: args.target
      ? {
          ecs: new ECSClient({ region: process.env.AWS_REGION || "us-east-1" }),
          target: args.target,
        }
      : undefined,
    onProgress: async (current) => {
      await writeFile(
        args.report,
        JSON.stringify(current, null, 2) + "\n",
        "utf8",
      );
    },
  });
  console.log(
    JSON.stringify({
      mode: report.mode,
      apply: report.apply,
      enumeration: report.enumeration,
      coverageReady: report.coverageReady,
      covered: report.outcomes.filter((outcome) => outcome.state === "covered")
        .length,
      unresolved: report.outcomes.filter(
        (outcome) => outcome.state === "unresolved",
      ).length,
    }),
  );
  process.exitCode = renewalCoverageExitCode(report);
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Renewal coverage failed. " +
        STANDALONE_COVERAGE_APPLY_REFUSAL +
        " Enforcement was not enabled. Inspect the private report before retrying.",
    );
    process.exitCode = 1;
  });
