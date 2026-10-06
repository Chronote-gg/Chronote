export const SUMMARY_UPGRADE = {
  heading: "Need more recording time?",
  body: "Upgrade for more recording time and answers from more past meetings. Your subscription also helps keep Chronote running.",
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
