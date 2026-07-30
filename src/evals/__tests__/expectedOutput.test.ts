import { describe, expect, test } from "@jest/globals";
import { z } from "zod";
import { expectedOutputSchema } from "../expectedOutput";

const schema = expectedOutputSchema({
  transcript: z.string().optional(),
});

describe("expectedOutputSchema", () => {
  test("accepts null, which is what Langfuse sends for an unlabelled case", () => {
    // The bug this guards: `.optional()` accepts a missing key but rejects an
    // explicit null, so an unlabelled case aborted the whole experiment.
    expect(schema.parse(null)).toBeNull();
  });

  test("accepts undefined", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  test("accepts a populated expected output", () => {
    expect(schema.parse({ transcript: "hello" })).toEqual({
      transcript: "hello",
    });
  });

  test("still rejects a wrongly typed field", () => {
    expect(() => schema.parse({ transcript: 7 })).toThrow();
  });
});
