/** @jest-environment node */

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "@jest/globals";
import { DAVESession, VoiceReceiver, EndBehaviorType } from "@discordjs/voice";
import { OpusDiagnosticDecoder } from "../../src/utils/opusDiagnosticDecoder";
import Davey from "@snazzah/davey";
import prism from "prism-media";
import { createExternalSender } from "./fixtures/daveExternalSender.mjs";

const ALICE = "100";
const BOB = "200";
const CHANNEL = "300";

function createMembers() {
  const external = createExternalSender(CHANNEL);
  const alice = new DAVESession(1, ALICE, CHANNEL, {});
  const bob = new DAVESession(1, BOB, CHANNEL, {});
  for (const member of [alice, bob]) {
    member.reinit("initial");
    member.setExternalSender(external.package);
  }
  return { alice, bob, external };
}

function prepareWelcome(alice, bob, external, transitionId) {
  const { commit, welcome } = alice.session.processProposals(
    Davey.ProposalsOperationType.APPEND,
    external.add(bob.session.getSerializedKeyPackage()),
    [BOB],
  );
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(transitionId);
  expect(alice.processCommit(Buffer.concat([prefix, commit]))).toEqual({
    transitionId,
    success: true,
  });
  expect(alice.executeTransition(transitionId)).toBe(true);
  return Buffer.concat([prefix, welcome]);
}

