import Stripe from "stripe";
export type StripeTransportRequest = {
  path: string;
  method: string;
  fields: URLSearchParams;
  idempotencyKey?: string;
};
export function stripeTransport(
  handler: (request: StripeTransportRequest) => unknown,
) {
  const requests: StripeTransportRequest[] = [];
  const stripe = new Stripe("sk_test_fixture", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, options) => {
      const url = new URL(input.toString());
      const request: StripeTransportRequest = {
        path: url.pathname,
        method: options?.method ?? "GET",
        fields: new URLSearchParams(
          typeof options?.body === "string" ? options.body : url.search,
        ),
        idempotencyKey:
          new Headers(options?.headers).get("Idempotency-Key") ?? undefined,
      };
      requests.push(request);
      return new Response(JSON.stringify(await handler(request)), {
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
