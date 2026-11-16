import { completedTextResponse } from "../../src/testSupport/openaiResponse";
import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import type { Request, Response } from "express";
import type { appRouter } from "../../src/trpc/router";
import { getMockUser } from "../../src/repositories/mockStore";
import * as apiOperation from "../../src/services/runtimeApiOperationService";

/** A response socket is not the owner of the handler: closing it must not cancel the correction. */
export async function verifyCorrectionDisconnect(input: {
  router: typeof appRouter;
  started: Promise<void>;
  release: (value: unknown) => void;
}) {
  const actual = apiOperation.runRuntimeApiOperation;
  const operations: Promise<unknown>[] = [];
  const signals: AbortSignal[] = [];
  const spy = jest
    .spyOn(apiOperation, "runRuntimeApiOperation")
    .mockImplementation((id, run) => {
      const operation = actual(id, (handle) => {
        signals.push(handle.signal);
        return run(handle);
      });
      operations.push(operation);
      return operation;
    });
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
    expect(operations).toHaveLength(1);
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    input.release(completedTextResponse("Late correction"));
    await expect(operations[0]).resolves.toMatchObject({ ok: true });
  } finally {
    input.release(completedTextResponse(""));
    server.closeAllConnections();
    server.close();
    spy.mockRestore();
  }
}
