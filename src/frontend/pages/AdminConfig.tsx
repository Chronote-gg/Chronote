import { useAuthNavigationBlocker } from "../hooks/useAuthNavigationBlocker";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { AdminConfigEntryList } from "../components/AdminConfigEntryList";
import type { ConfigMode } from "../components/AdminConfigEntryCard";
import Surface from "../components/Surface";
import { trpc } from "../services/trpc";
import { useAuth } from "../contexts/AuthContext";
import type { ConfigEntryInput } from "../types/configEntry";
import { uiOverlays } from "../uiTokens";
import { resolveScopeConfigInput } from "../utils/configScopes";
import { TTS_VOICE_OPTIONS } from "../../utils/ttsVoices";
import { coerceConfigValue } from "../../config/validation";

type GlobalConfigValue = { key: string; value?: unknown; source: string };

type ConfigModeUpdater = (
  prev: Record<string, ConfigMode>,
) => Record<string, ConfigMode>;

type ConfigValueUpdater = (
  prev: Record<string, unknown>,
) => Record<string, unknown>;

type AdminConfigState = {
  queryLoading: boolean;
  publishDisabled: boolean;
  entryDisabled: boolean;
  globalEntries: ConfigEntryInput[];
  valuesByKey: Map<string, { value?: unknown; source: string }>;
  localValues: Record<string, unknown>;
  localModes: Record<string, ConfigMode>;
  missingRequired: string[];
};

type AdminConfigActions = {
  refresh: () => void;
  publish: () => Promise<void>;
  markDirty: () => void;
  setLocalModes: (updater: ConfigModeUpdater) => void;
  setLocalValues: (updater: ConfigValueUpdater) => void;
};

const buildInitialState = (
  entries: ConfigEntryInput[],
  appconfigValues: Record<string, unknown>,
) => {
  const values: Record<string, unknown> = {};
  const modes: Record<string, ConfigMode> = {};

  entries.forEach((entry) => {
    if (Object.hasOwn(appconfigValues, entry.key)) {
      const rawValue = appconfigValues[entry.key];
      const coerced = coerceConfigValue(entry, rawValue);
      values[entry.key] = coerced.valid
        ? coerced.value
        : (entry.defaultValue ?? undefined);
    } else {
      values[entry.key] = entry.defaultValue ?? undefined;
    }
    modes[entry.key] = resolveInitialMode(entry, appconfigValues);
  });

  return { values, modes };
};

const buildPublishPayload = (
  entries: ConfigEntryInput[],
  localModes: Record<string, ConfigMode>,
  localValues: Record<string, unknown>,
) => {
  const valuesToPublish: Record<string, unknown> = {};
  entries.forEach((entry) => {
    if (localModes[entry.key] === "override") {
      valuesToPublish[entry.key] = localValues[entry.key];
    }
  });
  return valuesToPublish;
};

const resolveRegistry = (registry: ConfigEntryInput[] | undefined) =>
  registry ?? [];

const resolveValues = (values: GlobalConfigValue[] | undefined) => values ?? [];

const resolveAppConfigValues = (values: Record<string, unknown> | undefined) =>
  values ?? {};

const buildValuesByKey = (values: GlobalConfigValue[]) => {
  const map = new Map<string, { value?: unknown; source: string }>();
  values.forEach((entry) => {
    map.set(entry.key, entry);
  });
  return map;
};

const resolveLoading = (queryLoading: boolean, publishPending: boolean) =>
  queryLoading || publishPending;

const resolvePublishDisabled = (dirty: boolean, isLoading: boolean) =>
  !dirty || isLoading;

const resolveEntryDisabled = (isLoading: boolean) => isLoading;

const resolveInitialMode = (
  entry: ConfigEntryInput,
  appconfigValues: Record<string, unknown>,
): ConfigMode => {
  if (Object.hasOwn(appconfigValues, entry.key)) return "override";
  const scopeConfig = resolveScopeConfigInput(entry, "global");
  if (scopeConfig.required && entry.defaultValue === undefined) {
    return "override";
  }
  return "default";
};

