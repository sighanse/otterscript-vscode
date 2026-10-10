// @ts-check
/**
 * @fileoverview The time limit for the tests that keep a check linear in its
 * input's length (where it once took time growing with the square of it).
 */

const assert = require("node:assert/strict");

/**
 * How long such a check may take on its test input: 3 s. Each test's input is
 * sized so the old, quadratic code takes several seconds or more on it, while
 * the linear code takes well under 1 s -- also with coverage on (2-3 times
 * slower) and on a slow CI machine. The limit sits between the two, so it
 * catches the regression without failing at random.
 */
const LINEAR_TIME_LIMIT_MS = 3000;

/**
 * Runs `check` and asserts it finished within {@link LINEAR_TIME_LIMIT_MS}.
 *
 * @template T
 * @param {() => T} check
 * @param {string} [label] - Which input, in the failure message
 * @returns {T} What `check` returned
 */
function assertLinearTime(check, label = "") {
  const started = performance.now();
  const result = check();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < LINEAR_TIME_LIMIT_MS, `${label ? `${label}: ` : ""}took ${Math.round(elapsed)} ms`);
  return result;
}

module.exports = { LINEAR_TIME_LIMIT_MS, assertLinearTime };
