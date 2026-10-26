/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { recoverRetainedSandbox } from "../../scripts/deployment/recover-retained-sandbox.cjs";
import { retainedSourceLossFixture } from "../deployment/fixtures/retainedSourceLossFixture";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";
import {
  buildCarryforward,
  archiveSchema,
  controlAuthority,
} from "../../scripts/deployment/carryforward-state.cjs";

async function fixture() {
  const f = await retainedSourceLossFixture();
  const inspection = await recoverRetainedSandbox({
    ...f.options,
    mode: "inspect",
  });
  f.options.env.SOURCE_LOSS_BINDING_SHA256 = inspection.bindingSha256;
  await recoverRetainedSandbox({ ...f.options, mode: "recover" });
  const manifest = {
    operationId: "0e46f154-2ad7-482d-8930-f045fbfd197b",
    sourceCommit: "a".repeat(40),
    imageSourceCommit: "b".repeat(40),
    image: f.options.env.CANDIDATE_IMAGE,
    templateArn: "definition:template",
    preparedDefinitionSha256: "c".repeat(64),
    operatorExclusion: "exclusive_approved_writer_window",
    policy: "normal_protected_deployments_with_unresolved_history",
  };
  const observed = {
    control: structuredClone(f.state.ctl),
    recovery: structuredClone(f.loss.receipt),
    source: f.candidateIdentity,
    routing: {
      ...f.state.ctl.deployment.routing,
      sourceGroup: f.state.ctl.deployment.routing.candidateGroup,
      candidateGroup: f.state.ctl.deployment.routing.sourceGroup,
      state: "source",
    },
    runtimeMode: "all",
  };
  delete observed.routing.candidateRevision;
  const result = buildCarryforward({
    manifest,
    manifestSha256: "d".repeat(64),
    bindingSha256: "e".repeat(64),
    observed,
    runToken: "901-1",
    actorArn: "actual-oidc-actor",
    now: f.loss.clock,
    types: f.options.types,
    builders: f.options.builders,
  });
  return { ...f, observed, manifest, ...result };
}

test("atomic carryforward archives unresolved history and installs a normal preparing source without changing admission", async () => {
  const f = await fixture();
  expect(f.next).toMatchObject({
    servingGeneration: f.observed.control.servingGeneration,
    servingMembers: f.observed.control.servingMembers,
    coordinatorToken: "901-1",
    coordinatorEpoch: f.observed.control.coordinatorEpoch + 1,
    deployment: {
      phase: "preparing",
      outgoing: f.candidateIdentity,
      candidateId: f.manifest.operationId,
      previousTaskDefinition: "definition:new",
    },
  });
  expect(f.next.deployment.candidate).toBeUndefined();
  expect(f.next.deployment.taskDefinition).toBeUndefined();
  expect(f.archive.originalControl).toEqual(f.observed.control);
  expect(f.archive.recoverySha256).toBe(bindingHash(f.observed.recovery));
  expect(f.archive.settlement).toBe("lost_owner_settlement_pending");
  expect(f.archive.expiresAt).toBeUndefined();
  expect(archiveSchema(f.options.types).parse(f.archive)).toEqual(f.archive);
  const items = f.transaction.TransactItems;
  expect(items).toHaveLength(4);
  expect(items.filter((i) => i.Put)).toHaveLength(1);
  expect(items[0].Update.UpdateExpression).not.toMatch(
    /REMOVE|servingMembers|servingGeneration/,
  );
  expect(unmarshall(items[1].Put.Item)).toEqual(f.archive);
  expect(items[1].Put.ConditionExpression).toBe("attribute_not_exists(pk)");
  expect(unmarshall(items[2].ConditionCheck.Key)).toEqual({
    pk: f.observed.recovery.pk,
    sk: "RECOVERY",
  });
  expect(unmarshall(items[3].ConditionCheck.Key)).toEqual({
    pk: "ENV",
    sk: "RUNTIME#new",
  });
  expect(
    items.some(
      (i) => i.Update && unmarshall(i.Update.Key).sk === "RUNTIME#old",
    ),
  ).toBe(false);
});

test("authority binding preserves unrelated recovery cursor progress without ignoring deployment or replacement lineage", async () => {
  const f = await fixture();
  const changed = structuredClone(f.observed.control);
  changed.recoveryScanCursor = {
    guildId: "guild",
    channelId_timestamp: "cursor",
  };
  expect(controlAuthority(changed)).toEqual(
    controlAuthority(f.observed.control),
  );
  changed.deployment.routing.state = "forward_submitted";
  expect(controlAuthority(changed)).not.toEqual(
    controlAuthority(f.observed.control),
  );
  const update = f.transaction.TransactItems[0].Update;
  const alias = Object.keys(update.ExpressionAttributeNames).find(
    (key) => update.ExpressionAttributeNames[key] === "compatibleReplacement",
  );
  expect(update.ConditionExpression).toContain(
    `attribute_not_exists(${alias})`,
  );
});
