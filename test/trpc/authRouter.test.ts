/** @jest-environment node */
import type { Request, Response } from "express";
import { authRouter } from "../../src/trpc/routers/auth";
import { getMockUser } from "../../src/repositories/mockStore";
import type { TrpcContext } from "../../src/trpc/context";
const me = (user: TrpcContext["user"]) =>
  authRouter
    .createCaller({ req: {} as Request, res: {} as Response, user })
    .me();
test("auth.me requires the same usable access token as protected procedures", async () => {
  await expect(
    me({ ...getMockUser(), accessToken: undefined }),
  ).resolves.toBeNull();
  await expect(
    me({ ...getMockUser(), id: "fixture-user", accessToken: "fixture-token" }),
  ).resolves.toMatchObject({ id: "fixture-user" });
});
