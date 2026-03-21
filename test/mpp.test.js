import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  encodePaymentCredential,
} from "@axobot/mppx";

import { createExpressPaymentMiddleware } from "../dist/index.js";

const nowFuture = 4_102_444_800;

const createMockResponse = (status, payload) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
};

const makeResponseCapture = () => {
  const headers = {};
  const capture = {
    statusCode: 0,
    body: null,
    headers,
    response: {
      status(code) {
        capture.statusCode = code;
        return this;
      },
      json(payload) {
        capture.body = payload;
        return this;
      },
      setHeader(name, value) {
        headers[name] = value;
      },
    },
  };
  return capture;
};

const runMiddleware = async (middleware, request) => {
  const capture = makeResponseCapture();
  let calledNext = false;
  await middleware(request, capture.response, () => {
    calledNext = true;
  });
  return {
    ...capture,
    calledNext,
  };
};

const withIsolatedFetch = async (fetchImpl, handler) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handler();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const createTempTokenStorePath = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pay-mpp-"));
  return path.join(root, "server-tokens.json");
};

test("MPP protocol issues a Payment challenge and accepts a valid credential", async () => {
  const apiKey = "test-key";
  const resource = "/mpp-protected";
  const amountSats = 100;
  const tokenStorePath = await createTempTokenStorePath();
  const preimage = "aa".repeat(32);
  const paymentHash = crypto
    .createHash("sha256")
    .update(Buffer.from(preimage, "hex"))
    .digest("hex");

  await withIsolatedFetch(async (url, options = {}) => {
    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      return createMockResponse(200, {
        data: {
          id: "charge-mpp",
          invoice: { request: "lnbc-mpp" },
          paymentHash,
          expiresAt: nowFuture,
        },
      });
    }

    if (
      url.toString().endsWith("/v0/charges/charge-mpp") &&
      (options.method === "GET" || options.method === undefined)
    ) {
      return createMockResponse(200, {
        data: {
          status: "completed",
          paymentHash,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      protocol: "MPP",
      tokenStorePath,
    });

    const challengeResponse = await runMiddleware(middleware, {
      path: resource,
      headers: {
        host: "api.example.com",
      },
    });

    assert.equal(challengeResponse.statusCode, 402);
    assert.match(challengeResponse.headers["WWW-Authenticate"], /^Payment /);
    assert.equal(challengeResponse.body.paymentChallenge.intent, "charge");
    const credential = encodePaymentCredential({
      challenge: challengeResponse.body.paymentChallenge,
      payload: {
        preimage,
      },
    });

    const granted = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${credential}`,
        host: "api.example.com",
      },
    });

    assert.equal(granted.calledNext, true);
    assert.equal(granted.statusCode, 0);
  });
});
