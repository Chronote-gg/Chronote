import type { Request, Response } from "express";
import { getMockUser } from "../../src/repositories/mockStore";
import type { TrpcContext } from "../../src/trpc/context";
import { appRouter } from "../../src/trpc/router";

export const buildCaller = (user: TrpcContext["user"] = getMockUser()) =>
  appRouter.createCaller({
    req: { session: {} } as Request,
    res: {} as Response,
    user,
  });
