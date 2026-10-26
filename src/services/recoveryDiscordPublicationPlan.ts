import { z } from "zod";
import {
  discordBotIdentitySchema,
  discordChannelSchema,
  discordEditorMessageSchema,
  type DiscordEditorMessage,
} from "./discordMessageEditor";
import {
  batchMeetingNotesEmbeds,
  buildMeetingNotesEmbeds,
} from "../utils/meetingNotes";
import {
  formatMeetingCaptureNotice,
  withMeetingCaptureNotice,
} from "../utils/meetingCaptureNotice";
import { getMeetingProcessingNotice } from "../utils/meetingProcessing";
import {
  PublicationPreviewBlockedError,
  publicationScopeSchema,
  publicationHistorySchema,
  recoveryPublicationManifestSchema,
  recoveryDiscordPreviewSchema,
  editableEmbedSchema,
  footer,
  bindingSchema,
  targetSchema,
  bindRecoveryPublication,
  normalizePublicationEmbeds,
  publicationMessageFingerprint,
  stablePublicationJson,
  publicationDigest,
  digest,
  type PublicationScope,
  type PublicationHistory,
  type PublicationDependencies,
  type RecoveryDiscordPreview,
} from "./recoveryDiscordPublicationTypes";
type EditableEmbed = z.infer<typeof editableEmbedSchema>;
function isSummaryEmbed(embed: EditableEmbed): boolean {
  const names = new Set(embed.fields?.map((field) => field.name.toLowerCase()));
  return (
    ["start time", "end time", "duration"].filter((name) => names.has(name))
      .length >= 2
  );
}
function isNotesEmbed(embed: EditableEmbed, meetingName?: string): boolean {
  const forbidden = [
    embed.fields?.length,
    embed.author,
    embed.image,
    embed.thumbnail,
    embed.url,
  ];
  if (
    !embed.title ||
    embed.description === undefined ||
    forbidden.some(Boolean)
  )
    return false;
  const base = embed.title.replace(/ \(part \d+\/\d+\)$/, "");
  return (
    base === "Meeting Notes" ||
    base === meetingName?.trim() ||
    /^v\d+(?:$|[ •|])/.test(embed.footer?.text ?? "")
  );
}
const limitedEmbedSchema = editableEmbedSchema.extend({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  footer: footer.extend({ text: z.string().max(2048) }).optional(),
  author: editableEmbedSchema.shape.author
    .unwrap()
    .extend({ name: z.string().max(256) })
    .optional(),
  fields: z
    .array(
      z.object({
        name: z.string().max(256),
        value: z.string().max(1024),
        inline: z.boolean().optional(),
      }),
    )
    .max(25)
    .optional(),
});
function validateLimits(embeds: EditableEmbed[]) {
  z.array(limitedEmbedSchema).max(10).parse(embeds);
  const total = embeds.reduce(
    (sum, embed) =>
      sum +
      [
        embed.title,
        embed.description,
        embed.footer?.text,
        embed.author?.name,
        ...(embed.fields?.flatMap((field) => [field.name, field.value]) ?? []),
      ].join("").length,
    0,
  );
  if (total > 6000)
    throw new PublicationPreviewBlockedError(
      "Proposed message exceeds Discord aggregate text limit",
    );
}
function makeTarget(
  message: DiscordEditorMessage,
  afterEmbeds: Array<Record<string, unknown>>,
  role: "notes" | "summary",
  guildId: string,
): z.infer<typeof targetSchema> {
  const beforeEmbeds = normalizePublicationEmbeds(message.embeds);
  validateLimits(normalizePublicationEmbeds(afterEmbeds));
  return {
    role,
    channelId: message.channel_id,
    messageId: message.id,
    url: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
    before: message,
    beforeFingerprint: publicationMessageFingerprint(message),
    afterEmbeds,
    afterFingerprint: publicationMessageFingerprint({
      ...message,
      embeds: afterEmbeds,
    }),
    afterEmbedsDigest: digest(afterEmbeds),
    unchanged:
      stablePublicationJson(beforeEmbeds) ===
      stablePublicationJson(afterEmbeds),
    changes: afterEmbeds.flatMap((embed, index) =>
      stablePublicationJson(beforeEmbeds[index]) ===
      stablePublicationJson(embed)
        ? []
        : [{ embedIndex: index, before: beforeEmbeds[index], after: embed }],
    ),
  };
}
function targetChannel(stored: PublicationHistory, messageId: string): string {
  return messageId === stored.summaryMessageId
    ? (stored.textChannelId ?? stored.notesChannelId)
    : stored.notesChannelId;
}
function validatePublicationMessage(
  message: DiscordEditorMessage | null,
  {
    messageId,
    channelId,
    botId,
  }: { messageId: string; channelId: string; botId: string },
): asserts message is DiscordEditorMessage {
  if (
    !message ||
    message.id !== messageId ||
    message.channel_id !== channelId ||
    message.author.id !== botId ||
    !message.author.bot ||
    message.webhook_id ||
    (message.flags & 32768) !== 0
  )
    throw new PublicationPreviewBlockedError(
      `Saved Discord post ${messageId} is missing or not a supported bot-owned message`,
    );
  if (
    message.embeds.some(
      (embed) => embed.type !== undefined && embed.type !== "rich",
    )
  )
    throw new PublicationPreviewBlockedError(
      "Unrecognized non-rich embed cannot be preserved safely",
    );
}
async function readPublicationMessages(
  scope: PublicationScope,
  stored: PublicationHistory,
  botId: string,
  discord: PublicationDependencies["discord"],
) {
  const ids = [
    ...stored.notesMessageIds,
    ...(stored.summaryMessageId ? [stored.summaryMessageId] : []),
  ];
  if (new Set(ids).size !== ids.length)
    throw new PublicationPreviewBlockedError(
      "Duplicate or aliased summary and notes message IDs",
    );
  const channels = new Set(
    ids.map((messageId) => targetChannel(stored, messageId)),
  );
  for (const channelId of channels) {
    const channel = discordChannelSchema.parse(
      await discord.getChannel(channelId),
    );
    if (channel.id !== channelId || channel.guild_id !== scope.guildId)
      throw new PublicationPreviewBlockedError(
        "Saved message channel does not belong to selected guild",
      );
  }
  const messages: DiscordEditorMessage[] = [];
  for (const messageId of ids) {
    const channelId = targetChannel(stored, messageId);
    const raw = await discord.getMessage({ channelId, messageId });
    const message = raw === null ? null : discordEditorMessageSchema.parse(raw);
    validatePublicationMessage(message, { messageId, channelId, botId });
    messages.push(message);
  }
  return messages;
}
function mergeNotesSlot({
  current,
  candidate,
  page,
  total,
  footerText,
  requiredWarning,
}: {
  current: EditableEmbed;
  candidate: EditableEmbed;
  page: number;
  total: number;
  footerText: string;
  requiredWarning?: string;
}): EditableEmbed {
  const pagination = / \(part (\d+)\/(\d+)\)$/.exec(current.title ?? "");
  if (
    (total > 1 || pagination !== null) &&
    (!pagination ||
      Number(pagination[1]) !== page + 1 ||
      Number(pagination[2]) !== total)
  )
    throw new PublicationPreviewBlockedError(
      "Unrecognized notes pagination order",
    );
  if (
    !candidate.footer?.text.startsWith(footerText) ||
    (requiredWarning && !candidate.footer.text.includes(requiredWarning))
  )
    throw new PublicationPreviewBlockedError(
      "Required recovered version or uncertainty notice would be truncated",
    );
  const retainedNotice = current.footer?.text.replace(
    /^v\d+(?: \| Recovered notes| • Edited by [^•]+)?(?: • )?/,
    "",
  );
  if (retainedNotice && retainedNotice !== requiredWarning)
    throw new PublicationPreviewBlockedError(
      "Unrecognized existing footer may contain uncertainty text",
    );
  return {
    ...current,
    ...candidate,
    ...(current.color === undefined ? {} : { color: current.color }),
    footer: { ...current.footer, text: candidate.footer.text },
  };
}
function planNotesTargets(
  scope: PublicationScope,
  stored: PublicationHistory,
  messages: DiscordEditorMessage[],
) {
  const layouts = messages
    .filter((message) => message.id !== stored.summaryMessageId)
    .map((message) => {
      const embeds = normalizePublicationEmbeds(message.embeds);
      if (embeds.some(isSummaryEmbed))
        throw new PublicationPreviewBlockedError(
          "Mixed summary and notes layout is unsupported",
        );
      const slots = embeds.flatMap((embed, index) =>
        isNotesEmbed(embed, stored.meetingName) ? [index] : [],
      );
      if (!slots.length)
        throw new PublicationPreviewBlockedError(
          "Unrecognized notes embed layout",
        );
      return { message, embeds, slots };
    });
  const footerText = `v${stored.notesVersion} | Recovered notes`;
  const rendered = buildMeetingNotesEmbeds({
    ...stored,
    notesBody: stored.notes,
    footerText,
  });
  const batches = batchMeetingNotesEmbeds(rendered);
  const total = layouts.reduce((sum, layout) => sum + layout.slots.length, 0);
  const batchLayoutChanged =
    layouts.some((layout) => layout.slots.length > 1) &&
    (batches.length !== layouts.length ||
      batches.some(
        (batch, index) => batch.length !== layouts[index].slots.length,
      ));
  if (rendered.length !== total || batchLayoutChanged)
    throw new PublicationPreviewBlockedError(
      "Approved notes require a different pagination or message slot count",
    );
  const requiredWarning =
    getMeetingProcessingNotice(stored.processing, Boolean(stored.notes.trim()))
      ?.text ?? formatMeetingCaptureNotice(stored);
  let page = 0;
  return layouts.map(({ message, embeds, slots }) => {
    const after = [...embeds];
    for (const slot of slots) {
      const candidate = normalizePublicationEmbeds([
        rendered[page].toJSON(),
      ])[0];
      after[slot] = mergeNotesSlot({
        current: embeds[slot],
        candidate,
        page,
        total,
        footerText,
        requiredWarning,
      });
      page++;
    }
    return makeTarget(message, after, "notes", scope.guildId);
  });
}
function planSummaryTarget(
  scope: PublicationScope,
  stored: PublicationHistory,
  message: DiscordEditorMessage,
) {
  const embeds = normalizePublicationEmbeds(message.embeds);
  const slots = embeds.flatMap((embed, index) =>
    isSummaryEmbed(embed) ? [index] : [],
  );
  if (
    slots.length !== 1 ||
    embeds.some((embed) => isNotesEmbed(embed, stored.meetingName))
  )
    throw new PublicationPreviewBlockedError(
      "Unrecognized or mixed summary layout",
    );
  const summary = stored.summarySentence?.trim() ?? stored.summaryLabel?.trim();
  const description = withMeetingCaptureNotice(
    summary && summary.length ? summary : "Summary unavailable.",
    stored,
  );
  const title =
    stored.meetingName?.trim() ||
    stored.summaryLabel?.trim() ||
    "Meeting Summary";
  // Legacy recovery approval covers notes and transcript only.
  if (
    embeds[slots[0]].title !== title ||
    embeds[slots[0]].description !== description
  )
    throw new PublicationPreviewBlockedError(
      "Summary or title changes require separate approval",
    );
  return makeTarget(message, embeds, "summary", scope.guildId);
}
function previewBlocker(error: unknown): string {
  // Provider errors can contain private response bodies; retain only local blocker messages.
  if (error instanceof z.ZodError)
    return "Discord response has an unsupported shape";
  if (error instanceof PublicationPreviewBlockedError) return error.message;
  return "Publication preview could not read or validate its selected sources";
}
export async function previewRecoveryDiscordPublication(
  input: PublicationScope,
  deps: PublicationDependencies,
): Promise<RecoveryDiscordPreview> {
  const scope = publicationScopeSchema.parse(input);
  const createdAt = deps.now();
  let binding: z.infer<typeof bindingSchema> | null = null;
  let botId: string | null = null;
  const targets: z.infer<typeof targetSchema>[] = [];
  const blockers: string[] = [];
  try {
    const history = publicationHistorySchema.safeParse(
      await deps.readHistory(scope),
    );
    const manifest = recoveryPublicationManifestSchema.safeParse(
      await deps.readManifest(scope),
    );
    if (!history.success || !manifest.success)
      throw new PublicationPreviewBlockedError(
        "Stored meeting or approved operator recovery manifest is invalid",
      );
    const stored = history.data;
    binding = bindRecoveryPublication(scope, stored, manifest.data);
    const bot = discordBotIdentitySchema.parse(
      await deps.discord.getBotIdentity(),
    );
    botId = bot.id;
    const messages = await readPublicationMessages(
      scope,
      stored,
      botId,
      deps.discord,
    );
    targets.push(...planNotesTargets(scope, stored, messages));
    const summary = messages.find(
      (message) => message.id === stored.summaryMessageId,
    );
    if (summary) targets.push(planSummaryTarget(scope, stored, summary));
  } catch (error) {
    blockers.push(previewBlocker(error));
  }
  const result = {
    schemaVersion: 1,
    scope,
    createdAt,
    botId,
    binding,
    targets,
    blockers,
    kind: blockers.length ? "blocked" : "ready",
  };
  return recoveryDiscordPreviewSchema.parse({
    ...result,
    previewDigest: publicationDigest(result),
  });
}
