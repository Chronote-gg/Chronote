import { act, render, screen, fireEvent } from "@testing-library/react";
import { useRenewalAnalytics } from "../../src/frontend/hooks/useRenewalAnalytics";
import { createRenewalFixture } from "../../src/frontend/pages/renewalFixtures";
import { annualSubscriber } from "../../src/frontend/pages/basicIntroFixtures";
import {
  track,
  isDoNotTrackEnabled,
} from "../../src/frontend/services/analytics";
import type { RenewalView } from "../../src/types/renewal";
jest.mock("../../src/frontend/services/analytics", () => ({
  track: jest.fn(),
  isDoNotTrackEnabled: jest.fn(() => false),
}));
let notify: IntersectionObserverCallback;
let observer: IntersectionObserver;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isDoNotTrackEnabled).mockReturnValue(false);
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  global.IntersectionObserver = jest.fn((callback) => {
    notify = callback;
    observer = {
      root: null,
      rootMargin: "0px",
      scrollMargin: "0px",
      thresholds: [1],
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
      takeRecords: () => [],
    };
    return observer;
  });
});
const ready = (): RenewalView => ({
  ...createRenewalFixture({
    details: annualSubscriber,
    cancellationAt: annualSubscriber.renewalAt,
  }),
  lifecycleAnalyticsEnabled: true,
});
function Page({ view = ready() }: { view?: RenewalView }) {
  const click = useRenewalAnalytics({
    view,
    serverId: "111111111111111111",
    active: true,
  });
  return (
    <div data-testid="renewal-off">
      <button onClick={click}>confirm</button>
    </div>
  );
}
function visibility(ratio: number) {
  const target = screen.getByTestId("renewal-off");
  act(() =>
    notify(
      [
        {
          target,
          time: 0,
          rootBounds: null,
          intersectionRect: new DOMRect(0, 0, 300, 100),
          boundingClientRect: new DOMRect(0, 0, 300, 100),
          isIntersecting: ratio > 0,
          intersectionRatio: ratio,
        },
      ],
      observer,
    ),
  );
}
test("counts actual visibility once per terms state and a deliberate click separately", () => {
  const view = ready();
  const rendered = render(<Page view={view} />);
  expect(track).not.toHaveBeenCalled();
  visibility(0.5);
  expect(track).not.toHaveBeenCalled();
  visibility(1);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
  rendered.rerender(<Page view={ready()} />);
  visibility(1);
  expect(track).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("confirm"));
  expect(track).toHaveBeenLastCalledWith(
    "billing_renewal_reactivation_clicked",
    expect.objectContaining({ guild_id: "111111111111111111", eligible: true }),
  );
  expect(JSON.stringify(jest.mocked(track).mock.calls)).not.toMatch(
    /quoteToken|synthetic-renewal|unitAmount|10000/,
  );
});
test("gate-off and browser DNT suppress exposure and clicks", () => {
  const view = ready();
  const rendered = render(
    <Page view={{ ...view, lifecycleAnalyticsEnabled: false }} />,
  );
  expect(global.IntersectionObserver).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("confirm"));
  expect(track).not.toHaveBeenCalled();
  rendered.rerender(<Page view={view} />);
  jest.mocked(isDoNotTrackEnabled).mockReturnValue(true);
  visibility(1);
  fireEvent.click(screen.getByText("confirm"));
  expect(track).not.toHaveBeenCalled();
});
test("nonpayer exposure cannot become an eligible save click", () => {
  const view = ready();
  view.canManageBilling = false;
  render(<Page view={view} />);
  visibility(1);
  expect(track).toHaveBeenCalledWith(
    "billing_renewal_off_viewed",
    expect.objectContaining({ eligible: false }),
  );
  fireEvent.click(screen.getByText("confirm"));
  expect(track).toHaveBeenCalledTimes(1);
});
