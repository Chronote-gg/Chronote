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
