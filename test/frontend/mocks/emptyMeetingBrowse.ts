import { jest } from "@jest/globals";

export function emptyMeetingBrowse() {
  return {
    data: {
      pages: [
        {
          meetings: [],
          hasMore: false,
          discoveryComplete: true,
          nextCursor: null,
        },
      ],
    },
    isLoading: false,
    isFetching: false,
    error: null,
    hasNextPage: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
  };
}
