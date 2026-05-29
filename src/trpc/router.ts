import { router } from "./trpc";
import { askRouter } from "./routers/ask";
import { authRouter } from "./routers/auth";
import { autorecordRouter } from "./routers/autorecord";
import { billingRouter } from "./routers/billing";
import { channelContextsRouter } from "./routers/channelContexts";
import { configRouter } from "./routers/config";
import { contextRouter } from "./routers/context";
import { dictionaryRouter } from "./routers/dictionary";
import { contactFeedbackRouter } from "./routers/contactFeedback";
import { feedbackRouter } from "./routers/feedback";
import { adminFeedbackRouter } from "./routers/adminFeedback";
import { meetingsRouter } from "./routers/meetings";
import { meetingSharesRouter } from "./routers/meetingShares";
import { notionRouter } from "./routers/notion";
import { personalUploadsRouter } from "./routers/personalUploads";
import { pricingRouter } from "./routers/pricing";
import { serversRouter } from "./routers/servers";

export const appRouter = router({
  ask: askRouter,
  auth: authRouter,
  autorecord: autorecordRouter,
  billing: billingRouter,
  channelContexts: channelContextsRouter,
  config: configRouter,
  contactFeedback: contactFeedbackRouter,
  context: contextRouter,
  dictionary: dictionaryRouter,
  feedback: feedbackRouter,
  adminFeedback: adminFeedbackRouter,
  meetings: meetingsRouter,
  meetingShares: meetingSharesRouter,
  notion: notionRouter,
  personalUploads: personalUploadsRouter,
  pricing: pricingRouter,
  servers: serversRouter,
});

export type AppRouter = typeof appRouter;
