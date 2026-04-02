import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AxoPayError,
  createExpressPaymentMiddleware,
  createHonoPaymentMiddleware,
} from "../dist/index.js";
import { withPaymentRequired } from "../dist/next.js";

const withMockFetch = async (handler) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        data: {
          id: "charge-smoke",
          invoice: { request: "lnbc-smoke" },
          paymentHash: "abcd",
          expiresAt: 4_102_444_800,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    await handler();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

test("express middleware returns payment_required challenge", async () => {
  await withMockFetch(async () => {
    const middleware = createExpressPaymentMiddleware({
      amount: 100,
      apiKey: "test-key",
    });

    let statusCode = 0;
    let jsonBody = null;
    const headers = {};
    let calledNext = false;

    await middleware(
      { path: "/protected", headers: {} },
      {
        status(code) {
          statusCode = code;
          return this;
        },
        json(payload) {
          jsonBody = payload;
          return this;
        },
        setHeader(name, value) {
          headers[name] = value;
        },
      },
      () => {
        calledNext = true;
      },
    );

    assert.equal(statusCode, 402);
    assert.equal(jsonBody.error.code, "payment_required");
    assert.equal(typeof headers["WWW-Authenticate"], "string");
    assert.equal(calledNext, false);
  });
});

test("hono middleware returns payment_required challenge", async () => {
  await withMockFetch(async () => {
    const middleware = createHonoPaymentMiddleware({
      amount: 100,
      apiKey: "test-key",
    });

    let statusCode = 0;
    let body = null;
    const headers = {};
    let calledNext = false;

    await middleware(
      {
        req: {
          path: "/protected",
          raw: new Request("https://example.com/protected"),
          header: () => undefined,
        },
        header(name, value) {
          headers[name] = value;
        },
        json(payload, status) {
          statusCode = status;
          body = payload;
          return new Response(JSON.stringify(payload), { status });
        },
      },
      async () => {
        calledNext = true;
      },
    );

    assert.equal(statusCode, 402);
    assert.equal(body.error.code, "payment_required");
    assert.equal(typeof headers["WWW-Authenticate"], "string");
    assert.equal(calledNext, false);
  });
});

test("next wrapper returns payment_required challenge", async () => {
  await withMockFetch(async () => {
    const wrapped = withPaymentRequired(
      {
        amount: 100,
        apiKey: "test-key",
      },
      async () => {
        return new Response("ok", { status: 200 });
      },
    );

    const response = await wrapped(new Request("https://example.com/protected"), {});
    const body = await response.json();

    assert.equal(response.status, 402);
    assert.equal(body.error.code, "payment_required");
    assert.equal(typeof response.headers.get("WWW-Authenticate"), "string");
  });
});

test("missing ZBD_API_KEY throws configuration_error", () => {
  const previous = process.env.ZBD_API_KEY;
  delete process.env.ZBD_API_KEY;

  try {
    assert.throws(
      () => {
        createExpressPaymentMiddleware({ amount: 100 });
      },
      (error) => {
        assert.ok(error instanceof AxoPayError);
        assert.equal(error.code, "configuration_error");
        assert.equal(error.status, 500);
        return true;
      },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ZBD_API_KEY;
    } else {
      process.env.ZBD_API_KEY = previous;
    }
  }
});
