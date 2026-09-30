/** @jest-environment node */

import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, jest, test } from "@jest/globals";
import {
  Networking,
  NetworkingStatusCode,
  VoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";

// Exercise the installed library's state machine without opening network sockets.
class OfflineNetworking extends Networking {
  createWebSocket() {
    const ws = new EventEmitter();
    ws.destroy = () => {};
    ws.sendPacket = () => {};
    ws.sequence = 0;
    ws.on("packet", this.onWsPacket);
    ws.on("close", this.onWsClose);
    return ws;
  }
}

test.each([
  [4015, true],
  [1006, true],
  [4015, false],
  [1006, false],
])(
  "decodes audio during voice WebSocket resume after close %s with DAVE=%s",
  async (closeCode, hasDave) => {
    const connection = new VoiceConnection(
      {
        guildId: "synthetic-guild",
        channelId: "synthetic-channel",
        selfDeaf: false,
        selfMute: false,
      },
      {
        adapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
      },
    );
    const networking = new OfflineNetworking(
      { endpoint: "unused.invalid" },
      {},
    );
    const udp = new EventEmitter();
    udp.destroy = () => {};
    const key = Buffer.alloc(32, 1);
    const plaintext = Buffer.from([0xf8, 0xff, 0xfe]); // Synthetic Opus silence.
    const ciphertext = Buffer.alloc(32, 0xff);
    ciphertext[29] = 12;
    ciphertext[30] = ciphertext[31] = 0xfa;
    const dave = new EventEmitter();
    dave.destroy = () => {};
    dave.decrypt = jest.fn(() => plaintext);
    networking.state = {
      ...networking.state,
      code: NetworkingStatusCode.Ready,
      udp,
      dave: hasDave ? dave : undefined,
      connectionData: {
        encryptionMode: "aead_aes256_gcm_rtpsize",
        nonceBuffer: Buffer.alloc(12),
        secretKey: key,
      },
    };
    networking.on("stateChange", connection.onNetworkingStateChange);
    connection.state = {
      ...connection.state,
      status: VoiceConnectionStatus.Ready,
      networking,
    };
    connection.receiver.ssrcMap.update({
      userId: "synthetic-speaker",
      audioSSRC: 123,
    });
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 0x78;
    header.writeUInt32BE(123, 8);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(1);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    const rtp = Buffer.concat([
      header,
      cipher.update(hasDave ? ciphertext : plaintext),
      cipher.final(),
      cipher.getAuthTag(),
      nonce.subarray(0, 4),
    ]);

    async function receive() {
      dave.decrypt.mockClear();
      const stream = connection.receiver.subscribe("synthetic-speaker", {
        end: { behavior: EndBehaviorType.Manual },
      });
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });
      let pcmChunks = 0;
      let errors = 0;
      let ciphertextDelivered = false;
      stream.on("data", (packet) => {
        ciphertextDelivered ||= packet.equals(ciphertext);
      });
      decoder.on("data", () => {
        pcmChunks++;
      });
      decoder.on("error", () => {
        errors++;
      });
      stream.pipe(decoder);
      udp.emit("message", rtp);
      await setImmediate();
      const result = {
        decryptCalls: dave.decrypt.mock.calls.length,
        ciphertextDelivered,
        pcmChunks,
        errors,
      };
      stream.destroy();
      decoder.destroy();
      await setImmediate();
      return result;
    }

    const expected = {
      decryptCalls: hasDave ? 1 : 0,
      ciphertextDelivered: false,
      pcmChunks: 1,
      errors: 0,
    };
    try {
      expect(await receive()).toEqual(expected);
      networking.state.ws.emit("close", { code: closeCode });
      expect(connection.state.status).toBe(VoiceConnectionStatus.Connecting);
      expect(networking.state.code).toBe(NetworkingStatusCode.Resuming);
      expect(networking.state.udp).toBe(udp);
      expect(networking.state.dave).toBe(hasDave ? dave : undefined);
      expect(await receive()).toEqual(expected);
      networking.state.ws.emit("packet", { op: 9, d: {} }); // VoiceOpcodes.Resumed
      expect(connection.state.status).toBe(VoiceConnectionStatus.Ready);
      expect(await receive()).toEqual(expected);
    } finally {
      connection.destroy();
    }
  },
);
