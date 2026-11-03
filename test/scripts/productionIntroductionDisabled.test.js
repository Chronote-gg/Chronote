/** @jest-environment node */
import { test, jest, expect } from "@jest/globals";
import { introduceProduction } from "../../scripts/deployment/introduce-production.cjs";

test.each(["introduce", "continue"])(
  "disabled legacy %s refuses before provider reads or writes",
  async (mode) => {
    const aws = jest.fn();
    const read = jest.fn();
    await expect(
      introduceProduction(
        { binding: { manifest: { schemaVersion: 1 } }, aws, read },
        mode,
      ),
    ).rejects.toThrow("legacy_introduction_recipe_disabled");
    expect(aws).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);
