import { z } from "zod";

/**
 * Builds the schema for a dataset case's `expectedOutput`.
 *
 * Always nullish. Langfuse sends `null` for a case that declares no expected
 * output, and a schema that rejects null aborts the entire experiment instead
 * of skipping that case's reference-dependent grades. Cases without one are
 * normal: harvested cases ship with `expectedOutput` blank for a human to fill
 * in, and some grades are reference independent.
 *
 * Exists so a runner cannot get this wrong by writing `.optional()`, which
 * accepts a missing key but not an explicit null.
 */
export const expectedOutputSchema = <Shape extends z.ZodRawShape>(
  shape: Shape,
) => z.object(shape).nullish();
