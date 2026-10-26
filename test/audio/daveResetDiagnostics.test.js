/** @jest-environment node */

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { afterEach, expect, jest, test } from "@jest/globals";
import {
  DAVESession,
  Networking,
  NetworkingStatusCode,
  VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import Davey from "@snazzah/davey";
import { VoiceOpcodes } from "discord-api-types/voice/v8";
import prism from "prism-media";
import controls from "./fixtures/davePublicControls.cjs";
import { offlineVoiceConnection } from "./fixtures/offlineVoiceConnection.mjs";

// Only the transport is offline; wrapper, networking and MLS methods remain real.
class OfflineNetworking extends Networking {
  createWebSocket() {
    const ws = new EventEmitter();
    ws.sent = [];
    ws.destroy = () => {};
    ws.sequence = 0;
    ws.sendPacket = (packet) => ws.sent.push(packet);
    ws.sendBinaryMessage = (op, payload) => ws.sent.push({ op, payload });
    ws.on("packet", this.onWsPacket);
    ws.on("binary", this.onWsBinary);
    ws.on("close", this.onWsClose);
    return ws;
  }
}

const networks = [];
afterEach(() => {
  for (const network of networks.splice(0)) network.destroy();
  jest.restoreAllMocks();
});

function networkAt(code = NetworkingStatusCode.SelectingProtocol) {
  const network = new OfflineNetworking(
    {
      endpoint: "unused.invalid",
      userId: controls.MY_USER_ID,
      channelId: controls.CHANNEL_ID,
    },
    { decryptionFailureTolerance: 1 },
  );
  networks.push(network);
  const udp = new EventEmitter();
  udp.destroy = () => {};
  network.state = {
    ...network.state,
    code,
    udp,
    connectionData: { connectedClients: new Set([controls.OTHER_USER_ID]) },
  };
  return network;
}

function installDave(network) {
  network.onWsPacket({
    op: VoiceOpcodes.SessionDescription,
    d: {
      mode: "aead_aes256_gcm_rtpsize",
      secret_key: Array(32).fill(1),
      dave_protocol_version: 1,
    },
  });
  return network.state.dave;
}

function activate(network, transitionId = 1) {
  const dave = network.state.dave;
  if (dave.session.status === Davey.SessionStatus.INACTIVE) {
    network.onWsBinary({
      op: VoiceOpcodes.DaveMlsExternalSender,
      payload: controls.EXTERNAL_SENDER,
    });
  }
  const { commit } = dave.session.processProposals(
    Davey.ProposalsOperationType.APPEND,
    controls.APPENDING_PROPOSALS,
    [controls.OTHER_USER_ID],
  );
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(transitionId);
  network.onWsBinary({
    op: VoiceOpcodes.DaveMlsAnnounceCommitTransition,
    payload: Buffer.concat([prefix, commit]),
  });
  network.onWsPacket({
    op: VoiceOpcodes.DaveExecuteTransition,
    d: { transition_id: transitionId },
  });
  expect(dave.session.ready).toBe(true);
}

test("attributes initial key package to its wrapper before networking installs it", () => {
  const network = networkAt();
  const dave = network.createDaveSession(1);
  try {
    expect(network.state.dave).toBeUndefined();
    expect(network.state.ws.sent.map(({ op }) => op)).toEqual([
      VoiceOpcodes.DaveMlsKeyPackage,
    ]);
    expect(dave.resetDiagnostics).toEqual({
      reason: "initial",
      atMs: expect.any(Number),
      keyPackageDisposition: "send-returned",
      invalidationDisposition: "not-emitted",
    });
  } finally {
    dave.destroy();
  }
});

test.each([
  ["processWelcome", "invalid-welcome"],
  ["processCommit", "invalid-commit"],
])(
  "classifies %s recovery and preserves invalidation before key package",
  (method, reason) => {
    const network = networkAt();
    const dave = installDave(network);
    const ws = network.state.ws;
    ws.sent.length = 0;
    const emitted = [];
    dave.on("invalidateTransition", (id, episode) =>
      emitted.push({ id, episode }),
    );
    dave.on("keyPackage", (payload, episode) =>
      emitted.push({ payload, episode }),
    );
    const invalid = Buffer.from([0, 7]);
    expect(dave[method](invalid)).toEqual({ transitionId: 7, success: false });
    expect(ws.sent.map(({ op }) => op)).toEqual([
      VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      VoiceOpcodes.DaveMlsKeyPackage,
    ]);
    expect(ws.sent[0].d).toEqual({ transition_id: 7 });
    expect(emitted[0].id).toBe(7);
    expect(emitted[1].payload).toBe(ws.sent[1].payload);
    expect(emitted[0].episode).toBe(dave.resetDiagnostics);
    expect(emitted[1].episode).toBe(dave.resetDiagnostics);
    expect(dave.resetDiagnostics).toEqual({
      reason,
      atMs: expect.any(Number),
      keyPackageDisposition: "send-returned",
      invalidationDisposition: "send-returned",
    });
    const episode = dave.resetDiagnostics;
    dave.recoverFromInvalidTransition(8, "unknown");
    expect(dave.resetDiagnostics).toBe(episode);
    expect(ws.sent.map(({ op }) => op)).toEqual([
      VoiceOpcodes.DaveMlsInvalidCommitWelcome,
      VoiceOpcodes.DaveMlsKeyPackage,
    ]);
  },
);

test("records accepted epoch and direct reinit but ignores epochs and no-native protocol zero", () => {
  const network = networkAt();
  const dave = installDave(network);
  const first = dave.resetDiagnostics;
  dave.prepareEpoch({ epoch: 2, protocol_version: 1 });
  expect(dave.resetDiagnostics).toBe(first);
  dave.prepareEpoch({ epoch: 1, protocol_version: 1 });
  expect(dave.resetDiagnostics).toMatchObject({ reason: "epoch-1" });
  expect(dave.resetDiagnostics).not.toBe(first);
  dave.reinit();
  expect(dave.resetDiagnostics).toMatchObject({ reason: "unknown" });
  const latest = dave.resetDiagnostics;
  const replacement = network.createDaveSession(1);
  try {
    expect(replacement.resetDiagnostics).toMatchObject({
      reason: "initial",
      invalidationDisposition: "not-emitted",
    });
    expect(dave.resetDiagnostics).toBe(latest);
  } finally {
    replacement.destroy();
  }
  dave.protocolVersion = 0;
  dave.reinit();
  expect(dave.resetDiagnostics).toMatchObject({
    reason: "unknown",
    keyPackageDisposition: "not-emitted",
    invalidationDisposition: "not-emitted",
  });
  const fresh = new DAVESession(
    0,
    controls.MY_USER_ID,
    controls.CHANNEL_ID,
    {},
  );
  const none = fresh.resetDiagnostics;
  fresh.reinit();
  expect(fresh.resetDiagnostics).toBe(none);
  expect(fresh.resetDiagnostics).toEqual({
    reason: "none",
    atMs: null,
    keyPackageDisposition: "not-emitted",
    invalidationDisposition: "not-emitted",
  });
});

test.each([
  [
    NetworkingStatusCode.SelectingProtocol,
    "send-returned",
    [VoiceOpcodes.DaveMlsInvalidCommitWelcome, VoiceOpcodes.DaveMlsKeyPackage],
  ],
  [
    NetworkingStatusCode.Ready,
    "send-returned",
    [VoiceOpcodes.DaveMlsInvalidCommitWelcome, VoiceOpcodes.DaveMlsKeyPackage],
  ],
  [NetworkingStatusCode.Resuming, "skipped-resuming", []],
  [NetworkingStatusCode.OpeningWs, "skipped-other-state", []],
  [NetworkingStatusCode.Closed, "skipped-other-state", []],
])(
  "records both recovery reply gates in networking state %s",
  (code, disposition, ops) => {
    const network = networkAt();
    const dave = installDave(network);
    const ws = network.state.ws;
    network.state = { ...network.state, code };
    ws.sent.length = 0;
    dave.recoverFromInvalidTransition(7, "unknown");
    expect(ws.sent.map(({ op }) => op)).toEqual(ops);
    expect(dave.resetDiagnostics).toMatchObject({
      keyPackageDisposition: disposition,
      invalidationDisposition: disposition,
    });
    // Legacy direct handler calls do not require an episode.
    network.onDaveKeyPackage(Buffer.alloc(0));
    network.onDaveInvalidateTransition(7);
    expect(ws.sent.map(({ op }) => op)).toEqual(
      ops.length
        ? [
            VoiceOpcodes.DaveMlsInvalidCommitWelcome,
            VoiceOpcodes.DaveMlsKeyPackage,
            VoiceOpcodes.DaveMlsKeyPackage,
            VoiceOpcodes.DaveMlsInvalidCommitWelcome,
          ]
        : [],
    );
  },
);

test.each([
  [
    "onDaveKeyPackage",
    "sendBinaryMessage",
    "keyPackageDisposition",
    Buffer.alloc(0),
  ],
  ["onDaveInvalidateTransition", "sendPacket", "invalidationDisposition", 7],
])(
  "%s retains original thrown send and records normal error-emitting returns",
  (handler, send, field, argument) => {
    const network = networkAt();
    const dave = installDave(network);
    const episode = dave.resetDiagnostics;
    const failure = new Error("synthetic transport error");
    network.state.ws[send] = () => {
      throw failure;
    };
    let caught;
    try {
      network[handler](argument, episode);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(episode[field]).toBe("send-threw");
    const errors = [];
    network.state.ws.on("error", (error) => errors.push(error));
    network.state.ws[send] = () => network.state.ws.emit("error", failure);
    network[handler](argument, episode);
    expect(errors).toEqual([failure]);
    expect(episode[field]).toBe("send-returned");
  },
);

test("native activation and resume recovery retain the latest episode without retry", () => {
  const connection = offlineVoiceConnection(VoiceConnection);
  const network = networkAt();
  network.on("stateChange", connection.onNetworkingStateChange);
  network.on("transitioned", connection.onNetworkingTransitioned);
  connection.state = {
    ...connection.state,
    status: VoiceConnectionStatus.Connecting,
    networking: network,
  };
  try {
    const dave = installDave(network);
    const first = dave.resetDiagnostics;
    activate(network);
    expect(dave.resetDiagnostics).toBe(first);
    const silence = Buffer.from([0xf8, 0xff, 0xfe]);
    expect(dave.decrypt(silence, controls.OTHER_USER_ID)).toBe(silence);
    const encoder = new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    const opus = encoder._encode(Buffer.alloc(960 * 2 * 2));
    encoder.destroy();
    const ciphertext = dave.session.encryptOpus(opus);
    expect(ciphertext.equals(opus)).toBe(false);
    dave.prepareEpoch({ epoch: 1, protocol_version: 1 });
    expect(dave.session.ready).toBe(false);
    expect(dave.decrypt(ciphertext, controls.OTHER_USER_ID)).toBe(ciphertext);
    expect(dave.decrypt(opus, controls.OTHER_USER_ID)).toBe(opus);
    const epoch = dave.resetDiagnostics;
    activate(network);
    expect(dave.resetDiagnostics).toBe(epoch);
    expect(dave.decrypt(silence, controls.OTHER_USER_ID)).toBe(silence);
    network.onWsClose({ code: 4015 });
    const ws = network.state.ws;
    const candidate = Buffer.alloc(32, 0xff);
    connection.receiver.decrypt = () => candidate;
    const receive = () =>
      connection.receiver.parsePacket(
        Buffer.alloc(16),
        "unused",
        null,
        null,
        controls.OTHER_USER_ID,
      );
    expect(receive()).toBeNull();
    expect(receive()).toBeNull();
    const episode = dave.resetDiagnostics;
    expect(dave.session.ready).toBe(false);
    const snapshot = connection.receiver.packetDiagnostics.get(receive());
    expect(snapshot).toMatchObject({
      daveResetReason: "decrypt-failures",
      daveKeyPackageDisposition: "skipped-resuming",
      daveInvalidationDisposition: "skipped-resuming",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(ws.sent).toEqual([]);
    network.onWsPacket({ op: VoiceOpcodes.Resumed, d: {} });
    expect(network.state.code).toBe(NetworkingStatusCode.Ready);
    expect(dave.session.ready).toBe(false);
    expect(dave.reinitializing).toBe(true);
    expect(dave.resetDiagnostics).toBe(episode);
    expect(ws.sent).toEqual([]);
    activate(network);
    expect(dave.resetDiagnostics).toBe(episode);
    connection.receiver.decrypt = () => silence;
    expect(connection.receiver.packetDiagnostics.get(receive())).toMatchObject({
      daveReady: true,
      daveResetReason: "decrypt-failures",
      daveKeyPackageDisposition: "skipped-resuming",
      daveInvalidationDisposition: "skipped-resuming",
    });
    expect(Object.keys(episode).sort()).toEqual([
      "atMs",
      "invalidationDisposition",
      "keyPackageDisposition",
      "reason",
    ]);
  } finally {
    connection.destroy();
  }
});
