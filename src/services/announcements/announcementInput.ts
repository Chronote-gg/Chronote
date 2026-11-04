import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AnnouncementInputError, type Announcement } from "./announcementTypes";

export type AnnouncementFormat = "markdown" | "json";

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
// Windows editors may save a byte order mark, which Node keeps when reading.
const BYTE_ORDER_MARK = /^\uFEFF/;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;
// @everyone, @here, and user, role and channel mention syntax.
const MENTION_PATTERN = /@everyone|@here|<@[!&]?\d+>|<#\d+>/g;
// Discord ids are 17 to 20 digits; a bare run that long is probably a pasted id.
const SNOWFLAKE_RUN_PATTERN = /(?<!\d)\d{17,20}(?!\d)/g;

const nonEmptyText = z.string().trim().min(1, "must not be empty");

// Repeated until stable, so overlapping input like "<!<!---- x -->-- y -->"
// cannot reassemble a comment from the pieces one pass leaves behind. Any
// marker that survives is an unterminated or stray comment and is refused.
const stripHtmlComments = (text: string): string => {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(HTML_COMMENT_PATTERN, "");
  } while (current !== previous);
  return current;
};

const frontMatterShape = {
  id: z
    .string()
    .regex(
      ID_PATTERN,
      "must be lowercase kebab-case, like incident-2026-11-04",
    ),
  kind: z.enum(["info", "incident", "resolved"]),
  title: nonEmptyText,
  fields: z
    .array(
      z.strictObject({
        name: nonEmptyText,
        value: nonEmptyText,
        inline: z.boolean().optional(),
      }),
    )
    .default([]),
};

// Templates carry operator guidance in HTML comments; it never reaches Discord.
const bodySchema = z
  .string()
  .transform((body) => stripHtmlComments(body).trim())
  .pipe(z.string().min(1, "must not be empty"));

const frontMatterSchema = z.strictObject(frontMatterShape);
// Keys double as the labels in problem messages, e.g. "front matter.id: ...".
const markdownSchema = z.object({
  "front matter": frontMatterSchema,
  body: bodySchema,
});
const jsonSchema = z.strictObject({ ...frontMatterShape, body: bodySchema });

const describeIssue = (issue: z.core.$ZodIssue) =>
  `${issue.path.map(String).join(".") || "announcement"}: ${issue.message}`;

const validate = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AnnouncementInputError(result.error.issues.map(describeIssue));
  }
  return result.data;
};

const parseSource = (read: () => unknown, label: string): unknown => {
  try {
    return read();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AnnouncementInputError([
      `${label}: could not be parsed: ${reason}`,
    ]);
  }
};

const parseMarkdown = (content: string): Announcement => {
  const match = FRONT_MATTER_PATTERN.exec(content.replace(BYTE_ORDER_MARK, ""));
  if (!match) {
    throw new AnnouncementInputError([
      "front matter: the file must start with a block delimited by --- lines",
    ]);
  }
  const parsed = validate(markdownSchema, {
    "front matter": parseSource(() => parseYaml(match[1]), "front matter"),
    body: match[2],
  });
  return { ...parsed["front matter"], body: parsed.body };
};

const parseJson = (content: string): Announcement =>
  validate(
    jsonSchema,
    parseSource(() => JSON.parse(content), "JSON"),
  );

type LabelledText = { label: string; text: string };

const labelledTexts = (announcement: Announcement): LabelledText[] => [
  { label: "title", text: announcement.title },
  { label: "body", text: announcement.body },
  ...announcement.fields.flatMap((field, index) => [
    { label: `fields.${index}.name`, text: field.name },
    { label: `fields.${index}.value`, text: field.value },
  ]),
];

const findCommentProblems = (texts: LabelledText[]): string[] =>
  texts.flatMap(({ label, text }) =>
    text.includes("<!--") || text.includes("-->")
      ? [
          `${label}: contains an unterminated or stray HTML comment marker (<!-- or -->)`,
        ]
      : [],
  );

const findMentionProblems = (texts: LabelledText[]): string[] =>
  texts.flatMap(({ label, text }) =>
    Array.from(
      text.matchAll(MENTION_PATTERN),
      ([mention]) => `${label}: mention syntax ${mention} is not allowed`,
    ),
  );

// Scanned over the whole file before parsing: a placeholder in the id, or a
// bare {{...}} that YAML reads as a mapping, must still be reported by name.
const findPlaceholderProblems = (content: string): string[] =>
  Array.from(
    stripHtmlComments(content).matchAll(PLACEHOLDER_PATTERN),
    ([, name]) => `unfilled placeholder {{${name}}}`,
  );

const findSnowflakeWarnings = (texts: LabelledText[]): string[] =>
  texts.flatMap(({ label, text }) =>
    Array.from(
      text.replace(MENTION_PATTERN, "").matchAll(SNOWFLAKE_RUN_PATTERN),
      ([digits]) =>
        `${label}: a ${digits.length}-digit number looks like a Discord snowflake id; check it is not a pasted server, channel or user id`,
    ),
  );

/**
 * Reads an operator announcement and refuses anything that could ping people
 * or ship an unfinished template. Warnings flag likely mistakes that are still
 * sendable, so preview can show them without blocking.
 */
export const parseAnnouncement = (
  content: string,
  format: AnnouncementFormat,
): { announcement: Announcement; warnings: string[] } => {
  const placeholders = findPlaceholderProblems(content);
  if (placeholders.length > 0) throw new AnnouncementInputError(placeholders);
  const announcement =
    format === "markdown" ? parseMarkdown(content) : parseJson(content);
  const texts = labelledTexts(announcement);
  const problems = [
    ...findCommentProblems(texts),
    ...findMentionProblems(texts),
  ];
  if (problems.length > 0) throw new AnnouncementInputError(problems);
  return { announcement, warnings: findSnowflakeWarnings(texts) };
};
