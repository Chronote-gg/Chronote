"use strict";
const assert = require("node:assert/strict");
const { marshall } = require("@aws-sdk/util-dynamodb");
const {
  compatiblePublicationImages,
  publicationImages,
} = require("./publication-compatibility.cjs");
const fields = [
  "publicationProtocol",
  "publicationCompatibleImages",
  "publicationPins",
  "publicationTransition",
];
function snapshot(control) {
  return Object.fromEntries(
    fields.map((field) => [field, control[field] ?? null]),
  );
}
function createSourceLossPublication(original, releases) {
  const images = publicationImages(original, original.deployment.image);
  const transition = { runToken: original.deployment.runToken, images };
  function binding(control) {
    const compatible =
      control.publicationProtocol === 1 &&
      compatiblePublicationImages(images, releases);
    if (!compatible)
      assert.equal(
        Object.keys(control.publicationPins ?? {}).length,
        0,
        "Unresolved publication excludes incompatible recovery",
      );
    if (control.publicationTransition !== undefined)
      assert.deepEqual(
        control.publicationTransition,
        transition,
        "Another publication transition holds recovery",
      );
    return { snapshot: snapshot(control), images, releases, compatible };
  }
  function admitted(control) {
    const proof = binding(control);
    return control.publicationProtocol === 1 && !proof.compatible
      ? { ...control, publicationTransition: transition }
      : control;
  }
  function assertCurrent(current, expected) {
    assert.deepEqual(
      snapshot(current),
      snapshot(expected),
      "Publication authority changed; preserve recovery receipt",
    );
  }
  function fence(update, previous, next) {
    const names = {},
      values = {},
      clauses = [];
    for (const [index, field] of fields.entries()) {
      const name = "#sourceLossPublication" + index;
      names[name] = field;
      if (previous[field] === undefined)
        clauses.push("attribute_not_exists(" + name + ")");
      else {
        const value = ":sourceLossPublication" + index;
        values[value] = previous[field];
        clauses.push(name + " = " + value);
      }
    }
    update.ConditionExpression += " AND " + clauses.join(" AND ");
    if (next.publicationTransition !== previous.publicationTransition) {
      update.UpdateExpression +=
        ", #sourceLossPublication3 = :sourceLossPublicationNext";
      values[":sourceLossPublicationNext"] = next.publicationTransition;
    }
    update.ExpressionAttributeNames = {
      ...update.ExpressionAttributeNames,
      ...names,
    };
    update.ExpressionAttributeValues = {
      ...update.ExpressionAttributeValues,
      ...marshall(values),
    };
    return update;
  }
  return { binding, admitted, assertCurrent, fence };
}
module.exports = { createSourceLossPublication };
