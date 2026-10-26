import { z } from "zod";
const historicalProviderPageSchema = z.object({
  has_more: z.boolean(),
  data: z.array(z.unknown()),
});
export function assertHistoricalProviderPage(page: unknown): void {
  historicalProviderPageSchema.parse(page);
}
