import { httpBatchLink } from "@trpc/client";
import { buildApiUrl, withCsrfToken } from "./apiClient";
import { trpc } from "./trpc";
import { authRecoveryLink } from "./authRecovery";

const trpcUrl = buildApiUrl("/trpc");

export const trpcClient = trpc.createClient({
  links: [
    authRecoveryLink,
    httpBatchLink({
      url: trpcUrl,
      async fetch(url, options) {
        const requestInit = await withCsrfToken(options);
        return fetch(url, {
          ...requestInit,
          credentials: "include",
        });
      },
    }),
  ],
});
