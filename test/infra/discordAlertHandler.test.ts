/**
 * Tests for the Discord alert Lambda handler.
 *
 * The handler lives at _infra/lambda/discord_alert/handler.mjs and is deployed
 * as a standalone Lambda. We import its exported functions directly to test
 * alarm parsing, embed building, and the handler integration.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock("@aws-sdk/client-secrets-manager", () => {
  const send = jest.fn().mockResolvedValue({ SecretString: "mock-bot-token" });
  return {
    SecretsManagerClient: jest.fn().mockImplementation(() => ({ send })),
    GetSecretValueCommand: jest.fn(),
  };
});

jest.mock("node:https", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events");

  function mockRequest(
    _url: string,
    _options: any,
    callback: (res: any) => void,
  ) {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200 });
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify({ id: "msg-1" })));
      res.emit("end");
    });
    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  }
  return { __esModule: true, default: { request: mockRequest } };
});

import {
  parseAlarmMessage,
  buildEmbed,
  handler,
} from "../../_infra/lambda/discord_alert/handler.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALARM_SNS_MESSAGE = JSON.stringify({
  AlarmName: "meeting-notes-prod-ecs-no-running-tasks",
  AlarmDescription: "ECS bot service has zero running tasks",
  NewStateValue: "ALARM",
  OldStateValue: "OK",
  NewStateReason:
    "Threshold Crossed: 1 out of the last 2 datapoints [0.0 (19/02/26 12:00:00)] was less than the threshold (1.0).",
  Region: "US East (N. Virginia)",
  StateChangeTime: "2026-02-19T12:05:00.000+0000",
  Trigger: {
    MetricName: "RunningTaskCount",
    Namespace: "ECS/ContainerInsights",
    Statistic: "Minimum",
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 1,
    ComparisonOperator: "LessThanThreshold",
  },
});

const OK_SNS_MESSAGE = JSON.stringify({
  AlarmName: "meeting-notes-prod-alb-target-5xx-errors",
  AlarmDescription: "ALB targets returning elevated 5xx errors",
  NewStateValue: "OK",
  OldStateValue: "ALARM",
  NewStateReason:
    "Threshold Crossed: no datapoints were received for 2 periods.",
  Region: "us-east-1",
  StateChangeTime: "2026-02-19T13:00:00.000+0000",
  Trigger: {
    MetricName: "HTTPCode_Target_5XX_Count",
    Namespace: "AWS/ApplicationELB",
    Statistic: "Sum",
    Period: 300,
    EvaluationPeriods: 2,
    Threshold: 10,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
  },
});

const MINIMAL_SNS_MESSAGE = JSON.stringify({
  AlarmName: "custom-alarm",
  NewStateValue: "ALARM",
  OldStateValue: "INSUFFICIENT_DATA",
});

// ---------------------------------------------------------------------------
// parseAlarmMessage
// ---------------------------------------------------------------------------

describe("parseAlarmMessage", () => {
  it("parses a full ALARM message with trigger details", () => {
    const alarm = parseAlarmMessage(ALARM_SNS_MESSAGE);

    expect(alarm.alarmName).toBe("meeting-notes-prod-ecs-no-running-tasks");
    expect(alarm.alarmDescription).toBe(
      "ECS bot service has zero running tasks",
    );
    expect(alarm.newState).toBe("ALARM");
    expect(alarm.oldState).toBe("OK");
    expect(alarm.region).toBe("us-east-1");
    expect(alarm.metric).toBe("RunningTaskCount");
    expect(alarm.namespace).toBe("ECS/ContainerInsights");
    expect(alarm.statistic).toBe("Minimum");
    expect(alarm.period).toBe(300);
    expect(alarm.evaluationPeriods).toBe(2);
    expect(alarm.threshold).toBe(1);
    expect(alarm.comparisonOperator).toBe("LessThanThreshold");
    expect(alarm.timestamp).toBe("2026-02-19T12:05:00.000+0000");
    expect(alarm.reason).toContain("Threshold Crossed");
  });

  it("parses an OK message", () => {
    const alarm = parseAlarmMessage(OK_SNS_MESSAGE);

    expect(alarm.newState).toBe("OK");
    expect(alarm.oldState).toBe("ALARM");
    expect(alarm.metric).toBe("HTTPCode_Target_5XX_Count");
    expect(alarm.threshold).toBe(10);
    expect(alarm.comparisonOperator).toBe("GreaterThanOrEqualToThreshold");
  });

  it("handles a minimal message with missing optional fields", () => {
    const alarm = parseAlarmMessage(MINIMAL_SNS_MESSAGE);

    expect(alarm.alarmName).toBe("custom-alarm");
    expect(alarm.newState).toBe("ALARM");
    expect(alarm.oldState).toBe("INSUFFICIENT_DATA");
    expect(alarm.alarmDescription).toBe("");
    expect(alarm.reason).toBe("");
    expect(alarm.metric).toBe("");
    expect(alarm.namespace).toBe("");
    expect(alarm.period).toBeUndefined();
    expect(alarm.evaluationPeriods).toBeUndefined();
    expect(alarm.threshold).toBeUndefined();
  });

  it("resolves human-readable region name to region code", () => {
    const alarm = parseAlarmMessage(ALARM_SNS_MESSAGE);
    expect(alarm.region).toBe("us-east-1");
  });

  it("passes through region codes unchanged", () => {
    const msg = JSON.stringify({
      AlarmName: "test",
      NewStateValue: "ALARM",
      OldStateValue: "OK",
      Region: "eu-west-2",
    });
    const alarm = parseAlarmMessage(msg);
    expect(alarm.region).toBe("eu-west-2");
  });

  it("falls back to AWS_REGION for unknown region labels", () => {
    const origRegion = process.env.AWS_REGION;
    process.env.AWS_REGION = "ap-southeast-1";
    try {
      const msg = JSON.stringify({
        AlarmName: "test",
        NewStateValue: "ALARM",
        OldStateValue: "OK",
        Region: "Some Unknown Region",
      });
      const alarm = parseAlarmMessage(msg);
      expect(alarm.region).toBe("ap-southeast-1");
    } finally {
      if (origRegion === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = origRegion;
    }
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAlarmMessage("not json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildEmbed
// ---------------------------------------------------------------------------

describe("buildEmbed", () => {
  const ALARM_COLOR = 0xe74c3c;
  const OK_COLOR = 0x2ecc71;
  const UNKNOWN_COLOR = 0x95a5a6;

  it("builds a red embed for ALARM state", () => {
    const alarm = parseAlarmMessage(ALARM_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    expect(embed.color).toBe(ALARM_COLOR);
    expect(embed.title).toContain("meeting-notes-prod-ecs-no-running-tasks");
    expect(embed.description).toBe("ECS bot service has zero running tasks");
    expect(embed.url).toContain("us-east-1.console.aws.amazon.com");
    expect(embed.url).toContain(
      encodeURIComponent("meeting-notes-prod-ecs-no-running-tasks"),
    );
    expect(embed.footer.text).toBe("CloudWatch Alarm");
    expect(embed.timestamp).toBe("2026-02-19T12:05:00.000+0000");
  });

  it("builds a green embed for OK state", () => {
    const alarm = parseAlarmMessage(OK_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    expect(embed.color).toBe(OK_COLOR);
    expect(embed.title).toContain("meeting-notes-prod-alb-target-5xx-errors");
  });

  it("builds a grey embed for unknown state", () => {
    const alarm = parseAlarmMessage(MINIMAL_SNS_MESSAGE);
    // Override the new state to something unexpected
    alarm.newState = "INSUFFICIENT_DATA";
    const embed = buildEmbed(alarm);

    expect(embed.color).toBe(UNKNOWN_COLOR);
  });

  it("includes Status, Region, Metric, Threshold, and Evaluation fields", () => {
    const alarm = parseAlarmMessage(ALARM_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    const fieldNames = embed.fields.map((f: any) => f.name);
    expect(fieldNames).toContain("Status");
    expect(fieldNames).toContain("Region");
    expect(fieldNames).toContain("Metric");
    expect(fieldNames).toContain("Threshold");
    expect(fieldNames).toContain("Evaluation");
    expect(fieldNames).toContain("Reason");

    const statusField = embed.fields.find((f: any) => f.name === "Status")!;
    expect(statusField.value).toContain("OK");
    expect(statusField.value).toContain("**ALARM**");

    const metricField = embed.fields.find((f: any) => f.name === "Metric")!;
    expect(metricField.value).toBe("ECS/ContainerInsights / RunningTaskCount");

    const thresholdField = embed.fields.find(
      (f: any) => f.name === "Threshold",
    )!;
    expect(thresholdField.value).toBe("Minimum < 1");

    const evalField = embed.fields.find((f: any) => f.name === "Evaluation")!;
    expect(evalField.value).toContain("2 × 300s");
    expect(evalField.value).toContain("10m window");
  });

  it("formats >= operator in threshold field", () => {
    const alarm = parseAlarmMessage(OK_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    const thresholdField = embed.fields.find(
      (f: any) => f.name === "Threshold",
    )!;
    expect(thresholdField.value).toBe("Sum >= 10");
  });

  it("omits Metric, Threshold, Evaluation, and Reason for minimal alarms", () => {
    const alarm = parseAlarmMessage(MINIMAL_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    const fieldNames = embed.fields.map((f: any) => f.name);
    expect(fieldNames).toContain("Status");
    expect(fieldNames).toContain("Region");
    expect(fieldNames).not.toContain("Metric");
    expect(fieldNames).not.toContain("Threshold");
    expect(fieldNames).not.toContain("Evaluation");
    expect(fieldNames).not.toContain("Reason");
  });

  it("omits description when alarm has no AlarmDescription", () => {
    const alarm = parseAlarmMessage(MINIMAL_SNS_MESSAGE);
    const embed = buildEmbed(alarm);

    expect(embed.description).toBeUndefined();
  });

  it("truncates long reason to 1024 chars", () => {
    const longReason = "x".repeat(2000);
    const alarm = parseAlarmMessage(ALARM_SNS_MESSAGE);
    alarm.reason = longReason;
    const embed = buildEmbed(alarm);

    const reasonField = embed.fields.find((f: any) => f.name === "Reason")!;
    expect(reasonField.value.length).toBeLessThanOrEqual(1024);
    expect(reasonField.value).toMatch(/\.\.\.$/);
  });
});

// ---------------------------------------------------------------------------
// handler (integration)
// ---------------------------------------------------------------------------

describe("handler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DISCORD_CHANNEL_ID: "123456789",
      DISCORD_BOT_TOKEN_SECRET_ARN:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:token",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("processes an SNS event with one record", async () => {
    const event = {
      Records: [{ Sns: { Message: ALARM_SNS_MESSAGE } }],
    };

    const result = await handler(event);
    expect(result).toEqual({ statusCode: 200 });
  });

  it("processes an SNS event with multiple records", async () => {
    const event = {
      Records: [
        { Sns: { Message: ALARM_SNS_MESSAGE } },
        { Sns: { Message: OK_SNS_MESSAGE } },
      ],
    };

    const result = await handler(event);
    expect(result).toEqual({ statusCode: 200 });
  });

  it("throws when DISCORD_CHANNEL_ID is missing", async () => {
    delete process.env.DISCORD_CHANNEL_ID;
    const event = {
      Records: [{ Sns: { Message: ALARM_SNS_MESSAGE } }],
    };

    await expect(handler(event)).rejects.toThrow(
      "DISCORD_CHANNEL_ID is not configured",
    );
  });
});
