import { useEffect, useState } from "react";

const RECAPTCHA_SCRIPT_ID = "recaptcha-v3-script";
const RECAPTCHA_API_URL = "https://www.google.com/recaptcha/api.js";

declare global {
  interface Window {
    grecaptcha?: {
      ready: (callback: () => void) => void;
      execute: (
        siteKey: string,
        options: { action: string },
      ) => Promise<string>;
    };
  }
}

function getSiteKey(): string {
  return (
    (typeof process !== "undefined"
      ? process.env.VITE_RECAPTCHA_SITE_KEY
      : undefined) ?? ""
  );
}

/**
 * Loads the reCAPTCHA v3 script if a site key is configured.
 * Returns true when the script is loaded and ready.
 */
export function useRecaptchaScript(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const siteKey = getSiteKey();
    if (!siteKey) return;

    const handleReady = () => setReady(true);
    const handleLoad = () => window.grecaptcha?.ready(handleReady);

    const existing = document.getElementById(RECAPTCHA_SCRIPT_ID);
    if (existing) {
      if (window.grecaptcha) {
        window.grecaptcha.ready(handleReady);
        return;
      }
      existing.addEventListener("load", handleLoad);
      return () => existing.removeEventListener("load", handleLoad);
    }

    const script = document.createElement("script");
    script.id = RECAPTCHA_SCRIPT_ID;
    script.src = `${RECAPTCHA_API_URL}?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.addEventListener("load", handleLoad);
    document.head.appendChild(script);
    return () => script.removeEventListener("load", handleLoad);
  }, []);

  return ready;
}

/**
 * Execute reCAPTCHA v3 and return a token.
 * Returns undefined if the site key is not configured.
 */
export async function executeRecaptcha(
  action: string,
): Promise<string | undefined> {
  const siteKey = getSiteKey();
  if (!siteKey || !window.grecaptcha) return undefined;
  return window.grecaptcha.execute(siteKey, { action });
}
