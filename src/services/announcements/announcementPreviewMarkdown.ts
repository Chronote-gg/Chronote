import type { AnnouncementPreview, PreviewEntry } from "./announcementRunner";
import { ownerDmContent } from "./announcementSend";
import type { CandidateRejection } from "./announcementTypes";

// Backslash first, so a backslash in the value cannot cancel the pipe escape.
export const markdownTableCell = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|") || "-";

const rejectedText = (rejected: CandidateRejection[]) =>
  rejected
    .map(
      ({ source, channelId, problem, missing }) =>
        `${source} ${channelId}: ${problem}${missing ? ` (${missing.join(", ")})` : ""}`,
    )
    .join("; ");

const row = ({ guildId, decision }: PreviewEntry) => {
  const rejected =
    "rejected" in decision ? rejectedText(decision.rejected) : "";
  if (decision.kind === "target")
    return [
      guildId,
      "post",
      decision.channelSource,
      decision.channelId,
      rejected,
    ];
  if (decision.kind === "owner_dm")
    return [
      guildId,
      `OWNER DM (missing ${decision.missing.join(", ")})`,
      "owner_dm",
      `DM to owner ${decision.ownerId}`,
      rejected,
    ];
  const detail =
    "detail" in decision && decision.detail ? `: ${decision.detail}` : "";
  return [guildId, `skip ${decision.reason}${detail}`, "-", "-", rejected];
};

/** The private, human-readable copy of a preview the operator reviews before send. */
export const previewMarkdown = (preview: AnnouncementPreview): string => {
  const { announcement, embed } = preview;
  const ownerDms = preview.entries.flatMap(({ guildId, decision }) =>
    decision.kind === "owner_dm"
      ? [
          `- ${guildId}: ${ownerDmContent(decision.guildName, decision.missing)}`,
        ]
      : [],
  );
  return [
    `# Announcement preview: ${announcement.id}`,
    "",
    `Kind: ${announcement.kind}`,
    `Created: ${preview.createdAt}`,
    `Retry failed: ${preview.retryFailed}`,
    `Preview SHA-256: ${preview.sha256}`,
    "",
    "## Embed",
    "",
    "````text",
    `Title: ${embed.title}`,
    "",
    embed.description,
    "",
    ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
    `Footer: ${embed.footer.text}`,
    "````",
    "",
    "## Warnings",
    "",
    ...(preview.warnings.length > 0
      ? preview.warnings.map((warning) => `- ${warning}`)
      : ["None."]),
    "",
    "## Owner DMs",
    "",
    "These owners get the embed by DM, with this line above it, because the bot cannot post in their community updates channel.",
    "",
    ...(ownerDms.length > 0 ? ownerDms : ["None."]),
    "",
    "## Servers",
    "",
    "| Server | Decision | Channel source | Channel | Rejected candidates |",
    "| --- | --- | --- | --- | --- |",
    ...preview.entries.map(
      (entry) => `| ${row(entry).map(markdownTableCell).join(" | ")} |`,
    ),
    "",
  ].join("\n");
};