const useAdminConfigState = (): {
  state: AdminConfigState;
  actions: AdminConfigActions;
} => {
  const globalQuery = trpc.config.global.useQuery();
  const publishGlobal = trpc.config.publishGlobal.useMutation({
    onSuccess: () => globalQuery.refetch(),
  });

  const registry = resolveRegistry(globalQuery.data?.registry);
  const globalEntries = useMemo(
    () =>
      registry.filter(
        (entry) => resolveScopeConfigInput(entry, "global").enabled,
      ),
    [registry],
  );
  const values = resolveValues(globalQuery.data?.values);
  const appconfigValues = resolveAppConfigValues(
    globalQuery.data?.appconfigValues,
  );
  const missingRequired = globalQuery.data?.validation?.missingRequired ?? [];

  const valuesByKey = useMemo(() => buildValuesByKey(values), [values]);

  const [localValues, setLocalValuesState] = useState<Record<string, unknown>>(
    {},
  );
  const [localModes, setLocalModesState] = useState<Record<string, ConfigMode>>(
    {},
  );
  const [dirty, setDirty] = useState(false);
  useAuthNavigationBlocker(dirty);

  useEffect(() => {
    if (dirty) return;
    const initialState = buildInitialState(globalEntries, appconfigValues);
    setLocalValuesState(initialState.values);
    setLocalModesState(initialState.modes);
    setDirty(false);
  }, [appconfigValues, dirty, globalEntries]);

  const isLoading = resolveLoading(
    globalQuery.isLoading,
    publishGlobal.isPending,
  );
  const publishDisabled = resolvePublishDisabled(dirty, isLoading);
  const entryDisabled = resolveEntryDisabled(isLoading);

  const refresh = () => {
    setDirty(false);
    globalQuery.refetch();
  };

  const publish = async () => {
    const valuesToPublish = buildPublishPayload(
      globalEntries,
      localModes,
      localValues,
    );
    await publishGlobal.mutateAsync({ values: valuesToPublish });
    setDirty(false);
  };

  const markDirty = () => setDirty(true);

  const setLocalModes = (updater: ConfigModeUpdater) => {
    setLocalModesState(updater);
  };

  const setLocalValues = (updater: ConfigValueUpdater) => {
    setLocalValuesState(updater);
  };

  return {
    state: {
      queryLoading: globalQuery.isLoading,
      publishDisabled,
      entryDisabled,
      globalEntries,
      valuesByKey,
      localValues,
      localModes,
      missingRequired,
    },
    actions: {
      refresh,
      publish,
      markDirty,
      setLocalModes,
      setLocalValues,
    },
  };
};

function AdminConfigAccessDenied() {
  return (
    <Surface tone="soft" p="xl">
      <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
        Super admin access is required to view this page.
      </Alert>
    </Surface>
  );
}

type MissingRequiredAlertProps = {
  missing: string[];
};

function MissingRequiredAlert({ missing }: MissingRequiredAlertProps) {
  if (missing.length === 0) return null;

  return (
    <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
      Missing required global values (defaults are applied):{" "}
      {missing.join(", ")}
    </Alert>
  );
}

function AdminConfigContent() {
  const { state, actions } = useAdminConfigState();
  const uiContext = useMemo(
    () => ({
      ttsVoiceOptions: TTS_VOICE_OPTIONS,
      resolvedValues: state.localValues,
    }),
    [state.localValues],
  );

  return (
    <Stack gap="lg" data-testid="admin-config-page">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Title order={2}>Admin configuration</Title>
          <Text size="sm" c="dimmed">
            Manage AppConfig defaults for global settings. Changes apply across
            all servers unless overridden at a narrower scope.
          </Text>
        </Stack>
        <Group>
          <Button
            variant="default"
            onClick={actions.refresh}
            disabled={state.queryLoading}
            data-testid="admin-config-refresh"
          >
            Refresh
          </Button>
          <Button
            onClick={actions.publish}
            disabled={state.publishDisabled}
            data-testid="admin-config-publish"
          >
            Publish AppConfig
          </Button>
        </Group>
      </Group>

      <MissingRequiredAlert missing={state.missingRequired} />

      <Surface tone="raised" p="lg" style={{ position: "relative" }}>
        <LoadingOverlay
          visible={state.queryLoading}
          overlayProps={uiOverlays.loading}
          loaderProps={{ size: "md" }}
        />
        <Stack gap="md">
          <AdminConfigEntryList
            entries={state.globalEntries}
            valuesByKey={state.valuesByKey}
            localValues={state.localValues}
            localModes={state.localModes}
            disabled={state.entryDisabled}
            missingRequired={state.missingRequired}
            uiContext={uiContext}
            onModeChange={actions.setLocalModes}
            onValueChange={actions.setLocalValues}
            onDirty={actions.markDirty}
          />
        </Stack>
      </Surface>
    </Stack>
  );
}

export default function AdminConfig() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);

  if (!isSuperAdmin) {
    return <AdminConfigAccessDenied />;
  }

  return <AdminConfigContent />;
}
