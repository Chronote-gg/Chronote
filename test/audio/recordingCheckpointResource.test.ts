/** @jest-environment node */
import { createAudioResource, StreamType } from "@discordjs/voice";
import { PassThrough } from "node:stream";
import { createCheckpointPlaybackTap } from "../../src/services/recordingCheckpointPlayback";
import { getCheckpointPcmBudget } from "../../src/services/recordingCheckpointCapture";

test("installed AudioResource advances saved PCM only on consumed real packets", async () => {
  const push = jest.fn<boolean, [Buffer, number]>(() => true);
  const tap = createCheckpointPlaybackTap({ push, stop: jest.fn() });
  tap.stream.resume();
  tap.stream.write(Buffer.alloc(3840 * 3));
  const opus = new PassThrough({ objectMode: true });
  const resource = createAudioResource(opus, {
    inputType: StreamType.Opus,
    silencePaddingFrames: 2,
  });
  tap.attach(resource);
  expect(resource.read()).toBeNull();
  expect(push).not.toHaveBeenCalled();
  opus.write(Buffer.from([0xf8, 0xff, 0xfe]));
  expect(resource.read()).not.toBeNull();
  expect(resource.playbackDuration).toBe(20);
  expect(push).toHaveBeenCalledTimes(1);
  expect(push.mock.calls[0][0]).toHaveLength(3840);
  // Pause means no resource reads; prefetch cannot manufacture saved speech.
  expect(push).toHaveBeenCalledTimes(1);
  opus.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  resource.read();
  resource.read();
  expect(push).toHaveBeenCalledTimes(1);
  expect(tap.complete()).toBe(false);
  tap.dispose();
  opus.destroy();
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});
