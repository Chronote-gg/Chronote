import { firstPublicationFixture } from "./firstPublication.fixture";
import {
  createFirstPublicationRepository,
  createMemoryFirstPublicationStore,
} from "../../src/repositories/firstPublicationRepository";
import type {
  FirstPublicationDependencies,
  PublicationPayload,
} from "../../src/services/firstPublicationTypes";
import type { DiscordEditorMessage } from "../../src/services/discordMessageEditor";
export function workflowFixture() {
  const f = firstPublicationFixture(),
    store = createMemoryFirstPublicationStore([f.row], {
      pk: "ENV",
      sk: "CONTROL",
      publicationProtocol: 1,
      servingGeneration: 1,
      coordinatorEpoch: 1,
    }),
    repo = createFirstPublicationRepository(store);
  const messages = new Map<string, DiscordEditorMessage>(),
    posts: PublicationPayload[] = [];
  const deps: FirstPublicationDependencies = {
    profile: f.profile,
    now: () => "2026-11-03T09:00:00.000Z",
    processId: "local:synthetic:run",
    identity: async () => f.profile.accountId,
    repository: repo,
    readObject: async (key) =>
      key.endsWith("manifest.json")
        ? JSON.stringify(f.manifest)
        : key.endsWith("notes.md")
          ? f.objects.notes
          : f.objects.transcript,
    targetActive: async () => false,
    runtime: async () => ({
      kind: "compatible",
      generation: 1,
      control: structuredClone(store.control),
    }),
    stopped: async () => "synthetic process exited",
    discord: {
      getBotIdentity: async () => ({ id: "999", bot: true }),
      inspectDestination: async () => ({ allowed: true }),
      duplicateEvidence: async () => ({
        ambiguous: false,
        bounds: "synthetic window",
      }),
      getMessage: async (_c, id) => messages.get(id) ?? null,
      createNotesMessage: async ({ channelId, payload }) => {
        posts.push(payload);
        const id = String(900 + posts.length),
          m = {
            id,
            channel_id: channelId,
            author: { id: "999", bot: true },
            content: "",
            embeds: payload.embeds,
            components: payload.components,
            attachments: [],
            flags: 0,
          };
        messages.set(id, m);
        return m;
      },
    },
  };
  return { ...f, store, repo, deps, messages, posts };
}
