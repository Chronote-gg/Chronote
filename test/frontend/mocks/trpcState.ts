import { jest } from "@jest/globals";
export type QueryState<T> = {
  dataUpdatedAt: number;
  data: T | null;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: jest.Mock<() => Promise<void>>;
};

export type MutationState<TArgs extends unknown[], TResult> = {
  mutateAsync: jest.Mock<(...args: TArgs) => Promise<TResult>>;
  isPending: boolean;
  reset: jest.Mock<() => void>;
};

export const buildQueryState = <T>(data: T | null): QueryState<T> => ({
  dataUpdatedAt: 0,
  data,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

export const buildMutationState = <TArgs extends unknown[], TResult>(
  result: TResult,
): MutationState<TArgs, TResult> => ({
  mutateAsync: jest
    .fn<(...args: TArgs) => Promise<TResult>>()
    .mockResolvedValue(result),
  isPending: false,
  reset: jest.fn(),
});

export const resetQueryState = <T>(state: QueryState<T>, data: T | null) => {
  state.dataUpdatedAt = 0;
  state.data = data;
  state.isLoading = false;
  state.isFetching = false;
  state.error = null;
  state.refetch.mockReset();
  state.refetch.mockResolvedValue(undefined);
};

export const resetMutationState = <TArgs extends unknown[], TResult>(
  state: MutationState<TArgs, TResult>,
  result: TResult,
) => {
  state.isPending = false;
  state.mutateAsync.mockReset();
  state.mutateAsync.mockResolvedValue(result);
  state.reset.mockReset();
};
