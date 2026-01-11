import { getFeedbackRepository } from "../repositories/feedbackRepository";
import type {
  FeedbackRating,
  FeedbackRecord,
  FeedbackSource,
  FeedbackTargetType,
} from "../types/db";

const ALL_TARGET_TYPES: FeedbackTargetType[] = [
  "meeting_summary",
  "ask_answer",
];

type FeedbackListResult = {
  items: FeedbackRecord[];
  nextCursor?: string;
};

const resolveCursorEndAt = (cursor?: string) => {
  if (!cursor) return undefined;
  return cursor;
};

const buildFeedbackKey = (item: FeedbackRecord) => `${item.pk}:${item.sk}`;

const dedupeFeedback = (items: FeedbackRecord[]) => {
  const map = new Map<string, FeedbackRecord>();
  items.forEach((item) => {
    map.set(buildFeedbackKey(item), item);
  });
  return Array.from(map.values());
};

export async function listFeedbackEntries(params: {
  targetType?: FeedbackTargetType;
  rating?: FeedbackRating;
  source?: FeedbackSource;
  limit?: number;
  cursor?: string;
}): Promise<FeedbackListResult> {
  const types = params.targetType ? [params.targetType] : ALL_TARGET_TYPES;
  const limit = params.limit ?? 100;
  const hasFilters = Boolean(params.rating || params.source);
  const perTypeLimit = Math.min(limit * (hasFilters ? 2 : 1), 500);
  const repo = getFeedbackRepository();
  const initialEndAt = resolveCursorEndAt(params.cursor);
  const applyFilters = (items: FeedbackRecord[]) => {
    let filtered = items;
    if (params.rating) {
      filtered = filtered.filter((item) => item.rating === params.rating);
    }
    if (params.source) {
      filtered = filtered.filter((item) => item.source === params.source);
    }
    return filtered;
  };
  const typeStates = new Map<
    FeedbackTargetType,
    { endAt?: string; done: boolean }
  >();
  types.forEach((targetType) => {
    typeStates.set(targetType, { endAt: initialEndAt, done: false });
  });
  const hasRemaining = () =>
    Array.from(typeStates.values()).some((state) => !state.done);
  let accumulated: FeedbackRecord[] = [];

  while (accumulated.length < limit && hasRemaining()) {
    const batches = await Promise.all(
      types.map(async (targetType) => {
        const state = typeStates.get(targetType);
        if (!state || state.done) return [] as FeedbackRecord[];
        const batch = await repo.listByTargetType({
          targetType,
          limit: perTypeLimit,
          endAt: state.endAt,
        });
        if (batch.length < perTypeLimit) {
          state.done = true;
        }
        if (batch.length > 0) {
          const lastCreatedAt = batch[batch.length - 1]?.createdAt;
          state.endAt = resolveCursorEndAt(lastCreatedAt);
        }
        return batch;
      }),
    );

    const filtered = applyFilters(dedupeFeedback(batches.flat()));
    if (filtered.length > 0) {
      accumulated = dedupeFeedback(accumulated.concat(filtered));
    }
  }

  accumulated.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sliced = accumulated.slice(0, limit);
  const nextCursor =
    sliced.length === limit ? sliced[sliced.length - 1]?.createdAt : undefined;
  return { items: sliced, nextCursor };
}
