/**
 * Load test for the sponsorship endpoint, for k6 (https://k6.io).
 *
 * The in-suite test (backend/test/load.test.ts) proves the property that matters most — a quota of
 * N grants exactly N under concurrency — but it drives the handler in-process. It therefore says
 * nothing about the things that actually fall over first in production: TLS handshakes, connection
 * limits, the Postgres pool under sustained writes, and the load balancer in front. That is what
 * this is for, and why it lives outside the test suite: it needs a DEPLOYED instance.
 *
 * Run:
 *   k6 run -e BASE_URL=https://paymaster.example.com \
 *          -e API_KEY=pm_live_... \
 *          -e CHAIN_ID=8453 \
 *          -e SENDER=0xYourSmartAccount \
 *          deploy/load/k6-sponsor.js
 *
 * IMPORTANT — this spends money. Every 2xx is a real attestation against a real deposit, and the
 * quota counters it consumes are real. Point it at staging, or at a policy whose spend cap you are
 * willing to exhaust. It is not safe to run against production with a production key "just to see".
 */
import http from "k6/http";
import {check, fail} from "k6";
import {Counter, Rate, Trend} from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const API_KEY = __ENV.API_KEY;
const CHAIN_ID = Number(__ENV.CHAIN_ID || 8453);
const SENDER = __ENV.SENDER;

if (!BASE_URL || !API_KEY || !SENDER) {
  fail("BASE_URL, API_KEY and SENDER are required (see the header of this file)");
}

/**
 * Separated from the built-in http_req_failed, which counts only transport failures. A 429 is the
 * service working correctly under a quota, and folding it into an error rate would make a
 * successful load test look like an outage.
 */
const sponsored = new Counter("paymaster_sponsored");
const quotaDenied = new Counter("paymaster_quota_denied");
const serverErrors = new Counter("paymaster_server_errors");
const sponsorLatency = new Trend("paymaster_sponsor_latency", true);
const cleanResponses = new Rate("paymaster_clean_responses");

export const options = {
  scenarios: {
    // Ramp rather than a step: a step to full load measures cold caches and an empty connection
    // pool, which is a real scenario but not the one you usually mean by "can it hold N rps".
    ramp: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        {target: 25, duration: "30s"},
        {target: 100, duration: "1m"},
        {target: 100, duration: "2m"},
        {target: 0, duration: "30s"},
      ],
    },
  },
  thresholds: {
    // A 5xx is the only unambiguous failure: it leaves the caller unable to tell whether they were
    // charged. Zero tolerance is right here, unlike a latency budget.
    paymaster_server_errors: ["count==0"],
    paymaster_clean_responses: ["rate>0.999"],
    // Signing is CPU-bound and the policy path does one Redis round trip; a p95 above 500ms means
    // something is queueing, most likely the database or the quota store.
    "paymaster_sponsor_latency{expected_response:true}": ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

/** A syntactically valid operation. It is never submitted, so its callData need not do anything. */
function userOperation(nonce) {
  return {
    sender: SENDER,
    // Distinct per iteration so requests are not deduplicated anywhere along the path, and so the
    // sponsorship records this creates are distinguishable afterwards.
    nonce: "0x" + nonce.toString(16),
    callData: "0x",
    callGasLimit: "0x30d40",
    verificationGasLimit: "0x7a120",
    preVerificationGas: "0x186a0",
    maxFeePerGas: "0x4a817c800",
    maxPriorityFeePerGas: "0x3b9aca00",
  };
}

export default function () {
  const nonce = Date.now() * 1000 + __VU * 1000 + __ITER;

  const response = http.post(
    `${BASE_URL}/paymaster/sponsor`,
    JSON.stringify({chainId: CHAIN_ID, userOperation: userOperation(nonce)}),
    {
      headers: {"content-type": "application/json", authorization: `Bearer ${API_KEY}`},
      tags: {name: "sponsor"},
    },
  );

  sponsorLatency.add(response.timings.duration);

  if (response.status === 201 || response.status === 200) {
    sponsored.add(1);
    cleanResponses.add(true);
    check(response, {
      "attestation has paymasterAndData": (r) => {
        const body = r.json();
        return typeof body.paymasterAndData === "string" && body.paymasterAndData.length > 100;
      },
      // An expiry in the past would be an attestation no bundler can use — a success that is not one.
      "attestation is not already expired": (r) => new Date(r.json().expiresAt).getTime() > Date.now(),
    });
  } else if (response.status === 429 || response.status === 403) {
    // Expected under a quota or a policy denial. Counted, not failed: reaching the cap is the
    // system working, and a load test that exhausts a daily budget should say so plainly.
    quotaDenied.add(1);
    cleanResponses.add(true);
  } else if (response.status >= 500) {
    serverErrors.add(1);
    cleanResponses.add(false);
    console.error(`5xx from sponsor: ${response.status} ${response.body}`);
  } else {
    cleanResponses.add(false);
    console.error(`unexpected status ${response.status}: ${response.body}`);
  }
}

export function handleSummary(data) {
  const sponsoredCount = data.metrics.paymaster_sponsored?.values.count ?? 0;
  const deniedCount = data.metrics.paymaster_quota_denied?.values.count ?? 0;
  const errorCount = data.metrics.paymaster_server_errors?.values.count ?? 0;

  const lines = [
    "",
    "paymaster load test",
    "===================",
    `sponsored:      ${sponsoredCount}`,
    `quota-denied:   ${deniedCount}  (expected once a cap is reached — not a failure)`,
    `server errors:  ${errorCount}   (must be 0)`,
    `p95 latency:    ${(data.metrics.paymaster_sponsor_latency?.values["p(95)"] ?? 0).toFixed(0)}ms`,
    "",
    "Check the deposit on the target chain afterwards: every sponsorship above committed real funds.",
    "",
  ];
  return {stdout: lines.join("\n")};
}
