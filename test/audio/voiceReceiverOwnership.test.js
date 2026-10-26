/** @jest-environment node */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { expect, test } from "@jest/globals";

test.each(["cjs", "esm"])(
  "%s receiver retains a replacement when the old stream closes",
  (distribution) => {
    const load =
      distribution === "cjs"
        ? 'createRequire(import.meta.url)("@discordjs/voice")'
        : 'await import("@discordjs/voice")';
    const script = `
      import assert from "node:assert/strict";
      import { EventEmitter, once } from "node:events";
      import { createRequire } from "node:module";
      const { VoiceReceiver, EndBehaviorType } = ${load};
      const receiver = new VoiceReceiver(new EventEmitter());
      const oldStream = receiver.subscribe("synthetic", { end: { behavior: EndBehaviorType.Manual } });
      receiver.subscriptions.delete("synthetic");
      oldStream.destroy();
      const replacement = receiver.subscribe("synthetic", { end: { behavior: EndBehaviorType.Manual } });
      await once(oldStream, "close");
      assert.equal(receiver.subscriptions.get("synthetic"), replacement);
      replacement.destroy();
      await once(replacement, "close");
      assert.equal(receiver.subscriptions.has("synthetic"), false);
      process.stdout.write("ownershipPreserved=true\\n");
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ownershipPreserved=true\n");
    expect(result.stderr).toBe("");
  },
);
