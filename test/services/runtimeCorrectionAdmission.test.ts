/** @jest-environment node */
import { correctionProcedure, router } from "../../src/trpc/trpc";
import type { TrpcContext } from "../../src/trpc/context";

function caller(effect: Parameters<typeof correctionProcedure.mutation>[0]) {
  const api = router({ correct: correctionProcedure.mutation(effect) });
  return api.createCaller({
    user: { id: "user", accessToken: "test" },
  } as TrpcContext);
}

test("a correction dispatches with no serving runtime and receives its operation", async () => {
  const effect = jest.fn(async ({ ctx }: { ctx: { operation: unknown } }) =>
    Boolean(ctx.operation),
  );
  await expect(caller(effect).correct()).resolves.toBe(true);
  expect(effect).toHaveBeenCalledTimes(1);
});
