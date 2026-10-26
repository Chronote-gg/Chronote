/** @jest-environment node */

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { expect, jest, test } from "@jest/globals";
import { DAVESession, VoiceReceiver } from "@discordjs/voice";
import { once } from "node:events";
import { OpusDiagnosticDecoder } from "../../src/utils/opusDiagnosticDecoder";
import prism from "prism-media";
import controls from "./fixtures/davePublicControls.cjs";

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
      daveResetReason: "none",
      daveResetAgoMs: null,
      daveKeyPackageDisposition: "not-emitted",
      daveInvalidationDisposition: "not-emitted",
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
    daveResetReason: null,
    daveResetAgoMs: null,
    daveKeyPackageDisposition: null,
    daveInvalidationDisposition: null,
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
    dave.session = { reinit() {}, getSerializedKeyPackage() { return Buffer.alloc(0); } };
    Date.now = () => 100;
    dave.reinit('epoch-1');
    Date.now = () => 145;
    dave.resetDiagnostics.keyPackageDisposition = 'skipped-resuming';
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
    daveNativeSessionPresent: true,
    daveReady: null,
    daveDecryptDecision: "not-ready",
    daveResetReason: "epoch-1",
    daveResetAgoMs: 45,
    daveKeyPackageDisposition: "skipped-resuming",
    daveInvalidationDisposition: "not-emitted",
  });
});

test("queued real decoder failure retains receive-time reset scalars after mutation and replacement", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(100);
  const dave = new DAVESession(1, controls.MY_USER_ID, controls.CHANNEL_ID, {});
  dave.reinit("epoch-1");
  const connection = new EventEmitter();
  connection.state = {
    status: "connecting",
    networking: { state: { code: 5, dave } },
  };
  const receiver = new VoiceReceiver(connection);
  clock.mockReturnValue(145);
  receiver.decrypt = () => Buffer.alloc(32, 0xff);
  const packet = receiver.parsePacket(
    Buffer.alloc(16),
    "unused",
    null,
    null,
    controls.OTHER_USER_ID,
  );
  const snapshot = receiver.packetDiagnostics.get(packet);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.keys(snapshot).sort()).toEqual([
    "connectionStatus",
    "daveDecryptDecision",
    "daveInvalidationDisposition",
    "daveKeyPackageDisposition",
    "daveNativeSessionPresent",
    "daveProtocolVersion",
    "daveReady",
    "daveResetAgoMs",
    "daveResetReason",
    "daveSessionPresent",
    "daveTransitionAgoMs",
    "networkingCode",
  ]);
  const originalTransform = prism.opus.Decoder.prototype._transform;
  let release;
  const hold = jest
    .spyOn(prism.opus.Decoder.prototype, "_transform")
    .mockImplementationOnce(function (input, encoding, done) {
      release = () => originalTransform.call(this, input, encoding, done);
    });
  const decoder = new OpusDiagnosticDecoder(receiver, {
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  decoder.resume();
  try {
    const error = once(decoder, "error");
    decoder.write(Buffer.from([0xf8, 0xff, 0xfe]));
    decoder.write(packet);
    // Change both the old episode and the wrapper's latest reference while queued.
    dave.resetDiagnostics.keyPackageDisposition = "send-returned";
    clock.mockReturnValue(200);
    dave.reinit("unknown");
    release();
    await error;
    expect(decoder.failedInput.receiver).toBe(snapshot);
    expect(decoder.formatFailureDiagnostics()).toContain(
      "daveResetReason=epoch-1 daveResetAgoMs=45 daveKeyPackageDisposition=not-emitted daveInvalidationDisposition=not-emitted",
    );
  } finally {
    hold.mockRestore();
    clock.mockRestore();
    decoder.destroy();
    dave.destroy();
  }
});

