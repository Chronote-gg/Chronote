import { Buffer } from "node:buffer";
import prism from "prism-media";

export function generatedOpus() {
  const encoder = new prism.opus.Encoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  try {
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let sample = 0; sample < 960; sample++) {
      const value = Math.round(
        Math.sin((sample * 2 * Math.PI * 440) / 48000) * 10000,
      );
      pcm.writeInt16LE(value, sample * 4);
      pcm.writeInt16LE(value, sample * 4 + 2);
    }
    return encoder._encode(pcm);
  } finally {
    encoder.destroy();
  }
}
