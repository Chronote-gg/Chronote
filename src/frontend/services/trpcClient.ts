import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { buildApiUrl, withCsrfToken } from "./apiClient";
import { trpc } from "./trpc";
import { authRecoveryLink } from "./authRecovery";

const trpcUrl = buildApiUrl("/trpc");

export const trpcClient = trpc.createClient({
  links: [
    authRecoveryLink,
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({
        url: trpcUrl,
        eventSourceOptions: { withCredentials: true },
      }),
      false: httpBatchLink({
        url: trpcUrl,
        async fetch(url, options) {
          const requestInit = await withCsrfToken(options);
          return fetch(url, {
            ...requestInit,
            credentials: "include",
          });
        },
      }),
    }),
  ],
});
