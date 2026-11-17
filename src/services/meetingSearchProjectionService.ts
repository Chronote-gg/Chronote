import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { MeetingHistory } from "../types/db";
import type {
  MeetingSearchProjectionState,
  MeetingSearchStateRepository,
  SearchProjectionDocument,
  SearchProjectionKey,
  SearchProjectionSource,
} from "../types/meetingSearchProjection";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const tokenizer = getEncoding("cl100k_base");
export const searchTranscriptHash = hash;

// Delivery state is excluded so a Discord acknowledgement does not invalidate search.
export const meetingSearchSourceRevision = (history: MeetingHistory) =>
  hash(
    JSON.stringify(
      [
        history.guildId,
        history.channelId_timestamp,
        history.meetingId,
        history.channelId,
        history.textChannelId,
        history.notesChannelId,
        history.timestamp,
        history.meetingName,
        history.summarySentence,
        history.summaryLabel,
        history.notes,
        history.tags,
        history.archivedAt,
        history.ownershipScope,
        history.ownerUserId,
        history.accessGrants,
        history.participants,
        history.attendees,
        history.meetingCreatorId,
        history.transcriptS3Key,
        history.transcript,
        history.notesVersion,
        history.contentRevision,
        history.status,
      ],
      (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            )
          : value,
    ),
  );

function transcriptPassageEnd(transcript: string, start: number) {
  let end = Math.min(start + 3000, transcript.length);
  if (end < transcript.length) {
    const paragraph = transcript.lastIndexOf("\n\n", end - 2);
    const line = transcript.lastIndexOf("\n", end - 1);
    if (paragraph > start + 1500) end = paragraph + 2;
    else if (line > start + 1500) end = line + 1;
  }
  while (tokenizer.encode(transcript.slice(start, end), [], []).length > 8192) {
    end = start + Math.floor((end - start) * 0.9);
  }
  // Preserve UTF-16 offsets without dividing a surrogate pair.
  if (end < transcript.length && /[\uD800-\uDBFF]/.test(transcript[end - 1]))
    end--;
  return end;
}

