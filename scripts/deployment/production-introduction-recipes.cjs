"use strict";
const { canonicalHash } = require("./production-manifest.cjs");
function introductionRecipes(options) {
  const builders =
    options.builders ??
    require("../../dist/services/productionIntroductionTransactions.js");
  const fixtureBuilders =
    options.fixtureBuilders ??
    require("../../dist/services/productionFixtureCommandService.js");
  const { hold, authority, table } = options;
  function request(m, a, c) {
    if (a.kind !== "introduction_write")
      throw Error("introduction_recipe_refused");
    const tables = {
        deploymentControl: table,
        meetingHistory: m.resources.tables.meetingHistory,
        personalJob: m.resources.tables.personalJob,
        personalSegment: m.resources.tables.personalSegment,
      },
      base = { hold, authority, tables };
    let input;
    switch (a.purpose) {
      case "initialize":
        input = builders.buildInitializeIntroductionControl({
          ...base,
          control: c.control,
          lineage: c.lineage,
          paused: c.paused,
        });
        if (c.paused) {
          const cohort = {
            ...c.paused,
            identities: c.paused.parents.map(({ uploadId, ownerUserId }) => ({
              uploadId,
              ownerUserId,
            })),
            declaration: { capture: { sha256: c.paused.captureSha256 } },
            digests: {
              cohortSha256: c.paused.cohortSha256,
              captureSha256: c.paused.captureSha256,
              policyScopeSha256: c.paused.policyScopeSha256,
            },
          };
          const bounds =
            require("./production-acceptance-capacity.cjs").initializationCapacityEnvelope(
              {
                manifest: m,
                manifestHash: authority.manifestHash,
                actor: authority.actor,
              },
              cohort,
              c.lineage,
            );
          require("../../dist/services/productionAcceptanceConditions.js").assertTransactionCapacity(
            input,
            bounds.map((bound) => bound.maximumItemBytes),
          );
        }
        break;
      case "replace_control":
        input = builders.buildReplaceUnservedControl({
          ...base,
          previous: c.control,
          launch: c.launch,
          now: c.now,
        });
        break;
      case "renew":
        input = builders.buildIntroductionRenew({
          ...base,
          previous: c.control,
          now: c.now,
        });
        break;
      case "retire_failed":
        input = builders.buildFailedCandidateRetirement({
          ...base,
          control: c.control,
          runtime: c.runtime,
          now: c.now,
        });
        break;
      case "promote": {
        const slot =
          a.slot === "bootstrap"
            ? {
                candidateId: m.runtime.candidateId,
                digest: m.runtime.candidateDigest,
                epoch: m.handoff.priorEpoch,
                token: m.handoff.priorRunToken,
              }
            : {
                candidateId: m.failedUnserved.candidateId,
                digest: m.failedUnserved.imageDigest,
                epoch: m.failedUnserved.epoch,
                token: m.failedUnserved.runToken,
              };
        if (
          c.runtime.identity.candidateId !== slot.candidateId ||
          c.runtime.identity.imageDigest !== slot.digest
        )
          throw Error("introduction_recipe_refused");
        input = builders.buildIntroductionPromotion({
          ...base,
          promotion: {
            coordinatorToken: slot.token,
            coordinatorEpoch: slot.epoch,
            expectedServingGeneration: 0,
            expectedServingMembers: [],
            proposedGeneration: 1,
            candidate: c.runtime.identity,
            candidateRuntimeMode: m.runtime.mode,
            now: c.now,
          },
        });
        break;
      }
      case "authorize_fixture": {
        const h = builders.effectiveHandoff(
          authority,
          c.control.coordinatorEpoch,
        );
        const operation = {
          pk: `INTRODUCTION#${hold.introductionId}`,
          sk: "FIXTURE_COORDINATOR",
          recordType: "fixture_coordinator_authority",
          holdId: hold.holdId,
          introductionId: hold.introductionId,
          manifestHash: hold.manifestHash,
          revision: hold.revision,
          ...Object.fromEntries(
            Object.entries(h).filter(
              ([k]) => !["priorCandidateId", "priorDigest"].includes(k),
            ),
          ),
          priorMember: Object.values(c.control.servingMembers)[0],
        };
        input = builders.buildAuthorizeFixtureCoordinator({
          ...base,
          expectedControl: c.control,
          operation,
        });
        break;
      }
      case "enqueue_fixture": {
        const grant = m.handoff.grants[a.grantIndex];
        if (!grant) throw Error("introduction_recipe_refused");
        const value = {
          ...grant,
          pk: `FIXTURE#${grant.grantId}`,
          sk: "AUTHORITY",
          recordType: "fixture_grant",
          protocolVersion: 1,
          holdId: hold.holdId,
          introductionId: hold.introductionId,
          revision: hold.revision,
          state: "issued",
        };
        const at = new Date(c.now * 1000).toISOString();
        input = fixtureBuilders.buildFixtureStartTransaction({
          hold: c.currentHold,
          grant: value,
          command: {
            requestId: grant.commandId,
            commandType: "start_meeting",
            queueStatus: "pending",
            userId: grant.actorUserId,
            input: {
              serverId: grant.guildId,
              voiceChannelId: grant.voiceChannelId,
              textChannelId: grant.textChannelId,
            },
            createdAt: at,
            updatedAt: at,
            expiresAt: c.now + 180,
          },
          tables: {
            deploymentControl: table,
            meetingControlCommand: m.resources.tables.meetingControl,
          },
        });
        // The shared fixture transaction already checks/updates the hold. Add only immutable operation authority.
        input.TransactItems.push(
          builders.introductionChecks(hold, authority, table)[1],
        );
        break;
      }
      default:
        throw Error("introduction_recipe_refused");
    }
    return { operation: "transactWriteItems", input };
  }
  return {
    request,
    acknowledgment(m, a, response, c, wire) {
      if (!response || response.UnprocessedItems)
        throw Error("introduction_ack_missing");
      return {
        resourceIds: [table],
        ...(a.purpose === "initialize"
          ? {
              facts: {
                ...c.coldExclusion,
                ...(c.paused
                  ? {
                      paused:
                        require("../../dist/services/productionPausedInitialization.js").pausedInitializationDigestsSchema.parse(
                          {
                            cohortSha256: c.paused.cohortSha256,
                            captureSha256: c.paused.captureSha256,
                            policyScopeSha256: c.paused.policyScopeSha256,
                          },
                        ),
                    }
                  : {}),
              },
            }
          : {}),
        ...(a.purpose === "promote"
          ? {
              facts: {
                kind: "promotion",
                control: c.control,
                candidate: c.runtime,
                nativeProtection: c.nativeProtection,
              },
            }
          : {}),
        evidenceHash: canonicalHash({
          request: wire,
          directAcknowledgment: true,
        }),
      };
    },
    observation(m, a, value) {
      if (
        value.purpose !== a.purpose ||
        !/^[a-f0-9]{64}$/.test(value.stateHash) ||
        Object.keys(value).length !== (value.facts ? 3 : 2)
      )
        throw Error("introduction_observation_refused");
      return {
        resourceIds: [table],
        evidenceHash: canonicalHash(value),
        ...(value.facts ? { facts: value.facts } : {}),
      };
    },
  };
}
module.exports = { introductionRecipes };
