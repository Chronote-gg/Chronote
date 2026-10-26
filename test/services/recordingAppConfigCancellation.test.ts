/** @jest-environment node */
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpResponse } from "@smithy/core/protocols";
import { Readable } from "node:stream";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/configService", () => {
  const actual = jest.requireActual("../../src/services/configService");
  return {
    ...actual,
    config: {
      ...actual.config,
      appConfig: {
        ...actual.config.appConfig,
        enabled: true,
        applicationId: "generated",
        environmentId: "generated",
        profileId: "generated",
      },
    },
  };
});
jest.mock("@aws-sdk/client-appconfigdata", () => {
  const sdk = jest.requireActual("@aws-sdk/client-appconfigdata");
  return {
    ...sdk,
    AppConfigDataClient: class extends sdk.AppConfigDataClient {
      constructor(options: object) {
        super({
          ...options,
          endpoint: "http://127.0.0.1:1",
          credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
          maxAttempts: 1,
          requestHandler: mockHandler,
        });
      }
    },
  };
});
const mockHandler = new NodeHttpHandler();
test.each([1, 2])(
  "strict AppConfig snapshot request %s settles on SDK abort",
  async (heldRequest) => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalWorker = process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = "development";
    delete process.env.JEST_WORKER_ID;
    let read!: typeof import("../../src/services/appConfigService").getGlobalConfigValues;
    jest.isolateModules(() => {
      read = jest.requireActual(
        "../../src/services/appConfigService",
      ).getGlobalConfigValues;
    });
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JEST_WORKER_ID = originalWorker;
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let count = 0;
    let settled = false;
    let watchdogFired = false;
    const handle = jest
      .spyOn(mockHandler, "handle")
      .mockImplementation(async (_request, options) => {
        expect(options?.abortSignal).toBe(controller.signal);
        if (++count < heldRequest)
          return {
            response: new HttpResponse({
              statusCode: 200,
              headers: { "content-type": "application/json" },
              body: Readable.from([
                Buffer.from(
                  JSON.stringify({
                    InitialConfigurationToken: "generated-token",
                  }),
                ),
              ]),
            }),
          };
        try {
          return await new Promise<never>((_resolve, reject) => {
            const signal = options!.abortSignal!;
            const abort = () => {
              clearTimeout(watchdog);
              signal.onabort = null;
              reject(
                Object.assign(new Error("generated abort"), {
                  name: "AbortError",
                }),
              );
            };
            const watchdog = setTimeout(() => {
              watchdogFired = true;
              abort();
            }, 1000);
            signal.onabort = abort;
            entered();
          });
        } finally {
          settled = true;
        }
      });
    try {
      const task = read({ strict: true, signal: controller.signal });
      const rejected = expect(task).rejects.toThrow("generated abort");
      await ready;
      controller.abort();
      await rejected;
      expect(settled).toBe(true);
      expect(watchdogFired).toBe(false);
      expect(count).toBe(heldRequest);
    } finally {
      handle.mockRestore();
    }
  },
);