function generatedOpus() {
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

test("authenticates remote media after delayed initial welcome and again after native reset", () => {
  const { alice, bob, external } = createMembers();
  const opus = generatedOpus();
  try {
    for (const transitionId of [1, 2]) {
      if (transitionId === 2) {
        alice.prepareEpoch({ epoch: 1, protocol_version: 1 });
        bob.prepareEpoch({ epoch: 1, protocol_version: 1 });
      }
      const welcome = prepareWelcome(alice, bob, external, transitionId);
      const ciphertext = alice.session.encryptOpus(opus);
      expect(ciphertext.equals(opus)).toBe(false);
      // The joining member has not received its real welcome yet.
      expect(bob.session.ready).toBe(false);
      expect(bob.processWelcome(welcome)).toEqual({
        transitionId,
        success: true,
      });
      expect(bob.executeTransition(transitionId)).toBe(true);
      expect(bob.session.ready).toBe(true);
      expect(bob.session.getEpochAuthenticator()).toEqual(
        alice.session.getEpochAuthenticator(),
      );
      expect(bob.session.getUserIds().sort()).toEqual([ALICE, BOB]);
      bob.session.setPassthroughMode(false, 0);
      expect(bob.decrypt(ciphertext, ALICE)).toEqual(opus);
      expect(bob.session.getDecryptionStats(ALICE)).toMatchObject({
        attempts: 1,
        successes: 1,
        failures: 0,
        passthroughs: 0,
      });
      const reverse = bob.session.encryptOpus(opus);
      expect(alice.decrypt(reverse, BOB)).toEqual(opus);
      expect(alice.session.getDecryptionStats(BOB)).toMatchObject({
        attempts: 1,
        successes: 1,
        failures: 0,
        passthroughs: 0,
      });
    }
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test("rejects an external Add whose signature was changed", () => {
  const { alice, bob, external } = createMembers();
  try {
    const proposal = external.add(bob.session.getSerializedKeyPackage());
    proposal[proposal.length - 1] ^= 1;
    expect(() =>
      alice.session.processProposals(
        Davey.ProposalsOperationType.APPEND,
        proposal,
        [BOB],
      ),
    ).toThrow();
    expect(alice.session.ready).toBe(false);
    expect(bob.session.ready).toBe(false);
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test("rejects altered authenticated media rather than returning it as plaintext", () => {
  const { alice, bob, external } = createMembers();
  try {
    expect(
      bob.processWelcome(prepareWelcome(alice, bob, external, 1)).success,
    ).toBe(true);
    const ciphertext = alice.session.encryptOpus(generatedOpus());
    ciphertext[0] ^= 1;
    expect(bob.decrypt(ciphertext, ALICE)).toBeNull();
    expect(bob.session.getDecryptionStats(ALICE)).toMatchObject({
      attempts: 1,
      successes: 0,
      failures: 1,
      passthroughs: 0,
    });
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test("the same decoder handles plaintext before welcome and authenticated Opus after welcome", async () => {
  const { alice, bob, external } = createMembers();
  const opus = generatedOpus();
  const connection = new EventEmitter();
  connection.state = {
    status: "ready",
    networking: { state: { code: 4, dave: bob } },
  };
  const receiver = new VoiceReceiver(connection);
  let input = opus;
  receiver.decrypt = () => input;
  receiver.connectionData = {
    encryptionMode: "aead_aes256_gcm_rtpsize",
    nonceBuffer: Buffer.alloc(12),
    secretKey: Buffer.alloc(32),
  };
  receiver.ssrcMap.update({ userId: ALICE, audioSSRC: 123 });
  const stream = receiver.subscribe(ALICE, {
    end: { behavior: EndBehaviorType.Manual },
  });
  const decoder = new OpusDiagnosticDecoder(receiver, {
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  const received = [];
  let pendingLosses = 0;
  stream.on("davePendingInput", () => pendingLosses++);
  let decoded = 0;
  const errors = [];
  stream.on("data", (packet) =>
    received.push(receiver.packetDiagnostics.get(packet).daveDecryptDecision),
  );
  decoder.on("data", () => decoded++);
  decoder.on("error", (error) => errors.push(error));
  stream.pipe(decoder);
  const rtp = Buffer.alloc(16);
  rtp[0] = 0x80;
  rtp[1] = 0x78;
  rtp.writeUInt32BE(123, 8);
  try {
    receiver.onUdpMessage(rtp);
    await setImmediate();
    expect(decoded).toBe(1);
    const welcome = prepareWelcome(alice, bob, external, 1);
    expect(bob.session.ready).toBe(false);
    input = alice.session.encryptOpus(opus);
    receiver.onUdpMessage(rtp);
    await setImmediate();
    expect(decoded).toBe(1);
    expect(pendingLosses).toBe(1);
    expect(errors).toEqual([]);
    expect(stream.destroyed).toBe(false);
    expect(decoder.destroyed).toBe(false);
    expect(bob.processWelcome(welcome).success).toBe(true);
    input = alice.session.encryptOpus(opus);
    receiver.onUdpMessage(rtp);
    await setImmediate();
    expect(received).toEqual(["not-ready", "native-decrypt-returned"]);
    expect(decoded).toBe(2);
    expect(errors).toEqual([]);
    expect(bob.session.getDecryptionStats(ALICE)).toMatchObject({
      successes: 1,
      passthroughs: 0,
    });
  } finally {
    stream.destroy();
    decoder.destroy();
    alice.destroy();
    bob.destroy();
  }
});

// These protocol-invalid vectors expose the pinned native parser disagreement.
// They are investigative gate tests, not permission to adopt native's wider rules.
function malformedFrame(nonceAndRanges) {
  return Buffer.concat([
    Buffer.alloc(12),
    Buffer.from(nonceAndRanges),
    Buffer.from([11 + nonceAndRanges.length, 0xfa, 0xfa]),
  ]);
}

test.each([
  ["nonce exceeds u32", malformedFrame([0x80, 0x80, 0x80, 0x80, 0x10])],
  [
    "nonce encoding exceeds u64",
    malformedFrame([
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0,
    ]),
  ],
  ["duplicate empty ranges", malformedFrame([0, 0, 0, 0, 0])],
  ["overlapping ranges", malformedFrame([0, 0, 2, 1, 1])],
  ["range exceeds entire frame", malformedFrame([0, 99, 1])],
  ["incomplete range pair", malformedFrame([0, 1])],
  ["incomplete nonce", malformedFrame([0x80])],
  [
    "supplemental data fills the entire frame",
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0xfa, 0xfa]),
  ],
  [
    "range extends into supplemental data",
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 1, 14, 0xfa, 0xfa]),
  ],
])(
  "protocol-invalid %s must pass through as non-protocol data",
  (name, frame) => {
    const { alice, bob, external } = createMembers();
    try {
      expect(
        bob.processWelcome(prepareWelcome(alice, bob, external, 1)).success,
      ).toBe(true);
      bob.session.setPassthroughMode(true);
      let unchanged = false;
      try {
        unchanged = bob.session
          .decrypt(ALICE, Davey.MediaType.AUDIO, frame)
          .equals(frame);
      } catch {
        // Keep native messages and input bytes out of the assertion output.
      }
      const stats = bob.session.getDecryptionStats(ALICE);
      expect({
        unchanged,
        attempts: stats.attempts,
        passthroughs: stats.passthroughs,
      }).toEqual({
        unchanged: true,
        attempts: 0,
        passthroughs: 1,
      });
    } finally {
      alice.destroy();
      bob.destroy();
    }
  },
);

test("CJS and ESM wrappers authenticate real two-member activation with passthrough disabled", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const esm = await import(process.env.CHRONOTE_TEST_VOICE ? pathToFileURL(process.env.CHRONOTE_TEST_VOICE.replace('index.js', 'index.mjs')).href : '@discordjs/voice');
    import Davey from '@snazzah/davey';
    import prism from 'prism-media';
    import { createExternalSender } from './test/audio/fixtures/daveExternalSender.mjs';
    const cjs = createRequire(import.meta.url)('@discordjs/voice');
    const results = [];
    const options = { rate: 48000, channels: 2, frameSize: 960 };
    const encoder = new prism.opus.Encoder(options);
    const opus = encoder._encode(Buffer.alloc(3840));
    encoder.destroy();
    for (const voice of [cjs, esm]) {
      const external = createExternalSender('300');
      const alice = new voice.DAVESession(1, '100', '300', {});
      const bob = new voice.DAVESession(1, '200', '300', {});
      try {
        for (const member of [alice, bob]) {
          member.reinit('initial');
          member.setExternalSender(external.package);
        }
        const { commit, welcome } = alice.session.processProposals(
          Davey.ProposalsOperationType.APPEND, external.add(bob.session.getSerializedKeyPackage()), ['200']);
        const committed = alice.processCommit(Buffer.concat([Buffer.from([0,1]), commit])).success;
        const ciphertext = alice.session.encryptOpus(opus);
        const delayed = !bob.session.ready;
        const pendingRejected = bob.decrypt(ciphertext, '100') === null;
        const pendingPlaintext = bob.decrypt(opus, '100').equals(opus);
        const joined = bob.processWelcome(Buffer.concat([Buffer.from([0,1]), welcome])).success;
        bob.session.setPassthroughMode(false, 0);
        const plaintext = bob.decrypt(ciphertext, '100');
        const decoder = new prism.opus.Decoder(options);
        const decoded = decoder._decode(plaintext).length > 0;
        decoder.destroy();
        const stats = bob.session.getDecryptionStats('100');
        results.push({ committed, delayed, joined, decoded, pendingRejected, pendingPlaintext,
          matched: plaintext.equals(opus), authenticated: stats.successes === 1 && stats.passthroughs === 0,
          sameEpoch: alice.session.getEpochAuthenticator().equals(bob.session.getEpochAuthenticator()) });
      } finally { alice.destroy(); bob.destroy(); }
    }
    console.log(JSON.stringify(results));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual(
    Array(2).fill({
      committed: true,
      pendingRejected: true,
      pendingPlaintext: true,
      delayed: true,
      joined: true,
      decoded: true,
      matched: true,
      authenticated: true,
      sameEpoch: true,
    }),
  );
});

test("unready native receive preserves plaintext, rejects ciphertext, then authenticates it after welcome", () => {
  const { alice, bob, external } = createMembers();
  try {
    const opus = generatedOpus();
    const welcome = prepareWelcome(alice, bob, external, 1);
    const encrypted = alice.session.encryptOpus(opus);
    expect(bob.session.ready).toBe(false);
    expect(bob.session.decrypt(ALICE, Davey.MediaType.AUDIO, opus)).toEqual(
      opus,
    );
    expect(() =>
      bob.session.decrypt(ALICE, Davey.MediaType.AUDIO, encrypted),
    ).toThrow();
    expect(bob.processWelcome(welcome).success).toBe(true);
    expect(bob.decrypt(encrypted, ALICE)).toEqual(opus);
    expect(bob.session.getDecryptionStats(ALICE)).toMatchObject({
      successes: 1,
      passthroughs: 0,
    });
  } finally {
    alice.destroy();
    bob.destroy();
  }
});
