import Stripe from "stripe";
export function stripeTransport(
  handler: (request: {
    path: string;
    method: string;
    fields: URLSearchParams;
  }) => unknown,
) {
  const requests: { path: string; method: string; fields: URLSearchParams }[] =
    [];
  const stripe = new Stripe("sk_test_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, options) => {
      const url = new URL(input.toString());
      const request = {
        path: url.pathname,
        method: options?.method ?? "GET",
        fields: new URLSearchParams(
          typeof options?.body === "string" ? options.body : url.search,
        ),
      };
      requests.push(request);
      return new Response(JSON.stringify(handler(request)), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Stripe-Version": "2026-09-30.endive",
        },
      });
    }),
  });
  return { stripe, requests };
}
