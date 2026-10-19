/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { acknowledgmentFor } from "../../scripts/deployment/introduction-transitions.cjs";
import { fixture } from "../fixtures/productionManifest.js";

const manifest = fixture();
const action = manifest.actions.find((a) => a.kind === "route_maintenance");
const target =
  action.targetGroup === "a"
    ? manifest.resources.targetGroupA
    : manifest.resources.targetGroupB;
const response = (forward) => ({
  Listeners: [
    { ListenerArn: manifest.resources.listenerArn, DefaultActions: [forward] },
  ],
});

test.each([
  { Type: "forward", TargetGroupArn: target, Order: 1 },
  {
    Type: "forward",
    Order: 1,
    ForwardConfig: { TargetGroups: [{ TargetGroupArn: target, Weight: 1 }] },
  },
  {
    Type: "forward",
    TargetGroupArn: target,
    ForwardConfig: {
      TargetGroups: [{ TargetGroupArn: target }],
      TargetGroupStickinessConfig: { Enabled: false, DurationSeconds: 3600 },
    },
  },
])("accepts an equivalent bounded direct listener response %j", (forward) => {
  expect(
    acknowledgmentFor(manifest, action, response(forward)).resourceIds,
  ).toEqual([manifest.resources.listenerArn, target]);
});

test.each([
  { Type: "forward", TargetGroupArn: target, Order: 2 },
  { Type: "forward", TargetGroupArn: target, UnknownBehavior: true },
  {
    Type: "forward",
    TargetGroupArn: target,
    ForwardConfig: { TargetGroups: [{ TargetGroupArn: "foreign" }] },
  },
  {
    Type: "forward",
    ForwardConfig: {
      TargetGroups: [
        { TargetGroupArn: target },
        { TargetGroupArn: "foreign", Weight: 0 },
      ],
    },
  },
  {
    Type: "forward",
    ForwardConfig: { TargetGroups: [{ TargetGroupArn: target, Weight: 0 }] },
  },
  {
    Type: "forward",
    ForwardConfig: {
      TargetGroups: [{ TargetGroupArn: target }],
      TargetGroupStickinessConfig: { Enabled: true },
    },
  },
])("refuses changed or unknown listener behavior %j", (forward) => {
  expect(() =>
    acknowledgmentFor(manifest, action, response(forward)),
  ).toThrow();
});
