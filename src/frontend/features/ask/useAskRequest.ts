import { useAuth } from "../../contexts/AuthContext";
import { trpc } from "../../services/trpc";
import { useAskRun } from "./useAskRun";
export function resolveAskCapabilities(
  settings:
    { agentEnabled?: boolean; searchEnabled?: boolean } | null | undefined,
) {
  return {
    agentEnabled: settings?.agentEnabled ?? false,
    searchEnabled: settings?.searchEnabled ?? false,
  };
}
export function useAskRequest({
  agentEnabled,
  serverId,
  conversationId,
  errorMessage,
  setErrorMessage,
}: {
  agentEnabled: boolean;
  serverId: string | null;
  conversationId: string | null;
  errorMessage: string | null;
  setErrorMessage: (message: string) => void;
}) {
  const { user } = useAuth();
  const runMutation = useAskRun({
    userId: user?.id ?? null,
    serverId: agentEnabled ? serverId : null,
    conversationId: agentEnabled ? conversationId : null,
  });
  const legacyAskMutation = trpc.ask.ask.useMutation();
  const askMutation = agentEnabled
    ? runMutation
    : {
        ...runMutation,
        mutateAsync: legacyAskMutation.mutateAsync,
        isPending: legacyAskMutation.isPending,
        text: "",
        question: "",
        activity: undefined,
        recoveredResult: null,
        recoveryError: null,
      };
  const paneProps = {
    historyDescription: agentEnabled
      ? undefined
      : "Uses recent accessible meeting history.",
    errorMessage: errorMessage ?? askMutation.recoveryError,
    activity: askMutation.isPending ? askMutation.activity : undefined,
    onStop: agentEnabled
      ? () => {
          void askMutation
            .stop()
            .catch(() =>
              setErrorMessage("Stop could not be confirmed. Try Stop again."),
            );
        }
      : undefined,
  };
  return { ...askMutation, paneProps };
}