test("formats known no-attempt, missing instrumentation and clock rollback distinctly", () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(100);
  const dave = new DAVESession(0, controls.MY_USER_ID, controls.CHANNEL_ID, {});
  const connection = new EventEmitter();
  connection.state = {
    status: "ready",
    networking: { state: { code: 4, dave } },
  };
  const receiver = new VoiceReceiver(connection);
  receiver.decrypt = () => Buffer.alloc(32, 0xff);
  const decoder = new OpusDiagnosticDecoder(receiver, {
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  const formatInput = () => {
    const packet = receiver.parsePacket(
      Buffer.alloc(16),
      "unused",
      null,
      null,
      controls.OTHER_USER_ID,
    );
    decoder.failedInput = { receiver: receiver.packetDiagnostics.get(packet) };
    return decoder.formatFailureDiagnostics();
  };
  try {
    expect(formatInput()).toContain(
      "daveResetReason=none daveResetAgoMs=none daveKeyPackageDisposition=not-emitted daveInvalidationDisposition=not-emitted",
    );
    dave.protocolVersion = 1;
    dave.reinit();
    clock.mockReturnValue(90);
    expect(formatInput()).toContain("daveResetReason=unknown daveResetAgoMs=0");
    delete dave.resetDiagnostics;
    expect(formatInput()).toContain(
      "daveResetReason=UNKNOWN daveResetAgoMs=UNKNOWN daveKeyPackageDisposition=UNKNOWN daveInvalidationDisposition=UNKNOWN",
    );
    decoder.failedInput = undefined;
    expect(decoder.formatFailureDiagnostics()).toContain(
      "daveResetReason=UNKNOWN daveResetAgoMs=UNKNOWN",
    );
  } finally {
    decoder.destroy();
    dave.destroy();
    clock.mockRestore();
  }
});

test("CJS and ESM retain equivalent native recovery episodes and reply gates", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as esm from '@discordjs/voice';
    import { createRequire } from 'node:module';
    import { EventEmitter } from 'node:events';
    import Davey from '@snazzah/davey';
    import controls from './test/audio/fixtures/davePublicControls.cjs';
    const cjs = createRequire(import.meta.url)('@discordjs/voice');
    Date.now = () => 100;
    const results = [];
    for (const voice of [cjs, esm]) {
      class OfflineNetworking extends voice.Networking {
        createWebSocket() {
          const ws = new EventEmitter();
          ws.destroy = () => {};
          ws.sequence = 0;
          ws.sent = [];
          ws.sendPacket = packet => ws.sent.push(packet.op);
          ws.sendBinaryMessage = op => ws.sent.push(op);
          return ws;
        }
      }
      const network = new OfflineNetworking({ endpoint: 'unused.invalid',
        userId: controls.MY_USER_ID, channelId: controls.CHANNEL_ID },
        { decryptionFailureTolerance: 1 });
      network.state = { ...network.state, code: 3 };
      const dave = network.createDaveSession(1);
      network.state = { ...network.state, code: 4, dave };
      const initial = { ...dave.resetDiagnostics };
      dave.setExternalSender(controls.EXTERNAL_SENDER);
      const { commit } = dave.session.processProposals(Davey.ProposalsOperationType.APPEND,
        controls.APPENDING_PROPOSALS, [controls.OTHER_USER_ID]);
      const prefix = Buffer.from([0, 1]);
      dave.processCommit(Buffer.concat([prefix, commit]));
      dave.executeTransition(1);
      network.state = { ...network.state, code: 5 };
      const input = Buffer.alloc(32, 0xff);
      dave.decrypt(input, controls.OTHER_USER_ID);
      dave.decrypt(input, controls.OTHER_USER_ID);
      const connection = new EventEmitter();
      connection.state = { status: 'connecting', networking: network };
      const receiver = new voice.VoiceReceiver(connection);
      receiver.decrypt = () => input;
      const packet = receiver.parsePacket(Buffer.alloc(16), 'unused', null, null, controls.OTHER_USER_ID);
      const snapshot = receiver.packetDiagnostics.get(packet);
      const gates = [];
      for (const code of [3, 4, 5, 0, 6]) {
        network.state = { ...network.state, code };
        network.onDaveKeyPackage(Buffer.alloc(0), dave.resetDiagnostics);
        network.onDaveInvalidateTransition(1, dave.resetDiagnostics);
        gates.push([dave.resetDiagnostics.keyPackageDisposition, dave.resetDiagnostics.invalidationDisposition]);
      }
      results.push({ initial, ready: dave.session.ready, snapshot, gates });
      network.destroy();
    }
    console.log(JSON.stringify(results));
  `,
    ],
    { encoding: "utf8" },
  );
  const [cjs, esm] = JSON.parse(result);
  expect(esm).toEqual(cjs);
  expect(cjs).toMatchObject({
    initial: { reason: "initial", keyPackageDisposition: "send-returned" },
    ready: false,
    snapshot: {
      daveResetReason: "decrypt-failures",
      daveResetAgoMs: 0,
      daveKeyPackageDisposition: "skipped-resuming",
      daveInvalidationDisposition: "skipped-resuming",
    },
    gates: [
      ["send-returned", "send-returned"],
      ["send-returned", "send-returned"],
      ["skipped-resuming", "skipped-resuming"],
      ["skipped-other-state", "skipped-other-state"],
      ["skipped-other-state", "skipped-other-state"],
    ],
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
