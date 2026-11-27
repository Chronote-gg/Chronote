/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const infra = join(__dirname, "..", "..", "_infra");
const read = (path: string) =>
  readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const alarmBlocks = readdirSync(infra)
  .filter((name) => name.endsWith(".tf"))
  .flatMap((name) => read(join(infra, name)).split(/^resource "/m))
  .filter((block) => block.startsWith('aws_cloudwatch_metric_alarm" "'));
const alarmName = (block: string) => block.split('"')[2];
const topic =
  /\[(aws_sns_topic\.critical_alerts\[0\]\.arn|local\.critical_alerts_topic_arn)\]/;

// The tftest checks planned values but can only target alarms it names; this
// keeps that list complete, so a new alarm cannot skip the topic unnoticed.
test("every alarm in the root sends ALARM and OK to the critical alerts topic", () => {
  expect(alarmBlocks.length).toBeGreaterThan(0);
  for (const block of alarmBlocks) {
    expect([alarmName(block), block]).toEqual([
      alarmName(block),
      expect.stringMatching(
        new RegExp(`alarm_actions\\s*=\\s*${topic.source}`),
      ),
    ]);
    expect([alarmName(block), block]).toEqual([
      alarmName(block),
      expect.stringMatching(new RegExp(`ok_actions\\s*=\\s*${topic.source}`)),
    ]);
  }
});

test("the alert delivery tftest plans every alarm in the root", () => {
  const tftest = read(join(infra, "tests", "alert-delivery.tftest.hcl"));
  const targeted = new Set(
    [...tftest.matchAll(/aws_cloudwatch_metric_alarm\.(\w+),/g)].map(
      (match) => match[1],
    ),
  );
  expect([...targeted].sort()).toEqual(
    [...new Set(alarmBlocks.map(alarmName))].sort(),
  );
});
