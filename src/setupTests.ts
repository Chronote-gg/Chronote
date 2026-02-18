import { jest } from "@jest/globals";
import { TextDecoder, TextEncoder } from "util";
import { ReadableStream } from "stream/web";

// jest-dom adds custom jest matchers for asserting on DOM nodes (jsdom only).
// In node environment, the import would fail because there's no DOM.
// Dynamic require is intentional to avoid loading DOM matchers in node env.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@testing-library/jest-dom");
}

const requiredTestEnv = {
  MOCK_MODE: "true",
  ENABLE_OAUTH: "false",
  DISCORD_BOT_TOKEN: "test-discord-bot-token",
  DISCORD_CLIENT_ID: "test-discord-client-id",
  DISCORD_CLIENT_SECRET: "test-discord-client-secret",
  DISCORD_CALLBACK_URL: "http://localhost:3001/callback",
  OAUTH_SECRET: "test-oauth-secret",
  OPENAI_API_KEY: "test-openai-api-key",
  STRIPE_MODE: "test",
  STRIPE_SECRET_KEY: "test-stripe-secret-key",
  STRIPE_WEBHOOK_SECRET: "test-stripe-webhook-secret",
  STRIPE_SUCCESS_URL: "http://localhost:3001/stripe/success",
  STRIPE_CANCEL_URL: "http://localhost:3001/stripe/cancel",
  FRONTEND_SITE_URL: "http://localhost:5173",
};

Object.entries(requiredTestEnv).forEach(([key, value]) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
});

// Browser-specific polyfills (only apply in jsdom environment)
const hasBrowserGlobals = typeof window !== "undefined";

if (hasBrowserGlobals) {
  // Minimal matchMedia polyfill for Mantine components in tests
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }

  if (typeof window.ResizeObserver === "undefined") {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserver;
  }

  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    value: () => {},
    writable: true,
  });
}

// Universal polyfills (apply in both jsdom and node environments)
if (typeof globalThis.fetch === "undefined") {
  globalThis.fetch = jest.fn() as unknown as typeof fetch;
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder =
    TextEncoder as unknown as typeof globalThis.TextEncoder;
}

if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder =
    TextDecoder as unknown as typeof globalThis.TextDecoder;
}

if (typeof globalThis.ReadableStream === "undefined") {
  globalThis.ReadableStream =
    ReadableStream as unknown as typeof globalThis.ReadableStream;
}
