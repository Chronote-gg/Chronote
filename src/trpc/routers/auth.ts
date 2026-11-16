import { publicProcedure, router } from "../trpc";
import { isSuperAdmin } from "../../services/adminAccessService";

export const authRouter = router({
  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user?.accessToken) return null;
    return {
      id: ctx.user.id,
      username: ctx.user.username,
      avatar: ctx.user.avatar,
      isSuperAdmin: isSuperAdmin(ctx.user.id),
    };
  }),
});
