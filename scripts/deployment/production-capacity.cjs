"use strict";
// Bounds shared with the actual polling paths. Every capacity entry remains reviewed.
const LEASE_SECONDS = 180;
const RENEWAL_MARGIN_SECONDS = 60;
const RENEWAL_INTERVAL_SECONDS = LEASE_SECONDS - RENEWAL_MARGIN_SECONDS;
const WARMUP_SECONDS = 900;
const RETIREMENT_SECONDS = 7500;
const INITIAL_LEASE_SECONDS = 1800;
const renewals = (seconds) => Math.ceil(seconds / RENEWAL_INTERVAL_SECONDS);
const coordinatorRenewals = Object.freeze({
  warming: renewals(WARMUP_SECONDS),
  promoted: 1,
  retiring: renewals(RETIREMENT_SECONDS),
});
const introductionRenewals = Object.freeze({
  bootstrap: renewals(
    Math.max(
      0,
      2 * WARMUP_SECONDS - INITIAL_LEASE_SECONDS + RENEWAL_MARGIN_SECONDS,
    ),
  ),
  replacement: renewals(WARMUP_SECONDS),
});
// 13 non-renew coordinator writes per branch; 18 other closed actions overall.
const MINIMUM_ACTIONS =
  2 * (13 + Object.values(coordinatorRenewals).reduce((a, b) => a + b, 0)) +
  18 +
  Object.values(introductionRenewals).reduce((a, b) => a + b, 0);
const MAXIMUM_ACTIONS = 200;
module.exports = {
  LEASE_SECONDS,
  RENEWAL_MARGIN_SECONDS,
  WARMUP_SECONDS,
  RETIREMENT_SECONDS,
  INITIAL_LEASE_SECONDS,
  coordinatorRenewals,
  introductionRenewals,
  MINIMUM_ACTIONS,
  MAXIMUM_ACTIONS,
};
