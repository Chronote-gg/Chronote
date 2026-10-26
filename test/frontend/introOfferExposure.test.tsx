import { act, render } from "@testing-library/react";
import { useIntroOfferExposure } from "../../src/frontend/hooks/useIntroOfferExposure";
import {
  track,
  isDoNotTrackEnabled,
} from "../../src/frontend/services/analytics";
import type { ExpectedIntroOffer } from "../../src/types/pricing";

jest.mock("../../src/frontend/services/analytics", () => ({
  track: jest.fn(),
  isDoNotTrackEnabled: jest.fn(() => false),
}));

let notify: IntersectionObserverCallback;
const disconnect = jest.fn();
const observe = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDoNotTrackEnabled).mockReturnValue(false);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  global.IntersectionObserver = jest.fn((callback) => {
    notify = callback;
    return {
      observe,
      disconnect,
      unobserve: jest.fn(),
      takeRecords: () => [],
      root: null,
      rootMargin: "0px",
      scrollMargin: "0px",
      thresholds: [1],
    };
  });
});

function Page({
  offer = "basic_intro_v1",
  entry = "upgrade:server-a",
  observationKey,
}: {
  offer?: ExpectedIntroOffer;
  entry?: string;
  observationKey?: string;
}) {
  useIntroOfferExposure({
    offer,
    entry,
    surface: "upgrade",
    guildId: entry.split(":")[1],
    observationKey,
  });
  return (
    <div key={observationKey} data-testid="basic-intro-terms">
      Actual purchase terms
    </div>
  );
}

test("rebinds responsive terms without counting an offer twice", () => {
  const view = render(<Page observationKey="table" />);
  const original = document.querySelector('[data-testid="basic-intro-terms"]');
  view.rerender(<Page observationKey="cards" />);
  const cards = document.querySelector('[data-testid="basic-intro-terms"]');
  expect(cards).not.toBe(original);
  expect(disconnect).toHaveBeenCalled();
  expect(observe).toHaveBeenLastCalledWith(cards);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
  view.rerender(<Page observationKey="table" />);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
});

function visibility(ratio: number) {
  const target = document.querySelector('[data-testid="basic-intro-terms"]')!;
  act(() =>
    notify(
      [
        {
          target,
          intersectionRatio: ratio,
          isIntersecting: ratio > 0,
          boundingClientRect: { width: 300, height: 80 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
}

test("counts each fully visible displayed offer once per page/server entry", () => {
  const view = render(<Page />);
  expect(track).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledWith(
    document.querySelector('[data-testid="basic-intro-terms"]'),
  );
  visibility(0.9);
  expect(track).not.toHaveBeenCalled();
  visibility(1);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenLastCalledWith("basic_intro_offer_exposed", {
    offer: "basic_intro_v1",
    interval: "month",
    surface: "upgrade",
    guild_id: "server-a",
    event_version: 1,
  });
  view.rerender(<Page offer="basic_annual_intro_v1" />);
  visibility(1);
  view.rerender(<Page />);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(2);
  view.rerender(<Page entry="upgrade:server-b" />);
  visibility(1);
  view.rerender(<Page entry="billing:server-b" />);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(4);
});

test("waits for document visibility and respects DNT without consuming unseen exposure", () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  render(<Page />);
  visibility(1);
  expect(track).not.toHaveBeenCalled();
  jest.mocked(isDoNotTrackEnabled).mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(track).not.toHaveBeenCalled();
  jest.mocked(isDoNotTrackEnabled).mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
});

test("does not observe an unavailable offer and releases observers on exit", () => {
  const view = render(<Page offer="none" />);
  expect(observe).not.toHaveBeenCalled();
  view.rerender(<Page />);
  view.unmount();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test("zero-area terms do not count even when a synthetic observer reports intersection", () => {
  render(<Page />);
  const target = document.querySelector('[data-testid="basic-intro-terms"]')!;
  act(() =>
    notify(
      [
        {
          target,
          intersectionRatio: 1,
          isIntersecting: true,
          boundingClientRect: { width: 0, height: 0 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
  expect(track).not.toHaveBeenCalled();
});

test("ignores queued visibility from the previous server entry", () => {
  const view = render(<Page />);
  const oldNotify = notify;
  const target = document.querySelector('[data-testid="basic-intro-terms"]')!;
  view.rerender(<Page entry="upgrade:server-b" />);
  act(() =>
    oldNotify(
      [
        {
          target,
          intersectionRatio: 1,
          isIntersecting: true,
          boundingClientRect: { width: 300, height: 80 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
  expect(track).not.toHaveBeenCalled();
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenLastCalledWith(
    "basic_intro_offer_exposed",
    expect.objectContaining({ guild_id: "server-b" }),
  );
});

test("requires fresh viewport proof when a hidden tab becomes visible", () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  render(<Page />);
  visibility(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(track).not.toHaveBeenCalled();
  visibility(0.5);
  expect(track).not.toHaveBeenCalled();
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
});

test("rejects the old observer's queued full record after tab return", () => {
  render(<Page />);
  const oldNotify = notify;
  const target = document.querySelector('[data-testid="basic-intro-terms"]')!;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(track).not.toHaveBeenCalled();
  act(() =>
    oldNotify(
      [
        {
          target,
          intersectionRatio: 1,
          isIntersecting: true,
          boundingClientRect: { width: 300, height: 80 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
  expect(track).not.toHaveBeenCalled();
  visibility(0.5);
  expect(track).not.toHaveBeenCalled();
  visibility(1);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
});
