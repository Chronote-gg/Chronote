import { useEffect, useRef, useState } from "react";
import { trpc } from "../services/trpc";
import type { RenewalRecoveryView } from "../../types/renewalRecovery";

const none: RenewalRecoveryView = { status: "none" };
export function useBillingRenewalRecovery({
  serverId,
  active,
  view: snapshot,
  onBillingChanged,
}: {
  serverId: string | null;
  active: boolean;
  view: RenewalRecoveryView | undefined;
  onBillingChanged: () => Promise<unknown>;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.billing.cancelRenewalPayment.useMutation();
  const [error, setError] = useState<string | null>(null);
  const currentServer = useRef(serverId);
  currentServer.current = serverId;
  const billingChanged = useRef(onBillingChanged);
  billingChanged.current = onBillingChanged;
  const previous = useRef({ serverId, status: snapshot?.status });
  const view = active ? (snapshot ?? none) : none;
  const pending = view.status !== "none" && view.status !== "canceled";
  const endsAt = view.status === "none" ? null : view.endsAt;
  const invalidateControls = async () => {
    if (!serverId) return;
    await Promise.allSettled([
      utils.billing.change.invalidate({ serverId }),
      utils.billing.renewal.invalidate({ serverId }),
    ]);
  };
  const refresh = async (): Promise<void> => {
    if (!active || !serverId || currentServer.current !== serverId) return;
    await Promise.allSettled([billingChanged.current(), invalidateControls()]);
  };
  const refreshAction = useRef(refresh);
  refreshAction.current = refresh;
  useEffect(() => {
    setError(null);
  }, [serverId]);
  useEffect(() => {
    const before = previous.current;
    previous.current = { serverId, status: view.status };
    if (
      before.serverId === serverId &&
      before.status !== view.status &&
      (view.status === "none" || view.status === "canceled")
    ) {
      setError(null);
      void invalidateControls();
    }
  }, [serverId, view.status, utils]);
  useEffect(() => {
    if (!active || !serverId || view.status === "none") return;
    const update = () => {
      void refreshAction.current();
    };
    const interval = pending
      ? setInterval(update, view.status === "grace" ? 30000 : 3000)
      : undefined;
    const delay = endsAt ? Date.parse(endsAt) - Date.now() : 0;
    const deadline = delay > 0 ? setTimeout(update, delay) : undefined;
    window.addEventListener("focus", update);
    window.addEventListener("pageshow", update);
    return () => {
      clearInterval(interval);
      clearTimeout(deadline);
      window.removeEventListener("focus", update);
      window.removeEventListener("pageshow", update);
    };
  }, [serverId, active, view.status, endsAt, pending]);
  const cancel = async (): Promise<void> => {
    if (
      !serverId ||
      !active ||
      mutation.isPending ||
      view.status !== "grace" ||
      !view.canManage
    )
      return;
    setError(null);
    try {
      const result = await mutation.mutateAsync({ serverId });
      if (currentServer.current !== serverId) return;
      utils.billing.me.setData({ serverId }, (previous) =>
        previous ? { ...previous, renewalRecovery: result } : previous,
      );
    } catch {
      if (currentServer.current === serverId)
        setError(
          "We couldn't confirm cancellation. Refresh billing to check its status.",
        );
    } finally {
      await refresh();
    }
  };
  return { view, pending, busy: mutation.isPending, error, refresh, cancel };
}
