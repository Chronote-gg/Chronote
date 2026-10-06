/** @jest-environment node */

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { expect, test } from "@jest/globals";
import { DAVESession, VoiceReceiver } from "@discordjs/voice";
import { once } from "node:events";
import { OpusDiagnosticDecoder } from "../../src/utils/opusDiagnosticDecoder";

test.each([
  ["ready", 4, false, 1, false, "not-ready"],
  ["connecting", 5, false, 1, false, "not-ready"],
  ["connecting", 5, true, 1, false, "native-decrypt-returned"],
  ["ready", 4, true, 0, false, "protocol-passthrough"],
  ["ready", 4, true, 0, true, "native-decrypt-unchanged"],
  ["disconnected", 6, true, 1, false, "receiver-bypass"],
])(
  "records actual decision with connection=%s network=%s ready=%s version=%s passthrough=%s",
  (status, code, ready, version, passthrough, decision) => {
    const input = Buffer.alloc(16, 0xff);
    const plaintext = Buffer.from([0xf8, 0xff, 0xfe]);
    const dave = new DAVESession(
      version,
      "synthetic-user",
      "synthetic-channel",
      {},
    );
    dave.session = {
      ready,
      canPassthrough: () => passthrough,
      decrypt: () => (passthrough ? Buffer.from(input) : plaintext),
    };
    const connection = new EventEmitter();
    connection.state = { status, networking: { state: { code, dave } } };
    const receiver = new VoiceReceiver(connection);
    // Stub only transport encryption; keep receiver and DAVE decisions real.
    receiver.decrypt = () => input;
    const packet = receiver.parsePacket(
      Buffer.alloc(16),
      "unused",
      null,
      null,
      "synthetic-user",
    );
    expect(packet).toEqual(
      decision === "native-decrypt-returned" ? plaintext : input,
    );
    expect(receiver.packetDiagnostics?.get(packet)).toEqual({
      connectionStatus: status,
      networkingCode: code,
      daveSessionPresent: true,
      daveNativeSessionPresent: true,
      daveReady: ready,
      daveProtocolVersion: version,
      daveDecryptDecision: decision,
      daveTransitionAgoMs: null,
    });
  },
);

test("preserves legitimate silence and drops a failed native decrypt without logging content", () => {
  const input = Buffer.alloc(16, 0xff);
  const dave = new DAVESession(1, "synthetic-user", "synthetic-channel", {});
  dave.session = {
    ready: true,
    decrypt: () => {
      throw new Error("synthetic failure");
    },
  };
  const connection = new EventEmitter();
  connection.state = {
    status: "ready",
    networking: { state: { code: 4, dave } },
  };
  const receiver = new VoiceReceiver(connection);
  receiver.decrypt = () => input;
  expect(
    receiver.parsePacket(
      Buffer.alloc(16),
      "unused",
      null,
      null,
      "synthetic-user",
    ),
  ).toBeNull();
  const decision = {};
  expect(dave.decrypt(input, "synthetic-user", decision)).toBeNull();
  expect(decision.daveDecryptDecision).toBe("dropped");
  const silence = Buffer.from([0xf8, 0xff, 0xfe]);
  receiver.decrypt = () => silence;
  connection.emit("transitioned", 0);
  const packet = receiver.parsePacket(
    Buffer.alloc(16),
    "unused",
    null,
    null,
    "synthetic-user",
  );
  expect(packet).toBe(silence);
  expect(receiver.packetDiagnostics?.get(packet)).toMatchObject({
    daveDecryptDecision: "silence",
    daveTransitionAgoMs: expect.any(Number),
  });
});

test("records no-session passthrough without inventing native readiness", () => {
  const connection = new EventEmitter();
  connection.state = { status: "ready", networking: { state: { code: 4 } } };
  const receiver = new VoiceReceiver(connection);
  const input = Buffer.from([0xf8, 0xff, 0xfe]);
  receiver.decrypt = () => input;
  const packet = receiver.parsePacket(
    Buffer.alloc(16),
    "unused",
    null,
    null,
    "synthetic-user",
  );
  expect(packet).toBe(input);
  expect(receiver.packetDiagnostics?.get(packet)).toMatchObject({
    daveSessionPresent: false,
    daveNativeSessionPresent: false,
    daveReady: null,
    daveProtocolVersion: null,
    daveDecryptDecision: "no-session",
  });
});

test("ships the same receiver decision in the ESM distribution", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { EventEmitter } from 'node:events';
    import { DAVESession, VoiceReceiver } from '@discordjs/voice';
    const dave = new DAVESession(1, 'synthetic-user', 'synthetic-channel', {});
    const connection = new EventEmitter();
    connection.state = { status: 'connecting', networking: { state: { code: 5, dave } } };
    const receiver = new VoiceReceiver(connection);
    receiver.decrypt = () => Buffer.alloc(16);
    const packet = receiver.parsePacket(Buffer.alloc(16), 'unused', null, null, 'synthetic-user');
    console.log(JSON.stringify(receiver.packetDiagnostics.get(packet)));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(result)).toMatchObject({
    connectionStatus: "connecting",
    networkingCode: 5,
    daveSessionPresent: true,
    daveNativeSessionPresent: false,
    daveReady: null,
    daveDecryptDecision: "not-ready",
  });
});

test("reports receive-time state when a real Opus decode fails after state changes", async () => {
  const dave = new DAVESession(1, "synthetic-user", "synthetic-channel", {});
  dave.session = { ready: false };
  const connection = new EventEmitter();
  connection.state = {
    status: "ready",
    networking: { state: { code: 4, dave } },
  };
  const receiver = new VoiceReceiver(connection);
  receiver.decrypt = () => Buffer.alloc(32, 0xff);
  const packet = receiver.parsePacket(
    Buffer.alloc(16),
    "unused",
    null,
    null,
    "synthetic-user",
  );
  connection.state.status = "disconnected";
  connection.state.networking.state.code = 6;
  dave.session.ready = true;
  const decoder = new OpusDiagnosticDecoder(receiver, {
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  const error = once(decoder, "error");
  decoder.write(packet);
  await error;
  expect(decoder.failedInput.receiver).toMatchObject({
    connectionStatus: "ready",
    networkingCode: 4,
    daveReady: false,
    daveDecryptDecision: "not-ready",
  });
  expect(decoder.formatFailureDiagnostics()).toContain("opusPacketBytes=32");
  expect(decoder.formatFailureDiagnostics()).not.toContain("synthetic-user");
});
