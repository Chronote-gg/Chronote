import { z } from "zod";
export const autoCompletionPolicySchema = z
  .object({
    enabled: z.boolean(),
    maximumSeconds: z.number().nonnegative(),
    maximumWords: z.number().int().nonnegative(),
    maximumChatMessages: z.number().int().nonnegative(),
    dismissedMinimumMilliseconds: z.number().nonnegative(),
    dismissedMinimumChatMessages: z.number().int().nonnegative(),
  })
  .strict();
export const completionPolicySchema = z
  .object({
    policy: autoCompletionPolicySchema,
    isAutoRecording: z.boolean(),
    elapsedMilliseconds: z.number().finite().nonnegative().optional(),
    chatMessageCount: z.number().int().nonnegative(),
    dismissed: z.boolean(),
    decision: z.enum(["undecided", "cancel", "proceed"]),
  })
  .strict();
export type CompletionPolicy = z.infer<typeof completionPolicySchema>;
