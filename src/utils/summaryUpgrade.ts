export const SUMMARY_UPGRADE = {
  heading: "Need more recording time?",
  body: "Upgrade for more recording time. Your subscription also helps keep Chronote running.",
  button: "Upgrade",
};

export function buildSummaryUpgradeBody(recordedSeconds: number): string {
  const minutes = Math.floor(recordedSeconds / 60);
  const hours =
    recordedSeconds > 10 * 3600
      ? Math.floor(recordedSeconds / 3600)
      : Math.floor(recordedSeconds / 360) / 10;
  const duration =
    recordedSeconds < 60
      ? "less than a minute"
      : recordedSeconds <= 3600
        ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
        : `${hours.toLocaleString("en-US")} ${hours === 1 ? "hour" : "hours"}`;
  return `Your server has recorded ${duration} across its saved meetings. ${SUMMARY_UPGRADE.body}`;
}

export function isSummaryUpgradeField(field: {
  name: string;
  value: string;
  inline?: boolean;
}): boolean {
  if (field.name !== SUMMARY_UPGRADE.heading || field.inline === true)
    return false;
  const value = field.value.replace(
    "Upgrade for more recording time and answers from more past meetings.",
    "Upgrade for more recording time.",
  );
  const prefix = "Your server has recorded ";
  const suffix = ` across its saved meetings. ${SUMMARY_UPGRADE.body}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const duration = value.slice(prefix.length, -suffix.length);
  if (duration === "less than a minute") return true;
  const match = /^([\d,.]+) (minutes?|hours?)$/.exec(duration);
  if (!match) return false;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const seconds = match[2].startsWith("minute")
    ? amount * 60
    : Math.round(amount * 3600) + (amount === 1 ? 1 : 0);
  return buildSummaryUpgradeBody(seconds) === value;
}
