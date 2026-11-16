import {
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../contexts/AuthContext";

type Phase =
  "checking" | "redirecting" | "unavailable" | "required" | "blocked";
type RecoveryViewProps = {
  phase: Phase;
  onRetry: () => void;
  onSignIn: () => void;
  onStay: () => void;
};
export function AuthRecoveryView({
  phase,
  onRetry,
  onSignIn,
  onStay,
}: RecoveryViewProps) {
  if (phase === "checking" || phase === "redirecting")
    return (
      <Stack align="center" gap="sm" role="status">
        <Loader color="brand" />
        <Text>
          {phase === "checking"
            ? "Checking your sign-in..."
            : "Returning through Discord..."}
        </Text>
      </Stack>
    );
  if (phase === "blocked")
    return (
      <Stack gap="sm">
        <Text>
          Signing in will leave this page and discard unfinished edits or
          uploads.
        </Text>
        <Text size="sm" c="dimmed">
          Your local work stays in this tab until you choose to leave. Saving is
          paused until you sign in.
        </Text>
        <Group>
          <Button onClick={onSignIn}>Continue to sign in</Button>
          <Button variant="default" onClick={onStay}>
            Stay here
          </Button>
        </Group>
      </Stack>
    );
  return (
    <Stack align="center" gap="sm" role="alert">
      <Text fw={600}>
        {phase === "unavailable"
          ? "We couldn't check your sign-in"
          : "We couldn't restore access"}
      </Text>
      <Text size="sm" c="dimmed">
        Your meetings are not shown until access can be checked.
      </Text>
      <Group>
        <Button onClick={phase === "unavailable" ? onRetry : onSignIn}>
          {phase === "unavailable" ? "Retry" : "Sign in again"}
        </Button>
        {phase === "required" ? (
          <Button variant="default" onClick={onRetry}>
            Retry access check
          </Button>
        ) : null}
        <Button component="a" href="/" variant="subtle">
          Back to home
        </Button>
      </Group>
    </Stack>
  );
}

function recoveryPhase(
  state: ReturnType<typeof useAuth>["state"],
  ready: boolean,
  blocked: boolean,
): Phase {
  if (state === "unknown") return "checking";
  if (state === "authenticated" && !ready) return "checking";
  if (state === "unavailable") return "unavailable";
  if (state === "recovering") return "redirecting";
  if (state === "unauthenticated" && !blocked) return "redirecting";
  return blocked ? "blocked" : "required";
}

function useSessionContent(
  actorKey: number,
  ready: boolean,
  navigationBlocked: boolean,
) {
  const mounted = useRef({ actorKey, content: false });
  if (mounted.current.actorKey !== actorKey)
    mounted.current = { actorKey, content: false };
  if (ready) mounted.current.content = true;
  return {
    mounted: mounted.current.content,
    retain: mounted.current.content && (ready || navigationBlocked),
  };
}

export function ProtectedSessionBoundary({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  const auth = useAuth();
  const path = window.location.pathname;
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  const [staying, setStaying] = useState(false);
  const ready =
    auth.state === "authenticated" &&
    auth.protectedQueriesReady &&
    checkedPath === path &&
    !loading;
  const content = useSessionContent(
    auth.actorKey,
    ready,
    auth.navigationBlocked,
  );
  useEffect(() => {
    let current = true;
    void auth.ensureProtectedSession().then(() => {
      if (current) setCheckedPath(path);
    });
    return () => {
      current = false;
    };
  }, [auth.ensureProtectedSession, path]);
  useEffect(() => {
    if (
      auth.state === "unauthenticated" &&
      !auth.navigationBlocked &&
      checkedPath === path
    )
      auth.continueRecovery();
  }, [
    auth.state,
    auth.navigationBlocked,
    auth.continueRecovery,
    checkedPath,
    path,
  ]);
  const blocked = auth.navigationBlocked && !ready;
  const phase = recoveryPhase(auth.state, ready, blocked);
  const showDialog = blocked && content.mounted && !staying;
  const view = (
    <AuthRecoveryView
      phase={phase}
      onRetry={() => void auth.retryRecovery()}
      onSignIn={() =>
        auth.continueRecovery({
          interactive: auth.state === "recovery-required",
          discardWork: true,
        })
      }
      onStay={() => setStaying(true)}
    />
  );
  return (
    <>
      {content.retain ? (
        <div
          key={auth.actorKey}
          style={{ display: ready || staying ? "contents" : "none" }}
          inert={!ready}
        >
          {children}
        </div>
      ) : null}
      {!ready && !showDialog ? <Center py="xl">{view}</Center> : null}
      <Modal
        opened={showDialog}
        onClose={() => setStaying(true)}
        title="Sign-in paused"
        withCloseButton={false}
        closeOnEscape={false}
        closeOnClickOutside={false}
        zIndex={1000}
        centered
      >
        {view}
      </Modal>
    </>
  );
}
