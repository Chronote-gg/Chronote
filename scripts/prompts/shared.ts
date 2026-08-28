import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";

export type PromptType = "text" | "chat";
export type ChatMessage = {
  role: string;
  content: string;
};

export type PromptFrontMatter = {
  name?: string;
  type?: PromptType;
  labels?: string[];
  tags?: string[];
  config?: unknown;
  commitMessage?: string;
  extends?: string[] | string;
  fragment?: boolean;
  messages?: ChatMessage[];
  prompt?: ChatMessage[];
  version?: number;
  [key: string]: unknown;
};

export type PromptFile = {
  filePath: string;
  name: string;
  type: PromptType;
  labels: string[];
  tags: string[];
  config: unknown;
  commitMessage?: string;
  version?: number;
  extends: string[];
  fragment: boolean;
  prompt: string | ChatMessage[];
  content: string;
  extraFrontMatter: Record<string, unknown>;
};

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string") as string[];
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function resolvePromptName(filePath: string, data: PromptFrontMatter): string {
  if (typeof data.name === "string" && data.name.trim().length > 0) {
    return data.name.trim();
  }
  return path.basename(filePath, path.extname(filePath));
}

function resolvePromptType(data: PromptFrontMatter): PromptType {
  if (data.type === "chat" || data.type === "text") {
    return data.type;
  }
  return "text";
}

function extractChatMessages(data: PromptFrontMatter): ChatMessage[] {
  const messages = data.messages ?? data.prompt;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.filter(
    (msg): msg is ChatMessage =>
      Boolean(msg) &&
      typeof msg === "object" &&
      typeof (msg as ChatMessage).role === "string" &&
      typeof (msg as ChatMessage).content === "string",
  );
}

function stripKnownKeys(data: PromptFrontMatter): Record<string, unknown> {
  const {
    name,
    type,
    labels,
    tags,
    config,
    commitMessage,
    extends: extendsList,
    fragment,
    messages,
    prompt,
    version,
    ...rest
  } = data;
  void name;
  void type;
  void labels;
  void tags;
  void config;
  void commitMessage;
  void extendsList;
  void fragment;
  void messages;
  void prompt;
  void version;
  return rest;
}

export async function listPromptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPromptFiles(entryPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

type ResolveOptions = {
  rootDir: string;
  seen?: Set<string>;
};

function resolveExtendPath(
  rootDir: string,
  fromFilePath: string,
  reference: string,
): string {
  const normalized = reference.replace(/\\/g, "/");
  const withExt = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return path.resolve(path.dirname(fromFilePath), withExt);
  }
  if (normalized.startsWith("/")) {
    return path.resolve(rootDir, normalized.slice(1));
  }
  return path.resolve(rootDir, withExt);
}

async function resolvePromptFile(
  filePath: string,
  options: ResolveOptions,
): Promise<PromptFile> {
  const absolutePath = path.resolve(filePath);
  const seen = options.seen ?? new Set<string>();
  if (seen.has(absolutePath)) {
    throw new Error(`Circular prompt extends detected at ${filePath}.`);
  }
  const nextSeen = new Set(seen);
  nextSeen.add(absolutePath);

  const prompt = await readPromptFile(absolutePath);
  if (prompt.extends.length === 0) {
    return prompt;
  }

  const basePrompts = await Promise.all(
    prompt.extends.map((reference) =>
      resolvePromptFile(
        resolveExtendPath(options.rootDir, absolutePath, reference),
        { rootDir: options.rootDir, seen: nextSeen },
      ),
    ),
  );

  for (const base of basePrompts) {
    if (base.type !== prompt.type) {
      throw new Error(
        `Prompt type mismatch: ${prompt.name} (${prompt.type}) extends ${base.name} (${base.type}).`,
      );
    }
  }

  const mergedPrompt =
    prompt.type === "chat"
      ? [
          ...basePrompts.flatMap((base) => base.prompt as ChatMessage[]),
          ...(prompt.prompt as ChatMessage[]),
        ]
      : [
          ...basePrompts.map((base) => base.prompt as string),
          prompt.prompt as string,
        ].join("\n\n");

  return {
    ...prompt,
    prompt: mergedPrompt,
  };
}

export async function readPromptFileResolved(
  filePath: string,
  rootDir: string,
): Promise<PromptFile> {
  return resolvePromptFile(filePath, { rootDir });
}

export async function readPromptFile(filePath: string): Promise<PromptFile> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = matter(raw, {
    engines: { yaml: (input) => parseYaml(input) as object },
  });
  const data = parsed.data as PromptFrontMatter;
  const content = normalizeLineEndings(parsed.content).trimEnd();

  const name = resolvePromptName(filePath, data);
  const type = resolvePromptType(data);
  const labels = normalizeStringArray(data.labels);
  const tags = normalizeStringArray(data.tags);
  const config = data.config ?? {};
  const commitMessage =
    typeof data.commitMessage === "string" && data.commitMessage.trim()
      ? data.commitMessage.trim()
      : undefined;
  const version = typeof data.version === "number" ? data.version : undefined;
  const extendsList = normalizeStringArray(data.extends);
  const fragment = data.fragment === true;

  const messages = extractChatMessages(data);
  if (type === "chat" && messages.length === 0) {
    throw new Error(
      `Chat prompt "${name}" is missing messages in front matter (${filePath}).`,
    );
  }

  return {
    filePath,
    name,
    type,
    labels,
    tags,
    config,
    commitMessage,
    version,
    extends: extendsList,
    fragment,
    prompt: type === "chat" ? messages : content,
    content,
    extraFrontMatter: stripKnownKeys(data),
  };
}

export function buildPromptPath(baseDir: string, promptName: string): string {
  const parts = promptName.split("/").filter(Boolean);
  return path.join(baseDir, ...parts) + ".md";
}

export function mergeFrontMatter(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...overrides };
}

export function formatPromptFile(
  frontMatter: Record<string, unknown>,
  content: string,
): string {
  const sanitized = stripUndefinedRecord(frontMatter);
  return matter.stringify(content.trimEnd(), sanitized);
}

function stripUndefinedRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.entries(value).reduce<Record<string, unknown>>(
    (acc, [key, val]) => {
      const cleaned = stripUndefinedValue(val);
      if (cleaned !== undefined) {
        acc[key] = cleaned;
      }
      return acc;
    },
    {},
  );
}

function stripUndefinedValue(value: unknown): unknown | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map(stripUndefinedValue)
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    return stripUndefinedRecord(value as Record<string, unknown>);
  }
  return value;
}

export function normalizePromptText(value: string): string {
  return normalizeLineEndings(value).trimEnd();
}

export function compareStringArrays(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function normalizeLabels(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => value.toLowerCase() !== "latest");
}

export function compareLabelArrays(a: string[], b: string[]): boolean {
  const left = normalizeLabels(a).sort();
  const right = normalizeLabels(b).sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function compareChatMessages(
  left: ChatMessage[],
  right: ChatMessage[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((msg, index) => {
    const other = right[index];
    return (
      msg.role === other.role &&
      normalizePromptText(msg.content) === normalizePromptText(other.content)
    );
  });
}
