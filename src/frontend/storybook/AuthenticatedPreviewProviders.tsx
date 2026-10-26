import type { ReactNode } from "react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { trpc } from "../services/trpc";
import { AuthProvider } from "../contexts/AuthContext";
import { GuildProvider } from "../contexts/GuildContext";

type Props = {
  client: ReturnType<typeof trpc.createClient>;
  queryClient: QueryClient;
  children: ReactNode;
};

export function AuthenticatedPreviewProviders({
  client,
  queryClient,
  children,
}: Props) {
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <GuildProvider>{children}</GuildProvider>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export const createPreviewQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