export function buildMeetingSearchDocuments(
  history: MeetingHistory,
  transcript: string,
  generation: string,
  attempt: string,
  dataset?: "meetings" | "transcripts",
): SearchProjectionDocument[] {
  const revision = meetingSearchSourceRevision(history);
  const metadata: SearchProjectionDocument["metadata"] = {
    server_id: history.guildId,
    meeting_id: history.channelId_timestamp,
    meeting_ref: JSON.stringify([history.guildId, history.channelId_timestamp]),
    source_revision: revision,
    voice_channel_id: history.channelId,
    text_channel_id:
      history.textChannelId ?? history.notesChannelId ?? history.channelId,
    timestamp: Date.parse(history.timestamp),
    archived: Boolean(history.archivedAt),
    ...(history.tags?.length ? { tags: history.tags } : {}),
  };
  if (!Number.isFinite(metadata.timestamp))
    throw Error("Invalid meeting timestamp");
  const documents: SearchProjectionDocument[] = [];
  const append = (
    dataset: SearchProjectionDocument["dataset"],
    text: string,
    extra = {},
  ) => {
    if (!text.trim()) return;
    const filterable = { ...metadata, ...extra };
    if (Buffer.byteLength(JSON.stringify(filterable), "utf8") > 2048)
      throw Error("Search filterable metadata exceeds 2 KB");
    if (
      Buffer.byteLength(
        JSON.stringify({ ...filterable, search_text: text }),
        "utf8",
      ) >
      40 * 1024
    )
      throw Error("Search metadata exceeds 40 KB");
    if (tokenizer.encode(text, [], []).length > 8192)
      throw Error("Search embedding exceeds 8192 tokens");
    documents.push({
      key: hash(
        JSON.stringify([
          generation,
          revision,
          attempt,
          dataset,
          documents.length,
        ]),
      ),
      dataset,
      inputHash: hash(JSON.stringify(["text-embedding-3-small", 1536, text])),
      text,
      metadata: filterable,
    });
  };
  if (dataset !== "transcripts")
    append(
      "meetings",
      [
        history.meetingName,
        history.summaryLabel,
        history.summarySentence,
        history.tags?.join(" "),
        history.notes,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  const transcriptHash = hash(transcript);
  for (let start = 0; dataset !== "meetings" && start < transcript.length;) {
    const end = transcriptPassageEnd(transcript, start);
    append("transcripts", transcript.slice(start, end), {
      start,
      end,
      transcript_hash: transcriptHash,
    });
    if (end === transcript.length) break;
    start = end - 200;
    if (/[\uDC00-\uDFFF]/.test(transcript[start])) start++;
  }
  return documents;
}

export interface SearchProjectionIndex {
  put(
    documents: (SearchProjectionDocument & { vector: number[] })[],
    signal?: AbortSignal,
  ): Promise<void>;
  remove(
    dataset: SearchProjectionDocument["dataset"],
    keys: string[],
  ): Promise<void>;
  get(
    dataset: SearchProjectionDocument["dataset"],
    key: string,
  ): Promise<number[] | undefined>;
}

export function createMeetingSearchProjector(deps: {
  generation: string;
  state: MeetingSearchStateRepository;
  source: SearchProjectionSource;
  index: SearchProjectionIndex;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const save = (state: MeetingSearchProjectionState) => deps.state.put(state);
  async function cleanup(state: MeetingSearchProjectionState) {
    state.status = "tombstone";
    // Retain tombstones: an unacknowledged old PutVectors may finish after this delete.
    await save(state);
    const keys = state.documents.map((document) => document.key);
    for (let offset = 0; offset < keys.length; offset += 500) {
      await deps.index.remove(state.dataset, keys.slice(offset, offset + 500));
    }
  }
  return async function project(
    key: SearchProjectionKey,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const history = await deps.source.get(key, signal);
    const states = await deps.state.list(key, deps.generation);
    if (!history) {
      for (const old of states) await cleanup(old);
      return;
    }
    const revision = meetingSearchSourceRevision(history);
    async function loadState(
      dataset: "meetings" | "transcripts",
      transcriptHash: string,
    ): Promise<MeetingSearchProjectionState> {
      const projectionId = hash(
        JSON.stringify([
          deps.generation,
          key.guildId,
          key.channelId_timestamp,
          revision,
          dataset,
          transcriptHash,
        ]),
      );
      const existing = await deps.state.get(projectionId);
      return (
        existing ?? {
          projectionId,
          generation: deps.generation,
          dataset,
          meeting: {
            guildId: key.guildId,
            channelId_timestamp: key.channelId_timestamp,
          },
          revision,
          transcriptHash,
          model: "text-embedding-3-small",
          dimensions: 1536,
          status: "pending",
          documents: [],
          attempts: 0,
          retryAt: now(),
          createdAt: now(),
        }
      );
    }
    async function cleanupOld(state: MeetingSearchProjectionState) {
      for (const old of states) {
        if (
          old.dataset === state.dataset &&
          old.projectionId !== state.projectionId
        )
          await cleanup(old);
      }
    }
    async function embedDocuments(
      documents: SearchProjectionDocument[],
      state: MeetingSearchProjectionState,
    ) {
      const cachedVectors = new Map<string, number[]>();
      const missing: SearchProjectionDocument[] = [];
      for (const document of documents) {
        signal?.throwIfAborted();
        const prior = states
          .filter(
            (s) =>
              s.status === "ready" &&
              s.dataset === state.dataset &&
              s.model === state.model &&
              s.dimensions === state.dimensions,
          )
          .flatMap((s) => s.documents)
          .find((d) => d.inputHash === document.inputHash);
        const vector = prior
          ? await deps.index.get(state.dataset, prior.key)
          : undefined;
        if (vector) cachedVectors.set(document.key, vector);
        else missing.push(document);
      }
      const fresh = missing.length
        ? await deps.embed(
            missing.map((d) => d.text),
            signal,
          )
        : [];
      if (fresh.length !== missing.length)
        throw Error("Embedding batch output mismatch");
      missing.forEach((document, index) =>
        cachedVectors.set(document.key, fresh[index]),
      );
      return documents.map((document) => ({
        ...document,
        vector: cachedVectors.get(document.key)!,
      }));
    }
    async function projectDataset(dataset: "meetings" | "transcripts") {
      let state = await loadState(dataset, "");
      let failure: NonNullable<MeetingSearchProjectionState["failure"]> =
        "source";
      try {
        const transcript =
          dataset === "transcripts"
            ? await deps.source.transcript(history!, signal)
            : "";
        const transcriptHash =
          dataset === "transcripts" ? hash(transcript) : "";
        state = await loadState(dataset, transcriptHash);
        if (state.status === "ready") {
          await cleanupOld(state);
          return;
        }
        state.status = "pending";
        state.attempts++;
        state.failure = undefined;
        failure = "limits";
        const documents = buildMeetingSearchDocuments(
          history!,
          transcript,
          deps.generation,
          state.projectionId,
          dataset,
        );
        state.documents = documents.map(
          ({ key: documentKey, dataset, inputHash }) => ({
            key: documentKey,
            dataset,
            inputHash,
          }),
        );
        // Deterministic revision keys preserve uncertain writes across retries without allocating new intents.
        await save(state);
        failure = "embedding";
        const embedded = await embedDocuments(documents, state);
        async function current() {
          const latest = await deps.source.get(key, signal);
          return (
            latest &&
            meetingSearchSourceRevision(latest) === revision &&
            (dataset === "meetings" ||
              hash(await deps.source.transcript(latest, signal)) ===
                transcriptHash)
          );
        }
        if (!(await current())) {
          await cleanup(state);
          return;
        }
        failure = "index";
        for (let offset = 0; offset < embedded.length; offset += 100) {
          signal?.throwIfAborted();
          await deps.index.put(embedded.slice(offset, offset + 100), signal);
        }
        if (!(await current())) {
          await cleanup(state);
          return;
        }
        state.status = "ready";
        state.retryAt = 0;
        await save(state);
        await cleanupOld(state);
      } catch (error) {
        if (failure === "source") state.attempts++;
        state.failure = failure;
        state.retryAt =
          now() + Math.min(3_600_000, 1000 * 2 ** Math.min(state.attempts, 12));
        await save(state);
        throw error;
      }
    }
    const failures: unknown[] = [];
    for (const dataset of ["meetings", "transcripts"] as const) {
      try {
        await projectDataset(dataset);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  };
}
