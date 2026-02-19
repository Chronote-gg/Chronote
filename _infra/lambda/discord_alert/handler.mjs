/**
 * Lambda handler: forwards CloudWatch Alarm SNS notifications to a Discord channel.
 *
 * Uses the Discord REST API directly (no SDK dependencies) to keep the Lambda
 * thin and independent of the main application runtime.
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN_SECRET_ARN - Secrets Manager ARN for the bot token
 *   DISCORD_CHANNEL_ID           - Channel to post alerts to
 *   AWS_REGION                   - Set automatically by Lambda
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import https from "node:https";

const DISCORD_API_VERSION = "10";
const DISCORD_API_BASE = `https://discord.com/api/v${DISCORD_API_VERSION}`;

const ALARM_COLOR = 0xe74c3c; // red
const OK_COLOR = 0x2ecc71; // green
const UNKNOWN_COLOR = 0x95a5a6; // grey

/**
 * CloudWatch SNS messages use human-readable region names (e.g. "US East (N. Virginia)").
 * Map them to AWS region codes for console deeplinks.
 */
const REGION_NAME_TO_CODE = {
  "US East (N. Virginia)": "us-east-1",
  "US East (Ohio)": "us-east-2",
  "US West (N. California)": "us-west-1",
  "US West (Oregon)": "us-west-2",
  "Africa (Cape Town)": "af-south-1",
  "Asia Pacific (Hong Kong)": "ap-east-1",
  "Asia Pacific (Hyderabad)": "ap-south-2",
  "Asia Pacific (Jakarta)": "ap-southeast-3",
  "Asia Pacific (Melbourne)": "ap-southeast-4",
  "Asia Pacific (Mumbai)": "ap-south-1",
  "Asia Pacific (Osaka)": "ap-northeast-3",
  "Asia Pacific (Seoul)": "ap-northeast-2",
  "Asia Pacific (Singapore)": "ap-southeast-1",
  "Asia Pacific (Sydney)": "ap-southeast-2",
  "Asia Pacific (Tokyo)": "ap-northeast-1",
  "Canada (Central)": "ca-central-1",
  "Canada West (Calgary)": "ca-west-1",
  "Europe (Frankfurt)": "eu-central-1",
  "Europe (Ireland)": "eu-west-1",
  "Europe (London)": "eu-west-2",
  "Europe (Milan)": "eu-south-1",
  "Europe (Paris)": "eu-west-3",
  "Europe (Spain)": "eu-south-2",
  "Europe (Stockholm)": "eu-north-1",
  "Europe (Zurich)": "eu-central-2",
  "Israel (Tel Aviv)": "il-central-1",
  "Middle East (Bahrain)": "me-south-1",
  "Middle East (UAE)": "me-central-1",
  "South America (Sao Paulo)": "sa-east-1",
};

/** Convert a CloudWatch region label to an AWS region code. */
function resolveRegionCode(region) {
  if (!region) return process.env.AWS_REGION ?? "us-east-1";
  // Already a region code (e.g. "us-east-1")
  if (/^[a-z]{2}-[a-z]+-\d$/.test(region)) return region;
  return REGION_NAME_TO_CODE[region] ?? process.env.AWS_REGION ?? "us-east-1";
}

/** @type {string | undefined} */
let cachedToken;

const sm = new SecretsManagerClient({});

async function getDiscordToken() {
  if (cachedToken) return cachedToken;
  const result = await sm.send(
    new GetSecretValueCommand({
      SecretId: process.env.DISCORD_BOT_TOKEN_SECRET_ARN,
    }),
  );
  cachedToken = result.SecretString;
  return cachedToken;
}

/**
 * POST a JSON body to the Discord REST API.
 * Uses Node built-in https to avoid extra dependencies.
 */
