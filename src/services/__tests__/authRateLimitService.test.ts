/** @jest-environment node */

import { describe, expect, test } from "@jest/globals";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAuthRateLimiter } from "../authRateLimitService";

const AUTHENTICATED_HEADER = "x-test-authenticated";

// One window wide enough that nothing expires mid-test, and a limit small
// enough to reach in three requests.
const startServer = (options: { wasAuthenticated?: boolean }) => {
  const app = express();
  app.use(
    createAuthRateLimiter({
      enabled: true,
      windowMs: 60_000,
      limit: 2,
      countFailuresOnly: true,
      ...(options.wasAuthenticated === undefined
        ? {}
        : {
            wasAuthenticated: (req) =>
              req.headers[AUTHENTICATED_HEADER] === "yes",
          }),
    }),
  );
  app.get("/rejects", (_req, res) => {
    res.status(400).json({ error: "invalid_request" });
  });

  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const closeServer = async (server: http.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const statusesFor = async (baseUrl: string, authenticated: boolean) => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}/rejects`, {
      headers: authenticated ? { [AUTHENTICATED_HEADER]: "yes" } : {},
    });
    statuses.push(response.status);
  }
  return statuses;
};

describe("auth rate limiter", () => {
  test("counts rejected requests when no authentication predicate is given", async () => {
    const { server, baseUrl } = startServer({});

    try {
      await expect(statusesFor(baseUrl, false)).resolves.toEqual([
        400, 400, 429,
      ]);
    } finally {
      await closeServer(server);
    }
  });

  test("still counts rejections that never authenticated", async () => {
    const { server, baseUrl } = startServer({ wasAuthenticated: true });

    try {
      await expect(statusesFor(baseUrl, false)).resolves.toEqual([
        400, 400, 429,
      ]);
    } finally {
      await closeServer(server);
    }
  });

  test("does not count rejections from an authenticated caller", async () => {
    const { server, baseUrl } = startServer({ wasAuthenticated: true });

    try {
      // Without the predicate these would exhaust the bucket, taking the
      // allowance away from every other caller sharing this key.
      await expect(statusesFor(baseUrl, true)).resolves.toEqual([
        400, 400, 400,
      ]);
    } finally {
      await closeServer(server);
    }
  });
});
