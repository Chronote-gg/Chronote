"use strict";
const { marshall } = require("@aws-sdk/util-dynamodb");
async function reservePublicationCompatibility({
  aws,
  table,
  control,
  images,
  runToken,
  releases,
}) {
  const known =
    releases?.contract === "first_publication_archive_fence_v1" &&
    images.length &&
    images.every((image) =>
      releases.images.includes(image.replace(/^.*@/, "")),
    );
  if (known) return;
  if (Object.keys(control.publicationPins ?? {}).length)
    throw Error("Unresolved publication excludes incompatible deployment");
  const names = {
    "#generation": "servingGeneration",
    "#epoch": "coordinatorEpoch",
    "#publicationPins": "publicationPins",
    "#transition": "publicationTransition",
  };
  const values = {
    ":generation": control.servingGeneration,
    ":epoch": control.coordinatorEpoch,
    ":zero": 0,
    ":transition": { runToken, images },
  };
  let condition =
    "#generation = :generation AND #epoch = :epoch AND (attribute_not_exists(#publicationPins) OR size(#publicationPins) = :zero)";
  if (control.publicationTransition === undefined)
    condition += " AND attribute_not_exists(#transition)";
  else {
    condition += " AND #transition = :previous";
    values[":previous"] = control.publicationTransition;
  }
  await aws("dynamodb", "update-item", {
    TableName: table,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ConditionExpression: condition,
    UpdateExpression: "SET #transition = :transition",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
  });
}
module.exports = { reservePublicationCompatibility };

function publicationDeployment({
  control,
  config,
  options,
  tables,
  callAws,
  assertWriter,
  production,
}) {
  async function guard() {
    const ctl = await control();
    if (ctl.publicationProtocol !== 1) return;
    const releases =
      options.publicationReleases ??
      require("../operator/recovery-publication-releases.json");
    const images = [
      config.image,
      ...Object.values(ctl.servingMembers).map((m) => m.imageDigest),
      ...(ctl.deployment?.originalMembers ?? []).map((m) => m.imageDigest),
    ];
    await reservePublicationCompatibility({
      aws: callAws,
      table: tables.deploymentControl,
      control: ctl,
      images,
      runToken: config.runToken,
      releases,
    });
  }
  async function enroll(previous, next) {
    const releases =
      options.publicationReleases ??
      require("../operator/recovery-publication-releases.json");
    if (
      !production &&
      next.deployment?.phase === "complete" &&
      releases.images.length &&
      Object.values(next.servingMembers).every((m) =>
        releases.images.includes(m.imageDigest),
      ) &&
      releases.images.includes(config.image.replace(/^.*@/, ""))
    ) {
      await assertWriter();
      const response = await callAws("dynamodb", "update-item", {
        TableName: tables.deploymentControl,
        Key: marshall({ pk: "ENV", sk: "CONTROL" }),
        UpdateExpression:
          "SET #protocol = :one, #images = :images REMOVE #transition",
        ConditionExpression:
          "coordinatorToken = :token AND coordinatorEpoch = :epoch AND (attribute_not_exists(#transition) OR #transition.#run = :token)",
        ExpressionAttributeNames: {
          "#protocol": "publicationProtocol",
          "#transition": "publicationTransition",
          "#images": "publicationCompatibleImages",
          "#run": "runToken",
        },
        ExpressionAttributeValues: marshall({
          ":one": 1,
          ":images": releases.images,
          ":token": previous.coordinatorToken,
          ":epoch": previous.coordinatorEpoch,
        }),
      });
      void response;
      previous = {
        ...previous,
        publicationProtocol: 1,
        publicationCompatibleImages: releases.images,
      };
      next = {
        ...next,
        publicationProtocol: 1,
        publicationCompatibleImages: releases.images,
      };
      delete previous.publicationTransition;
      delete next.publicationTransition;
    }

    return { previous, next };
  }
  return {
    guard,
    enroll,
    aws: createPublicationAwsCaller(callAws, assertWriter, guard),
  };
}
module.exports.publicationDeployment = publicationDeployment;

function createPublicationAwsCaller(callAws, assertWriter, guard) {
  return async (service, operation, input) => {
    if (
      [
        "update-item",
        "transact-write-items",
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(operation)
    )
      await assertWriter();
    if (
      [
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(operation)
    )
      await guard();
    return callAws(service, operation, input);
  };
}
