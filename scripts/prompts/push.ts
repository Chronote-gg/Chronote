import { createTwoFilesPatch } from "diff";
import { createPrompt, tryGetPrompt } from "./langfuseApi";
import {
  compareChatMessages,
  compareLabelArrays,
  compareStringArrays,
  listPromptFiles,
  normalizePromptText,
  readPromptFileResolved,
  PromptFile,
  ChatMessage,
  normalizeLabels,
} from "./shared";

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveLabels(prompt: PromptFile, override?: string): string[] {
  if (override) return [override];
  if (prompt.labels.length > 0) return prompt.labels;
  const envLabel = process.env.LANGFUSE_PROMPT_LABEL;
  if (envLabel && envLabel.trim().length > 0) {
    return [envLabel.trim()];
  }
  return ["production"];
}

function resolveCommitMessage(prompt: PromptFile, override?: string): string {
  if (override) return override;
  if (prompt.commitMessage) return prompt.commitMessage;
  return "Sync prompts from repo";
}

type PromptComparable = Pick<
  PromptFile,
  "type" | "labels" | "tags" | "config" | "prompt"
>;

function isPromptEqual(
  local: PromptComparable,
  remote: {
    prompt: string | ChatMessage[];
    type: string;
    labels: string[];
    tags: string[];
    config: unknown;
  },
): boolean {
  if (local.type !== remote.type) return false;
  if (!compareLabelArrays(local.labels, remote.labels)) return false;
  if (!compareStringArrays(local.tags, remote.tags)) return false;
  if (
    JSON.stringify(local.config ?? {}) !== JSON.stringify(remote.config ?? {})
  ) {
    return false;
  }

  if (local.type === "chat") {
    return compareChatMessages(
      local.prompt as ChatMessage[],
      remote.prompt as ChatMessage[],
    );
  }
  return (
    normalizePromptText(local.prompt as string) ===
    normalizePromptText(remote.prompt as string)
  );
}

function formatList(values: string[]): string {
  if (values.length === 0) return "(none)";
  return values.join(", ");
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function logTextDiff(localText: string, remoteText: string): void {
  const patch = createTwoFilesPatch(
    "local",
    "remote",
    localText,
    remoteText,
    "",
    "",
    { context: 3 },
  );
  console.log(patch.trimEnd());
}

function logPromptDiff(
  name: string,
  local: PromptComparable,
  remote: {
    prompt: string | ChatMessage[];
    type: string;
    labels: string[];
    tags: string[];
    config: unknown;
  },
): void {
  console.log(`Diff for ${name}:`);
  if (local.type !== remote.type) {
    console.log(`Type local=${local.type} remote=${remote.type}`);
  }
  if (!compareLabelArrays(local.labels, remote.labels)) {
    console.log(
      `Labels local=[${formatList(normalizeLabels(local.labels))}] remote=[${formatList(
        normalizeLabels(remote.labels),
      )}]`,
    );
  }
  if (!compareStringArrays(local.tags, remote.tags)) {
    console.log(
      `Tags local=[${formatList(local.tags)}] remote=[${formatList(remote.tags)}]`,
    );
  }
  if (
    JSON.stringify(local.config ?? {}) !== JSON.stringify(remote.config ?? {})
  ) {
    console.log("Config local:");
    console.log(formatJson(local.config));
    console.log("Config remote:");
    console.log(formatJson(remote.config));
  }

  if (local.type !== remote.type) {
    return;
  }

  if (local.type === "chat") {
    const localMessages = local.prompt as ChatMessage[];
    const remoteMessages = remote.prompt as ChatMessage[];
    if (localMessages.length !== remoteMessages.length) {
      console.log(
        `Message count local=${localMessages.length} remote=${remoteMessages.length}`,
      );
    }
    const max = Math.max(localMessages.length, remoteMessages.length);
    for (let i = 0; i < max; i += 1) {
      const left = localMessages[i];
      const right = remoteMessages[i];
      if (!left) {
        console.log(
          `Missing local message ${i} (${right?.role ?? "unknown"}).`,
        );
        continue;
      }
      if (!right) {
        console.log(`Missing remote message ${i} (${left.role}).`);
        continue;
      }
      if (left.role !== right.role) {
        console.log(
          `Message ${i} role local=${left.role} remote=${right.role}`,
        );
      }
      const localContent = normalizePromptText(left.content);
      const remoteContent = normalizePromptText(right.content);
      if (localContent !== remoteContent) {
        console.log(`Message ${i} content diff:`);
        logTextDiff(localContent, remoteContent);
      }
    }
    return;
  }

  const localText = normalizePromptText(local.prompt as string);
  const remoteText = normalizePromptText(remote.prompt as string);
  if (localText !== remoteText) {
    logTextDiff(localText, remoteText);
  }
}

async function main() {
  const dir = parseFlagValue("--dir") ?? "prompts";
  const labelOverride = parseFlagValue("--label");
  const commitOverride = parseFlagValue("--commit");
  const dryRun = hasFlag("--dry-run");
  const debugDiff = hasFlag("--debug-diff");

  const files = await listPromptFiles(dir);
  if (files.length === 0) {
    console.log(`No prompt files found in ${dir}.`);
    return;
  }

  for (const filePath of files) {
    const prompt = await readPromptFileResolved(filePath, dir);
    if (prompt.fragment) {
      console.log(`Skip ${prompt.name}, marked as fragment.`);
      continue;
    }
    const labels = resolveLabels(prompt, labelOverride);
    const tags = prompt.tags;
    const config = prompt.config ?? {};
    const commitMessage = resolveCommitMessage(prompt, commitOverride);

    try {
      const remote = await tryGetPrompt({
        name: prompt.name,
        label: labels[0],
      });
      if (!remote) {
        console.log(
          `Prompt ${prompt.name} not found in Langfuse (${labels[0]}), creating.`,
        );
      } else {
        const comparable: PromptComparable = {
          type: prompt.type,
          labels,
          tags,
          config,
          prompt: prompt.prompt,
        };
        const matches = isPromptEqual(comparable, remote);
        if (!matches && debugDiff) {
          logPromptDiff(prompt.name, comparable, remote);
        }
        if (matches) {
          console.log(`Skip ${prompt.name}, no changes.`);
          continue;
        }
      }
    } catch (error) {
      console.warn(`Could not compare ${prompt.name}, pushing anyway.`);
      console.warn(error);
    }

    const payload = {
      name: prompt.name,
      type: prompt.type,
      prompt: prompt.prompt,
      config,
      labels,
      tags,
      commitMessage,
    };

    if (dryRun) {
      console.log(`Would push ${prompt.name} (${prompt.type}).`);
      continue;
    }

    const created = await createPrompt(payload);
    console.log(
      `Pushed ${created.name} v${created.version ?? "?"} (${created.type}).`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
