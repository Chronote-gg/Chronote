import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { buildApiUrl, withCsrfToken } from "./apiClient";
import { trpc } from "./trpc";
import { authRecoveryLink } from "./authRecovery";

const trpcUrl = buildApiUrl("/trpc");
const authenticatedFetch: typeof fetch = async (url, options) => {
  const requestInit = await withCsrfToken(options);
  return fetch(url, { ...requestInit, credentials: "include" });
};

export const trpcClient = trpc.createClient({
  links: [
    authRecoveryLink,
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({
        url: trpcUrl,
        eventSourceOptions: { withCredentials: true },
      }),
      false: splitLink({
        condition: (op) => op.path === "ask.searchMeetings",
        true: httpBatchLink({
          url: trpcUrl,
          methodOverride: "POST",
          fetch: authenticatedFetch,
        }),
        false: httpBatchLink({ url: trpcUrl, fetch: authenticatedFetch }),
      }),
    }),
  ],
});
