/** @jest-environment node */
import { PassThrough } from "node:stream";
import { disposeVoiceStream } from "../../src/utils/disposeVoiceStream";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("disposeVoiceStream", () => {
  test("consumes an error queued before owned listeners are detached", async () => {
    const stream = new PassThrough();
    const ownedError = jest.fn();
    const externalError = jest.fn();
    stream.on("error", ownedError);
    stream.on("error", externalError);
    stream.destroy(new Error("synthetic queued fault"));

    disposeVoiceStream(stream, () =>
      stream.removeListener("error", ownedError),
    );
    expect(stream.listenerCount("error")).toBe(2);
    await nextTurn();

    expect(ownedError).not.toHaveBeenCalled();
    expect(externalError).toHaveBeenCalledTimes(1);
    expect(stream.listeners("error")).toEqual([externalError]);
    expect(stream.listenerCount("close")).toBe(0);
  });

  test("unpipes and destroys once for repeated disposal of an aliased stream", async () => {
    const source = new PassThrough();
    const destination = new PassThrough();
    source.pipe(destination);
    const received: Buffer[] = [];
    destination.on("data", (chunk: Buffer) => received.push(chunk));
    const destroy = jest.spyOn(source, "destroy");
    const unpipe = jest.spyOn(source, "unpipe");
    const detach = jest.fn();

    disposeVoiceStream(source, detach);
    disposeVoiceStream(source, detach);
    source.emit("data", Buffer.from("late"));
    await nextTurn();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(unpipe).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
    expect(source.listenerCount("error")).toBe(0);
    destination.destroy();
  });

  test("keeps a local error consumer when emitClose is disabled", async () => {
    const stream = new PassThrough({ emitClose: false });
    const ownedError = jest.fn();
    stream.on("error", ownedError);
    stream.destroy(new Error("synthetic queued fault"));

    disposeVoiceStream(stream, () =>
      stream.removeListener("error", ownedError),
    );
    await nextTurn();

    expect(ownedError).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("error")).toBe(1);
    expect(() =>
      stream.emit("error", new Error("synthetic late fault")),
    ).not.toThrow();
    disposeVoiceStream(stream, () => {});
    expect(stream.listenerCount("error")).toBe(1);
  });

  test("installs the error consumer before an owned detach can emit an error", async () => {
    const stream = new PassThrough();
    expect(() =>
      disposeVoiceStream(stream, () => {
        stream.emit("error", new Error("synthetic detach fault"));
      }),
    ).not.toThrow();
    await nextTurn();
    expect(stream.listenerCount("error")).toBe(0);
  });
});
