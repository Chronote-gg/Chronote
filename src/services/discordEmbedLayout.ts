import { z } from "zod";
import {
  editableEmbedSchema,
  footer,
  PublicationPreviewBlockedError,
} from "./recoveryDiscordPublicationTypes";
export type EditableEmbed = z.infer<typeof editableEmbedSchema>;
export function isSummaryEmbed(embed: EditableEmbed): boolean {
  const names = new Set(embed.fields?.map((field) => field.name.toLowerCase()));
  return (
    ["start time", "end time", "duration"].filter((name) => names.has(name))
      .length >= 2
  );
}
export function hasNotesEmbedShape(
  embed: EditableEmbed,
): embed is EditableEmbed & { title: string; description: string } {
  const forbidden = [
    embed.fields?.length,
    embed.author,
    embed.image,
    embed.thumbnail,
    embed.url,
  ];
  return (
    Boolean(embed.title) &&
    embed.description !== undefined &&
    !forbidden.some(Boolean)
  );
}
export function isNotesEmbed(
  embed: EditableEmbed,
  meetingName?: string,
): boolean {
  if (!hasNotesEmbedShape(embed)) return false;
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
export function validateLimits(embeds: EditableEmbed[]) {
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
