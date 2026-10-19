import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { Request, Response } from "express";
import type { appRouter } from "../../src/trpc/router";
import { getMockUser } from "../../src/repositories/mockStore";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";

export async function verifyCorrectionDisconnect(input: {
  router: typeof appRouter;
  started: Promise<void>;
  settled: jest.Mock;
  release: (value: unknown) => void;
}) {
  const server = createServer(
    createHTTPHandler({
      router: input.router,
      createContext: ({ req, res }) => ({
        req: Object.assign(req, { session: {} }) as unknown as Request,
        res: res as unknown as Response,
        user: getMockUser(),
      }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const abort = new AbortController();
  const response = fetch(
    `http://127.0.0.1:${address.port}/meetings.suggestNotesCorrection`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverId: "guild-1",
        meetingId: "channel-1#2025-01-01",
        suggestion: "Fix",
      }),
      signal: abort.signal,
    },
  ).catch(() => undefined);
  try {
    await input.started;
    abort.abort();
    await response;
    server.closeAllConnections();
    server.close();
    expect(
      getRuntimeWorkAdmissionCheckpoints().filter(
        (entry) => entry.domain === "api_correction",
      ),
    ).toHaveLength(1);
    fenceRuntimeWorkAdmissions();
    expect(input.settled).not.toHaveBeenCalled();
    const checkpoints = getRuntimeWorkAdmissionCheckpoints();
    input.release({ choices: [{ message: { content: "Late correction" } }] });
    await Promise.allSettled(checkpoints.map((entry) => entry.ownedPromise));
    expect(input.settled).toHaveBeenCalledTimes(1);
    expect(
      getRuntimeWorkAdmissionCheckpoints().filter(
        (entry) => entry.domain === "api_correction",
      ),
    ).toHaveLength(0);
  } finally {
    input.release({ choices: [] });
    server.closeAllConnections();
    server.close();
  }
}
