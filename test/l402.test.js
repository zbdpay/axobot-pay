import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createExpressPaymentMiddleware } from "../dist/index.js";

const nowFuture = 4_102_444_800;

const createPaymentHash = (preimage) => {
  return crypto.createHash("sha256").update(preimage, "utf8").digest("hex");
};

const createMacaroon = (payload, secret) => {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
};

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pay-l402-"));
  return path.join(root, "server-tokens.json");
};

test("happy path: challenge then valid proof forwards request", async () => {
  const apiKey = "test-key";
  const resource = "/protected";
  const amountSats = 100;
  const preimage = "happy-proof-preimage";
  const paymentHash = createPaymentHash(preimage);
  const tokenStorePath = await createTempTokenStorePath();
  const fetchCalls = [];

  await withIsolatedFetch(async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method ?? "GET" });

    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      return createMockResponse(200, {
        data: {
          id: "charge-happy",
          invoice: { request: "lnbc-happy" },
          paymentHash,
          expiresAt: nowFuture,
        },
      });
    }

    if (
      url.toString().endsWith("/v0/charges/charge-happy") &&
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
      tokenStorePath,
    });

    const challenge = await runMiddleware(middleware, {
      path: resource,
      headers: {},
    });

    assert.equal(challenge.statusCode, 402);
    assert.equal(challenge.body.error.code, "payment_required");
    assert.equal(challenge.calledNext, false);
    assert.match(challenge.headers["WWW-Authenticate"], /^L402 /);

    const macaroon = challenge.body.macaroon;

    const granted = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `L402 ${macaroon}:${preimage}`,
      },
    });

    assert.equal(granted.calledNext, true);
    assert.equal(granted.statusCode, 0);

    const replay = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `LSAT ${macaroon}:${preimage}`,
      },
    });

    assert.equal(replay.calledNext, true);

    const getCalls = fetchCalls.filter((call) =>
      call.url.toString().includes("/v0/charges/charge-happy"),
    );
    assert.equal(getCalls.length, 1);

    const storeRaw = await fs.readFile(tokenStorePath, "utf8");
    const store = JSON.parse(storeRaw);
    assert.equal(store.settled["charge-happy"].paymentHash, paymentHash);
  });
});

test("invalid proof path returns 401 invalid_payment_proof", async () => {
  const apiKey = "test-key";
  const resource = "/proof-check";
  const amountSats = 100;
  const preimage = "valid-preimage";
  const paymentHash = createPaymentHash(preimage);
  const badPreimage = "bad-preimage";

  await withIsolatedFetch(async (url, options = {}) => {
    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      return createMockResponse(200, {
        data: {
          id: "charge-proof",
          invoice: { request: "lnbc-proof" },
          paymentHash,
          expiresAt: nowFuture,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      tokenStorePath: await createTempTokenStorePath(),
    });

    const challenge = await runMiddleware(middleware, {
      path: resource,
      headers: {},
    });

    const denied = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `L402 ${challenge.body.macaroon}:${badPreimage}`,
      },
    });

    assert.equal(denied.statusCode, 401);
    assert.equal(denied.body.error.code, "invalid_payment_proof");
    assert.equal(denied.calledNext, false);
  });
});

test("resource mismatch path returns 403 resource_mismatch", async () => {
  const apiKey = "test-key";
  const amountSats = 100;
  const preimage = "resource-preimage";
  const paymentHash = createPaymentHash(preimage);

  await withIsolatedFetch(async (url, options = {}) => {
    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      return createMockResponse(200, {
        data: {
          id: "charge-resource",
          invoice: { request: "lnbc-resource" },
          paymentHash,
          expiresAt: nowFuture,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      tokenStorePath: await createTempTokenStorePath(),
    });

    const challenge = await runMiddleware(middleware, {
      path: "/resource-a",
      headers: {},
    });

    const denied = await runMiddleware(middleware, {
      path: "/resource-b",
      headers: {
        authorization: `L402 ${challenge.body.macaroon}:${preimage}`,
      },
    });

    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, "resource_mismatch");
    assert.equal(denied.calledNext, false);
  });
});

test("amount mismatch path returns 403 amount_mismatch", async () => {
  const apiKey = "test-key";
  const preimage = "amount-preimage";
  const paymentHash = createPaymentHash(preimage);
  let dynamicAmount = 100;

  await withIsolatedFetch(async (url, options = {}) => {
    if (url.toString().endsWith("/v0/charges") && options.method === "POST") {
      return createMockResponse(200, {
        data: {
          id: "charge-amount",
          invoice: { request: "lnbc-amount" },
          paymentHash,
          expiresAt: nowFuture,
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url.toString()}`);
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: () => dynamicAmount,
      apiKey,
      tokenStorePath: await createTempTokenStorePath(),
    });

    const challenge = await runMiddleware(middleware, {
      path: "/amount",
      headers: {},
    });

    dynamicAmount = 120;

    const denied = await runMiddleware(middleware, {
      path: "/amount",
      headers: {
        authorization: `L402 ${challenge.body.macaroon}:${preimage}`,
      },
    });

    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, "amount_mismatch");
    assert.equal(denied.calledNext, false);
  });
});

test("expiry path returns 403 token_expired", async () => {
  const apiKey = "test-key";
  const resource = "/expired";
  const amountSats = 100;
  const preimage = "expired-preimage";
  const paymentHash = createPaymentHash(preimage);
  const expiredMacaroon = createMacaroon(
    {
      chargeId: "charge-expired",
      resource,
      amountSats,
      expiresAt: 1,
      paymentHash,
    },
    apiKey,
  );

  await withIsolatedFetch(async () => {
    throw new Error("fetch should not be called for expired token");
  }, async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: amountSats,
      apiKey,
      tokenStorePath: await createTempTokenStorePath(),
    });

    const denied = await runMiddleware(middleware, {
      path: resource,
      headers: {
        authorization: `L402 ${expiredMacaroon}:${preimage}`,
      },
    });

    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.code, "token_expired");
    assert.equal(denied.calledNext, false);
  });
});
