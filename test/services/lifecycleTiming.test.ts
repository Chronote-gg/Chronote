/** @jest-environment node */
import {
  LIFECYCLE,
  leaseCapEpochSeconds,
} from "../../src/services/lifecycleTiming";

const RESERVED_AT_MS = 1_700_000_000_000;
const TWO_HOURS_MS = 2 * 3_600_000;

test("lease cap is duration plus grace", () => {
  expect(leaseCapEpochSeconds(RESERVED_AT_MS, TWO_HOURS_MS)).toBe(
    Math.floor(
      (RESERVED_AT_MS + TWO_HOURS_MS + LIFECYCLE.leaseCapGraceMs) / 1000,
    ),
  );
  expect(leaseCapEpochSeconds(1_500, 0)).toBe(
    Math.floor((1_500 + LIFECYCLE.leaseCapGraceMs) / 1000),
  );
});
