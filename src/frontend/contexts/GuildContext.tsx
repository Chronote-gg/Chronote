import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { trpc } from "../services/trpc";
import { useAuth } from "./AuthContext";

export type Guild = {
  id: string;
  name: string;
  icon?: string | null;
  canManage: boolean;
};

type GuildContextValue = {
  guilds: Guild[];
  selectedGuildId: string | null;
  setSelectedGuildId: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const GuildContext = createContext<GuildContextValue | undefined>(undefined);
const STORAGE_KEY = "mn-selected-guild";

const clearStoredGuild = () => {
  localStorage.removeItem(STORAGE_KEY);
};

const storeGuild = (id: string | null) => {
  if (id) {
    localStorage.setItem(STORAGE_KEY, id);
  } else {
    clearStoredGuild();
  }
};

const isGuildErrorWithData = (
  error: unknown,
): error is { data?: { code?: string } } =>
  Boolean(error && typeof error === "object" && "data" in error);

const resolveGuildError = (error: unknown) => {
  if (isGuildErrorWithData(error) && error.data?.code === "UNAUTHORIZED") {
    return "auth";
  }
  return "Unable to load your servers. Please re-login with the guilds scope.";
};

const syncSelectedGuild = (options: {
  selectedGuildId: string | null;
  guilds: Guild[];
  setSelectedGuildId: (value: string | null) => void;
}) => {
  const { selectedGuildId, guilds, setSelectedGuildId } = options;
  if (!selectedGuildId || guilds.length === 0) return;
  const stillMember = guilds.some((guild) => guild.id === selectedGuildId);
  if (stillMember) return;
  setSelectedGuildId(null);
  clearStoredGuild();
};

const applyGuildQueryState = (options: {
  authState: string;
  guildsData: Guild[] | null;
  guildError: unknown;
  selectedGuildId: string | null;
  setGuilds: (value: Guild[]) => void;
  setSelectedGuildId: (value: string | null) => void;
  setError: (value: string | null) => void;
}) => {
  const {
    authState,
    guildsData,
    guildError,
    selectedGuildId,
    setGuilds,
    setSelectedGuildId,
    setError,
  } = options;
  if (authState === "unauthenticated") {
    setGuilds([]);
    setSelectedGuildId(null);
    clearStoredGuild();
    setError("auth");
    return;
  }
  if (guildError) {
    const message = resolveGuildError(guildError);
    if (message === "auth") {
      setError("auth");
    } else {
      console.error("Guild fetch error", guildError);
      setError(message);
    }
    return;
  }
  if (guildsData) {
    setGuilds(
      guildsData.map((guild) => ({
        ...guild,
        canManage: guild.canManage ?? false,
      })),
    );
    syncSelectedGuild({
      selectedGuildId,
      guilds: guildsData,
      setSelectedGuildId,
    });
    setError(null);
  }
};

export function GuildProvider({ children }: { children: React.ReactNode }) {
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );
  const [error, setError] = useState<string | null>(null);
  const { state: authState } = useAuth();
  const guildQuery = trpc.servers.listEligible.useQuery(undefined, {
    retry: false,
    enabled: authState === "authenticated",
  });
  const loading =
    authState === "authenticated"
      ? guildQuery.isLoading
      : authState === "unknown";

  useEffect(() => {
    const data = Array.isArray(guildQuery.data?.guilds)
      ? guildQuery.data?.guilds
      : null;
    applyGuildQueryState({
      authState,
      guildsData: data,
      guildError: guildQuery.error,
      selectedGuildId,
      setGuilds,
      setSelectedGuildId,
      setError,
    });
  }, [authState, guildQuery.data, guildQuery.error, selectedGuildId]);

  const value = useMemo(
    () => ({
      guilds,
      selectedGuildId,
      setSelectedGuildId: (id: string | null) => {
        if (
          id &&
          (authState !== "authenticated" ||
            (!error &&
              guilds.length > 0 &&
              !guilds.some((guild) => guild.id === id)))
        ) {
          return;
        }
        setSelectedGuildId(id);
        storeGuild(id);
      },
      loading,
      error,
      refresh: async () => {
        await guildQuery.refetch();
      },
    }),
    [authState, guilds, selectedGuildId, loading, error, guildQuery],
  );

  return (
    <GuildContext.Provider value={value}>{children}</GuildContext.Provider>
  );
}

export function useGuildContext(): GuildContextValue {
  const ctx = useContext(GuildContext);
  if (!ctx) {
    throw new Error("useGuildContext must be used within GuildProvider");
  }
  return ctx;
}