function discordPost(path, body, token) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${DISCORD_API_BASE}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              resolve({ raw: responseBody });
            }
          } else {
            reject(new Error(`Discord API ${res.statusCode}: ${responseBody}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Map CloudWatch alarm state to embed color. */
function stateColor(state) {
  if (state === "ALARM") return ALARM_COLOR;
  if (state === "OK") return OK_COLOR;
  return UNKNOWN_COLOR;
}

/** Build a CloudWatch console deeplink for the alarm. */
function alarmConsoleUrl(region, alarmName) {
  const encoded = encodeURIComponent(alarmName);
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encoded}`;
}

/**
 * Parse a CloudWatch Alarm SNS message into a structured object.
 * The message JSON shape is documented at:
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html#alarm-evaluation-messages
 */
export function parseAlarmMessage(raw) {
  const msg = JSON.parse(raw);
  return {
    alarmName: msg.AlarmName ?? "Unknown Alarm",
    alarmDescription: msg.AlarmDescription ?? "",
    newState: msg.NewStateValue ?? "UNKNOWN",
    oldState: msg.OldStateValue ?? "UNKNOWN",
    reason: msg.NewStateReason ?? "",
    region: resolveRegionCode(msg.Region),
    metric: msg.Trigger?.MetricName ?? "",
    namespace: msg.Trigger?.Namespace ?? "",
    statistic: msg.Trigger?.Statistic ?? "",
    period: msg.Trigger?.Period,
    evaluationPeriods: msg.Trigger?.EvaluationPeriods,
    threshold: msg.Trigger?.Threshold,
    comparisonOperator: msg.Trigger?.ComparisonOperator ?? "",
    timestamp: msg.StateChangeTime ?? new Date().toISOString(),
  };
}

/** Format the comparison operator for display. */
function formatOperator(op) {
  const operators = {
    GreaterThanOrEqualToThreshold: ">=",
    GreaterThanThreshold: ">",
    LessThanThreshold: "<",
    LessThanOrEqualToThreshold: "<=",
  };
  return operators[op] ?? op;
}

/** Build a Discord embed from a parsed alarm. */
export function buildEmbed(alarm) {
  const stateEmoji =
    alarm.newState === "ALARM" ? "🚨" : alarm.newState === "OK" ? "✅" : "❓";
  const title = `${stateEmoji} ${alarm.alarmName}`;
  const consoleUrl = alarmConsoleUrl(alarm.region, alarm.alarmName);

  const fields = [
    {
      name: "Status",
      value: `${alarm.oldState} → **${alarm.newState}**`,
      inline: true,
    },
    { name: "Region", value: alarm.region, inline: true },
  ];

  if (alarm.metric) {
    fields.push({
      name: "Metric",
      value: `${alarm.namespace} / ${alarm.metric}`,
      inline: true,
    });
  }

  if (alarm.threshold !== undefined && alarm.threshold !== null) {
    const thresholdStr = `${alarm.statistic} ${formatOperator(alarm.comparisonOperator)} ${alarm.threshold}`;
    fields.push({ name: "Threshold", value: thresholdStr, inline: true });
  }

  if (alarm.period && alarm.evaluationPeriods) {
    const windowMinutes = (alarm.period * alarm.evaluationPeriods) / 60;
    fields.push({
      name: "Evaluation",
      value: `${alarm.evaluationPeriods} × ${alarm.period}s (${windowMinutes}m window)`,
      inline: true,
    });
  }

  if (alarm.reason) {
    // Truncate long reasons to fit embed field limit (1024 chars)
    const maxReasonLength = 1024;
    const reason =
      alarm.reason.length > maxReasonLength
        ? alarm.reason.slice(0, maxReasonLength - 3) + "..."
        : alarm.reason;
    fields.push({ name: "Reason", value: reason, inline: false });
  }

  return {
    title,
    description: alarm.alarmDescription || undefined,
    url: consoleUrl,
    color: stateColor(alarm.newState),
    fields,
    timestamp: alarm.timestamp,
    footer: { text: "CloudWatch Alarm" },
  };
}

export async function handler(event) {
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!channelId) {
    throw new Error("DISCORD_CHANNEL_ID is not configured");
  }

  const token = await getDiscordToken();

  for (const record of event.Records) {
    const alarm = parseAlarmMessage(record.Sns.Message);
    const embed = buildEmbed(alarm);

    await discordPost(
      `/channels/${channelId}/messages`,
      { embeds: [embed] },
      token,
    );

    console.log(
      JSON.stringify({
        action: "discord_alert_sent",
        alarm: alarm.alarmName,
        state: alarm.newState,
        channel: channelId,
      }),
    );
  }

  return { statusCode: 200 };
}
