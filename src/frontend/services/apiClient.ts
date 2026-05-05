export class AuthNeededError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthNeededError";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const CSRF_TOKEN_PATH = "/api/csrf-token";
const CSRF_HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
let csrfTokenPromise: Promise<string> | undefined;

async function parseJsonSafely(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthNeededError("Non-JSON response (likely auth redirect)");
  }
}

declare global {
  interface Window {
    __API_BASE_URL__?: string;
  }
}

function normalizeApiBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // Assume localhost is plain HTTP for local dev.
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  // Default to HTTPS for everything else (avoids mixed-content on HTTPS sites).
  return `https://${trimmed}`;
}

type ApiBaseGlobal = { __API_BASE_URL__?: string };

const apiBaseFromGlobal =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as ApiBaseGlobal).__API_BASE_URL__ === "string"
    ? (globalThis as ApiBaseGlobal).__API_BASE_URL__
    : undefined;

const runtimeApiBase =
  apiBaseFromGlobal ||
  (typeof process !== "undefined" ? process.env.VITE_API_BASE_URL : undefined);

export const API_BASE = normalizeApiBase(runtimeApiBase || "");

export function buildApiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE) return normalized;
  return `${API_BASE.replace(/\/$/, "")}${normalized}`;
}

function withBase(input: RequestInfo): RequestInfo {
  if (typeof input !== "string") return input;
  if (!API_BASE || input.startsWith("http")) return input;
  // ensure single slash
  return `${API_BASE.replace(/\/$/, "")}${input.startsWith("/") ? "" : "/"}${input}`;
}

function getRequestMethod(init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  return init?.body ? "POST" : "GET";
}

async function getCsrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch(withBase(CSRF_TOKEN_PATH), {
    credentials: "include",
  })
    .then(async (res) => {
      if (!res.ok) {
        throw new ApiError(res.status, `HTTP ${res.status}`);
      }
      const data = await parseJsonSafely(res);
      const token = (data as { csrfToken?: unknown }).csrfToken;
      if (typeof token !== "string" || token.length === 0) {
        throw new ApiError(res.status, "Missing CSRF token");
      }
      return token;
    })
    .catch((error) => {
      csrfTokenPromise = undefined;
      throw error;
    });

  return csrfTokenPromise;
}

export async function withCsrfToken(init?: RequestInit): Promise<RequestInit> {
  if (SAFE_METHODS.has(getRequestMethod(init))) {
    return init ?? {};
  }

  const csrfToken = await getCsrfToken();
  const headers = new Headers(init?.headers);
  headers.set(CSRF_HEADER_NAME, csrfToken);
  return { ...init, headers };
}

export async function apiFetch<T = unknown>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const requestInit = await withCsrfToken(init);
  const res = await fetch(withBase(input), {
    ...requestInit,
    credentials: "include",
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthNeededError();
  }

  if (!res.ok) {
    throw new ApiError(res.status, `HTTP ${res.status}`);
  }

  const data = await parseJsonSafely(res);
  return data as T;
}
