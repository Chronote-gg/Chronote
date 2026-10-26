import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import process from "node:process";
import Davey from "@snazzah/davey";
import { VoiceOpcodes } from "discord-api-types/voice/v8";
import controls from "./davePublicControls.cjs";
import { offlineVoiceConnection } from "./offlineVoiceConnection.mjs";
const loadCjs = createRequire(import.meta.url);

async function main() {
  const { DAVESession, Networking, VoiceConnection } =
    process.argv[2] === "esm"
      ? await import("@discordjs/voice")
      : loadCjs("@discordjs/voice");
  let now = 0;
  Object.defineProperty(performance, "now", { value: () => now });

  function session() {
    const dave = new DAVESession(
      1,
      controls.MY_USER_ID,
      controls.CHANNEL_ID,
      {},
    );
    const summaries = [];
    dave.on("resetSummary", (summary) => summaries.push(summary));
    dave.reinit("initial");
    dave.setExternalSender(controls.EXTERNAL_SENDER);
    return { dave, summaries };
  }
  function commit(dave) {
    const { commit } = dave.session.processProposals(
      Davey.ProposalsOperationType.APPEND,
      controls.APPENDING_PROPOSALS,
      [controls.OTHER_USER_ID],
    );
    return Buffer.concat([Buffer.from([0, 1]), commit]);
  }
  function activate(dave) {
    assert.equal(dave.processCommit(commit(dave)).success, true);
    assert.equal(dave.session.ready, true);
  }
  const row = (reason, outcome, ageBucket, count = 1) => ({
    reason,
    outcome,
    ageBucket,
    count,
  });

  // Completion is native activation, not transition execution or repeated media.
  for (const [age, bucket] of [
    [0, "under-100ms"],
    [99, "under-100ms"],
    [100, "100ms-to-1s"],
    [999, "100ms-to-1s"],
    [1000, "1s-to-10s"],
    [9999, "1s-to-10s"],
    [10000, "10s-to-1m"],
    [59999, "10s-to-1m"],
    [60000, "1m-or-more"],
  ]) {
    now = 0;
    const { dave, summaries } = session();
    now = age;
    activate(dave);
    dave.executeTransition(1);
    dave.executeTransition(1);
    dave.decrypt(Buffer.from([0xf8, 0xff, 0xfe]), controls.OTHER_USER_ID);
    assert.deepEqual(summaries, []);
    dave.destroy();
    dave.destroy();
    assert.deepEqual(summaries, [[row("initial", "ready", bucket)]]);
  }

  // A stale prior-group commit cannot complete the replacement reset.
  now = 0;
  {
    const { dave, summaries } = session();
    const stale = commit(dave);
    now = 50;
    dave.prepareEpoch({ epoch: 1, protocol_version: 1 });
    now = 150;
    assert.equal(dave.processCommit(stale).success, false);
    assert.equal(dave.session.ready, false);
    now = 200;
    activate(dave);
    dave.destroy();
    assert.deepEqual(summaries, [
      [
        row("initial", "superseded-pending", "under-100ms"),
        row("epoch-1", "superseded-pending", "100ms-to-1s"),
        row("invalid-commit", "ready", "under-100ms"),
      ],
    ]);
  }

  // Pending media does not create readiness or a timeout; destroy censors it.
  now = 0;
  {
    const { dave, summaries } = session();
    now = 60000;
    const packet = Buffer.alloc(8);
    for (let i = 0; i < 10; i++) {
      assert.equal(dave.decrypt(packet, controls.OTHER_USER_ID), packet);
    }
    assert.deepEqual(summaries, []);
    dave.destroy();
    assert.deepEqual(summaries, [
      [row("initial", "destroyed-pending", "1m-or-more")],
    ]);
  }

  // Aggregate repeated reset outcomes without retaining episode identifiers.
  now = 0;
  {
    const { dave, summaries } = session();
    activate(dave);
    for (let i = 0; i < 3; i++) {
      dave.prepareEpoch({ epoch: 1, protocol_version: 1 });
      activate(dave);
    }
    dave.destroy();
    assert.deepEqual(summaries, [
      [
        row("initial", "ready", "under-100ms"),
        row("epoch-1", "ready", "under-100ms", 3),
      ],
    ]);
  }

  // Invalid welcome stays pending; an observer error must not break cleanup.
  now = 0;
  {
    const { dave, summaries } = session();
    assert.equal(dave.processWelcome(Buffer.from([0, 7])).success, false);
    dave.on("resetSummary", () => {
      throw new Error("synthetic observer failure");
    });
    assert.doesNotThrow(() => dave.destroy());
    assert.deepEqual(summaries, [
      [
        row("initial", "superseded-pending", "under-100ms"),
        row("invalid-welcome", "destroyed-pending", "under-100ms"),
      ],
    ]);
  }

  // Runtime callers cannot introduce unbounded reason labels into telemetry.
  {
    const { dave, summaries } = session();
    dave.reinit("unrecognized-reason");
    dave.destroy();
    assert.deepEqual(summaries, [
      [
        row("initial", "superseded-pending", "under-100ms"),
        row("unknown", "destroyed-pending", "under-100ms"),
      ],
    ]);
  }

  // Protocol zero does not start a native activation measurement.
  {
    const dave = new DAVESession(
      0,
      controls.MY_USER_ID,
      controls.CHANNEL_ID,
      {},
    );
    const summaries = [];
    dave.on("resetSummary", (summary) => summaries.push(summary));
    dave.reinit();
    dave.destroy();
    assert.deepEqual(summaries, []);
  }
  {
    const { dave, summaries } = session();
    dave.protocolVersion = 0;
    dave.reinit();
    dave.destroy();
    assert.deepEqual(summaries, [
      [row("initial", "superseded-pending", "under-100ms")],
    ]);
  }

  // Exercise real Networking and VoiceConnection listener/teardown forwarding.
  Networking.prototype.createWebSocket = function () {
    const ws = new EventEmitter();
    ws.destroy = () => {};
    ws.sendPacket = () => {};
    ws.sendBinaryMessage = () => {};
    return ws;
  };
  const connection = offlineVoiceConnection(VoiceConnection);
  const summaries = [];
  connection.on("daveResetSummary", (summary) => summaries.push(summary));
  connection.packets.server = {
    endpoint: "unused.invalid",
    guild_id: "offline",
    token: "offline",
  };
  connection.packets.state = {
    session_id: "offline",
    user_id: controls.MY_USER_ID,
    channel_id: controls.CHANNEL_ID,
  };
  connection.configureNetworking();
  for (let i = 0; i < 2; i++) {
    const network = connection.state.networking;
    const udp = new EventEmitter();
    udp.destroy = () => {};
    network.state = { ...network.state, code: 3, udp, connectionData: {} };
    network.onWsPacket({
      op: VoiceOpcodes.SessionDescription,
      d: {
        mode: "aead_aes256_gcm_rtpsize",
        secret_key: Array(32).fill(1),
        dave_protocol_version: 1,
      },
    });
    now += 5;
    if (i === 0) {
      const oldDave = network.state.dave;
      const replacement = network.createDaveSession(1);
      network.state = { ...network.state, dave: replacement };
      assert.equal(oldDave.listenerCount("resetSummary"), 0);
      connection.configureNetworking();
    } else connection.destroy();
    assert.equal(network.listenerCount("daveResetSummary"), 0);
  }
  assert.deepEqual(summaries, [
    [row("initial", "destroyed-pending", "under-100ms")],
    [row("initial", "destroyed-pending", "under-100ms")],
    [row("initial", "destroyed-pending", "under-100ms")],
  ]);
  process.stdout.write("resetReadinessVerified=true\n");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
