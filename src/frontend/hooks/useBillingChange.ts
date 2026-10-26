import { useEffect, useRef } from "react";
import { notifications } from "@mantine/notifications";
import { trpc } from "../services/trpc";
import type {
  BillingChangeSelection,
  BillingChangeView,
} from "../../types/billingChange";

export function useBillingChange({
  serverId,
  active,
  canStart = true,
  onBillingChanged,
}: {
  serverId: string | null;
  active: boolean;
  canStart?: boolean;
  onBillingChanged: () => Promise<unknown>;
}) {
  const utils = trpc.useUtils();
  const currentServer = useRef(serverId);
  currentServer.current = serverId;
  const query = trpc.billing.change.useQuery(
    { serverId: serverId ?? "" },
    {
      enabled: active && Boolean(serverId),
      retry: false,
      refetchInterval: (query) => {
        const view = query.state.data;
        if (view?.kind === "operation" && view.state === "review") return 30000;
        return view?.kind === "operation" &&
          ["preparing", "accepted", "applying", "canceling"].includes(
            view.state,
          )
          ? 3000
          : false;
      },
    },
  );
  const prepare = trpc.billing.prepareChange.useMutation();
  const confirm = trpc.billing.confirmChange.useMutation();
  const cancel = trpc.billing.cancelChange.useMutation();
  const busy = prepare.isPending || confirm.isPending || cancel.isPending;
  const view = query.data;
  const observed = useRef(new Map<string, BillingChangeView>());
  const refreshBilling = useRef(onBillingChanged);
  refreshBilling.current = onBillingChanged;
  useEffect(() => {
    if (!serverId || !active || !view) return;
    const previous = observed.current.get(serverId);
    observed.current.set(serverId, view);
    const complete =
      view.kind === "operation" &&
      ["succeeded", "canceled"].includes(view.state);
    const newlyComplete =
      complete &&
      (previous?.kind !== "operation" ||
        previous.operationId !== view.operationId ||
        previous.state !== view.state);
    const completedElsewhere =
      view.kind === "none" &&
      previous?.kind === "operation" &&
      !["succeeded", "canceled"].includes(previous.state);
    if (newlyComplete || completedElsewhere)
      void Promise.allSettled([
        utils.billing.change.invalidate({ serverId }),
        refreshBilling.current(),
      ]);
  }, [serverId, active, view, utils]);
  const receive = async (result: BillingChangeView) => {
    if (!serverId) return;
    utils.billing.change.setData({ serverId }, result);
    if (
      result.kind === "operation" &&
      ["succeeded", "canceled"].includes(result.state)
    ) {
      if (currentServer.current === serverId)
        notifications.show({
          color: "gray",
          title:
            result.state === "succeeded"
              ? "Plan change complete"
              : "Change canceled",
          message:
            result.state === "succeeded"
              ? "Your billing details have been updated."
              : "Your current plan is unchanged.",
        });
    }
  };
  const run = async (
    action: () => Promise<BillingChangeView>,
    openPayment = false,
  ) => {
    if (!serverId || !active || busy) return;
    try {
      const result = await action();
      await receive(result);
      if (
        openPayment &&
        currentServer.current === serverId &&
        result.kind === "operation" &&
        result.state === "accepted" &&
        result.paymentUrl
      )
        window.location.href = result.paymentUrl;
    } catch (error) {
      if (currentServer.current !== serverId) return;
      notifications.show({
        color: "gray",
        title: "Check your plan change",
        message:
          error instanceof Error
            ? error.message
            : "Refresh billing to check the current status.",
      });
      await query.refetch();
    }
  };
  const select = async (selection: BillingChangeSelection) => {
    if (!canStart) return;
    await run(() =>
      prepare.mutateAsync({ serverId: serverId ?? "", selection }),
    );
  };
  const approve = () =>
    run(() => {
      if (view?.kind !== "operation" || view.state !== "review")
        throw new Error("Refresh the review before confirming.");
      return confirm.mutateAsync({
        serverId: serverId ?? "",
        operationId: view.operationId,
        revision: view.revision,
      });
    }, true);
  const abandon = () =>
    run(() => {
      if (view?.kind !== "operation")
        throw new Error("Refresh billing before canceling.");
      return cancel.mutateAsync({
        serverId: serverId ?? "",
        operationId: view.operationId,
      });
    });
  const pay = () => {
    if (
      view?.kind === "operation" &&
      view.state === "accepted" &&
      view.paymentUrl
    )
      window.location.href = view.paymentUrl;
  };
  return {
    view,
    busy,
    error: query.isError,
    loading: query.isLoading,
    select,
    approve,
    abandon,
    pay,
    refresh: () => query.refetch(),
    enabled: active && canStart && view?.kind === "none" && view.enabled,
    pending:
      view?.kind === "operation" &&
      !["succeeded", "canceled"].includes(view.state),
  };
}
