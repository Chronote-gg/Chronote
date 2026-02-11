import { router } from "./trpc";
import { askRouter } from "./routers/ask";
import { authRouter } from "./routers/auth";
import { autorecordRouter } from "./routers/autorecord";
import { billingRouter } from "./routers/billing";
import { channelContextsRouter } from "./routers/channelContexts";
import { configRouter } from "./routers/config";
import { contextRouter } from "./routers/context";
import { dictionaryRouter } from "./routers/dictionary";
import { feedbackRouter } from "./routers/feedback";
import { adminFeedbackRouter } from "./routers/adminFeedback";
import { meetingsRouter } from "./routers/meetings";
import { meetingSharesRouter } from "./routers/meetingShares";
import { pricingRouter } from "./routers/pricing";
import { serversRouter } from "./routers/servers";

export const appRouter = router({
  ask: askRouter,
  auth: authRouter,
  autorecord: autorecordRouter,
  billing: billingRouter,
  channelContexts: channelContextsRouter,
  config: configRouter,
  context: contextRouter,
  dictionary: dictionaryRouter,
  feedback: feedbackRouter,
  adminFeedback: adminFeedbackRouter,
  meetings: meetingsRouter,
  meetingShares: meetingSharesRouter,
  pricing: pricingRouter,
  servers: serversRouter,
});

export type AppRouter = typeof appRouter;
