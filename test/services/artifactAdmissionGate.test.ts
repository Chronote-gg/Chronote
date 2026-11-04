/** @jest-environment node */
import { createArtifactAdmissionGate } from "../../src/services/artifactAdmissionGate";
import { RuntimeAdmissionUnavailable } from "../../src/services/runtimeAdmissionError";

test("seal owns an accepted producer and its existing stop control through actual settlement", async () => {
  const gate = createArtifactAdmissionGate();
  const producer = gate.begin();
  let drained = false;
  const draining = gate.seal().then(() => {
    drained = true;
  });
  expect(() => gate.begin()).toThrow(RuntimeAdmissionUnavailable);
  const stop = producer.beginOwned();
  producer.settle();
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(gate.active).toBe(1);
  stop.settle();
  stop.settle();
  await draining;
  expect(gate.active).toBe(0);
  expect(() => producer.beginOwned()).toThrow();
});

test("only explicit resume reopens admission after a cancelled drain", async () => {
  const gate = createArtifactAdmissionGate();
  const producer = gate.begin();
  const controller = new AbortController();
  const draining = gate.seal(controller.signal);
  controller.abort(new Error("Preparation cancelled"));
  await expect(draining).rejects.toThrow("cancelled");
  producer.settle();
  expect(() => gate.begin()).toThrow(RuntimeAdmissionUnavailable);
  gate.resume();
  const next = gate.begin();
  expect(gate.active).toBe(1);
  next.settle();
});

test("a producer racing just before the seal is included in the drain", async () => {
  const gate = createArtifactAdmissionGate();
  const first = gate.begin();
  const second = gate.begin();
  const draining = gate.seal();
  first.settle();
  expect(gate.active).toBe(1);
  second.settle();
  await draining;
  expect(gate.sealed).toBe(true);
});
