import { z } from "zod";
import {
  controlRecordSchema,
  runtimeRecordSchema,
} from "../types/deploymentControl";

const id = z.string().min(1).max(1024);
const nativeProtection = z
  .object({
    taskArn: id,
    protectionEnabled: z.literal(true),
    expirationDate: z.string(),
  })
  .strict();

export const launcherObservationSchema = z
  .object({
    kind: z.literal("launcher_settings"),
    mode: z.literal("zero-external-launcher-mutations"),
    manifestHash: id,
    baselineHash: id,
    sourceCommit: id,
    observedAt: z.number().int().nonnegative(),
    coverage: z.tuple([
      z.literal("github_routes"),
      z.literal("github_environment"),
      z.literal("github_branch"),
      z.literal("github_variables"),
      z.literal("github_actions"),
      z.literal("resumable_jobs"),
      z.literal("named_roles"),
      z.literal("oidc"),
    ]),
  })
  .strict();

/** Bounded facts retained at the trusted ACK/observation site. Hashes alone remain insufficient. */
export const introductionHistoricalFactsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cold_exclusion"),
      control: controlRecordSchema,
      scopeHash: id,
      observedAt: z.number().int().nonnegative(),
      tasks: z
        .array(
          z
            .object({
              taskArn: id,
              taskDefinitionArn: id,
              lastStatus: z.literal("STOPPED"),
              desiredStatus: z.literal("STOPPED"),
              protectionEnabled: z.literal(false),
              classification: z.literal("related"),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      services: z
        .array(
          z
            .object({
              serviceArn: id,
              desiredCount: z.literal(0),
              runningCount: z.literal(0),
              pendingCount: z.literal(0),
            })
            .strict(),
        )
        .length(1),
      targets: z.array(z.never()).length(0),
      launchers: z.array(z.never()).length(0),
      coverage: z
        .array(
          z
            .object({
              operation: id,
              status: z.enum(["enumerated", "verified"]),
            })
            .strict(),
        )
        .min(1)
        .max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("acceptance_transition"),
      purpose: z.enum([
        "persist_acceptance",
        "reopen_admission",
        "release_deployment",
      ]),
      acceptanceId: id,
      restoration: launcherObservationSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_stop"),
      taskArn: id,
      desiredStatus: z.literal("STOPPED"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_stopped"),
      taskArn: id,
      lastStatus: z.literal("STOPPED"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("service_request"),
      serviceArn: id,
      taskDefinition: id,
      desiredCount: z.number().int().nonnegative(),
      launcherBaseline: launcherObservationSchema.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("route"), listenerArn: id, targetGroupArn: id })
    .strict(),
  z
    .object({
      kind: z.literal("service_stopped"),
      serviceArn: id,
      taskDefinition: id,
      desiredCount: z.literal(0),
      runningCount: z.literal(0),
      pendingCount: z.literal(0),
      stoppedTaskArns: z.array(id).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed_stopped"),
      serviceArn: id,
      taskDefinition: id,
      desiredCount: z.literal(0),
      runningCount: z.literal(0),
      pendingCount: z.literal(0),
      taskArn: id,
      lastStatus: z.literal("STOPPED"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_running"),
      serviceArn: id,
      taskArn: id,
      taskDefinition: id,
      imageDigest: id,
      lastStatus: z.literal("RUNNING"),
    })
    .strict(),
  z
    .object({ kind: z.literal("control"), control: controlRecordSchema })
    .strict(),
  z
    .object({ kind: z.literal("runtime"), runtime: runtimeRecordSchema })
    .strict(),
  z
    .object({
      kind: z.literal("promotion"),
      control: controlRecordSchema,
      candidate: runtimeRecordSchema,
      nativeProtection: z.array(nativeProtection).min(1).max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("retirement_complete"),
      control: controlRecordSchema,
      runtime: runtimeRecordSchema,
    })
    .strict(),
]);
