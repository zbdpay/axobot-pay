import assert from "node:assert/strict";

const root = await import("@axobot/pay");
const next = await import("@axobot/pay/next");

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

assert.equal(typeof root.createExpressPaymentMiddleware, "function");
assert.equal(typeof root.createHonoPaymentMiddleware, "function");
assert.equal(typeof root.createPaymentMiddlewareFoundation, "function");
assert.equal(typeof next.withPaymentRequired, "function");

const express = root.createExpressPaymentMiddleware({
  amount: 50,
  apiKey: "smoke-key",
});

let expressStatus = 0;
await express(
  { path: "/smoke" },
  {
    status(code) {
      expressStatus = code;
      return this;
    },
    json() {
      return this;
    },
  },
  () => {
    throw new Error("next should not be called without proof");
  },
);

assert.equal(expressStatus, 402);

const hono = root.createHonoPaymentMiddleware({
  amount: 75,
  apiKey: "smoke-key",
});

let honoStatus = 0;
await hono(
  {
    req: {
      path: "/smoke",
      raw: new Request("https://example.com/smoke"),
      header: () => undefined,
    },
    json(_payload, status) {
      honoStatus = status;
      return new Response("", { status });
    },
  },
  async () => {
    throw new Error("next should not be called without proof");
  },
);

assert.equal(honoStatus, 402);

const wrapped = next.withPaymentRequired(
  {
    amount: 30,
    apiKey: "smoke-key",
  },
  async () => new Response("wrapped", { status: 200 }),
);

const response = await wrapped(new Request("https://example.com/smoke"), {});
assert.equal(response.status, 402);

const previous = process.env.ZBD_API_KEY;
delete process.env.ZBD_API_KEY;

try {
  assert.throws(
    () => {
      root.createExpressPaymentMiddleware({ amount: 10 });
    },
    (error) => {
      assert.equal(error.code, "configuration_error");
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

process.stdout.write("adapter smoke checks passed\n");
} finally {
  globalThis.fetch = previousFetch;
}
