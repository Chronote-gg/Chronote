import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  executeRecaptcha,
  useRecaptchaScript,
} from "../../../src/frontend/hooks/useRecaptcha";

const RECAPTCHA_SCRIPT_ID = "recaptcha-v3-script";
const SITE_KEY = "test-site-key";
const originalSiteKey = process.env.VITE_RECAPTCHA_SITE_KEY;

function RecaptchaProbe() {
  const ready = useRecaptchaScript();
  return (
    <div data-testid="recaptcha-ready">{ready ? "ready" : "not-ready"}</div>
  );
}

const removeRecaptchaScript = () => {
  const script = document.getElementById(RECAPTCHA_SCRIPT_ID);
  script?.remove();
};

describe("useRecaptcha", () => {
  beforeEach(() => {
    window.grecaptcha = undefined;
    removeRecaptchaScript();
  });

  afterEach(() => {
    cleanup();
    window.grecaptcha = undefined;
    removeRecaptchaScript();
    jest.restoreAllMocks();

    if (originalSiteKey === undefined) {
      delete process.env.VITE_RECAPTCHA_SITE_KEY;
      return;
    }

    process.env.VITE_RECAPTCHA_SITE_KEY = originalSiteKey;
  });

  test("does not load script when site key is missing", () => {
    delete process.env.VITE_RECAPTCHA_SITE_KEY;

    render(<RecaptchaProbe />);

    expect(screen.getByTestId("recaptcha-ready").textContent).toBe("not-ready");
    expect(document.getElementById(RECAPTCHA_SCRIPT_ID)).toBeNull();
  });

  test("loads script and marks ready after load event", async () => {
    process.env.VITE_RECAPTCHA_SITE_KEY = SITE_KEY;
    const readyMock = jest.fn((callback: () => void) => callback());
    window.grecaptcha = {
      ready: readyMock,
      execute: async () => "unused-token",
    };

    render(<RecaptchaProbe />);

    const script = document.getElementById(RECAPTCHA_SCRIPT_ID);
    expect(script).not.toBeNull();
    expect(script?.getAttribute("src")).toBe(
      `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(SITE_KEY)}`,
    );

    await act(async () => {
      script?.dispatchEvent(new Event("load"));
    });

    expect(readyMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("recaptcha-ready").textContent).toBe("ready");
  });

  test("waits for existing script before marking ready", async () => {
    process.env.VITE_RECAPTCHA_SITE_KEY = SITE_KEY;

    const existingScript = document.createElement("script");
    existingScript.id = RECAPTCHA_SCRIPT_ID;
    document.head.appendChild(existingScript);

    render(<RecaptchaProbe />);

    const readyMock = jest.fn((callback: () => void) => callback());
    window.grecaptcha = {
      ready: readyMock,
      execute: async () => "unused-token",
    };

    await act(async () => {
      existingScript.dispatchEvent(new Event("load"));
    });

    expect(readyMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("recaptcha-ready").textContent).toBe("ready");
  });

  test("executeRecaptcha returns undefined when unavailable", async () => {
    delete process.env.VITE_RECAPTCHA_SITE_KEY;
    expect(await executeRecaptcha("submit_feedback")).toBeUndefined();

    process.env.VITE_RECAPTCHA_SITE_KEY = SITE_KEY;
    window.grecaptcha = undefined;
    expect(await executeRecaptcha("submit_feedback")).toBeUndefined();
  });

  test("executeRecaptcha returns token when available", async () => {
    process.env.VITE_RECAPTCHA_SITE_KEY = SITE_KEY;
    const executeMock = jest.fn(
      async (siteKey: string, options: { action: string }) => {
        void siteKey;
        void options;
        return "token-123";
      },
    );
    window.grecaptcha = {
      ready: jest.fn(),
      execute: executeMock,
    };

    await expect(executeRecaptcha("submit_feedback")).resolves.toBe(
      "token-123",
    );
    expect(executeMock).toHaveBeenCalledWith(SITE_KEY, {
      action: "submit_feedback",
    });
  });
});
