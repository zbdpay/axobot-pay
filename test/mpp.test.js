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
    const sessionStorePath = path.join(path.dirname(tokenStorePath), "mpp-charge-sessions.json");
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      protocol: "MPP",
      tokenStorePath,
      mppSessionStorePath: sessionStorePath,
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

test("MPP session supports open, bearer, top-up, and close with Lightning Address refunds", async () => {
  const apiKey = "test-key";
  const resource = "/mpp-session";
  const amountSats = 50;
  const tokenStorePath = await createTempTokenStorePath();
  const sessionStorePath = path.join(path.dirname(tokenStorePath), "mpp-sessions.json");

  const openPreimage = "bb".repeat(32);
  const openPaymentHash = crypto
    .createHash("sha256")
    .update(Buffer.from(openPreimage, "hex"))
    .digest("hex");

  const topUpPreimage = "cc".repeat(32);
  const topUpPaymentHash = crypto
    .createHash("sha256")
    .update(Buffer.from(topUpPreimage, "hex"))
    .digest("hex");

  const refundPreimage = "dd".repeat(32);
  const refundPaymentHash = crypto
    .createHash("sha256")
    .update(Buffer.from(refundPreimage, "hex"))
    .digest("hex");

  const createdCharges = [
    {
      id: "charge-open",
      invoice: { request: "lnbc-open" },
      paymentHash: openPaymentHash,
      expiresAt: nowFuture,
    },
    {
      id: "charge-topup",
      invoice: { request: "lnbc-topup" },
      paymentHash: topUpPaymentHash,
      expiresAt: nowFuture,
    },
    {
      id: "charge-close",
      invoice: { request: "lnbc-close" },
      paymentHash: "ee".repeat(32),
      expiresAt: nowFuture,
    },
  ];

  await withIsolatedFetch(async (url, options = {}) => {
    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      const nextCharge = createdCharges.shift();
      if (!nextCharge) {
        throw new Error("Unexpected charge creation");
      }
      return createMockResponse(200, {
        data: nextCharge,
      });
    }

    if (
      url.toString().endsWith("/v0/charges/charge-open") &&
      (options.method === "GET" || options.method === undefined)
    ) {
      return createMockResponse(200, {
        data: {
          status: "completed",
          paymentHash: openPaymentHash,
        },
      });
    }

    if (
      url.toString().endsWith("/v0/charges/charge-topup") &&
      (options.method === "GET" || options.method === undefined)
    ) {
      return createMockResponse(200, {
        data: {
          status: "completed",
          paymentHash: topUpPaymentHash,
        },
      });
    }

    if (
      url.toString().endsWith("/v0/ln-address/send-payment") &&
      options.method === "POST"
    ) {
      return createMockResponse(200, {
        data: {
          id: "refund-payment",
          paymentHash: refundPaymentHash,
          preimage: refundPreimage,
          amountSats: 50,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      protocol: "MPP",
      mppIntent: "session",
      mppDepositMultiplier: 2,
      tokenStorePath,
      mppSessionStorePath: sessionStorePath,
    });

    const initialChallenge = await runMiddleware(middleware, {
      path: resource,
      headers: {
        host: "api.example.com",
      },
    });

    assert.equal(initialChallenge.statusCode, 402);
    assert.equal(initialChallenge.body.paymentChallenge.intent, "session");
    assert.equal(initialChallenge.body.depositSats, 100);

    const sessionId = initialChallenge.body.paymentHash;
    const openCredential = encodePaymentCredential({
      challenge: initialChallenge.body.paymentChallenge,
      payload: {
        action: "open",
        preimage: openPreimage,
        returnLightningAddress: "agent@axo.bot",
      },
    });

    const opened = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${openCredential}`,
        host: "api.example.com",
      },
    });

    assert.equal(opened.calledNext, true);

    const bearerCredential = encodePaymentCredential({
      challenge: initialChallenge.body.paymentChallenge,
      payload: {
        action: "bearer",
        sessionId,
        preimage: openPreimage,
      },
    });

    const firstBearer = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${bearerCredential}`,
        host: "api.example.com",
      },
    });

    assert.equal(firstBearer.calledNext, true);

    const exhausted = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${bearerCredential}`,
        host: "api.example.com",
      },
    });

    assert.equal(exhausted.statusCode, 402);
    assert.equal(exhausted.body.paymentChallenge.intent, "session");
    assert.equal(exhausted.body.reason, "insufficient_balance");
    assert.equal(exhausted.body.sessionId, sessionId);

    const topUpCredential = encodePaymentCredential({
      challenge: exhausted.body.paymentChallenge,
      payload: {
        action: "topUp",
        sessionId,
        topUpPreimage,
      },
    });

    const toppedUp = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${topUpCredential}`,
        host: "api.example.com",
      },
    });

    assert.equal(toppedUp.calledNext, true);

    const closeChallenge = await runMiddleware(middleware, {
      path: resource,
      headers: {
        host: "api.example.com",
      },
    });

    assert.equal(closeChallenge.statusCode, 402);
    assert.equal(closeChallenge.body.paymentChallenge.intent, "session");

    const closeCredential = encodePaymentCredential({
      challenge: closeChallenge.body.paymentChallenge,
      payload: {
        action: "close",
        sessionId,
        preimage: openPreimage,
      },
    });

    const closed = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `Payment ${closeCredential}`,
        host: "api.example.com",
      },
    });

    assert.equal(closed.calledNext, false);
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.body.status, "closed");
    assert.equal(closed.body.refundedSats, 50);
    assert.equal(closed.body.refundStatus, "succeeded");
    assert.equal(closed.body.refundReference, "refund-payment");
  });
});
