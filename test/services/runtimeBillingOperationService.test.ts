/** @jest-environment node */
import Stripe from "stripe";
import {
  drainBillingOperations,
  persistBillingAcknowledgment,
  runBillingOperation,
  runBillingReceiptOperation,
  runBillingWorkerOperation,
  UnresolvedBillingMutation,
  type RuntimeBillingOwner,
} from "../../src/services/runtimeBillingOperationService";
import { BillingActionError } from "../../src/services/billingActionError";
import { RuntimeAdmissionUnavailable } from "../../src/services/runtimeAdmissionError";
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => {
    throw new Error("No deployment control record exists");
  },
}));

test("an operation runs without any deployment control record and returns its result", async () => {
  const result = { id: "operation-result" };
  await expect(
    runBillingOperation(undefined, async () => result),
  ).resolves.toBe(result);
  await expect(
    runBillingWorkerOperation(new AbortController().signal, async () => result),
  ).resolves.toBe(result);
  await expect(
    runBillingReceiptOperation(
      async () => true,
      async () => result,
    ),
  ).resolves.toBe(result);
});
test("an operation error before any mutation is returned unchanged", async () => {
  const error = new BillingActionError("BAD_REQUEST", "rejected");
  await expect(
    runBillingOperation(undefined, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
test("each top-level operation receives its own signal that aborts on shutdown", async () => {
  await jest.isolateModulesAsync(async () => {
    const { beginShutdown } = await import("../../src/services/shutdownSignal");
    const billing =
      await import("../../src/services/runtimeBillingOperationService");
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const released = new Promise<void>((done) => {
      release = done;
    });
    const provider = jest.fn(async () => undefined);
    const running = billing.runBillingOperation(undefined, async (owner) => {
      signals.push(owner.signal);
      await released;
      await owner.effect(provider);
    });
    await billing.runBillingReceiptOperation(
      async () => true,
      async (owner) => {
        signals.push(owner.signal);
      },
    );
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.some((signal) => signal.aborted)).toBe(false);
    const reason = new Error("shutting down");
    beginShutdown(reason);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    release();
    await expect(running).rejects.toBe(reason);
    expect(provider).not.toHaveBeenCalled();
  });
});
test("a receipt operation whose admission write is refused never runs", async () => {
  const run = jest.fn();
  await expect(
    runBillingReceiptOperation(async () => false, run),
  ).rejects.toBeInstanceOf(RuntimeAdmissionUnavailable);
  expect(run).not.toHaveBeenCalled();
});
test("a receipt admission error is returned unchanged", async () => {
  const error = new Error("receipt table unavailable");
  const run = jest.fn();
  await expect(
    runBillingReceiptOperation(async () => {
      throw error;
    }, run),
  ).rejects.toBe(error);
  expect(run).not.toHaveBeenCalled();
});
test("only the original registered owner can join and it expires after settlement", async () => {
  let captured!: RuntimeBillingOwner;
  await runBillingOperation(undefined, async (owner) => {
    captured = owner;
    await runBillingOperation(owner, async (nested) =>
      expect(nested).toBe(owner),
    );
  });
  const run = jest.fn();
  await expect(runBillingOperation(captured, run)).rejects.toThrow();
  await expect(runBillingOperation({ ...captured }, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
test.each([true, false])(
  "provider rejection known=%s keeps exact outcome semantics",
  async (known) => {
    const error = known
      ? new Stripe.errors.StripeInvalidRequestError({
          message: "definite rejection",
          statusCode: 400,
        })
      : new Error("response lost");
    const caught = await runBillingOperation(undefined, async (owner) =>
      owner.effect(async () => {
        throw error;
      }),
    ).catch((reason: unknown) => reason);
    if (known) expect(caught).toBe(error);
    else {
      expect(caught).toBeInstanceOf(UnresolvedBillingMutation);
      expect(caught).toHaveProperty("cause", error);
    }
  },
);
test("a receipt failure after acknowledged mutation remains unresolved", async () => {
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await owner.effect(async () => "ack");
      throw new Error("receipt lost");
    }),
  ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
});
test.each(["false", "known rejection"])(
  "%s without an earlier write remains a known outcome",
  async (kind) => {
    await expect(
      runBillingOperation(undefined, async (owner) => {
        await owner.effect(async () => {
          if (kind === "known rejection")
            throw new BillingActionError("BAD_REQUEST", "rejected");
          return false;
        });
        expect(owner.mutationStarted()).toBe(false);
        throw new BillingActionError("BAD_REQUEST", "rejected");
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);
test("an earlier acknowledged write survives a later no-write rejection", async () => {
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await owner.effect(async () => undefined);
      await owner.effect(async () => false);
      throw new BillingActionError("BAD_REQUEST", "later CAS rejected");
    }),
  ).rejects.toMatchObject({ cause: { code: "BAD_REQUEST" } });
});
test.each(["acknowledged", "unknown"])(
  "a detached %s mutation tail cannot be lost on callback failure",
  async (outcome) => {
    let settled = false;
    await expect(
      runBillingOperation(undefined, async (owner) => {
        void owner
          .effect(async () => {
            await Promise.resolve();
            settled = true;
            if (outcome === "unknown") throw new Error("tail response lost");
          })
          .catch(() => undefined);
        throw new Error("callback failed");
      }),
    ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
    expect(settled).toBe(true);
  },
);
test("a worker owner persists an ACK after cancellation but refuses the next dispatch", async () => {
  const controller = new AbortController();
  const persisted = jest.fn(async () => true);
  const provider = jest.fn(async () => undefined);
  await runBillingWorkerOperation(controller.signal, async (owner) => {
    await owner.effect(async () => {
      controller.abort();
    });
    await persistBillingAcknowledgment(owner, persisted);
    await expect(owner.effect(provider)).rejects.toThrow();
  });
  expect(persisted).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
});
test("forged and settled owners cannot persist receipts", async () => {
  let settled!: RuntimeBillingOwner;
  const write = jest.fn();
  await runBillingOperation(undefined, async (owner) => {
    settled = owner;
    await expect(
      persistBillingAcknowledgment({ ...owner }, write),
    ).rejects.toThrow("registered");
  });
  await expect(persistBillingAcknowledgment(settled, write)).rejects.toThrow(
    "registered",
  );
  expect(write).not.toHaveBeenCalled();
});
test("a raw domain receipt ACK without a provider write retains a later failure", async () => {
  const saved: string[] = [];
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await persistBillingAcknowledgment(owner, async () => {
        saved.push("receipt");
      });
      expect(owner.mutationStarted()).toBe(true);
      throw new Error("read after receipt failed");
    }),
  ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
  expect(saved).toEqual(["receipt"]);
});
test.each(["effect", "persistence"])(
  "an unknown %s outcome fences every later dispatch in the same operation",
  async (mechanism) => {
    const later = jest.fn(async () => undefined);
    let signal!: AbortSignal;
    await expect(
      runBillingOperation(undefined, async (owner) => {
        signal = owner.signal;
        const lost = async () => {
          throw new Error("response lost");
        };
        await (
          mechanism === "effect"
            ? owner.effect(lost)
            : persistBillingAcknowledgment(owner, lost)
        ).catch(() => undefined);
        await owner.effect(later).catch(() => undefined);
      }),
    ).rejects.toBeInstanceOf(UnresolvedBillingMutation);
    expect(signal.aborted).toBe(true);
    expect(later).not.toHaveBeenCalled();
  },
);
test("a known rejection does not fence the operation", async () => {
  const later = jest.fn(async () => "later");
  await expect(
    runBillingOperation(undefined, async (owner) => {
      await owner
        .effect(async () => {
          throw new BillingActionError("BAD_REQUEST", "rejected");
        })
        .catch(() => undefined);
      return owner.effect(later);
    }),
  ).resolves.toBe("later");
});
/** Starts a drain and reports whether it has finished. */
function startDrain() {
  let finished = false;
  const draining = drainBillingOperations(new AbortController().signal).then(
    () => {
      finished = true;
    },
  );
  return { draining, finished: () => finished };
}
test("drain resolves after in-flight operations settle", async () => {
  let release!: () => void;
  const released = new Promise<void>((done) => {
    release = done;
  });
  const running = runBillingOperation(undefined, () => released);
  const failing = runBillingWorkerOperation(
    new AbortController().signal,
    async () => {
      await released;
      throw new Error("handler failed");
    },
  );
  void failing.catch(() => undefined);
  const drain = startDrain();
  await Promise.resolve();
  expect(drain.finished()).toBe(false);
  release();
  await drain.draining;
  expect(drain.finished()).toBe(true);
  await running;
  await expect(
    drainBillingOperations(new AbortController().signal),
  ).resolves.toBeUndefined();
});
test("drain returns when its signal aborts", async () => {
  let release!: () => void;
  const running = runBillingOperation(
    undefined,
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const stop = new AbortController();
  const draining = drainBillingOperations(stop.signal);
  stop.abort();
  await expect(draining).resolves.toBeUndefined();
  release();
  await running;
});
test("drain waits for a webhook receipt that is still being admitted", async () => {
  let admit!: (admitted: boolean) => void;
  const admission = new Promise<boolean>((done) => {
    admit = done;
  });
  const handler = jest.fn(async () => "handled");
  const receipt = runBillingReceiptOperation(() => admission, handler);
  const drain = startDrain();
  await Promise.resolve();
  expect(drain.finished()).toBe(false);
  admit(true);
  await drain.draining;
  expect(handler).toHaveBeenCalledTimes(1);
  await expect(receipt).resolves.toBe("handled");
});
