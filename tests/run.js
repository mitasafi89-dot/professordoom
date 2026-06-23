"use strict";

/**
 * Test runner. Executes every server test suite in sequence, each in its own
 * process (so a crash in one can't take the others down), and exits non-zero if
 * any suite fails. This is what `npm test` invokes, so the suite is no longer a
 * manual "remember the right node path" step.
 *
 * The browser-dependent suite (test_autocontinue) self-skips when Playwright is
 * not installed, so it is safe to include here unconditionally.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  "test_credits_errors.js",
  "test_documents.js",
  "test_streaming_protocol.js",
  "test_file_proxy.js",
  "test_autocontinue.js",
  "test_live_status.js",
];

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n=================== ${suite} ===================`);
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    failed++;
    console.log(`*** ${suite} FAILED (exit ${r.status}) ***`);
  }
}

console.log(
  `\n=================== summary ===================\n` +
    `${SUITES.length - failed}/${SUITES.length} suites passed.`
);
process.exit(failed === 0 ? 0 : 1);
