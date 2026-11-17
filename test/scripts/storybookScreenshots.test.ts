/** @jest-environment node */
import { spawnSync } from "node:child_process";

test("Storybook runs state assertions without capturing every story", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import config from './.storybook/test-runner.ts';
    const captures = [];
    const page = {
      setViewportSize: async () => {}, waitForLoadState: async () => {},
      waitForTimeout: async () => {}, screenshot: async (options) => captures.push(options),
    };
    delete process.env.STORYBOOK_SCREENSHOTS;
    await config.postVisit(page, {id: 'components-example--default'});
    assert.equal(captures.length, 0);
    process.env.STORYBOOK_SCREENSHOTS = 'true';
    await config.postVisit(page, {id: 'components-example--default'});
    assert.equal(captures.length, 1);
    assert(captures[0].path.endsWith('components-example--default.png'));
  `,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toContain("AssertionError");
  expect(result.status).toBe(0);
});
