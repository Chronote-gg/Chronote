import { RENEWAL_QUOTE_TTL_MS } from "../../src/utils/renewalConstants";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, jest } from "@jest/globals";
import { resetFrontendMocks } from "./testUtils";
import { billingRenewalQuery, billingRenewalMutation } from "./mocks/trpc";
import { useBillingRenewal } from "../../src/frontend/hooks/useBillingRenewal";
import type { RenewalResult } from "../../src/types/renewal";
import { renewalQuote } from "../fixtures/renewal";

beforeEach(() => {
  resetFrontendMocks();
  billingRenewalQuery.data = {
    state: {
      kind: "off",
      tier: "basic",
      endsAt: renewalQuote.terms.renewsAt,
      action: {
        kind: "ready",
        quoteToken: "signed-consent",
        expiresAt: Date.now() + RENEWAL_QUOTE_TTL_MS,
        terms: renewalQuote.terms,
      },
    },
    canManageBilling: true,
    lifecycleAnalyticsEnabled: false,
  };
  billingRenewalQuery.refetch.mockRejectedValue(Error("read unavailable"));
});

it.each(["processing", "needs_review"] as const)(
  "retains the returned %s operation when the following read fails",
  async (kind) => {
    billingRenewalMutation.mutateAsync.mockResolvedValue({
      kind,
      operationId: "existing-operation",
    });
    const onBillingChanged = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ serverId }) =>
        useBillingRenewal({ serverId, active: true, onBillingChanged }),
      { initialProps: { serverId: "g1" } },
    );
    await act(async () => {
      await result.current.onConfirm("signed-consent");
    });
    expect(result.current.view?.state).toMatchObject({
      kind,
      operationId: "existing-operation",
    });
    await act(async () => {
      await result.current.onCheckStatus("existing-operation");
    });
    expect(billingRenewalMutation.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        serverId: "g1",
        request: { kind: "recover", operationId: "existing-operation" },
      }),
    );
    rerender({ serverId: "g2" });
    expect(result.current.view?.state.kind).toBe("off");
    rerender({ serverId: "g1" });
    expect(result.current.view?.state.kind).toBe(kind);
    billingRenewalQuery.refetch.mockImplementation(async () => {
      billingRenewalQuery.data = {
        state: { kind: "on", terms: renewalQuote.terms },
        canManageBilling: true,
        lifecycleAnalyticsEnabled: false,
      };
    });
    await act(async () => {
      await result.current.onRetry();
    });
    expect(result.current.view?.state.kind).toBe("on");
  },
);

it("retains the original server operation when its mutation finishes after switching servers", async () => {
  const response: { resolve: (value: RenewalResult) => void } = {
    resolve: () => undefined,
  };
  const deferred = new Promise<RenewalResult>((resolve) => {
    response.resolve = resolve;
  });
  billingRenewalMutation.mutateAsync.mockReturnValue(deferred);
  const originalView = billingRenewalQuery.data;
  const onBillingChanged = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ serverId }) =>
      useBillingRenewal({ serverId, active: true, onBillingChanged }),
    { initialProps: { serverId: "g1" } },
  );
  let submitted = Promise.resolve();
  act(() => {
    submitted = result.current.onConfirm("signed-consent");
  });
  billingRenewalQuery.data = {
    state: { kind: "not_applicable" },
    canManageBilling: false,
    lifecycleAnalyticsEnabled: false,
  };
  billingRenewalQuery.dataUpdatedAt = 10;
  rerender({ serverId: "g2" });
  await act(async () => {
    response.resolve({ kind: "processing", operationId: "original-operation" });
    await submitted;
  });
  expect(result.current.view?.state.kind).toBe("not_applicable");
  expect(billingRenewalQuery.refetch).not.toHaveBeenCalled();
  expect(onBillingChanged).not.toHaveBeenCalled();
  billingRenewalQuery.data = originalView;
  billingRenewalQuery.dataUpdatedAt = 0;
  rerender({ serverId: "g1" });
  expect(result.current.view?.state).toMatchObject({
    kind: "processing",
    operationId: "original-operation",
  });
});

it("keeps independent pending operations for each server", async () => {
  const originalView = billingRenewalQuery.data;
  billingRenewalMutation.mutateAsync
    .mockResolvedValueOnce({ kind: "processing", operationId: "operation-g1" })
    .mockResolvedValueOnce({ kind: "processing", operationId: "operation-g2" });
  const onBillingChanged = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ serverId }) =>
      useBillingRenewal({ serverId, active: true, onBillingChanged }),
    { initialProps: { serverId: "g1" } },
  );
  await act(async () => {
    await result.current.onConfirm("signed-consent");
  });
  if (
    originalView?.state.kind !== "off" ||
    originalView.state.action.kind !== "ready"
  )
    throw Error("Expected another server quote");
  const otherView = {
    ...originalView,
    state: {
      ...originalView.state,
      action: { ...originalView.state.action, quoteToken: "server-b-consent" },
    },
  };
  billingRenewalQuery.data = otherView;
  billingRenewalQuery.dataUpdatedAt = 10;
  rerender({ serverId: "g2" });
  await act(async () => {
    await result.current.onConfirm("server-b-consent");
  });
  expect(result.current.view?.state).toMatchObject({
    kind: "processing",
    operationId: "operation-g2",
  });
  billingRenewalQuery.data = null;
  billingRenewalQuery.dataUpdatedAt = 0;
  rerender({ serverId: "g2" });
  expect(result.current.view?.state).toMatchObject({
    kind: "processing",
    operationId: "operation-g2",
  });
  billingRenewalQuery.data = originalView;
  billingRenewalQuery.dataUpdatedAt = 0;
  rerender({ serverId: "g1" });
  expect(result.current.view?.state).toMatchObject({
    kind: "processing",
    operationId: "operation-g1",
  });
  billingRenewalQuery.data = {
    state: { kind: "on", terms: renewalQuote.terms },
    canManageBilling: true,
    lifecycleAnalyticsEnabled: false,
  };
  billingRenewalQuery.dataUpdatedAt = 20;
  rerender({ serverId: "g1" });
  expect(result.current.view?.state.kind).toBe("on");
  billingRenewalQuery.data = null;
  billingRenewalQuery.dataUpdatedAt = 0;
  rerender({ serverId: "g1" });
  expect(result.current.view?.state).toBeUndefined();
});
