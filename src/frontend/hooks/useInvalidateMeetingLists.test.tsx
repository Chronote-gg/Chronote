import { renderHook, act } from "@testing-library/react";
import { useInvalidateMeetingLists } from "./useInvalidateMeetingLists";
const mockGlobal = jest.fn(async () => {});
const mockLegacy = jest.fn(async () => {});
jest.mock("../services/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: {
        myList: { invalidate: mockGlobal },
        list: { invalidate: mockLegacy },
      },
    }),
  },
}));
beforeEach(() => jest.clearAllMocks());
test.each([null, "server"])(
  "invalidates global filter variants and scoped legacy lists for %s",
  async (serverId) => {
    const { result } = renderHook(() => useInvalidateMeetingLists(serverId));
    await act(() => result.current());
    expect(mockGlobal).toHaveBeenCalledWith();
    expect(mockLegacy).toHaveBeenCalledTimes(serverId ? 3 : 0);
  },
);
